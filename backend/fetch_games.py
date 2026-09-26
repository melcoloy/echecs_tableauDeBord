"""
Récupère toutes les parties d'un joueur Chess.com et les résume dans data/games.json.

Usage :
    python backend/fetch_games.py TON_PSEUDO

Source : API publique de Chess.com (pas de clé). Les mois passés ne changent plus :
ils sont mis en cache dans data/archives/ et ne sont téléchargés qu'une fois.
Seul le mois en cours est rechargé à chaque exécution.
Aucune dépendance externe : uniquement la bibliothèque standard.
"""
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "archives"
# Chess.com demande un User-Agent identifiable : mets ton adresse mail
USER_AGENT = "echecs-dashboard/1.0 (projet perso etudiant; contact: melcoloy@gmail.com)"

# Codes de fin de partie Chess.com -> (résultat pour ce joueur, façon dont la partie s'est terminée)
RESULTS = {
    "win": ("V", None),
    "checkmated": ("D", "mat"), "resigned": ("D", "abandon"), "timeout": ("D", "temps"),
    "abandoned": ("D", "abandon"), "lose": ("D", "autre"), "kingofthehill": ("D", "autre"),
    "threecheck": ("D", "autre"), "bughousepartnerlose": ("D", "autre"),
    "agreed": ("N", "accord"), "repetition": ("N", "répétition"), "stalemate": ("N", "pat"),
    "insufficient": ("N", "matériel insuffisant"), "50move": ("N", "règle des 50 coups"),
    "timevsinsufficient": ("N", "temps contre matériel insuffisant"),
}
# Quand on gagne, la façon dont la partie s'est terminée se lit dans le code de l'adversaire
WIN_HOW = {"checkmated": "mat", "resigned": "abandon", "timeout": "temps", "abandoned": "abandon"}


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise SystemExit(f"Joueur introuvable : vérifie le pseudo ({url})")
            if e.code == 429 and attempt < 2:  # trop de requêtes : on patiente
                time.sleep(10)
                continue
            raise
    return {}


def opening_name(game: dict) -> str:
    """Nom de l'ouverture, tiré de l'URL ECO (ex. .../openings/Sicilian-Defense-Najdorf-Variation-6.Be3)."""
    url = game.get("eco") or ""
    m = re.search(r"/openings/([^?#]+)", url)
    if not m:
        return "Inconnue"
    slug = re.split(r"-\d+\.", m.group(1))[0]  # retire la suite de coups en fin d'URL
    return slug.replace("-", " ").strip() or "Inconnue"


def move_count(pgn: str) -> int:
    """Nombre de coups complets joués, d'après la numérotation du PGN."""
    body = pgn.split("\n\n", 1)[-1]
    numbers = re.findall(r"(\d+)\.(?!\.)", body)
    return int(numbers[-1]) if numbers else 0


def summarize(game: dict, me: str) -> dict | None:
    white, black = game.get("white", {}), game.get("black", {})
    if white.get("username", "").lower() == me:
        mine, theirs, color = white, black, "blancs"
    elif black.get("username", "").lower() == me:
        mine, theirs, color = black, white, "noirs"
    else:
        return None
    result, how = RESULTS.get(mine.get("result", ""), ("?", "autre"))
    if result == "V":
        how = WIN_HOW.get(theirs.get("result", ""), "autre")
    accuracy = (game.get("accuracies") or {}).get("white" if color == "blancs" else "black")
    return {
        "date": datetime.datetime.fromtimestamp(game["end_time"], datetime.timezone.utc).isoformat(),
        "cadence": game.get("time_class", "?"),        # bullet, blitz, rapid, daily
        "controle": game.get("time_control", ""),       # ex. "180+2"
        "classee": bool(game.get("rated")),
        "variante": game.get("rules", "chess"),
        "couleur": color,
        "elo": mine.get("rating"),
        "adversaire": theirs.get("username"),
        "elo_adversaire": theirs.get("rating"),
        "resultat": result,                             # V, N, D
        "fin": how,
        "ouverture": opening_name(game),
        "coups": move_count(game.get("pgn", "")),
        "precision": accuracy,
        "url": game.get("url"),
    }


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage : python backend/fetch_games.py TON_PSEUDO")
    me = sys.argv[1].lower()
    CACHE.mkdir(parents=True, exist_ok=True)

    archives = get_json(f"https://api.chess.com/pub/player/{me}/games/archives").get("archives", [])
    if not archives:
        raise SystemExit("Aucune partie trouvée pour ce pseudo.")
    current = datetime.date.today().strftime("%Y/%m")

    games = []
    for i, url in enumerate(archives, 1):
        month = "/".join(url.rstrip("/").split("/")[-2:])      # "2024/05"
        cache_file = CACHE / f"{month.replace('/', '-')}.json"
        if cache_file.exists() and month != current:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
        else:
            print(f"  téléchargement {month} ({i}/{len(archives)})")
            data = get_json(url)
            cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            time.sleep(0.5)  # Chess.com demande des requêtes l'une après l'autre
        games.extend(filter(None, (summarize(g, me) for g in data.get("games", []))))

    games = [g for g in games if g["variante"] == "chess"]  # échecs classiques uniquement
    games.sort(key=lambda g: g["date"])
    out = {"joueur": me, "maj": datetime.date.today().isoformat(), "parties": games}
    (DATA / "games.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # petit résumé pour vérifier que tout est cohérent
    print(f"\n{len(games)} parties de {me} écrites dans data/games.json")
    if games:
        print(f"  du {games[0]['date'][:10]} au {games[-1]['date'][:10]}")
        for cad in ("bullet", "blitz", "rapid", "daily"):
            sub = [g for g in games if g["cadence"] == cad]
            if sub:
                v = sum(g["resultat"] == "V" for g in sub)
                n = sum(g["resultat"] == "N" for g in sub)
                print(f"  {cad:7s} {len(sub):5d} parties, {100 * v / len(sub):4.1f} % de victoires, "
                      f"{100 * n / len(sub):4.1f} % de nulles, Elo actuel {sub[-1]['elo']}")
        top = {}
        for g in games:
            top[g["ouverture"]] = top.get(g["ouverture"], 0) + 1
        print("  ouvertures les plus jouées :")
        for name, n in sorted(top.items(), key=lambda kv: -kv[1])[:5]:
            print(f"    {n:4d}  {name}")


if __name__ == "__main__":
    main()