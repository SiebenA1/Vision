import json
import urllib.request

cases = [
    ("box", "from build123d import *\nresult = Box(100, 20, 10)"),
    ("sphere", "from build123d import *\nresult = Sphere(30)"),
    ("cylinder", "from build123d import *\nresult = Cylinder(25, 80)"),
]
for name, script in cases:
    body = json.dumps({
        "script": script,
        "material": {"E": 210000, "nu": 0.3, "rho": 7850, "yieldStrength": 235},
        "supports": [{"face": "x-min", "enabled": True}],
        "loads": [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 100, "enabled": True}],
        "mesh_size": 2.0,
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
            print(name, data["elements"], data["maxDisplacement"], data["loadArea"])
    except urllib.error.HTTPError as error:
        print(name, "HTTP", error.code, error.read().decode()[:500])
    except Exception as error:
        print(name, "ERR", error)
