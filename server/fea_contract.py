"""Validate the currently supported single-load static study before native work."""
import math

FACES = {"x-min", "x-max", "y-min", "y-max", "z-min", "z-max"}


def _number(value, name, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    if positive and value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def validate_study(material, supports, loads, mesh_size):
    if not isinstance(material, dict):
        raise ValueError("material must be an object")
    for key in ("E", "rho", "yieldStrength"):
        _number(material.get(key), key, positive=True)
    nu = _number(material.get("nu"), "nu")
    if not -1 < nu < 0.5:
        raise ValueError("nu must be between -1 and 0.5")
    _number(mesh_size, "mesh_size", positive=True)
    selected = []
    for name, items in (("supports", supports), ("loads", loads)):
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise ValueError(f"{name} must be an array of objects")
        if any(not isinstance(item.get("enabled", True), bool) for item in items):
            raise ValueError(f"{name}.enabled must be boolean")
        active = [item for item in items if item.get("enabled", True)]
        if not active:
            raise ValueError(f"at least one enabled {name} entry is required")
        if len(active) > 64:
            raise ValueError(f"at most 64 enabled {name} entries are supported")
        for item in active:
            region = item.get("region")
            if region is None:
                if item.get("face") not in FACES:
                    raise ValueError(f"invalid {name} face")
            else:
                validate_region(region)
        selected.append(active)
    active_supports, active_loads = selected
    for support in active_supports:
        if support.get("type", "fixed") != "fixed":
            raise ValueError("only fixed supports are supported")
    for load in active_loads:
        vector = load.get("vector")
        if not isinstance(vector, list) or len(vector) != 3:
            raise ValueError("load vector must have three components")
        for value in vector:
            _number(value, "vector component")
        if math.hypot(*vector) == 0:
            raise ValueError("load vector must be nonzero")
        _number(load.get("magnitude"), "load magnitude", positive=True)
    return active_supports, active_loads


def validate_region(region):
    if not isinstance(region, dict) or region.get("type") not in {"box", "sphere", "cad-face"}:
        raise ValueError("region must be a box, sphere or native CAD face")
    if region["type"] == "cad-face":
        import re
        if not re.fullmatch(r"[a-f0-9]{64}", str(region.get("artifactId", ""))):
            raise ValueError("native face requires an artifact id")
        if not isinstance(region.get("faceIds"), list) or not region["faceIds"] or any(not re.fullmatch(r"body-[0-9]+/face-[0-9]+", str(identity)) for identity in region["faceIds"]):
            raise ValueError("native face requires valid face ids")
        _number(region.get("toleranceMm"), "face tolerance", positive=True)
        return
    keys = ("min", "max") if region["type"] == "box" else ("center",)
    for key in keys:
        vector = region.get(key)
        if not isinstance(vector, list) or len(vector) != 3:
            raise ValueError(f"region.{key} must have three components")
        for value in vector:
            _number(value, f"region.{key}")
    if region["type"] == "box":
        if any(a > b for a, b in zip(region["min"], region["max"])):
            raise ValueError("region min must not exceed max")
    else:
        _number(region.get("radius"), "region.radius", positive=True)

