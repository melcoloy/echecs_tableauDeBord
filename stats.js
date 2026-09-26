// Calculs du tableau de bord. Aucune dépendance au DOM : testable avec Node.
const Stats = (() => {
  const DAY = 864e5;

  // ---------- ouvertures ----------
  const prettyOpening = n => (n || "Inconnue")
    .replace(/\bVan t\b/g, "Van't")
    .replace(/\b(King|Queen|Alekhine|Petrov|Bird|Owen|Philidor|Larsen|Bishop|Nimzowitsch)s\b/g, "$1's");

  // "Sicilian Defense Najdorf Variation" -> "Sicilian Defense"
  const family = n => {
    const m = n.match(/^(.*?\b(Opening|Defense|Game|Gambit|Attack|System))\b/);
    return m ? m[1] : n;
  };

  // ---------- scores ----------
  const score = games => {
    const n = games.length;
    const v = games.filter(g => g.resultat === "V").length;
    const d = games.filter(g => g.resultat === "N").length;
    const l = n - v - d;
    return { n, v, d, l, pct: n ? (v + d / 2) / n : 0 };
  };
  const expected = (me, opp) => 1 / (1 + 10 ** ((opp - me) / 400));

  // ---------- filtres ----------
  const filter = (games, { cadence = "tout", jours = 0 } = {}) => {
    const since = jours ? Date.now() - jours * DAY : 0;
    return games.filter(g =>
      (cadence === "tout" || g.cadence === cadence) && (!since || new Date(g.date).getTime() >= since));
  };

  // ---------- Elo dans le temps (dernier Elo de chaque jour) ----------
  const eloSeries = (games, cadence) => {
    const byDay = new Map();
    for (const g of games) if (g.cadence === cadence && g.elo) byDay.set(g.date.slice(0, 10), g.elo);
    return [...byDay].map(([d, elo]) => ({ x: new Date(d).getTime(), y: elo }));
  };

  // ---------- ouvertures par couleur ----------
  const openings = (games, couleur, minGames = 5) => {
    const fams = new Map();
    for (const g of games.filter(g => g.couleur === couleur)) {
      const full = prettyOpening(g.ouverture);
      const fam = family(full);
      if (!fams.has(fam)) fams.set(fam, { games: [], vars: new Map() });
      const f = fams.get(fam);
      f.games.push(g);
      if (!f.vars.has(full)) f.vars.set(full, []);
      f.vars.get(full).push(g);
    }
    return [...fams].map(([name, f]) => ({
      name, ...score(f.games),
      variations: [...f.vars].map(([vn, gs]) => ({ name: vn, ...score(gs) }))
        .filter(v => v.name !== name || f.vars.size > 1)
        .sort((a, b) => b.n - a.n),
    })).filter(f => f.n >= minGames).sort((a, b) => b.n - a.n);
  };

  // ---------- jour x tranche horaire (heure locale) ----------
  const SLOTS = ["0-3h", "3-6h", "6-9h", "9-12h", "12-15h", "15-18h", "18-21h", "21-24h"];
  const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const heatmap = games => {
    const cells = DAYS.map(() => SLOTS.map(() => []));
    for (const g of games) {
      const d = new Date(g.date);
      cells[(d.getDay() + 6) % 7][Math.floor(d.getHours() / 3)].push(g);
    }
    return cells.map(row => row.map(score));
  };

  // ---------- résultat selon l'écart d'Elo ----------
  const GAP_EDGES = [-Infinity, -200, -100, -50, 0, 50, 100, 200, Infinity];
  const gapLabel = i => {
    const a = GAP_EDGES[i], b = GAP_EDGES[i + 1];
    if (a === -Infinity) return `< ${b}`;
    if (b === Infinity) return `> +${a}`;
    return `${a > 0 ? "+" : ""}${a} à ${b > 0 ? "+" : ""}${b}`;
  };
  const eloGap = games => GAP_EDGES.slice(0, -1).map((_, i) => {
    const gs = games.filter(g => g.elo && g.elo_adversaire &&
      g.elo_adversaire - g.elo >= GAP_EDGES[i] && g.elo_adversaire - g.elo < GAP_EDGES[i + 1]);
    const exp = gs.length ? gs.reduce((s, g) => s + expected(g.elo, g.elo_adversaire), 0) / gs.length : 0;
    return { label: gapLabel(i), ...score(gs), expected: exp };
  });

  // ---------- façons de gagner / perdre ----------
  const endings = games => {
    const count = (res) => {
      const m = {};
      for (const g of games.filter(g => g.resultat === res)) m[g.fin] = (m[g.fin] || 0) + 1;
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    return { wins: count("V"), losses: count("D"), draws: count("N") };
  };

  // ---------- sessions : une pause de plus de 45 min coupe la session ----------
  const GAP_SESSION = 45 * 60 * 1000;
  const sessions = games => {
    const sorted = [...games].sort((a, b) => a.date.localeCompare(b.date));
    const afterWin = [], afterLoss = [], byIndex = [[], [], [], [], [], []]; // 1..5, 6+
    let idx = 0, prev = null;
    for (const g of sorted) {
      const t = new Date(g.date).getTime();
      const same = prev && t - new Date(prev.date).getTime() < GAP_SESSION;
      idx = same ? idx + 1 : 0;
      byIndex[Math.min(idx, 5)].push(g);
      if (same && prev.resultat === "V") afterWin.push(g);
      if (same && prev.resultat === "D") afterLoss.push(g);
      prev = g;
    }
    return {
      afterWin: score(afterWin), afterLoss: score(afterLoss),
      byIndex: byIndex.map((gs, i) => ({ label: i < 5 ? `${i + 1}e partie` : "6e et +", ...score(gs) })),
    };
  };

  // ---------- précision moyenne par mois ----------
  const accuracy = games => {
    const m = new Map();
    for (const g of games) if (typeof g.precision === "number") {
      const k = g.date.slice(0, 7);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(g.precision);
    }
    return [...m].map(([k, xs]) => ({ month: k, n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / xs.length }));
  };

  return { prettyOpening, family, score, expected, filter, eloSeries, openings,
           heatmap, SLOTS, DAYS, eloGap, endings, sessions, accuracy };
})();

if (typeof module !== "undefined") module.exports = Stats;