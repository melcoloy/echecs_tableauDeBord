// Tableau de bord : chargement des données, filtres et affichage.
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = x => `${Math.round(x * 100)} %`;
const CAD_FR = { blitz: "Blitz", rapid: "Rapide", bullet: "Bullet", daily: "Daily" };

let ALL = [], state = { cadence: "tout", jours: 0 }, charts = {};

Chart.defaults.font.family = '"IBM Plex Sans", system-ui, sans-serif';
Chart.defaults.color = "#5C6778";

async function init() {
  try {
    const data = await (await fetch("data/games.json", { cache: "no-cache" })).json();
    ALL = data.parties;
    $("player").textContent = data.joueur;
    $("updated").textContent = `${ALL.length} parties · mis à jour le ${new Date(data.maj).toLocaleDateString("fr-BE")}`;
    document.querySelectorAll("#cadences button").forEach(b => {
      if (b.dataset.c !== "tout" && !ALL.some(g => g.cadence === b.dataset.c)) b.disabled = true;
      b.onclick = () => {
        state.cadence = b.dataset.c;
        document.querySelectorAll("#cadences button").forEach(x => x.setAttribute("aria-pressed", x === b));
        render();
      };
    });
    $("period").onchange = e => { state.jours = +e.target.value; render(); };
    render();
  } catch (e) {
    $("player").textContent = "Données introuvables";
    $("updated").textContent = "Lance backend/fetch_games.py puis ouvre le site via un serveur local (python -m http.server).";
    console.error(e);
  }
}

function render() {
  const games = Stats.filter(ALL, state);
  renderKpis(games);
  renderElo(games);
  renderOpenings(games);
  renderHeat(games);
  renderGap(games);
  renderEndings(games);
  renderSessions(games);
  renderAccuracy(games);
}

// ---------- utilitaires ----------
const wdlBar = (s, cls = "bar") => s.n
  ? `<div class="${cls}"><i class="w" style="width:${100 * s.v / s.n}%"></i><i class="d" style="width:${100 * s.d / s.n}%"></i><i class="x" style="width:${100 * s.l / s.n}%"></i></div>`
  : `<div class="${cls}"></div>`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function chart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), config);
}

// ---------- chiffres clés ----------
function renderKpis(games) {
  const s = Stats.score(games);
  const cads = state.cadence === "tout" ? ["blitz", "rapid"] : [state.cadence];
  const elos = cads.map(c => {
    const gs = games.filter(g => g.cadence === c && g.elo);
    return gs.length ? { c, now: gs.at(-1).elo, max: Math.max(...gs.map(g => g.elo)) } : null;
  }).filter(Boolean);
  const acc = games.filter(g => typeof g.precision === "number");
  const accAvg = acc.length ? acc.reduce((a, g) => a + g.precision, 0) / acc.length : null;

  $("kpis").innerHTML = `
    <div class="kpi"><div class="v">${s.n}</div><div class="l">parties</div>${wdlBar(s, "wdl")}
      <div class="s">${s.v} V · ${s.d} N · ${s.l} D</div></div>
    <div class="kpi"><div class="v">${pct(s.pct)}</div><div class="l">score</div>
      <div class="s">${pct(s.n ? s.v / s.n : 0)} de victoires</div></div>
    ${elos.map(e => `<div class="kpi"><div class="v">${e.now}</div><div class="l">Elo ${CAD_FR[e.c]} actuel</div>
      <div class="s">record sur la période : ${e.max}</div></div>`).join("")}
    <div class="kpi"><div class="v">${accAvg ? accAvg.toFixed(1) : "—"}</div><div class="l">précision moyenne</div>
      <div class="s">${acc.length} parties analysées</div></div>`;
}

// ---------- progression ----------
function renderElo(games) {
  const cads = state.cadence === "tout"
    ? ["blitz", "rapid", "bullet", "daily"].filter(c => games.filter(g => g.cadence === c).length >= 30)
    : [state.cadence];
  const colors = { blitz: css("--accent"), rapid: css("--win"), bullet: css("--loss"), daily: css("--gold") };
  const series = cads.map(c => Stats.eloSeries(games, c));
  const xs = series.flat().map(p => p.x);
  chart("eloChart", {
    type: "line",
    data: { datasets: cads.map((c, i) => ({
      label: CAD_FR[c], data: series[i], borderColor: colors[c], backgroundColor: colors[c],
      borderWidth: 2, pointRadius: 0, pointHitRadius: 6, tension: .2 })) },
    options: {
      maintainAspectRatio: false, interaction: { mode: "nearest", intersect: false },
      scales: {
        x: { type: "linear", min: xs.length ? Math.min(...xs) : undefined, max: xs.length ? Math.max(...xs) : undefined, ticks: { callback: v => new Date(v).toLocaleDateString("fr-BE", { month: "short", year: "2-digit" }), maxTicksLimit: 8 }, grid: { display: false } },
        y: { grid: { color: css("--line") } },
      },
      plugins: { tooltip: { callbacks: { title: it => new Date(it[0].parsed.x).toLocaleDateString("fr-BE") } } },
    },
  });
}

// ---------- ouvertures ----------
function renderOpenings(games) {
  const table = couleur => {
    const fams = Stats.openings(games, couleur).slice(0, 10);
    if (!fams.length) return `<p class="empty">Pas assez de parties sur cette sélection.</p>`;
    const cls = p => p >= .55 ? "good" : p <= .45 ? "bad" : "";
    return `<div class="colhead"><span>Famille</span><span>Parties</span><span>V / N / D</span><span>Score</span></div>` +
      fams.map(f => `<details><summary>
          <span class="nm" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="num">${f.n}</span>${wdlBar(f)}
          <span class="num pct ${cls(f.pct)}">${pct(f.pct)}</span></summary>
          <ul class="vars">${f.variations.length
            ? f.variations.map(v => `<li><span>${esc(v.name)}</span><span class="num">${v.n}</span><span class="num pct ${cls(v.pct)}">${pct(v.pct)}</span></li>`).join("")
            : "<li><span>Pas de variante distincte</span></li>"}</ul></details>`).join("");
  };
  $("opW").innerHTML = table("blancs");
  $("opB").innerHTML = table("noirs");
}

// ---------- carte de chaleur ----------
function renderHeat(games) {
  const cells = Stats.heatmap(games);
  let html = `<div></div>` + Stats.SLOTS.map(s => `<div class="h">${s}</div>`).join("");
  cells.forEach((row, d) => {
    html += `<div class="d">${Stats.DAYS[d]}</div>`;
    row.forEach(c => {
      if (c.n < 5) { html += `<div class="c none" title="${c.n} partie(s)"></div>`; return; }
      const a = Math.min(.9, Math.abs(c.pct - .5) * 3.5);
      const rgb = c.pct >= .5 ? "46,139,87" : "194,65,59";
      html += `<div class="c" style="background:rgba(${rgb},${a});color:${a > .5 ? "#fff" : "inherit"}" title="${c.v} V · ${c.d} N · ${c.l} D">
        ${pct(c.pct)}<small>${c.n} parties</small></div>`;
    });
  });
  $("heat").innerHTML = html;
}

// ---------- écart d'Elo ----------
function renderGap(games) {
  const b = Stats.eloGap(games).filter(x => x.n >= 5);
  chart("gapChart", {
    data: {
      labels: b.map(x => x.label),
      datasets: [
        { type: "bar", label: "Score réel", data: b.map(x => +(x.pct * 100).toFixed(1)),
          backgroundColor: b.map(x => x.pct >= x.expected ? css("--win") : css("--loss")), borderRadius: 4 },
        { type: "line", label: "Score attendu", data: b.map(x => +(x.expected * 100).toFixed(1)),
          borderColor: css("--ink"), borderDash: [5, 4], pointRadius: 3, backgroundColor: css("--ink") },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100, ticks: { callback: v => v + " %" }, grid: { color: css("--line") } },
                x: { title: { display: true, text: "Elo adverse − ton Elo" }, grid: { display: false } } },
      plugins: { tooltip: { callbacks: { afterBody: it => `${b[it[0].dataIndex].n} parties` } } },
    },
  });
}

// ---------- fins de partie ----------
function renderEndings(games) {
  const e = Stats.endings(games);
  const group = (title, rows, color) => {
    const total = rows.reduce((s, [, n]) => s + n, 0);
    if (!total) return "";
    return `<div class="endgrp"><h3>${title} (${total})</h3>` + rows.map(([how, n]) => `
      <div class="endrow"><span>${esc(how)}</span>
        <div class="track"><div class="fill" style="width:${100 * n / total}%;background:${color}"></div></div>
        <span class="num">${pct(n / total)}</span></div>`).join("") + `</div>`;
  };
  $("endings").innerHTML = group("Victoires", e.wins, css("--win")) + group("Défaites", e.losses, css("--loss"))
    + group("Nulles", e.draws, css("--draw")) || `<p class="empty">Aucune partie sur cette sélection.</p>`;
}

// ---------- sessions et tilt ----------
function renderSessions(games) {
  const s = Stats.sessions(games);
  const diff = s.afterWin.pct - s.afterLoss.pct;
  let verdict = "Pas encore assez de parties enchaînées pour conclure.";
  if (s.afterWin.n >= 20 && s.afterLoss.n >= 20) {
    verdict = diff > .05
      ? `Après une défaite, ton score baisse de ${Math.round(diff * 100)} points : c'est souvent le bon moment pour faire une pause.`
      : diff < -.05
        ? `Tu rebondis bien : ton score est meilleur après une défaite qu'après une victoire.`
        : `Pas d'effet tilt marqué : ton score est stable, que la partie précédente soit gagnée ou perdue.`;
  }
  $("tilt").innerHTML = `<div class="tiltgrid">
      <div class="tiltcard"><div class="v">${pct(s.afterWin.pct)}</div><div class="l">score après une victoire (${s.afterWin.n} parties)</div></div>
      <div class="tiltcard"><div class="v">${pct(s.afterLoss.pct)}</div><div class="l">score après une défaite (${s.afterLoss.n} parties)</div></div>
    </div><p class="verdict">${verdict}</p>`;
  chart("sessionChart", {
    type: "bar",
    data: { labels: s.byIndex.map(x => x.label),
            datasets: [{ label: "Score", data: s.byIndex.map(x => x.n ? +(x.pct * 100).toFixed(1) : null),
                         backgroundColor: css("--accent"), borderRadius: 4 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false },
               tooltip: { callbacks: { afterBody: it => `${s.byIndex[it[0].dataIndex].n} parties` } } },
               scales: { y: { min: 0, max: 100, ticks: { callback: v => v + " %" }, grid: { color: css("--line") } },
                         x: { grid: { display: false }, title: { display: true, text: "Position dans la session" } } } },
  });
}

// ---------- précision ----------
function renderAccuracy(games) {
  const a = Stats.accuracy(games).filter(m => m.n >= 3);
  $("accBlock").hidden = a.length < 2;
  if (a.length < 2) return;
  chart("accChart", {
    type: "line",
    data: { labels: a.map(m => m.month), datasets: [{ label: "Précision moyenne", data: a.map(m => +m.avg.toFixed(1)),
            borderColor: css("--gold"), backgroundColor: css("--gold"), tension: .25, pointRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false },
               tooltip: { callbacks: { afterBody: it => `${a[it[0].dataIndex].n} parties analysées` } } },
               scales: { y: { grid: { color: css("--line") } }, x: { grid: { display: false } } } },
  });
}

init();