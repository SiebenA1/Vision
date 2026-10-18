import json
import urllib.request

script = open("server/examples/wheel_rim.py", encoding="utf-8").read()
body = json.dumps({"script": script, "density_kg_m3": 2700}).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:8101/cad/execute",
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.loads(response.read())
        print(json.dumps(data.get("metrics"), indent=2, ensure_ascii=False))
        print("stlBytes", data.get("stlBytes"))
except urllib.error.HTTPError as error:
    print(error.read().decode("utf-8"))
