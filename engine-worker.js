// Fait tourner le moteur en arrière-plan pour que la page ne gèle pas pendant qu'il calcule.
importScripts("engine.js");
const searcher = new Engine.Searcher();

onmessage = e => {
  const { id, fen, moves, timeMs, maxDepth } = e.data;
  const pos = new Engine.Position(fen);
  for (const uci of moves) {          // on rejoue la partie pour connaître les répétitions
    const m = pos.moveFromUci(uci);
    if (!m) break;
    pos.make(m);
  }
  const result = searcher.search(pos, {
    timeMs, maxDepth,
    onDepth: info => postMessage({ type: "info", id, ...info }),
  });
  postMessage({ type: "best", id, ...result });
};