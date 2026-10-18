import json
import urllib.request

script = open("server/examples/wheel_rim.py", encoding="utf-8").read()
body = json.dumps({
    "script": script,
    "material": {"E": 68900, "nu": 0.33, "rho": 2700, "yieldStrength": 276},
    "supports": [{"face": "x-min", "enabled": True}],
    "loads": [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 1000, "enabled": True}],
    "mesh_size": 1.5,
}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8105/fea/solve",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=300) as response:
        data = json.loads(response.read())
        for key in ["nodes", "elements", "maxDisplacement", "maxVonMises", "safetyFactor", "loadArea"]:
            print(key, data.get(key))
except urllib.error.HTTPError as error:
    print(error.read().decode()[:2000])
