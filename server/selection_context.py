"""Native topology evidence and read-only measurement candidates for the LLM.

Recognition by sampling is explicitly tolerance-based, never an analytic type claim.
"""
import math


def add(a, b): return tuple(x + y for x, y in zip(a, b))
def sub(a, b): return tuple(x - y for x, y in zip(a, b))
def mul(a, s): return tuple(x * s for x in a)
def dot(a, b): return sum(x * y for x, y in zip(a, b))
def cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def norm(a): return math.hypot(*a)
def unit(a): return mul(a, 1 / norm(a))


def circle_evidence(edge, tolerance):
    lo, hi = edge.parameter_range()
    samples = [tuple(edge.point_at(lo + (hi - lo) * i / 32)) for i in range(33)]
    a, b, c = samples[0], samples[11], samples[22]
    ab, ac = sub(b, a), sub(c, a)
    n = cross(ab, ac)
    if norm(n) < max(norm(ab) * norm(ac) * 1e-8, 1e-20):
        straight = norm(ab) > tolerance and max(norm(cross(sub(p, a), unit(ab))) for p in samples) <= tolerance
        return {"kind": "line" if straight else "general_curve"}
    center = add(a, mul(add(mul(cross(ac, n), dot(ab, ab)), mul(cross(n, ab), dot(ac, ac))), 1 / (2 * dot(n, n))))
    radius, normal = norm(sub(a, center)), unit(n)
    error = max(max(abs(norm(sub(p, center)) - radius), abs(dot(sub(p, center), normal))) for p in samples)
    if error > tolerance or radius <= tolerance:
        return {"kind": "general_curve", "circleFitResidualMm": error}
    return {"kind": "circular_within_tolerance", "centerMm": center, "axis": normal,
            "radiusMm": radius, "maxResidualMm": error, "toleranceMm": tolerance,
            "sampleCount": len(samples), "closedEdge": math.dist(samples[0], samples[-1]) <= tolerance}


def selection_context(bodies, topology, selected, properties, accuracy):
    import usd_brep as u
    candidates = {}

    def candidate(key, label, value, unit_name="", anchor=None, target=None, method="原生 B-Rep 查询", description=""):
        prop = {"id": key, "label": label, "value": value, "unit": unit_name, "method": method}
        if anchor is not None: prop["anchor"] = list(anchor)
        if target: prop["targetId"] = target
        candidates[key] = (prop, {"id": key, "label": label, "unit": unit_name, "targetId": target,
                                  "method": method, "description": description})

    for i, prop in enumerate(properties):
        key = f"base-{i}"
        prop["id"] = key
        candidates[key] = (prop, {"id": key, "label": prop["label"], "unit": prop["unit"], "method": "原生 B-Rep 查询 / 数值积分", "description": "当前选择的基础测量；保持原有量的定义和适用范围"})
    if not selected:
        return None, candidates

    identity = {item: key for key, (_, item, _) in topology.items()}
    body_tolerances = {}
    for i, body in enumerate(bodies):
        lo, hi = body.bounding_box()
        body_tolerances[i] = max(math.dist(lo, hi) * 1e-7, 1e-6)
    descriptions, curves = {}, {}

    def curve(edge, bi):
        key = identity[edge]
        if key not in curves:
            curves[key] = circle_evidence(edge, body_tolerances[bi])
        return curves[key]

    def describe(key):
        if key in descriptions: return descriptions[key]
        kind, item, bi = topology[key]
        info = {"id": key, "kind": kind, "bodyId": f"body-{bi}"}
        descriptions[key] = info
        if kind == "body":
            info.update({"solid": item.is_manifold_solid(), "faceCount": item.face_count(), "edgeCount": item.edge_count(), "boundsMm": item.bounding_box()})
        elif kind == "vertex":
            point = item.point()
            info.update({"pointMm": point, "edgeIds": [identity[e] for e in item.edges()], "faceIds": [identity[f] for f in item.faces()]})
            candidate(f"{key}:point", "顶点坐标 XYZ", list(point), "mm", point, key)
        elif kind == "edge":
            lo, hi = item.parameter_range()
            point = item.point_at((lo + hi) / 2)
            info.update({"lengthMm": item.length(), "curve": curve(item, bi), "faceIds": [identity[f] for f in item.faces()],
                         "vertexIds": [identity[v] for v in item.vertices()], "endpointsMm": [item.start_vertex().point(), item.end_vertex().point()]})
            candidate(f"{key}:length", "原生边长", item.length(), "mm", point, key)
            if info["curve"]["kind"] == "circular_within_tolerance":
                c = info["curve"]
                method = f"原生曲线圆形识别；{c['sampleCount']} 点验证，最大残差 {c['maxResidualMm']:.3g} mm，容差 {c['toleranceMm']:.3g} mm"
                candidate(f"{key}:diameter", "圆边直径（容差识别）", c["radiusMm"] * 2, "mm", point, key, method)
                candidate(f"{key}:radius", "圆边半径（容差识别）", c["radiusMm"], "mm", point, key, method)
                candidate(f"{key}:center", "圆边圆心 XYZ", list(c["centerMm"]), "mm", c["centerMm"], key, method)
        elif kind == "face":
            point = item.interior_point()
            _, uvs, _ = u.surface_closest_point(item.surface(), point)
            normal = item.outward_normal_at_uv(uvs[0].x, uvs[0].y) if uvs else None
            planar = item.surface().is_planar()
            loops = item.boundary_loops()
            info.update({"planar": planar, "areaMm2": item.area(accuracy), "areaCentroidMm": item.centroid(accuracy),
                         "interiorPointMm": point, "outwardNormalAtInterior": normal,
                         "boundaryLoops": [[{"edgeId": identity[e], "forward": forward} for e, forward in loop] for loop in loops],
                         "adjacentFaceIds": sorted({identity[f] for e in item.edges() for f in e.faces() if f != item})})
            candidate(f"{key}:area", "裁剪面面积", info["areaMm2"], "mm²", point, key)
            if planar:
                candidate(f"{key}:normal", "平面外向单位法线 XYZ", list(normal), "", point, key)
                candidate(f"{key}:inner_loops", "平面内边界环数", max(0, len(loops) - 1), "", point, key, description="内环不是必然的螺栓孔；用途需结合上下文")
            circular = [curve(edge, bi) for edge in item.edges() if curve(edge, bi)["kind"] == "circular_within_tolerance"]
            if not planar and circular:
                c = circular[0]
                axis, center, radius = c["axis"], c["centerMm"], c["radiusMm"]
                tol = body_tolerances[bi]
                aligned = all(abs(dot(axis, other["axis"])) > 1 - 1e-7 and abs(radius - other["radiusMm"]) <= tol and norm(cross(sub(other["centerMm"], center), axis)) <= tol for other in circular)
                if aligned:
                    (umin, vmin), (umax, vmax) = item.uv_domain()
                    samples, radial_errors, orientations = [], [], []
                    for ui in range(7):
                        for vi in range(5):
                            uv = (umin + (umax - umin) * (ui + .5) / 7, vmin + (vmax - vmin) * (vi + .5) / 5)
                            if item.classify_uv(*uv) not in ("inside", "boundary"): continue
                            p = tuple(item.point_at_uv(*uv))
                            radial = sub(sub(p, center), mul(axis, dot(sub(p, center), axis)))
                            r = norm(radial)
                            if r <= tol: continue
                            n = item.outward_normal_at_uv(*uv)
                            radial_errors.append(abs(r - radius))
                            orientations.append(dot(n, unit(radial)))
                            samples.append({"pointMm": p, "outwardNormal": n})
                    if len(samples) >= 10 and max(radial_errors) <= tol and all(abs(v) > 1 - 1e-6 for v in orientations) and (min(orientations) > 0 or max(orientations) < 0):
                        info["cylinderEvidence"] = {"kind": "cylindrical_within_tolerance", "radialOrientation": "inward" if max(orientations) < 0 else "outward",
                            "radiusMm": radius, "axisDirection": axis, "axisPointMm": center, "sampleCount": len(samples), "maxResidualMm": max(radial_errors), "toleranceMm": tol}
                        method = f"原生曲面圆柱识别；{len(samples)} 点径向及法向验证，最大径向残差 {max(radial_errors):.3g} mm，容差 {tol:.3g} mm"
                        candidate(f"{key}:diameter", "圆柱面直径（容差识别）", radius * 2, "mm", point, key, method, "只证明所选面在容差内为圆柱面；内向法线支持内凹孔壁推测，不证明孔用途或贯通性")
                        candidate(f"{key}:radius", "圆柱面半径（容差识别）", radius, "mm", point, key, method)
                        candidate(f"{key}:axis", "圆柱轴线方向 XYZ", list(axis), "", point, key, method)
                        stations = [dot(sub(other["centerMm"], center), axis) for other in circular]
                        # Only regular circular end boundaries plus axial straight seams support an axial-span measurement.
                        regular = all(curve(edge, bi)["kind"] == "circular_within_tolerance" or (curve(edge, bi)["kind"] == "line" and abs(dot(item_edge_direction(edge), axis)) > 1 - 1e-7) for edge in item.edges())
                        if regular and max(stations) - min(stations) > tol:
                            candidate(f"{key}:axial_span", "圆柱面轴向长度", max(stations) - min(stations), "mm", point, key, method,
                                      "所选圆柱面边界间的轴向范围，不是整孔深度、盲孔深度或板厚")
                    info["surfaceSamples"] = samples[:12]
        return info

    def item_edge_direction(edge):
        return unit(sub(edge.end_vertex().point(), edge.start_vertex().point()))

    selected_info = [describe(key) for key in selected[:16]]
    related_ids = set()
    for key in selected[:16]:
        kind, item, bi = topology[key]
        if kind == "face":
            related_ids.update(identity[e] for e in item.edges())
            related_ids.update(identity[f] for e in item.edges() for f in e.faces())
        elif kind in ("edge", "vertex"):
            related_ids.update(identity[f] for f in item.faces())
            if kind == "vertex": related_ids.update(identity[e] for e in item.edges())
        elif kind == "body":
            related_ids.update(identity[f] for f in item.faces())
        related_ids.add(f"body-{bi}")
    related_ids.difference_update(selected)
    related = [describe(key) for key in sorted(related_ids)[:40]]
    # Plane separation is explicit; it is never silently relabeled as material thickness.
    for selected_key in selected[:16]:
        info = descriptions[selected_key]
        if info["kind"] != "face" or not info["planar"]: continue
        _, face, bi = topology[selected_key]
        p, normal = info["interiorPointMm"], info["outwardNormalAtInterior"]
        distances = []
        for other in bodies[bi].faces():
            if other == face or not other.surface().is_planar(): continue
            q = other.interior_point()
            _, uv, _ = u.surface_closest_point(other.surface(), q)
            n = other.outward_normal_at_uv(uv[0].x, uv[0].y)
            if abs(dot(normal, n)) < 1 - 1e-8: continue
            distance = abs(dot(sub(q, p), normal))
            if distance > body_tolerances[bi]: distances.append((distance, identity[other], q))
        for distance, other_key, q in sorted(distances)[:4]:
            candidate(f"{selected_key}:plane_gap:{other_key}", "平行支撑平面间距", distance, "mm", p, selected_key,
                      description=f"相对于 {other_key} 的无限平面距离，不保证有限面重叠，不等于壁厚或最小间隙")
    context = {"selected": selected_info, "related": related, "selectedTotal": len(selected),
               "relatedTotal": len(related_ids), "truncated": len(selected) > 16 or len(related_ids) > 40,
               "recognitionMethod": "native topology plus tolerance-verified curve/surface samples; no functional intent is assumed"}
    return context, candidates
