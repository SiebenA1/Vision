"""Read-only native topology query in the isolated CAD runtime; no user scripts."""
import json
import difflib
import math
import re
import runpy
from pathlib import Path
import sys

import usd_brep as u


def capability_index(catalog):
    """Installed primitives and composition hints, never an exclusive allowlist."""
    functions = {entry['name']: entry for entry in catalog if entry['kind'] == 'function' and entry['group'] == 'usd_brep'}
    basics = ('create_line_segment', 'create_regular_polygon', 'create_circle', 'create_curve_approx_points',
              'create_helix', 'curve_sweep', 'pipe_sweep', 'linear_sweep', 'boolean_difference', 'create_box', 'create_cylinder')
    signatures = [{'symbol': functions[name]['symbol'], 'signature': functions[name]['documentation'].split('\n\n', 1)[0]}
                  for name in basics if name in functions and functions[name]['documentation']]
    groups = {'profiles': ('line_segment', 'polygon', 'circle', 'arc', 'approx_points'),
              'sweeps': ('sweep', 'helix', 'loft', 'revolve'), 'booleans': ('boolean_',),
              'transforms': ('translate', 'rotate', 'transform', 'copy')}
    families = {group: [name for name in sorted(functions) if any(term in name for term in terms)][:12]
                for group, terms in groups.items()}
    return {'core_signatures': signatures, 'families': families, 'total_root_functions': len(functions),
            'complete_catalog': False,
            'meaning': 'Selected installed API, not the complete API or a capability limit. Query missing details with native_api.',
            'closed_profile_hint': ('Use the listed finite segments or polygon primitives to compose a closed profile; '
                                    'query installed documentation before choosing parameters or a sweep frame.')
                                    if any(name in functions for name in ('create_line_segment', 'create_regular_polygon')) else None}


def capabilities(request):
    native = runpy.run_path(str(Path(__file__).resolve().parents[2] / "server/usd_brep_worker.py"))["capabilities"]()
    # Re-exported functions appear in several public modules. Prefer the root
    # spelling callable as u.name, rather than charging for duplicate pages.
    unique = {}
    for entry in sorted(native["entries"], key=lambda entry: (entry["group"] != "usd_brep", entry["symbol"])):
        unique.setdefault((entry["kind"], entry["name"], entry["documentation"]), entry)
    catalog = list(unique.values())
    overview = capability_index(catalog)
    lookups = request.get("queries") or [request]
    document_limit = min(1600, 8500 // sum(item["limit"] for item in lookups))
    def lookup(item):
        tokens = set(re.split(r"[\s|,]+", item["query"].strip().lower()))
        frequencies = {token: sum(token in entry["symbol"].lower() for entry in catalog) for token in tokens}
        matches = [entry for entry in catalog if any(token in entry["symbol"].lower() for token in tokens)]
        def relevance(entry):
            # A specific term such as polygon should outrank a generic create.
            score = sum(1 / max(1, frequencies[token]) for token in tokens if token in entry["symbol"].lower())
            return (not ({entry["name"].lower(), entry["symbol"].lower()} & tokens), entry["kind"] != "function", -score, entry["symbol"])
        matches.sort(key=relevance)
        entries = []
        for entry in matches[item["offset"]:item["offset"] + item["limit"]]:
            document = entry["documentation"][:document_limit]
            entries.append({**entry, "signature": entry["documentation"].split("\n\n", 1)[0],
                "documentation": document, "documentation_truncated": len(document) < len(entry["documentation"])})
        value = {"query": item["query"], "entries": entries, "total_matches": len(matches), "offset": item["offset"]}
        if len(matches) > len(entries):
            value["matching_symbols"] = [entry["symbol"] for entry in matches if entry["kind"] == "function"][:24]
        if not matches:
            names = sorted({entry["name"] for entry in catalog if entry["kind"] == "function"})
            value["suggested_symbols"] = difflib.get_close_matches(item["query"].strip(), names, n=6, cutoff=.4)
        return value
    if request.get("queries"):
        return {"version": native["version"], 'capability_index': overview, "lookups": [lookup(item) for item in request["queries"]]}
    return {"version": native["version"], 'capability_index': overview, **lookup(request)}


def inspect(request):
    topology = {}
    for index, path in enumerate(request["source_breps"]):
        body = u.Brep.read_from_file(path)
        topology[f"body-{index}"] = ("body", body)
        for kind, items in (("face", body.faces()), ("edge", body.edges())):
            for ordinal, item in enumerate(items):
                topology[f"body-{index}/{kind}-{ordinal}"] = (kind, item)
    selection = request["selection"]
    if any(key not in topology for key in selection):
        raise ValueError("selection unavailable in native topology")
    candidates = []
    pick = request.get("pick")
    if pick:
        point, tolerance = tuple(pick["point"]), pick["tolerance_mm"]
        for key, (kind, item) in topology.items():
            if kind != pick["kind"]:
                continue
            low, high = item.bounding_box()
            if any(point[i] < low[i] - tolerance or point[i] > high[i] + tolerance for i in range(3)):
                continue
            if kind == "body":
                position, distance = u.brep_closest_point(item, point)
                position = (position.x, position.y, position.z)
            elif kind == "face":
                position, distance = item.closest_point(point)
            else:
                position, _, distance = item.closest_point(point)
            if math.isfinite(distance) and distance <= tolerance:
                candidates.append({"id": key, "distance_mm": float(distance), "point": list(position)})
        candidates.sort(key=lambda candidate: (candidate["distance_mm"], candidate["id"]))
        # Every in-tolerance candidate is retained in the count. Ambiguity never
        # silently resolves through face order or an arbitrary nearest-face tie.
        if len(candidates) == 1:
            selection = [candidates[0]["id"]]
    lines, metrics = [], []
    truncated = False
    for key in selection:
        kind, item = topology[key]
        if kind == 'body':
            low, high = item.bounding_box()
            solid = bool(item.is_manifold_solid())
            metrics.append({'id':key, 'kind':'solid' if solid else 'sheet', 'entity_kind':'body', 'manifold':solid,
                            'volume_mm3':float(item.volume(1e-5)) if solid else None,
                            'area_mm2':sum(float(face.area(1e-5)) for face in item.faces()),
                            'bbox_mm':{'min':list(low), 'max':list(high), 'size':[high[i]-low[i] for i in range(3)]},
                            'face_count':len(item.faces()), 'edge_count':len(item.edges())})
        elif kind == "face":
            metrics.append({"id": key, "area_mm2": float(item.area(1e-4))})
        elif kind == "edge":
            metrics.append({"id": key, "length_mm": float(item.length())})
        if request.get('metrics_only'):
            continue
        edges = [item] if kind == "edge" else item.edges()
        for edge in edges:
            if len(lines) >= 512:
                truncated = True
                break
            low, high = edge.parameter_range()
            lines.append([list(edge.point_at(low + (high - low) * i / 32)) for i in range(33)])
    return {"selection": selection, "candidates": candidates[:16], "candidate_count": len(candidates),
            "visual": {"lines": lines, "truncated": truncated}, "metrics": metrics,
            "method": "native-trimmed-boundary-closest-point/1"}


if __name__ == "__main__":
    if sys.stdin.readline().strip() != "start":
        raise SystemExit("controller handshake missing")
    request, response = map(Path, sys.argv[1:3])
    try:
        value = json.loads(request.read_text(encoding="utf-8"))
        result = capabilities(value) if value.get("operation") == "capabilities" else inspect(value)
    except Exception as error:
        result = {"error": str(error)}
    response.write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
