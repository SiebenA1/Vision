"""Read-only, topology-driven measurements of the saved native BReps (mm)."""
import math

import usd_brep as u


def vector(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value
    ):
        raise ValueError(f"{name} must contain three finite numbers")
    return tuple(value)


def inspect(request):
    bodies = ([u.Brep.read_from_file(path) for path in request["source_breps"]]
              if request.get("source_breps") else u.usd.import_breps(request["source_usd"]))
    density = request.get("density_kg_m3", 2700)
    accuracy = request.get("relative_accuracy", 1e-4)
    if isinstance(density, bool) or not isinstance(density, (int, float)) or not math.isfinite(density) or not 1 <= density <= 1e9:
        raise ValueError("density must be finite in [1, 1e9] kg/m³")
    if isinstance(accuracy, bool) or not isinstance(accuracy, (int, float)) or not math.isfinite(accuracy) or not 1e-4 <= accuracy <= .1:
        raise ValueError("relative accuracy must be in [1e-4, 0.1]")
    topology = {}
    catalog = []
    for index, body in enumerate(bodies):
        identity = f"body-{index}"
        topology[identity] = ("body", body, index)
        catalog.append({"id": identity, "kind": "body", "label": request["names"][index]})
        for kind, items in (("face", body.faces()), ("edge", body.edges()), ("vertex", body.vertices())):
            for j, item in enumerate(items):
                key = f"{identity}/{kind}-{j}"
                topology[key] = (kind, item, index)
                catalog.append({"id": key, "kind": kind, "label": f"{request['names'][index]} / {kind} {j + 1}"})

    selected = request.get("selection", [])
    if not isinstance(selected, list) or len(selected) > 100 or any(not isinstance(key, str) or key not in topology for key in selected) or len(set(selected)) != len(selected):
        raise ValueError("select up to 100 unique objects from the current geometry")
    sample_point = None
    pick = request.get("pick")
    if pick is not None:
        point = vector(pick.get("point"), "pick point")
        tolerance = pick.get("tolerance_mm")
        if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or not math.isfinite(tolerance) or not 1e-7 <= tolerance <= 1e5:
            raise ValueError("invalid pick tolerance")
        kind = pick.get("kind")
        if kind not in ("body", "face", "edge", "vertex"):
            raise ValueError("invalid pick mode")
        hits = []
        for key, (candidate_kind, item, _) in topology.items():
            if candidate_kind != kind:
                continue
            if kind == "vertex":
                position = item.point()
                distance = math.dist(position, point)
            elif kind == "body":
                position, distance = u.brep_closest_point(item, point)
                # brep_closest_point returns the binding's Vec3, unlike the
                # tuple coordinates returned by face/edge closest_point.
                position = (position.x, position.y, position.z)
            elif kind == "face":
                position, distance = item.closest_point(point)
            else:
                position, _, distance = item.closest_point(point)
            if distance <= tolerance:
                hits.append((distance, key, tuple(position)))
        if not hits:
            raise ValueError("此处未找到该类型的原生几何，请靠近边或顶点点击，或从对象列表选择")
        _, key, sample_point = min(hits)
        selected = list(dict.fromkeys([*selected, key])) if pick.get("append") else [key]
        if len(selected) > 100:
            raise ValueError("最多选择 100 个对象")

    properties, notes, lines, points = [], [], [], []

    def prop(label, value, unit="", anchor=None, dimension=None, panel_only=False):
        entry = {"label": label, "value": value, "unit": unit}
        if anchor is not None:
            entry["anchor"] = list(anchor)
        if dimension is not None:
            entry["dimension"] = {"start": list(dimension[0]), "end": list(dimension[1]), "offset": len(dimension) > 2 and dimension[2]}
        if panel_only:
            entry["panelOnly"] = True
        properties.append(entry)
        return entry

    def outline(edge):
        # Display samples only; measurements always use the native edge.
        low, high = edge.parameter_range()
        lines.append([list(edge.point_at(low + (high - low) * i / 64)) for i in range(65)])

    def mass(items):
        solids = [item for item in items if item.is_manifold_solid()]
        if len(solids) != len(items):
            notes.append("曲面体没有实体体积和质量；实体质量仅统计闭合实体，未假设壳厚度。")
        if not solids:
            return
        results = [body.mass_properties(accuracy, density * 1e-9) for body in solids]
        total = sum(result["mass"] for result in results)
        center = [sum(r["mass"] * r["centroid"][i] for r in results) / total for i in range(3)]
        inertia = [0., 0., 0.]
        products = [0., 0., 0.]
        for r in results:
            offset = [r["centroid"][i] - center[i] for i in range(3)]
            for i in range(3):
                inertia[i] += r["moments_of_inertia"][i] + r["mass"] * sum(offset[j] ** 2 for j in range(3) if j != i)
            for i, (a, b) in enumerate(((1, 2), (2, 0), (0, 1))):
                products[i] += r["products_of_inertia"][i] + r["mass"] * offset[a] * offset[b]
        prop("实体体积", sum(r["volume"] for r in results), "mm³", anchor=center)
        prop("质量", total, "kg")
        prop("质量中心 XYZ", center, "mm")
        prop("质心惯性矩 Ixx / Iyy / Izz", inertia, "kg·mm²")
        prop("质心惯性积 ∫yz / ∫zx / ∫xy", products, "kg·mm²")
        notes.append("质量按当前材料均匀密度计算；惯性轴平行于世界坐标轴，惯性张量非对角元取惯性积的负值。")
        if len(items) > 1:
            notes.append("多个实体按独立部件累加，重叠体积会重复计入；需要合并材料时请先进行布尔并集。")

    objects = [topology[key] for key in selected]
    kinds = {kind for kind, _, _ in objects}
    section = request.get("section")
    prop("测量范围", "截面与保留区域" if section is not None else "整个模型" if not selected else f"所选对象（{len(selected)} 个）")
    if not selected or kinds == {"body"}:
        typed_items = [item for _, item, _ in objects] if objects else bodies
        body_types = list(dict.fromkeys("闭合实体" if item.is_manifold_solid() else "曲面体" if item.faces() else "线框体" if item.edges() else "点集" if item.vertices() else "空体" for item in typed_items))
        prop("对象类型", "、".join(body_types) + ("（混合）" if len(body_types) > 1 else ""))
    else:
        names = {"face": "面", "edge": "边", "vertex": "顶点"}
        prop("对象类型", "、".join(names.get(kind, "体") for kind in sorted(kinds)))
    if section is not None:
        if selected and kinds != {"body"}:
            raise ValueError("截面和局部质量查询需要选择实体，或选择整个模型")
        plane = vector(section.get("point"), "section point")
        normal = vector(section.get("normal"), "section normal")
        norm = math.hypot(*normal)
        if norm < 1e-12:
            raise ValueError("切割平面法向不能为零")
        normal = tuple(v / norm for v in normal)
        source = [item for _, item, _ in objects] if objects else bodies
        if any(not body.is_manifold_solid() for body in source):
            raise ValueError("局部体积与质量仅支持闭合实体，请从体列表选择实体")
        kept, cap_area, cap_centers = [], 0., []
        for body in source:
            curves = u.intersect_brep_with_plane(body, plane, normal)
            if not curves:
                signs = [sum((face.interior_point()[i] - plane[i]) * normal[i] for i in range(3)) for face in body.faces()]
                if min(signs) >= -1e-8:
                    kept.append(body)
                elif max(signs) > 1e-8:
                    raise ValueError("切割平面未产生截线且部件跨越两侧，无法可靠识别保留区域")
                continue
            # The installed kernel's cut() leaves an uncapped shell. Intersect a
            # closed half-space box covering the body's bounds instead.
            lo, hi = body.bounding_box()
            radius = max(math.dist(plane, (x, y, z)) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])) * 2 + 1
            ref = (1, 0, 0) if abs(normal[0]) < .9 else (0, 1, 0)
            x_axis = (ref[1]*normal[2]-ref[2]*normal[1], ref[2]*normal[0]-ref[0]*normal[2], ref[0]*normal[1]-ref[1]*normal[0])
            length = math.hypot(*x_axis)
            x_axis = tuple(v / length for v in x_axis)
            y_axis = (normal[1]*x_axis[2]-normal[2]*x_axis[1], normal[2]*x_axis[0]-normal[0]*x_axis[2], normal[0]*x_axis[1]-normal[1]*x_axis[0])
            clip = u.create_box((-radius, -radius, 0), 2 * radius, 2 * radius, radius)
            u.transform(clip, u.Axis2Placement(plane, x_axis, y_axis))
            cut = u.boolean_intersection(body.copy(), clip)
            if not cut.is_manifold_solid():
                raise ValueError("切割区域未形成闭合实体，请调整切割平面")
            kept.append(cut)
            for face in cut.faces():
                if not face.surface().is_planar():
                    continue
                p = face.interior_point()
                if abs(sum((p[i] - plane[i]) * normal[i] for i in range(3))) > 1e-6:
                    continue
                _, uvs, _ = u.surface_closest_point(face.surface(), p)
                n = face.outward_normal_at_uv(uvs[0].x, uvs[0].y)
                if abs(sum(n[i] * normal[i] for i in range(3))) < 1 - 1e-8:
                    continue
                area = face.area(accuracy)
                cap_area += area
                cap_centers.append((area, face.centroid(accuracy)))
                for edge in face.edges():
                    outline(edge)
        prop("平面点 XYZ", list(plane), "mm")
        prop("平面单位法向 XYZ", list(normal))
        prop("截面积", cap_area, "mm²")
        if cap_area > 0:
            cap_center = [sum(a * c[i] for a, c in cap_centers) / cap_area for i in range(3)]
            prop("截面面积形心 XYZ", cap_center, "mm", anchor=cap_center)
            next(p for p in properties if p["label"] == "截面积")["anchor"] = cap_center
        if kept:
            mass(kept)
            prop("保留区域表面积（含切面）", sum(body.area(accuracy) for body in kept), "mm²")
        else:
            prop("实体体积", 0, "mm³")
            prop("质量", 0, "kg")
            notes.append("法向正侧没有保留实体。")
        notes.append("只读切割副本：统计法向正侧的局部实体；截面轮廓以采样线显示。切面恰好重合原边界时请稍移平面。多个部件的截面积按部件累加。")
    elif not selected or kinds == {"body"}:
        items = [item for _, item, _ in objects] if objects else bodies
        prop("部件数", len(items))
        faces = [face for body in items for face in body.faces()]
        prop("表面积", sum(face.area(accuracy) for face in faces), "mm²", anchor=faces[0].interior_point() if faces else None)
        bounds = [body.bounding_box() for body in items]
        low = [min(box[0][i] for box in bounds) for i in range(3)]
        high = [max(box[1][i] for box in bounds) for i in range(3)]
        prop("轴对齐包围尺寸 XYZ", [high[i] - low[i] for i in range(3)], "mm", panel_only=True)
        for axis, name in enumerate("XYZ"):
            end = list(low)
            end[axis] = high[axis]
            prop(f"包围尺寸 {name}", high[axis] - low[axis], "mm", anchor=[(low[i] + end[i]) / 2 for i in range(3)], dimension=(low, end, True))
        mass(items)
        if selected:
            for body in items:
                for edge in body.edges():
                    outline(edge)
    elif kinds == {"face"}:
        faces = [item for _, item, _ in objects]
        areas = [face.area(accuracy) for face in faces]
        prop("所选面面积", sum(areas), "mm²", anchor=faces[0].interior_point() if len(faces) == 1 else None)
        if len(faces) > 1:
            for key, face, area in zip(selected, faces, areas):
                prop(f"{key} 面积", area, "mm²", anchor=face.interior_point())
        if sum(areas) > 0:
            centers = [face.centroid(accuracy) for face in faces]
            prop("面积形心 XYZ", [sum(area * c[i] for area, c in zip(areas, centers)) / sum(areas) for i in range(3)], "mm")
        # Loops count edge occurrences, including periodic seams; do not call it union perimeter.
        prop("裁剪边界总长（含接缝与重复边）", sum(edge.length() for face in faces for loop in face.boundary_loops() for edge, _ in loop), "mm")
        if len(faces) == 1:
            face = faces[0]
            prop("曲面类型", "平面" if face.surface().is_planar() else "曲面")
            prop("边界环数", len(face.boundary_loops()))
            p = sample_point or face.interior_point()
            _, uvs, _ = u.surface_closest_point(face.surface(), tuple(p))
            if uvs:
                uv = (uvs[0].x, uvs[0].y)
                prop("表面采样点 XYZ", list(p), "mm", anchor=p)
                prop("采样点外向法线 XYZ", list(face.outward_normal_at_uv(*uv)), anchor=p)
                points.append(list(p))
        for face in faces:
            for edge in face.edges():
                outline(edge)
        notes.append("面只有面积，局部体积或质量需选择闭合实体或定义切割区域。曲面不假设具有统一半径或壁厚。")
    elif kinds == {"edge"}:
        length_prop = prop("所选边总长", sum(item.length() for _, item, _ in objects), "mm")
        if len(objects) > 1:
            for key, (_, edge, _) in zip(selected, objects):
                low, high = edge.parameter_range()
                prop(f"{key} 边长", edge.length(), "mm", anchor=edge.point_at((low + high) / 2))
        for _, edge, _ in objects:
            outline(edge)
        if len(objects) == 1:
            edge = objects[0][1]
            low, high = edge.parameter_range()
            t = edge.closest_point(sample_point)[1] if sample_point else (low + high) / 2
            ev = u.evaluate_curve(edge.curve(), t)
            length_prop["anchor"] = list(ev["point"])
            a, b = tuple(ev["tangent"]), tuple(ev["curvature"])
            cross = (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
            speed = math.sqrt(sum(v*v for v in a))
            prop("起点 XYZ", list(edge.start_vertex().point()), "mm", anchor=edge.start_vertex().point())
            prop("终点 XYZ", list(edge.end_vertex().point()), "mm", anchor=edge.end_vertex().point())
            prop("曲线是否共面", "是" if edge.curve().is_planar() else "否")
            prop("曲线采样点 XYZ", list(ev["point"]), "mm", anchor=ev["point"])
            if speed > 1e-12:
                curvature = math.sqrt(sum(v*v for v in cross)) / speed**3
                prop("采样点曲率", curvature, "1/mm", anchor=ev["point"])
                if curvature > 1e-12:
                    prop("采样点曲率半径", 1 / curvature, "mm", anchor=ev["point"])
                prop("采样点单位切线 XYZ", list(edge.tangent_at(t)), anchor=ev["point"])
            points.append(list(ev["point"]))
            notes.append("曲率在点击处计算；列表选择使用参数区间中点。曲率半径是局部值，不代表整条边是圆弧。")
    elif kinds == {"vertex"}:
        for key in selected:
            point = list(topology[key][1].point())
            prop(key + " 坐标 XYZ", point, "mm", anchor=point)
            points.append(point)
    else:
        prop("所选对象", len(selected))
        notes.append("混合类型选择不累加面积或质量；请选择同类对象查看汇总属性。")
        for kind, item, _ in objects:
            if kind == "vertex":
                points.append(list(item.point()))
            elif kind == "edge":
                outline(item)
            else:
                for edge in item.edges():
                    outline(edge)

    if len(objects) == 2 and section is None:
        (ak, a, _), (bk, b, _) = objects
        if ak == bk == "body":
            relation = u.brep_relationship(a, b)
            prop("边界最短距离", relation["distance"], "mm")
            prop("实体空间关系", relation["relationship"])
        elif "vertex" in (ak, bk):
            vertex, other, other_kind = (a, b, bk) if ak == "vertex" else (b, a, ak)
            p = tuple(vertex.point())
            if other_kind == "vertex":
                q = tuple(other.point())
                distance = math.dist(p, q)
            elif other_kind == "body":
                q, distance = u.brep_closest_point(other, p)
            elif other_kind == "face":
                q, distance = other.closest_point(p)
            else:
                q, _, distance = other.closest_point(p)
            prop("最短距离（至原生边界）", distance, "mm", anchor=[(p[i] + q[i]) / 2 for i in range(3)], dimension=(p, q))
            lines.append([list(p), list(q)])
        elif ak == bk == "face" and a.surface().is_planar() and b.surface().is_planar():
            normals = []
            for face in (a, b):
                _, uv, _ = u.surface_closest_point(face.surface(), face.interior_point())
                normals.append(face.outward_normal_at_uv(uv[0].x, uv[0].y))
            dot = min(1., max(-1., sum(normals[0][i] * normals[1][i] for i in range(3))))
            prop("平面法线夹角", math.degrees(math.acos(dot)), "°")
            notes.append("此角度采用两面的外向法线；有限裁剪面间的最短距离尚未提供。")
        else:
            notes.append("当前内核接口未提供该组合的可靠全局距离或夹角，本面板不以包围盒或网格近似替代。")

    from selection_context import selection_context
    context, candidates = selection_context(bodies, topology, selected, properties, accuracy)
    requested = request.get("metricIds")
    metric_errors = []
    if requested is not None:
        if not isinstance(requested, list) or len(requested) > 12 or any(not isinstance(key, str) or len(key) > 240 for key in requested) or len(set(requested)) != len(requested):
            raise ValueError("metricIds must contain at most 12 unique measurement IDs")
        properties = []
        for key in requested:
            if key not in candidates:
                metric_errors.append({"id": key, "error": "当前选择没有此测量项，几何或选择可能已变化"})
            else:
                properties.append(candidates[key][0])
    return {"inspectionSchema": "vision.inspection/2", "requestedMetricIds": requested,
            "selection": selected, "catalog": catalog, "properties": properties, "notes": notes,
            "selectionContext": context, "availableMetrics": [entry[1] for entry in candidates.values()], "metricErrors": metric_errors,
            "visual": {"lines": lines, "points": points}, "relativeAccuracy": accuracy,
            "source": "NVIDIA USD BRep · 原生几何数值积分 / 查询"}
