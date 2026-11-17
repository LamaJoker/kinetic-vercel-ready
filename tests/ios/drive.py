"""Pilote Kinetic dans le simulateur iPhone (idb) : captures de chaque écran.

Usage : python3 tests/ios/drive.py <UDID> <dossier de sortie>
Ne s'arrête pas à la première erreur : chaque étape est journalisée.
"""
import json
import subprocess
import sys
import time

UDID, OUT = sys.argv[1], sys.argv[2]
BUNDLE = "com.lamajoker.kinetic"
shot_index = 0
problems = []


def run(*args, check=False):
    proc = subprocess.run(list(args), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} -> {proc.stderr.strip()[:300]}")
    return proc.stdout


def shot(name):
    global shot_index
    shot_index += 1
    path = f"{OUT}/{shot_index:02d}-{name}.png"
    run("xcrun", "simctl", "io", UDID, "screenshot", path)
    print("capture", path, flush=True)


def elements():
    raw = run("idb", "ui", "describe-all", "--udid", UDID, "--json")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = [json.loads(line) for line in raw.splitlines() if line.strip().startswith("{")]
    return data if isinstance(data, list) else [data]


def find(label, prefer_bottom=False):
    matches = [
        e for e in elements()
        if (e.get("AXLabel") or "").strip() == label and e.get("frame")
    ]
    if not matches:
        return None
    matches.sort(key=lambda e: e["frame"]["y"])
    return matches[-1] if prefer_bottom else matches[0]


def tap(label, prefer_bottom=False, wait=1.6):
    for _ in range(10):
        el = find(label, prefer_bottom)
        if el:
            f = el["frame"]
            x, y = f["x"] + f["width"] / 2, f["y"] + f["height"] / 2
            run("idb", "ui", "tap", str(round(x)), str(round(y)), "--udid", UDID)
            time.sleep(wait)
            return True
        time.sleep(1)
    problems.append(f"élément introuvable : « {label} »")
    print("INTROUVABLE", label, flush=True)
    return False


def open_page(page, wait=2.0):
    run("xcrun", "simctl", "openurl", UDID, f"{BUNDLE}://open/{page}")
    time.sleep(wait)


def scroll_down():
    run("idb", "ui", "swipe", "200", "700", "200", "250", "--udid", UDID, "--duration", "0.3")
    time.sleep(1.2)


t0 = time.time()
run("xcrun", "simctl", "launch", UDID, BUNDLE, check=True)
# Attendre le premier écran (bouton de l'onboarding) pour mesurer le démarrage à froid.
for _ in range(40):
    if find("Voir la démo"):
        break
    time.sleep(0.5)
print(f"démarrage à froid : {time.time() - t0:.1f} s jusqu'à l'onboarding", flush=True)
shot("onboarding")

if tap("Voir la démo", wait=4):
    shot("accueil")
    scroll_down()
    shot("accueil-bas")
    for tab, name in [("Séances", "seances"), ("Corps", "corps"), ("Récup", "recup"), ("Profil", "profil")]:
        if tap(tab, prefer_bottom=True, wait=2):
            shot(name)
    scroll_down()
    shot("profil-suite")
    scroll_down()
    shot("profil-fin")
    for page in ["progression", "records", "nutrition", "mensurations", "plates"]:
        open_page(page)
        shot(page)
    tap("Accueil", prefer_bottom=True)
    if tap("Commencer la séance", wait=2.5):
        shot("seance-en-cours")

alive = run("xcrun", "simctl", "spawn", UDID, "launchctl", "list")
if BUNDLE not in alive:
    problems.append("l'application ne tourne plus à la fin du parcours (plantage ?)")

print("PROBLÈMES:", json.dumps(problems, ensure_ascii=False), flush=True)
with open(f"{OUT}/problems.json", "w") as fh:
    json.dump(problems, fh, ensure_ascii=False, indent=2)
