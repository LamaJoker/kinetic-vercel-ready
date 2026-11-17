"""Parcourt Kinetic dans le simulateur iPhone et capture chaque écran.

Usage : python3 tests/ios/drive.py <UDID> <dossier de sortie>

Aucun toucher ni lien : le script dépose un plan (kinetic-autotest.json) dans
le dossier Documents privé de l'application, qui charge la démonstration et
affiche chaque écran (voir apps/web/src/lib/autotest.ts). L'application écrit
l'étape en cours dans kinetic-autotest-step.json ; la capture suit chaque étape.
"""
import json
import os
import subprocess
import sys
import time

UDID, OUT = sys.argv[1], sys.argv[2]
BUNDLE = "com.lamajoker.kinetic"
ROUTES = [
    "/", "/seances", "/vitalite", "/nutrition", "/profile", "/progression", "/records",
    "/bodyweight", "/mensurations", "/achievements", "/programs", "/plates", "/program",
]
problems = []


def run(*args, check=False):
    proc = subprocess.run(list(args), capture_output=True, text=True)
    if proc.returncode != 0:
        msg = f"{' '.join(args[:4])} : {proc.stderr.strip()[:200]}"
        if check:
            raise RuntimeError(msg)
        problems.append(msg)
    return proc.stdout


def shot(name):
    path = f"{OUT}/{name}.png"
    run("xcrun", "simctl", "io", UDID, "screenshot", path)
    print("capture", path, flush=True)


docs = os.path.join(run("xcrun", "simctl", "get_app_container", UDID, BUNDLE, "data", check=True).strip(), "Documents")
os.makedirs(docs, exist_ok=True)
step_file = os.path.join(docs, "kinetic-autotest-step.json")
with open(os.path.join(docs, "kinetic-autotest.json"), "w") as fh:
    json.dump({"demo": True, "routes": ROUTES, "stepMs": 3000}, fh)

t0 = time.time()
run("xcrun", "simctl", "launch", UDID, BUNDLE, check=True)
time.sleep(3)
shot("00-demarrage-3s")

seen = 0
deadline = time.time() + 240
while time.time() < deadline:
    try:
        with open(step_file) as fh:
            step = json.load(fh)
    except (OSError, ValueError):
        step = None
    if step and step["step"] != seen:
        seen = step["step"]
        if seen == 1:
            print(f"premier écran de démo affiché après {time.time() - t0:.1f} s", flush=True)
        if step["route"] == "fin":
            break
        time.sleep(0.8)
        name = step["route"].strip("/") or "accueil"
        shot(f"{seen:02d}-{name}")
    time.sleep(0.3)
else:
    problems.append(f"parcours incomplet : dernière étape {seen}/{len(ROUTES)}")

alive = run("xcrun", "simctl", "spawn", UDID, "launchctl", "list")
if BUNDLE not in alive:
    problems.append("l'application ne tourne plus à la fin du parcours (plantage ?)")

print("PROBLÈMES:", json.dumps(problems, ensure_ascii=False), flush=True)
with open(f"{OUT}/problems.json", "w") as fh:
    json.dump(problems, fh, ensure_ascii=False, indent=2)
