"""
Construit les arbres d'ouvertures de l'entraîneur à partir de l'explorateur Lichess.

Usage :
    python backend/build_openings.py            # toutes les ouvertures de backend/openings.json
    python backend/build_openings.py francaise  # une seule (par son id)

Principe, pour chaque position :
  - à toi de jouer : on retient LE coup le plus joué par les joueurs 1800-2200 (le coup à apprendre) ;
  - à l'adversaire : on garde ses réponses les plus fréquentes à ton niveau (1000-1600).

L'explorateur Lichess demande un jeton : crée-le sur https://lichess.org/account/oauth/token
(aucune permission à cocher) et mets-le dans un fichier .env à la racine : LICHESS_TOKEN=lip_xxx
Les réponses sont mises en cache dans data/explorer_cache/ : relancer le script est quasi instantané.
Aucune dépendance externe : uniquement la bibliothèque standard.
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "backend" / "openings.json"
OUT = ROOT / "data" / "openings"
CACHE = ROOT / "data" / "explorer_cache"
EXPLORER = "https://explorer.lichess.ovh/lichess"
USER_AGENT = "echecs-entraineur/1.0 (projet perso etudiant)"

STRONG = "1800,2000,2200"          # niveau de référence pour TES coups
OPPONENTS = "1000,1200,1400,1600"  # niveau de tes adversaires réels
SPEEDS = "blitz,rapid"
USER_MOVES = 6        # nombre de tes coups à apprendre après le début imposé
MIN_GAMES = 30        # en dessous, la position est trop rare pour être utile
MIN_SHARE = 0.08      # une réponse adverse doit représenter au moins 8 % des parties
REPLIES = [3, 2, 2, 2, 1, 1]  # nombre max de réponses adverses gardées selon la profondeur

requests_done = 0


def token() -> str | None:
    if os.getenv("LICHESS_TOKEN"):
        return os.getenv("LICHESS_TOKEN")
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("LICHESS_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"')
    return None


def explore(play: list[str], ratings: str) -> dict:
    global requests_done
    key = hashlib.sha1(f"{','.join(play)}|{ratings}|{SPEEDS}".encode()).hexdigest()
    cached = CACHE / f"{key}.json"
    if cached.exists():
        return json.loads(cached.read_text(encoding="utf-8"))

    params = urllib.parse.urlencode({
        "variant": "standard", "speeds": SPEEDS, "ratings": ratings,
        "play": ",".join(play), "moves": 12, "topGames": 0, "recentGames": 0,
    })
    headers = {"User-Agent": USER_AGENT}
    tok = token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(f"{EXPLORER}?{params}", headers=headers)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise SystemExit("Jeton Lichess refusé : vérifie LICHESS_TOKEN dans .env")
            if e.code == 429 and attempt < 5:
                msg = "" if tok else " (pas de jeton : ajoute LICHESS_TOKEN dans .env)"
                print(f"    limite de requêtes atteinte{msg}, pause d'une minute…")
                time.sleep(60)
                continue
            raise
    requests_done += 1
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(data), encoding="utf-8")
    time.sleep(1)  # politesse envers le serveur Lichess
    return data


def total(m: dict) -> int:
    return m["white"] + m["draws"] + m["black"]


def node(m: dict, white_moved: bool, share: float | None = None) -> dict:
    n = total(m)
    wins = m["white"] if white_moved else m["black"]
    out = {"san": m["san"], "uci": m["uci"], "n": n, "score": round((wins + m["draws"] / 2) / n, 3)}
    if share is not None:
        out["part"] = round(share, 3)
    return out


def build(play: list[str], color: str, user_left: int, depth: int) -> list[dict]:
    white_to_move = len(play) % 2 == 0
    user_turn = (color == "blancs") == white_to_move

    if user_turn:
        if user_left == 0:
            return []
        moves = [m for m in explore(play, STRONG)["moves"] if total(m) >= MIN_GAMES]
        if not moves:
            return []
        best = max(moves, key=total)  # le coup le plus joué à bon niveau
        child = node(best, white_to_move)
        child["enfants"] = build(play + [best["uci"]], color, user_left - 1, depth)
        return [child]

    moves = explore(play, OPPONENTS)["moves"]
    tot = sum(total(m) for m in moves)
    if tot < MIN_GAMES:
        return []
    keep = REPLIES[min(depth, len(REPLIES) - 1)]
    children = []
    for m in moves:  # déjà triés du plus joué au moins joué
        share = total(m) / tot
        if share < MIN_SHARE or len(children) == keep:
            break
        child = node(m, white_to_move, share)
        child["enfants"] = build(play + [m["uci"]], color, user_left, depth + 1)
        children.append(child)
    return children


def count_lines(children: list[dict]) -> int:
    return sum(count_lines(c["enfants"]) if c["enfants"] else 1 for c in children)


def main() -> None:
    openings = json.loads(CONFIG.read_text(encoding="utf-8"))
    wanted = set(sys.argv[1:])
    if not token():
        print("Attention : pas de LICHESS_TOKEN dans .env, l'explorateur risque de refuser les requêtes.\n")
    OUT.mkdir(parents=True, exist_ok=True)

    index = []
    for op in openings:
        out_file = OUT / f"{op['id']}.json"
        if wanted and op["id"] not in wanted:
            if out_file.exists():
                index.append(json.loads(out_file.read_text(encoding="utf-8"))["resume"])
            continue
        print(f"{op['nom']} ({op['couleur']})…")
        root_info = explore(op["debut"], OPPONENTS).get("opening") or {}
        tree = build(op["debut"], op["couleur"], USER_MOVES, 0)
        resume = {"id": op["id"], "nom": op["nom"], "couleur": op["couleur"],
                  "eco": root_info.get("eco", ""), "lignes": count_lines(tree)}
        out_file.write_text(json.dumps({"resume": resume, "debut": op["debut"], "arbre": tree},
                                       ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index.append(resume)
        print(f"  {resume['lignes']} lignes")

    (OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nTerminé : {len(index)} ouvertures, {requests_done} requêtes à l'explorateur.")


if __name__ == "__main__":
    main()