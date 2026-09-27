// Partie contre le moteur maison : chess.js gère l'affichage et les règles côté page,
// le moteur (engine.js) calcule dans un Web Worker.
const $ = id => document.getElementById(id);
const FILES = "abcdefgh";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const MATE = 100000;
const LEVELS = [
  { maxDepth: 1, timeMs: 1000 },
  { maxDepth: 2, timeMs: 1500 },
  { maxDepth: 4, timeMs: 2500 },
  { maxDepth: 64, timeMs: 1000 },
  { maxDepth: 64, timeMs: 3000 },
];

const worker = new Worker("engine-worker.js");
let game = new Chess(), userColor = "w", selected = null, lastMove = null;
let searchId = 0, thinking = false;

// ---------- partie ----------
function newGame() {
  searchId++; // ignore un éventuel calcul en cours
  game = new Chess();
  userColor = $("color").value;
  selected = null; lastMove = null; thinking = false;
  setEval(0);
  $("engineInfo").innerHTML = `<p class="hint">Les infos de calcul s'affichent quand le moteur réfléchit.</p>`;
  render();
  if (game.turn() !== userColor) engineMove(); else say("", "À toi de jouer.");
}

function engineMove() {
  if (game.game_over()) return;
  thinking = true;
  say("", "Le moteur réfléchit…");
  const level = LEVELS[+$("level").value];
  const moves = game.history({ verbose: true }).map(m => m.from + m.to + (m.promotion || ""));
  worker.postMessage({ id: ++searchId, fen: START, moves, ...level });
}

worker.onmessage = e => {
  const d = e.data;
  if (d.id !== searchId) return; // réponse d'une ancienne recherche
  showInfo(d);
  if (d.type !== "best") return;
  thinking = false;
  if (!d.best) return;
  lastMove = game.move({ from: d.best.slice(0, 2), to: d.best.slice(2, 4), promotion: d.best[4] || "q" });
  render();
  afterMove();
};

function afterMove() {
  if (game.in_checkmate()) {
    say("done", game.turn() === userColor ? "Échec et mat : le moteur gagne." : "Échec et mat : tu as gagné !");
  } else if (game.in_draw() || game.in_stalemate() || game.in_threefold_repetition()) {
    const why = game.in_stalemate() ? "pat" : game.in_threefold_repetition() ? "triple répétition"
      : game.insufficient_material() ? "matériel insuffisant" : "règle des 50 coups";
    say("done", `Partie nulle (${why}).`);
  } else if (game.turn() !== userColor) {
    engineMove();
  } else {
    say("", game.in_check() ? "Échec ! À toi de jouer." : "À toi de jouer.");
  }
}

// ---------- interactions ----------
$("board").addEventListener("click", e => {
  const sq = e.target.closest(".sq");
  if (!sq || thinking || game.game_over() || game.turn() !== userColor) return;
  const s = sq.dataset.sq, piece = game.get(s);
  if (selected && s !== selected && game.moves({ square: selected, verbose: true }).some(m => m.to === s)) {
    const from = selected;
    selected = null;
    lastMove = game.move({ from, to: s, promotion: "q" }); // promotion automatique en dame
    render();
    afterMove();
    return;
  }
  selected = piece && piece.color === userColor && s !== selected ? s : null;
  render();
});

$("undo").onclick = () => {
  if (!game.history().length) return;
  searchId++; thinking = false;                 // annule un éventuel calcul en cours
  game.undo();                                  // dernier coup (celui du moteur ou le tien)
  while (game.history().length && game.turn() !== userColor) game.undo();
  const h = game.history({ verbose: true });
  lastMove = h.length ? h[h.length - 1] : null;
  selected = null;
  render();
  if (game.turn() !== userColor) engineMove();  // tu as les noirs et on est revenu au début
  else say("", "Coup annulé. À toi de jouer.");
};
$("newGame").onclick = newGame;
$("color").onchange = newGame;

// ---------- affichage ----------
function say(kind, text) {
  $("feedback").className = "feedback" + (kind ? " " + kind : "");
  $("feedback").textContent = text;
}

// le moteur note du point de vue du camp au trait ; on convertit en point de vue des blancs
function whiteScore(d) {
  const moverIsWhite = game.turn() === "w";
  return moverIsWhite ? d.score : -d.score;
}
function formatScore(s) {
  if (Math.abs(s) > MATE - 1000) {
    const n = Math.ceil((MATE - Math.abs(s)) / 2);
    return `${s > 0 ? "Blancs" : "Noirs"} matent en ${n}`;
  }
  return (s > 0 ? "+" : "") + (s / 100).toFixed(2);
}
function setEval(s) {
  const clamped = Math.abs(s) > MATE - 1000 ? Math.sign(s) * 1000 : Math.max(-1000, Math.min(1000, s));
  $("evalFill").style.width = `${50 + clamped / 20}%`;
}

function pvToSan(pv) {
  const g = new Chess(game.fen());
  const out = [];
  for (const u of pv) {
    const m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
    if (!m) break;
    out.push(m.san);
  }
  return out;
}

function showInfo(d) {
  if (d.best === null && d.type === "best") return;
  const ws = whiteScore(d);
  setEval(ws);
  const nps = d.ms ? Math.round(d.nodes / d.ms) : 0;
  const pv = pvToSan(d.pv || []);
  $("engineInfo").innerHTML = `<div class="engstats">
      <div><div class="v">${formatScore(ws)}</div><div class="l">évaluation (+ = avantage blanc)</div></div>
      <div><div class="v">${d.depth}</div><div class="l">profondeur (demi-coups)</div></div>
      <div><div class="v">${(d.nodes || 0).toLocaleString("fr-BE")}</div><div class="l">positions examinées</div></div>
      <div><div class="v">${nps.toLocaleString("fr-BE")} k/s</div><div class="l">vitesse</div></div>
    </div>
    <div class="pv"><span class="hint">Variante envisagée :</span><br>${pv.join(" ") || "—"}</div>`;
}

function render() {
  const flip = userColor === "b";
  const dests = selected ? game.moves({ square: selected, verbose: true }).map(m => m.to) : [];
  const checkSq = game.in_check() ? findKing(game.turn()) : null;
  let html = "";
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = flip ? 7 - f : f, rank = flip ? r + 1 : 8 - r;
      const sq = FILES[file] + rank, p = game.get(sq);
      const cls = ["sq", (file + rank) % 2 ? "d" : "l"];
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cls.push("last");
      if (sq === selected) cls.push("sel");
      if (sq === checkSq) cls.push("bad");
      if (dests.includes(sq)) cls.push("dest", p ? "occ" : "");
      let coords = "";
      if (r === 7) coords += `<span class="coord f">${FILES[file]}</span>`;
      if (f === 0) coords += `<span class="coord r">${rank}</span>`;
      const img = p ? `<img src="pieces/${p.color}${p.type.toUpperCase()}.svg" alt="">` : "";
      html += `<div class="${cls.join(" ")}" data-sq="${sq}">${img}${coords}</div>`;
    }
  }
  $("board").innerHTML = html;

  const hist = game.history();
  let mv = "";
  for (let i = 0; i < hist.length; i += 2) {
    mv += `<li class="no">${i / 2 + 1}.</li><span class="${i === hist.length - 1 ? "cur" : ""}">${hist[i]}</span>` +
          `<span class="${i + 1 === hist.length - 1 ? "cur" : ""}">${hist[i + 1] || ""}</span>`;
  }
  $("moves").innerHTML = mv;
  $("moves").scrollTop = 1e6;
}

function findKing(color) {
  for (const f of FILES) for (let r = 1; r <= 8; r++) {
    const p = game.get(f + r);
    if (p && p.type === "k" && p.color === color) return f + r;
  }
  return null;
}

newGame();