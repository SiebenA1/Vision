"""Structural checks for imported CAD metadata; checksums alone do not type it."""
import math
import re


def validate_cad(manifest):
    def number(value, positive=False):
        if type(value) not in (float, int) or not math.isfinite(value) or value < 0 or (positive and value == 0):
            raise ValueError("invalid native CAD metric")
    def bounds(value):
        if not isinstance(value, dict):
            raise ValueError("invalid CAD bounds")
        for key in ("min", "max", "size"):
            vector = value.get(key)
            if not isinstance(vector, list) or len(vector) != 3 or any(type(item) not in (float, int) or not math.isfinite(item) for item in vector):
                raise ValueError("invalid CAD bounds vector")
        if any(a > b for a, b in zip(value["min"], value["max"])) or any(item < 0 for item in value["size"]):
            raise ValueError("invalid CAD bounds ordering")
    if manifest.get("schema") != "vision.cad/3" or not isinstance(manifest.get("nativeSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", manifest["nativeSha256"]):
        raise ValueError("unsupported native CAD manifest")
    if not isinstance(manifest.get("parameters"), dict) or not isinstance(manifest.get("kernelVersion"), str):
        raise ValueError("native CAD parameters or version missing")
    for value in manifest["parameters"].values():
        if type(value) not in (str, float, int, bool) or (type(value) in (float, int) and not math.isfinite(value)):
            raise ValueError("unsupported script parameter")
    if not isinstance(manifest.get("settings"), dict):
        raise ValueError("CAD settings missing")
    for key in ("tolerance_mm", "angle_deg"):
        number(manifest["settings"].get(key), positive=True)
    metrics = manifest.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("CAD metrics missing")
    bounds(metrics.get("bbox_mm"))
    for key in ("volume_mm3", "area_mm2", "mass_kg"):
        number(metrics.get(key))
    bodies = manifest.get("bodies")
    if not isinstance(bodies, list) or not bodies or len(bodies) > 10000:
        raise ValueError("invalid native body list")
    for index, body in enumerate(bodies):
        if not isinstance(body, dict) or body.get("id") != f"body-{index}" or body.get("stlFile") != f"body-{index}.stl" or body.get("kind") not in ("solid", "sheet") or not isinstance(body.get("name"), str):
            raise ValueError("invalid native body metadata")
        bounds(body.get("bbox_mm"))
        for key in ("volume_mm3", "area_mm2", "mass_kg"):
            number(body.get(key))
        for kind, field, metric in (("face", "faces", "area_mm2"), ("edge", "edges", "length_mm")):
            items = body.get(field)
            if not isinstance(items, list):
                raise ValueError("invalid topology list")
            for ordinal, item in enumerate(items):
                if not isinstance(item, dict) or item.get("id") != f"body-{index}/{kind}-{ordinal}":
                    raise ValueError("invalid topology identity")
                number(item.get(metric))
                bounds(item.get("bbox_mm"))
