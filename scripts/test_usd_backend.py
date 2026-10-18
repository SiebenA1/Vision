import json
import urllib.request

BASE = "http://127.0.0.1:8109"


def post(path, payload=None):
    data = json.dumps(payload or {}).encode() if payload is not None else b""
    request = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


cad = post("/cad/execute", {
    "script": "import usd_brep as u\nresult = u.create_box((-50, -10, -5), 100, 20, 10)\n",
    "density_kg_m3": 7850,
})
print("CAD", cad["schema"], cad["metrics"]["volume_mm3"], cad["metrics"]["triangles"], cad["stlBytes"])
fea = post("/fea/solve", {
    "stlBase64": cad["stlBase64"],
    "material": {"E": 210000, "nu": 0.3, "rho": 7850, "yieldStrength": 235},
    "supports": [{"face": "x-min", "enabled": True}],
    "loads": [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 100, "enabled": True}],
    "mesh_size": 2.0,
})
print("FEA", fea["nodes"], fea["elements"], fea["maxDisplacement"], fea["maxVonMises"])
validation = post("/fea/validate")
print("VALIDATION", validation["computed"], validation["errorPercent"], validation["passed"])


