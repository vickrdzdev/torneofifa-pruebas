# Descarga a img/futbin/ las banderas, ligas y escudos de club de futbin que usa el walkout,
# para servirlas desde nuestro propio sitio: desde algunos celulares futbin (Cloudflare) las
# entrega en un formato que no se puede mostrar. Lo corre el workflow futbin-imgs.yml.
# Toma las ligas firmadas de market.json ("img": plantilla + firma por id).
import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

mk = json.load(open("market.json", encoding="utf-8"))
KINDS = {"nation": "nation", "leagueMono": "league", "club": "club"}  # tipo en market.json -> carpeta
jobs = []
for kind, folder in KINDS.items():
    im = mk["img"][kind]
    os.makedirs(f"img/futbin/{folder}", exist_ok=True)
    for i, sig in im["s"].items():
        jobs.append((im["tpl"].replace("{id}", i).replace("{s}", sig), f"img/futbin/{folder}/{i}.png"))

def get(job):
    url, path = job
    if os.path.exists(path):
        return "ya"
    req = urllib.request.Request(url, headers={"Accept": "image/png", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"})
    for _ in range(3):
        try:
            data = urllib.request.urlopen(req, timeout=30).read()
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                open(path, "wb").write(data)
                return "ok"
            return "no-png"
        except Exception as e:
            err = str(e)
    return "error " + err

with ThreadPoolExecutor(8) as ex:
    res = list(ex.map(get, jobs))
summary = {r: res.count(r) for r in set(res)}
print(len(jobs), "imágenes:", summary)
bad = [j[1] for j, r in zip(jobs, res) if r not in ("ok", "ya")]
if bad:
    print("sin descargar:", bad[:20])
sys.exit(0 if res.count("ok") + res.count("ya") > len(jobs) * 0.9 else 1)
