// Moteur d'échecs écrit de zéro : plateau 0x88, alpha-bêta, quiescence, table de transposition.
// Fonctionne dans un navigateur (Web Worker) comme dans Node (tests perft).
const Engine = (() => {
  // ---------- pièces : type (bits 0-2) + couleur (8 = blanc, 16 = noir) ----------
  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  const WHITE = 8, BLACK = 16;
  const VALUE = [0, 100, 320, 330, 500, 900, 0];
  const PHASE = [0, 0, 1, 1, 2, 4, 0]; // poids de chaque pièce pour estimer la phase de jeu
  const MATE = 100000;
  const INF = 1000000;

  // ---------- directions sur un plateau 0x88 (case = rangée * 16 + colonne) ----------
  const KNIGHT = [33, 31, 18, 14, -14, -18, -31, -33];
  const KING = [16, 17, 1, -15, -16, -17, -1, 15];
  const BISHOP = [17, 15, -15, -17];
  const ROOK = [16, 1, -16, -1];
  const onBoard = sq => (sq & 0x88) === 0;
  const sqName = sq => "abcdefgh"[sq & 7] + ((sq >> 4) + 1);
  const parseSq = s => (s.charCodeAt(1) - 49) * 16 + (s.charCodeAt(0) - 97);

  // ---------- tables de position (du point de vue des blancs, a8 en premier) ----------
  const PST = {
    [P]: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
          0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    [N]: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
          -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    [B]: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
          -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    [R]: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
          -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    [Q]: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
          0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  };
  const KING_MID = [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
    20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20];
  const KING_END = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30,
    -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30,
    -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];
  // index dans une table 64 cases (a8 = 0) pour une case 0x88, vue par les blancs ou les noirs
  const pstIndex = (sq, color) => {
    const file = sq & 7, rank = sq >> 4;
    return color === WHITE ? (7 - rank) * 8 + file : rank * 8 + file;
  };

  // ---------- hachage Zobrist (deux entiers 32 bits, sans BigInt) ----------
  let seed = 1070372;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const ZP = [], ZC = [], ZE = [];
  for (let p = 0; p < 24; p++) { ZP[p] = []; for (let s = 0; s < 128; s++) ZP[p][s] = [rnd(), rnd()]; }
  for (let i = 0; i < 16; i++) ZC[i] = [rnd(), rnd()];
  for (let i = 0; i < 8; i++) ZE[i] = [rnd(), rnd()];
  const ZSIDE = [rnd(), rnd()];

  // droits de roque perdus quand une pièce part de (ou arrive sur) ces cases
  const CASTLE_MASK = new Array(128).fill(15);
  CASTLE_MASK[parseSq("e1")] = 15 & ~3; CASTLE_MASK[parseSq("h1")] = 15 & ~1; CASTLE_MASK[parseSq("a1")] = 15 & ~2;
  CASTLE_MASK[parseSq("e8")] = 15 & ~12; CASTLE_MASK[parseSq("h8")] = 15 & ~4; CASTLE_MASK[parseSq("a8")] = 15 & ~8;

  // ---------- codage d'un coup dans un entier ----------
  // bits 0-6 départ, 7-13 arrivée, 14-16 promotion, 17 prise, 18 en passant, 19 roque, 20 double pas
  const F_CAP = 1 << 17, F_EP = 1 << 18, F_CASTLE = 1 << 19, F_DOUBLE = 1 << 20;
  const mFrom = m => m & 127, mTo = m => (m >> 7) & 127, mPromo = m => (m >> 14) & 7;
  const mk = (from, to, flags = 0, promo = 0) => from | (to << 7) | (promo << 14) | flags;
  const toUci = m => sqName(mFrom(m)) + sqName(mTo(m)) + (mPromo(m) ? " nbrq"[mPromo(m) - 1] : "");

  // ============================================================
  class Position {
    constructor(fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1") { this.load(fen); }

    load(fen) {
      const [placement, side, castling, ep, half] = fen.trim().split(/\s+/);
      this.board = new Array(128).fill(0);
      let rank = 7, file = 0;
      for (const c of placement) {
        if (c === "/") { rank--; file = 0; }
        else if (/\d/.test(c)) file += +c;
        else {
          const color = c === c.toUpperCase() ? WHITE : BLACK;
          this.board[rank * 16 + file] = color | " pnbrqk".indexOf(c.toLowerCase());
          file++;
        }
      }
      this.side = side === "b" ? BLACK : WHITE;
      this.castling = (castling.includes("K") ? 1 : 0) | (castling.includes("Q") ? 2 : 0) |
                      (castling.includes("k") ? 4 : 0) | (castling.includes("q") ? 8 : 0);
      this.ep = ep && ep !== "-" ? parseSq(ep) : -1;
      this.half = +(half || 0);
      this.kings = {};
      for (let s = 0; s < 128; s++) if (onBoard(s) && (this.board[s] & 7) === K) this.kings[this.board[s] & 24] = s;
      this.stack = [];
      this.history = [];
      this.computeHash();
    }

    computeHash() {
      let lo = 0, hi = 0;
      for (let s = 0; s < 128; s++) if (onBoard(s) && this.board[s]) { lo ^= ZP[this.board[s]][s][0]; hi ^= ZP[this.board[s]][s][1]; }
      lo ^= ZC[this.castling][0]; hi ^= ZC[this.castling][1];
      if (this.ep >= 0) { lo ^= ZE[this.ep & 7][0]; hi ^= ZE[this.ep & 7][1]; }
      if (this.side === BLACK) { lo ^= ZSIDE[0]; hi ^= ZSIDE[1]; }
      this.lo = lo >>> 0; this.hi = hi >>> 0;
    }
    xp(p, s) { this.lo = (this.lo ^ ZP[p][s][0]) >>> 0; this.hi = (this.hi ^ ZP[p][s][1]) >>> 0; }

    // la case sq est-elle attaquée par la couleur "by" ?
    attacked(sq, by) {
      const b = this.board;
      const pawnDir = by === WHITE ? -16 : 16; // on regarde "à l'envers" depuis la case
      for (const d of [pawnDir - 1, pawnDir + 1]) {
        const s = sq + d;
        if (onBoard(s) && b[s] === (by | P)) return true;
      }
      for (const d of KNIGHT) { const s = sq + d; if (onBoard(s) && b[s] === (by | N)) return true; }
      for (const d of KING) { const s = sq + d; if (onBoard(s) && b[s] === (by | K)) return true; }
      for (const d of BISHOP) {
        for (let s = sq + d; onBoard(s); s += d) {
          if (b[s]) { if (b[s] === (by | B) || b[s] === (by | Q)) return true; break; }
        }
      }
      for (const d of ROOK) {
        for (let s = sq + d; onBoard(s); s += d) {
          if (b[s]) { if (b[s] === (by | R) || b[s] === (by | Q)) return true; break; }
        }
      }
      return false;
    }
    inCheck(color = this.side) { return this.attacked(this.kings[color], color ^ 24); }

    // coups pseudo-légaux (le roi peut encore être laissé en échec)
    generate(capturesOnly = false) {
      const b = this.board, us = this.side, them = us ^ 24, moves = [];
      for (let from = 0; from < 128; from++) {
        if (!onBoard(from)) { from += 7; continue; }
        const p = b[from];
        if (!p || (p & 24) !== us) continue;
        const t = p & 7;
        if (t === P) {
          const dir = us === WHITE ? 16 : -16;
          const startRank = us === WHITE ? 1 : 6, lastRank = us === WHITE ? 7 : 0;
          const addPawn = (to, flags) => {
            if ((to >> 4) === lastRank) for (const pr of [Q, R, B, N]) moves.push(mk(from, to, flags, pr));
            else moves.push(mk(from, to, flags));
          };
          const one = from + dir;
          if (onBoard(one) && !b[one]) {
            if (!capturesOnly || (one >> 4) === lastRank) addPawn(one, 0);
            const two = one + dir;
            if (!capturesOnly && (from >> 4) === startRank && !b[two]) moves.push(mk(from, two, F_DOUBLE));
          }
          for (const d of [dir - 1, dir + 1]) {
            const to = from + d;
            if (!onBoard(to)) continue;
            if (b[to] && (b[to] & 24) === them) addPawn(to, F_CAP);
            else if (to === this.ep) moves.push(mk(from, to, F_CAP | F_EP));
          }
          continue;
        }
        const dirs = t === N ? KNIGHT : t === B ? BISHOP : t === R ? ROOK : KING; // dame et roi : 8 directions
        const slide = t === B || t === R || t === Q;
        for (const d of dirs) {
          for (let to = from + d; onBoard(to); to += d) {
            if (b[to]) { if ((b[to] & 24) === them) moves.push(mk(from, to, F_CAP)); break; }
            if (!capturesOnly) moves.push(mk(from, to));
            if (!slide) break;
          }
        }
        if (t === K && !capturesOnly) this.genCastles(from, moves);
      }
      return moves;
    }

    genCastles(from, moves) {
      const b = this.board, us = this.side, them = us ^ 24;
      const [kSide, qSide] = us === WHITE ? [1, 2] : [4, 8];
      if ((this.castling & (kSide | qSide)) === 0 || this.attacked(from, them)) return;
      if (this.castling & kSide && !b[from + 1] && !b[from + 2] &&
          !this.attacked(from + 1, them) && !this.attacked(from + 2, them)) moves.push(mk(from, from + 2, F_CASTLE));
      if (this.castling & qSide && !b[from - 1] && !b[from - 2] && !b[from - 3] &&
          !this.attacked(from - 1, them) && !this.attacked(from - 2, them)) moves.push(mk(from, from - 2, F_CASTLE));
    }

    // joue un coup ; renvoie false (et l'annule) s'il laisse le roi en échec
    make(m) {
      const b = this.board, us = this.side, them = us ^ 24;
      const from = mFrom(m), to = mTo(m), piece = b[from];
      let captured = b[to], capSq = to;
      this.stack.push({ m, captured: 0, castling: this.castling, ep: this.ep, half: this.half, lo: this.lo, hi: this.hi });
      this.history.push(this.lo);
      const undo = this.stack[this.stack.length - 1];

      if (m & F_EP) { capSq = to + (us === WHITE ? -16 : 16); captured = b[capSq]; }
      if (captured) { this.xp(captured, capSq); b[capSq] = 0; }
      undo.captured = captured;

      this.xp(piece, from); b[from] = 0;
      const placed = mPromo(m) ? (us | mPromo(m)) : piece;
      b[to] = placed; this.xp(placed, to);
      if ((piece & 7) === K) this.kings[us] = to;

      if (m & F_CASTLE) {
        const [rFrom, rTo] = to > from ? [to + 1, to - 1] : [to - 2, to + 1];
        const rook = b[rFrom];
        this.xp(rook, rFrom); b[rFrom] = 0; b[rTo] = rook; this.xp(rook, rTo);
      }

      this.lo = (this.lo ^ ZC[this.castling][0]) >>> 0; this.hi = (this.hi ^ ZC[this.castling][1]) >>> 0;
      this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
      this.lo = (this.lo ^ ZC[this.castling][0]) >>> 0; this.hi = (this.hi ^ ZC[this.castling][1]) >>> 0;

      if (this.ep >= 0) { this.lo = (this.lo ^ ZE[this.ep & 7][0]) >>> 0; this.hi = (this.hi ^ ZE[this.ep & 7][1]) >>> 0; }
      this.ep = m & F_DOUBLE ? (from + to) >> 1 : -1;
      if (this.ep >= 0) { this.lo = (this.lo ^ ZE[this.ep & 7][0]) >>> 0; this.hi = (this.hi ^ ZE[this.ep & 7][1]) >>> 0; }

      this.half = captured || (piece & 7) === P ? 0 : this.half + 1;
      this.side = them;
      this.lo = (this.lo ^ ZSIDE[0]) >>> 0; this.hi = (this.hi ^ ZSIDE[1]) >>> 0;

      if (this.attacked(this.kings[us], them)) { this.unmake(); return false; }
      return true;
    }

    unmake() {
      const u = this.stack.pop();
      this.history.pop();
      const m = u.m, b = this.board;
      const from = mFrom(m), to = mTo(m);
      this.side ^= 24;
      const us = this.side;
      const piece = mPromo(m) ? (us | P) : b[to];
      b[from] = piece; b[to] = 0;
      if ((piece & 7) === K) this.kings[us] = from;
      if (u.captured) b[m & F_EP ? to + (us === WHITE ? -16 : 16) : to] = u.captured;
      if (m & F_CASTLE) {
        const [rFrom, rTo] = to > from ? [to + 1, to - 1] : [to - 2, to + 1];
        b[rFrom] = b[rTo]; b[rTo] = 0;
      }
      this.castling = u.castling; this.ep = u.ep; this.half = u.half; this.lo = u.lo; this.hi = u.hi;
    }

    // coup nul (on passe son tour) pour l'élagage null move
    makeNull() {
      this.stack.push({ m: 0, ep: this.ep, lo: this.lo, hi: this.hi, half: this.half, castling: this.castling, captured: 0 });
      this.history.push(this.lo);
      if (this.ep >= 0) { this.lo = (this.lo ^ ZE[this.ep & 7][0]) >>> 0; this.hi = (this.hi ^ ZE[this.ep & 7][1]) >>> 0; }
      this.ep = -1; this.side ^= 24;
      this.lo = (this.lo ^ ZSIDE[0]) >>> 0; this.hi = (this.hi ^ ZSIDE[1]) >>> 0;
    }
    unmakeNull() {
      const u = this.stack.pop(); this.history.pop();
      this.side ^= 24; this.ep = u.ep; this.lo = u.lo; this.hi = u.hi;
    }

    legalMoves() { return this.generate().filter(m => { const ok = this.make(m); if (ok) this.unmake(); return ok; }); }

    moveFromUci(uci) {
      return this.legalMoves().find(m => toUci(m) === uci) || 0;
    }

    isRepetition() {
      // même position déjà vue depuis le dernier coup irréversible (même camp au trait)
      const h = this.history;
      for (let i = h.length - 2, n = 0; i >= 0 && n < this.half; i -= 2, n += 2) if (h[i] === this.lo) return true;
      return false;
    }

    // évaluation statique, du point de vue du camp au trait
    evaluate() {
      const b = this.board;
      let mid = 0, end = 0, phase = 0;
      const bishops = { [WHITE]: 0, [BLACK]: 0 };
      for (let s = 0; s < 128; s++) {
        if (!onBoard(s)) { s += 7; continue; }
        const p = b[s];
        if (!p) continue;
        const t = p & 7, c = p & 24, sign = c === WHITE ? 1 : -1, i = pstIndex(s, c);
        phase += PHASE[t];
        if (t === B) bishops[c]++;
        if (t === K) { mid += sign * KING_MID[i]; end += sign * KING_END[i]; }
        else { const v = VALUE[t] + PST[t][i]; mid += sign * v; end += sign * v; }
      }
      if (bishops[WHITE] >= 2) { mid += 30; end += 50; }
      if (bishops[BLACK] >= 2) { mid -= 30; end -= 50; }
      phase = Math.min(phase, 24);
      const score = Math.round((mid * phase + end * (24 - phase)) / 24);
      return this.side === WHITE ? score : -score;
    }

    hasNonPawnMaterial(color) {
      for (let s = 0; s < 128; s++) {
        if (!onBoard(s)) { s += 7; continue; }
        const p = this.board[s];
        if (p && (p & 24) === color && (p & 7) !== P && (p & 7) !== K) return true;
      }
      return false;
    }
  }

  // ============================================================
  // recherche
  function perft(pos, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of pos.generate()) {
      if (!pos.make(m)) continue;
      n += perft(pos, depth - 1);
      pos.unmake();
    }
    return n;
  }

  const TT_SIZE = 1 << 20, TT_MASK = TT_SIZE - 1;
  const EXACT = 0, LOWER = 1, UPPER = 2;

  class Searcher {
    constructor() {
      this.tt = new Array(TT_SIZE);
      this.history = new Int32Array(24 * 128);
    }

    search(pos, { timeMs = 1000, maxDepth = 64, onDepth = null } = {}) {
      this.pos = pos;
      this.nodes = 0;
      this.stopAt = Date.now() + timeMs;
      this.stopped = false;
      this.killers = Array.from({ length: 128 }, () => [0, 0]);
      this.history.fill(0);
      const start = Date.now();
      let best = null;
      const legal = pos.legalMoves();
      if (!legal.length) return { best: null, score: pos.inCheck() ? -MATE : 0, depth: 0, nodes: 0, pv: [] };

      for (let depth = 1; depth <= maxDepth; depth++) {
        const score = this.negamax(depth, -INF, INF, 0, true);
        if (this.stopped && best) break; // profondeur inachevée : on garde la précédente
        const pv = this.principalVariation(depth);
        if (!pv.length) break;
        best = { best: pv[0], score, depth, nodes: this.nodes, ms: Date.now() - start, pv };
        if (onDepth) onDepth(best);
        if (Math.abs(score) > MATE - 200) break; // mat trouvé
        if (Date.now() > start + timeMs * 0.5) break; // la profondeur suivante ne finirait pas à temps
      }
      return best || { best: toUci(legal[0]), score: 0, depth: 0, nodes: this.nodes, pv: [toUci(legal[0])] };
    }

    principalVariation(depth) {
      const pos = this.pos, pv = [];
      for (let i = 0; i < depth; i++) {
        const e = this.tt[pos.lo & TT_MASK];
        if (!e || e.hi !== pos.hi || !e.move) break;
        const m = e.move;
        if (!pos.generate().includes(m) || !pos.make(m)) break;
        pv.push(toUci(m));
      }
      for (let i = 0; i < pv.length; i++) pos.unmake();
      return pv;
    }

    checkTime() {
      if ((this.nodes & 2047) === 0 && Date.now() > this.stopAt) this.stopped = true;
    }

    score(m, ttMove, ply) {
      if (m === ttMove) return 1e7;
      const b = this.pos.board;
      if (m & F_CAP) {
        const victim = m & F_EP ? P : b[mTo(m)] & 7;
        return 1e6 + VALUE[victim] * 10 - VALUE[b[mFrom(m)] & 7] / 10; // MVV-LVA
      }
      if (mPromo(m)) return 9e5 + VALUE[mPromo(m)];
      if (this.killers[ply][0] === m) return 8e5;
      if (this.killers[ply][1] === m) return 7e5;
      return this.history[b[mFrom(m)] * 128 + mTo(m)];
    }

    ordered(moves, ttMove, ply) {
      return moves.map(m => [m, this.score(m, ttMove, ply)]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    }

    negamax(depth, alpha, beta, ply, allowNull) {
      const pos = this.pos;
      this.nodes++;
      this.checkTime();
      if (this.stopped) return 0;
      if (ply > 0 && (pos.half >= 100 || pos.isRepetition())) return 0;

      const inCheck = pos.inCheck();
      if (inCheck) depth++; // extension d'échec
      if (depth <= 0) return this.quiesce(alpha, beta, ply);

      // table de transposition
      const alphaOrig = alpha;
      const e = this.tt[pos.lo & TT_MASK];
      let ttMove = 0;
      if (e && e.hi === pos.hi) {
        ttMove = e.move;
        if (ply > 0 && e.depth >= depth) {
          const s = fromTT(e.score, ply);
          if (e.flag === EXACT) return s;
          if (e.flag === LOWER && s >= beta) return s;
          if (e.flag === UPPER && s <= alpha) return s;
        }
      }

      // null move : si passer son tour suffit déjà à dépasser beta, la position est trop bonne
      if (allowNull && !inCheck && ply > 0 && depth >= 3 && pos.hasNonPawnMaterial(pos.side)) {
        pos.makeNull();
        const s = -this.negamax(depth - 3, -beta, -beta + 1, ply + 1, false);
        pos.unmakeNull();
        if (this.stopped) return 0;
        if (s >= beta) return beta;
      }

      let bestScore = -INF, bestMove = 0, legal = 0;
      for (const m of this.ordered(pos.generate(), ttMove, ply)) {
        if (!pos.make(m)) continue;
        legal++;
        const quiet = !(m & F_CAP) && !mPromo(m);
        let s;
        // réduction des coups tranquilles tardifs (LMR), avec recherche complète si le coup surprend
        if (legal > 4 && depth >= 3 && quiet && !inCheck && !pos.inCheck()) {
          s = -this.negamax(depth - 2, -alpha - 1, -alpha, ply + 1, true);
          if (s > alpha) s = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        } else {
          s = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        }
        pos.unmake();
        if (this.stopped) return 0;
        if (s > bestScore) { bestScore = s; bestMove = m; }
        if (s > alpha) alpha = s;
        if (alpha >= beta) {
          if (quiet) {
            const k = this.killers[ply];
            if (k[0] !== m) { k[1] = k[0]; k[0] = m; }
            this.history[pos.board[mFrom(m)] * 128 + mTo(m)] += depth * depth;
          }
          break;
        }
      }
      if (!legal) return inCheck ? -MATE + ply : 0; // mat ou pat

      const flag = bestScore <= alphaOrig ? UPPER : bestScore >= beta ? LOWER : EXACT;
      this.tt[pos.lo & TT_MASK] = { hi: pos.hi, depth, score: toTT(bestScore, ply), flag, move: bestMove };
      return bestScore;
    }

    // on continue tant qu'il y a des prises, pour ne pas évaluer une position en plein échange
    quiesce(alpha, beta, ply) {
      const pos = this.pos;
      this.nodes++;
      this.checkTime();
      if (this.stopped) return 0;
      const stand = pos.evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (ply > 100) return stand;
      for (const m of this.ordered(pos.generate(true), 0, Math.min(ply, 127))) {
        if (!pos.make(m)) continue;
        const s = -this.quiesce(-beta, -alpha, ply + 1);
        pos.unmake();
        if (this.stopped) return 0;
        if (s >= beta) return s;
        if (s > alpha) alpha = s;
      }
      return alpha;
    }
  }
  // les scores de mat dépendent de la distance à la racine : on les corrige en entrant/sortant de la table
  const toTT = (s, ply) => s > MATE - 1000 ? s + ply : s < -MATE + 1000 ? s - ply : s;
  const fromTT = (s, ply) => s > MATE - 1000 ? s - ply : s < -MATE + 1000 ? s + ply : s;

  return { Position, Searcher, perft, toUci, MATE };
})();

if (typeof module !== "undefined") module.exports = Engine;