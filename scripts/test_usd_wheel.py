import json
import urllib.request

BASE = "http://127.0.0.1:8111"


def post(path, payload):
    request = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


script = open("server/examples/wheel_rim_usd.py", encoding="utf-8").read()
cad = post("/cad/execute", {"script": script, "density_kg_m3": 2700})
fea = post(
    "/fea/solve",
    {
        "stlBase64": cad["stlBase64"],
        "material": {"E": 68900, "nu": 0.33, "rho": 2700, "yieldStrength": 276},
        "supports": [{"face": "x-min", "enabled": True}],
        "loads": [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 1000, "enabled": True}],
        "mesh_size": 4.0,
    },
)
print(fea["nodes"], fea["elements"], fea["maxDisplacement"], fea["maxVonMises"], fea["loadArea"], fea.get("stlCleanup"))
