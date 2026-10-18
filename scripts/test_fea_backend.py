import json
import urllib.request

script = "from build123d import *\nresult = Box(100, 20, 10)"
body = json.dumps({
    "script": script,
    "material": {"E": 210000, "nu": 0.3, "rho": 7850, "yieldStrength": 235},
    "supports": [{"face": "x-min", "enabled": True}],
    "loads": [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 100, "enabled": True}],
    "mesh_size": 2.5,
}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8104/fea/solve",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.loads(response.read())
        for key in ["nodes", "elements", "maxVonMises", "maxDisplacement", "safetyFactor", "mass_kg"]:
            print(key, data.get(key))
        print("positions", len(data.get("positions", [])))
except urllib.error.HTTPError as error:
    print(error.read().decode())


