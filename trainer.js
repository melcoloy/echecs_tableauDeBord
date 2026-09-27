// Entraîneur d'ouvertures : échiquier, vérification des coups, répétition des lignes ratées.
const $ = id => document.getElementById(id);
const FILES = "abcdefgh";
const norm = san => san.replace(/[+#!?]/g, "");
const pct = x => `${Math.round(x * 100)} %`;

let index = [], op = null, game = new Chess(), mode = "apprendre";
let children = [], path = [], selected = null, lastMove = null, flash = {};
let errorsHere = 0, errorsLine = 0, busy = false, progress = null, revealed = false;
let generation = 0; // invalide les coups adverses en attente quand on relance une ligne

// ---------- chargement ----------
async function init() {
  try {
    index = await (await fetch("data/openings/index.json", { cache: "no-cache" })).json();
  } catch (e) {
    $("title").textContent = "Aucune ouverture trouvée";
    $("subtitle").textContent = "Lance backend/build_openings.py, puis ouvre le site via un serveur local.";
    return;
  }
  $("opening").innerHTML = index.map(o =>
    `<option value="${o.id}">${o.nom} · ${o.couleur} (${o.lignes} lignes)</option>`).join("");
  $("opening").onchange = e => loadOpening(e.target.value);
  document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    mode = b.dataset.m;
    document.querySelectorAll("[data-m]").forEach(x => x.setAttribute("aria-pressed", x === b));
    newLine();
  });
  $("next").onclick = newLine;
  $("reset").onclick = () => {
    if (confirm("Effacer ta progression sur cette ouverture ?")) { progress = blankProgress(); saveProgress(); newLine(); }
  };
  $("board").addEventListener("click", onBoardClick);
  loadOpening(index[0].id);
}

async function loadOpening(id) {
  op = await (await fetch(`data/openings/${id}.json`, { cache: "no-cache" })).json();
  $("title").textContent = op.resume.nom;
  $("subtitle").textContent = `Tu joues avec les ${op.resume.couleur}${op.resume.eco ? " · " + op.resume.eco : ""} · ${op.resume.lignes} lignes`;
  progress = loadProgress();
  newLine();
}

// ---------- progression (stockée dans le navigateur) ----------
const blankProgress = () => ({ lignes: 0, parfaites: 0, erreurs: {} });
function loadProgress() {
  try { return JSON.parse(localStorage.getItem("ouv-" + op.resume.id)) || blankProgress(); }
  catch { return blankProgress(); }
}
function saveProgress() {
  try { localStorage.setItem("ouv-" + op.resume.id, JSON.stringify(progress)); } catch {}
}
const keyOf = p => p.join(" ");
// nombre d'erreurs enregistrées dans toute la sous-ligne qui commence par ce chemin
const errorsUnder = p => {
  const k = keyOf(p);
  return Object.entries(progress.erreurs).reduce((s, [key, n]) => s + (key === k || key.startsWith(k + " ") ? n : 0), 0);
};

// ---------- déroulement d'une ligne ----------
const userColor = () => (op.resume.couleur === "blancs" ? "w" : "b");
const userTurn = () => game.turn() === userColor();

function newLine() {
  generation++;
  game.reset();
  for (const u of op.debut) game.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
  const h = game.history({ verbose: true });
  lastMove = h.length ? h[h.length - 1] : null;
  children = op.arbre; path = []; selected = null; errorsLine = 0; errorsHere = 0; flash = {};
  say("", userTurn() ? "À toi de jouer." : "");
  render();
  step();
}

function step() {
  if (!children.length) return endLine();
  if (userTurn()) {
    busy = false;
    errorsHere = 0;
    revealed = false;
    if (mode === "apprendre") showHint();
    render();
  } else {
    busy = true;
    const gen = generation;
    setTimeout(() => { if (gen === generation && !userTurn()) opponentMove(); }, 450);
  }
}

function opponentMove() {
  // tirage pondéré par la fréquence, avec un bonus pour les lignes où tu t'es trompé
  const weights = children.map(c => c.n * (1 + 2 * errorsUnder([...path, norm(c.san)])));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let pick = children[children.length - 1];
  for (let i = 0; i < children.length; i++) { if ((r -= weights[i]) <= 0) { pick = children[i]; break; } }
  play(pick);
  if (children.length) say("", `L'adversaire a joué ${pick.san}. À toi de jouer.`);
  step();
}

function play(child) {
  lastMove = game.move(child.san);
  path.push(norm(child.san));
  children = child.enfants || [];
  flash = {};
  render();
}

function attempt(from, to) {
  const piece = game.get(from);
  const promo = piece && piece.type === "p" && (to[1] === "8" || to[1] === "1") ? "q" : undefined;
  const mv = game.move({ from, to, promotion: promo });
  if (!mv) return false;
  const expected = children[0];
  if (norm(mv.san) === norm(expected.san)) {
    game.undo();
    play(expected);
    say("good", `${mv.san} : bien joué !`);
    step();
  } else {
    game.undo();
    errorsHere++; errorsLine++;
    const k = keyOf(path);
    progress.erreurs[k] = (progress.erreurs[k] || 0) + 1;
    saveProgress();
    flash = { [from]: "bad", [to]: "bad" };
    if (mode === "apprendre" || errorsHere >= 2) {
      say("bad", `${mv.san} n'est pas le coup de référence. La réponse est ${expected.san}.`);
      showHint();
    } else {
      say("bad", `${mv.san} n'est pas le bon coup. Essaie encore (encore une erreur et la réponse s'affiche).`);
    }
    render();
    setTimeout(() => { if (flash[from] === "bad") { delete flash[from]; delete flash[to]; render(); } }, 700);
  }
  return true;
}

function endLine() {
  busy = true;
  progress.lignes++;
  if (errorsLine === 0) progress.parfaites++;
  saveProgress();
  say("done", errorsLine === 0
    ? "Ligne terminée sans erreur ! Clique sur « Nouvelle ligne » pour continuer."
    : `Ligne terminée avec ${errorsLine} erreur${errorsLine > 1 ? "s" : ""}. Elle reviendra plus souvent.`);
  render();
}

function showHint() {
  const expected = children[0];
  const mv = game.moves({ verbose: true }).find(m => norm(m.san) === norm(expected.san));
  if (mv) flash = { ...flash, [mv.from]: "hint", [mv.to]: "hint" };
  revealed = true;
}

// ---------- interactions ----------
function onBoardClick(e) {
  const sq = e.target.closest(".sq");
  if (!sq || busy || !children.length || !userTurn()) return;
  const s = sq.dataset.sq;
  const piece = game.get(s);
  if (selected && s !== selected && game.moves({ square: selected, verbose: true }).some(m => m.to === s)) {
    const from = selected;
    selected = null;
    attempt(from, s);
    return;
  }
  selected = piece && piece.color === userColor() && s !== selected ? s : null;
  render();
}

// ---------- affichage ----------
function say(kind, text) {
  const f = $("feedback");
  f.className = "feedback" + (kind ? " " + kind : "");
  f.textContent = text;
}

function render() {
  renderBoard();
  renderMoves();
  renderPosition();
  renderProgress();
}

function renderBoard() {
  const flip = userColor() === "b";
  const dests = selected ? game.moves({ square: selected, verbose: true }).map(m => m.to) : [];
  let html = "";
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = flip ? 7 - f : f, rank = flip ? r + 1 : 8 - r;
      const sq = FILES[file] + rank;
      const p = game.get(sq);
      const cls = ["sq", (file + rank) % 2 ? "d" : "l"];
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cls.push("last");
      if (sq === selected) cls.push("sel");
      if (flash[sq]) cls.push(flash[sq]);
      if (dests.includes(sq)) cls.push("dest", p ? "occ" : "");
      let coords = "";
      if (r === 7) coords += `<span class="coord f">${FILES[file]}</span>`;
      if (f === 0) coords += `<span class="coord r">${rank}</span>`;
      const img = p ? `<img src="pieces/${p.color}${p.type.toUpperCase()}.svg" alt="${p.color === "w" ? "blanc" : "noir"} ${p.type}">` : "";
      html += `<div class="${cls.join(" ")}" data-sq="${sq}">${img}${coords}</div>`;
    }
  }
  $("board").innerHTML = html;
}

function renderMoves() {
  const hist = game.history();
  const book = op.debut.length;
  let html = "";
  for (let i = 0; i < hist.length; i += 2) {
    const c = j => `<span class="${j < book ? "book" : ""} ${j === hist.length - 1 ? "cur" : ""}">${hist[j] || ""}</span>`;
    html += `<li class="no">${i / 2 + 1}.</li>${c(i)}${c(i + 1)}`;
  }
  $("moves").innerHTML = html;
  $("moves").scrollTop = 1e6;
}

function renderPosition() {
  if (!children.length) {
    $("posTitle").textContent = "Fin de la ligne";
    $("posInfo").innerHTML = `<p class="hint">Tu as couvert toute la théorie retenue pour cette variante.</p>`;
    return;
  }
  if (userTurn()) {
    const exp = children[0];
    $("posTitle").textContent = "À toi de jouer";
    $("posInfo").innerHTML = revealed
      ? `<p class="hint">Coup de référence (le plus joué entre 1800 et 2200) :</p>
         <div class="answer">${exp.san}</div>
         <p class="hint">${exp.n.toLocaleString("fr-BE")} parties · score ${pct(exp.score)} pour celui qui le joue</p>`
      : `<p class="hint">Trouve le coup de référence. Clique sur une pièce, puis sur sa case d'arrivée.</p>`;
  } else {
    $("posTitle").textContent = "Réponses adverses";
    $("posInfo").innerHTML = `<p class="hint">Ce que jouent tes adversaires (1000-1600) :</p>` +
      children.map(c => `<div class="optrow"><span class="san">${c.san}</span>
        <div class="track"><div class="fill" style="width:${100 * (c.part || 0)}%"></div></div>
        <span class="num">${pct(c.part || 0)}</span></div>`).join("");
  }
}

function renderProgress() {
  const nbErr = Object.values(progress.erreurs).reduce((a, b) => a + b, 0);
  $("progress").innerHTML = `<div class="stat">
    <div><div class="v">${progress.lignes}</div><div class="l">lignes jouées</div></div>
    <div><div class="v">${progress.parfaites}</div><div class="l">sans erreur</div></div>
    <div><div class="v">${nbErr}</div><div class="l">erreurs au total</div></div></div>`;
}

init();