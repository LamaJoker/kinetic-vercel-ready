"""Parcourt Kinetic dans le simulateur iPhone et capture chaque écran.

Usage : python3 tests/ios/drive.py <UDID> <dossier de sortie>

Aucun toucher ni lien : le script dépose un plan (kinetic-autotest.json) dans
le dossier Documents privé de l'application, qui charge la démonstration et
affiche chaque écran (voir apps/web/src/lib/autotest.ts). L'application écrit
l'étape en cours dans kinetic-autotest-step.json ; la capture suit chaque étape.
"""
import json
import re
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


def run_once(it):
    global problems
    docs = os.path.join(run("xcrun", "simctl", "get_app_container", UDID, BUNDLE, "data", check=True).strip(), "Documents")
    os.makedirs(docs, exist_ok=True)
    step_file = os.path.join(docs, "kinetic-autotest-step.json")
    ack_file = os.path.join(docs, "kinetic-autotest-ack.json")
    with open(os.path.join(docs, "kinetic-autotest.json"), "w") as fh:
        json.dump({"demo": True, "routes": ROUTES, "stepMs": 1500}, fh)

    t0 = time.time()
    run("xcrun", "simctl", "launch", UDID, BUNDLE, check=True)
    time.sleep(3)
    shot(f"{it}-00-demarrage-3s" if it else "00-demarrage-3s")

    seen = 0
    deadline = time.time() + 420
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
                try:
                    with open(os.path.join(docs, "kinetic-autotest-demo.json")) as fh:
                        print("chargement de la démo :", fh.read(), flush=True)
                except OSError:
                    print("chargement de la démo : pas de compte rendu", flush=True)
            print(f"étape {seen} {step['route']} : {json.dumps(step.get('diag'), ensure_ascii=False)}", flush=True)
            diag = step.get("diag") or {}
            storage = str(diag.get("storage", ""))
            if storage and not re.match(r"^\d+ clés, \d+ séances", storage):
                problems.append(f"stockage bloqué à l'étape {seen} ({step['route']}) : {storage[:300]}")
            # Reprise du stockage bloqué (sync.md § 4.11) : message affiché, rechargements subis.
            if diag.get("secours"):
                problems.append(f"message « stockage ne répond pas » affiché à l'étape {seen}")
            if diag.get("reloads"):
                print(f"  rechargements pendant le parcours : {diag['reloads']} (auto il y a {diag.get('rechargementAuto')} ms)", flush=True)
            if step["route"] == "fin":
                break
            time.sleep(0.8)
            name = step["route"].strip("/") or "accueil"
            shot(f"{it}-{seen:02d}-{name}" if it else f"{seen:02d}-{name}")
            with open(ack_file, "w") as fh:
                json.dump({"step": seen}, fh)
        time.sleep(0.3)
    else:
        problems.append(f"parcours incomplet : dernière étape {seen}/{len(ROUTES)}")

    alive = run("xcrun", "simctl", "spawn", UDID, "launchctl", "list")
    if BUNDLE not in alive:
        problems.append("l'application ne tourne plus à la fin du parcours (plantage ?)")

    print(f"parcours {it + 1} complet en {time.time() - t0:.0f} s", flush=True)


APP = sys.argv[3] if len(sys.argv) > 3 else None
REPEAT = int(os.environ.get("KINETIC_REPEAT", "1")) if APP else 1
for it in range(REPEAT):
    if it > 0:
        print(f"--- installation neuve n° {it + 1}", flush=True)
        run("xcrun", "simctl", "terminate", UDID, BUNDLE)
        run("xcrun", "simctl", "uninstall", UDID, BUNDLE, check=True)
        run("xcrun", "simctl", "install", UDID, APP, check=True)
    run_once(it)

print("PROBLÈMES:", json.dumps(problems, ensure_ascii=False), flush=True)
with open(f"{OUT}/problems.json", "w") as fh:
    json.dump(problems, fh, ensure_ascii=False, indent=2)
