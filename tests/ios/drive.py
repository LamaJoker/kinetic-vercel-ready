"""Parcourt Kinetic dans le simulateur iPhone et capture chaque écran.

Usage : python3 tests/ios/drive.py <UDID> <dossier de sortie>
Aucun outil de toucher : la navigation passe par les liens internes
com.lamajoker.kinetic://open/<page>, et open/demo charge la démonstration
(installation neuve uniquement). Chaque étape est journalisée, sans arrêt
à la première erreur.
"""
import json
import subprocess
import sys
import time

UDID, OUT = sys.argv[1], sys.argv[2]
BUNDLE = "com.lamajoker.kinetic"
PAGES = [
    "seances", "vitalite", "nutrition", "profile", "progression", "records",
    "bodyweight", "mensurations", "achievements", "programs", "plates", "program",
]
shot_index = 0
problems = []


def run(*args, check=False):
    proc = subprocess.run(list(args), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} -> {proc.stderr.strip()[:300]}")
    if proc.returncode != 0:
        problems.append(f"{' '.join(args[:4])} : {proc.stderr.strip()[:200]}")
    return proc.stdout


def shot(name):
    global shot_index
    shot_index += 1
    path = f"{OUT}/{shot_index:02d}-{name}.png"
    run("xcrun", "simctl", "io", UDID, "screenshot", path)
    print("capture", path, flush=True)


def open_page(page, wait=2.5):
    run("xcrun", "simctl", "openurl", UDID, f"{BUNDLE}://open/{page}")
    time.sleep(wait)


t0 = time.time()
out = run("xcrun", "simctl", "launch", UDID, BUNDLE, check=True)
print(f"lancement : {out.strip()} en {time.time() - t0:.1f} s", flush=True)
time.sleep(5)
shot("onboarding")

open_page("demo", wait=6)
shot("accueil")
for page in PAGES:
    open_page(page)
    shot(page)
open_page("vitalite", wait=1)
open_page("", wait=2)
shot("retour-accueil")

alive = run("xcrun", "simctl", "spawn", UDID, "launchctl", "list")
if BUNDLE not in alive:
    problems.append("l'application ne tourne plus à la fin du parcours (plantage ?)")

print("PROBLÈMES:", json.dumps(problems, ensure_ascii=False), flush=True)
with open(f"{OUT}/problems.json", "w") as fh:
    json.dump(problems, fh, ensure_ascii=False, indent=2)
