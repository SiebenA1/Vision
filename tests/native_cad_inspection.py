"""Run with .python312/python.exe tests/test_cad_inspection.py (real kernel)."""
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import usd_brep as u
from cad_inspection import inspect


class NativeInspectionTest(unittest.TestCase):
    def measure(self, bodies, selection=None, **options):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            paths = []
            for i, body in enumerate(bodies):
                path = str(Path(folder) / f"{i}.brep")
                body.write_to_file(path)
                paths.append(path)
            return inspect({"source_breps": paths, "names": [f"part {i}" for i in range(len(bodies))],
                            "selection": selection or [], "density_kg_m3": 2700, **options})

    def values(self, result):
        return {p["label"]: p["value"] for p in result["properties"]}

    def test_box_centroid_inertia_and_units(self):
        result = self.measure([u.create_box((10, 20, 30), 10, 20, 30)])
        values = self.values(result)
        self.assertEqual(values["测量范围"], "整个模型")
        self.assertEqual(values["对象类型"], "闭合实体")
        self.assertAlmostEqual(values["实体体积"], 6000)
        self.assertAlmostEqual(values["质量"], .0162)
        for actual, expected in zip(values["质量中心 XYZ"], [15, 30, 45]):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(values["质心惯性矩 Ixx / Iyy / Izz"], [1.755, 1.35, .675]):
            self.assertAlmostEqual(actual, expected)
        dimensions = [p for p in result["properties"] if p.get("dimension")]
        self.assertEqual(len(dimensions), 3)
        for prop in dimensions:
            self.assertAlmostEqual(math.dist(prop["dimension"]["start"], prop["dimension"]["end"]), prop["value"])
            self.assertEqual(len(prop["anchor"]), 3)
        self.assertNotIn("anchor", next(p for p in result["properties"] if p["label"] == "质量"))

    def test_holed_asymmetric_body_centroid_is_not_box_center(self):
        body = u.boolean_difference(u.create_box((0, 0, 0), 20, 20, 10), u.create_cylinder((5, 10, -1), 2, 12))
        values = self.values(self.measure([body]))
        volume = 4000 - math.pi * 4 * 10
        self.assertAlmostEqual(values["实体体积"], volume, delta=volume * 1e-4)
        self.assertAlmostEqual(values["质量中心 XYZ"][0], (4000 * 10 - math.pi * 40 * 5) / volume, delta=.001)

    def test_body_pick_returns_native_volume_and_only_selected_body_mass(self):
        result = self.measure([u.create_box((0, 0, 0), 10, 20, 30), u.create_box((100, 0, 0), 5, 5, 5)],
                              pick={"point": [3, 4, 30], "kind": "body", "tolerance_mm": .01})
        self.assertEqual(result["selection"], ["body-0"])
        values = self.values(result)
        self.assertAlmostEqual(values["实体体积"], 6000)
        self.assertAlmostEqual(values["质量"], .0162)
        for actual, expected in zip(values["轴对齐包围尺寸 XYZ"], [10, 20, 30]):
            self.assertAlmostEqual(actual, expected, delta=1e-4)

    def test_sheet_area_without_synthetic_volume_or_mass(self):
        result = self.measure([u.create_plane((0, 0, 0), 20, 30)])
        self.assertAlmostEqual(self.values(result)["表面积"], 600)
        self.assertEqual(self.values(result)["对象类型"], "曲面体")
        self.assertNotIn("质量", self.values(result))
        self.assertTrue(result["notes"])

    def test_trimmed_face_hole_area_and_pick_does_not_select_hole(self):
        body = u.boolean_difference(u.create_box((0, 0, 0), 20, 20, 10), u.create_cylinder((10, 10, -1), 2, 12))
        result = self.measure([body], pick={"point": [3, 3, 10], "kind": "face", "tolerance_mm": .01})
        self.assertAlmostEqual(self.values(result)["所选面面积"], 400 - math.pi * 4, delta=.01)
        self.assertEqual(self.values(result)["边界环数"], 2)
        self.assertEqual(self.values(result)["对象类型"], "面")
        self.assertEqual(self.values(result)["测量范围"], "所选对象（1 个）")
        anchor = next(p["anchor"] for p in result["properties"] if p["label"] == "所选面面积")
        self.assertGreaterEqual(math.hypot(anchor[0] - 10, anchor[1] - 10), 2 - 1e-6)
        with self.assertRaises(ValueError):
            self.measure([body], pick={"point": [10, 10, 10], "kind": "face", "tolerance_mm": .01})

    def test_local_circle_curvature_and_native_vertices(self):
        disk = self.values(self.measure([u.create_planar_circle((0, 0, 0), 8)]))
        self.assertEqual(disk["对象类型"], "曲面体")
        self.assertNotIn("质量", disk)
        result = self.measure([u.create_planar_circle((0, 0, 0), 8)], ["body-0/edge-0"])
        self.assertAlmostEqual(self.values(result)["所选边总长"], 16 * math.pi, delta=.001)
        self.assertAlmostEqual(self.values(result)["采样点曲率半径"], 8, delta=.001)
        self.assertNotIn("dimension", next(p for p in result["properties"] if p["label"] == "所选边总长"))
        result = self.measure([u.create_box((0, 0, 0), 10, 20, 30)], ["body-0/vertex-0", "body-0/vertex-1"])
        self.assertGreater(self.values(result)["最短距离（至原生边界）"], 0)
        self.assertEqual(len(result["visual"]["points"]), 2)

    def test_multi_body_parallel_axis_and_distance(self):
        bodies = [u.create_box((0, 0, 0), 10, 10, 10), u.create_box((20, 0, 0), 10, 10, 10)]
        values = self.values(self.measure(bodies, ["body-0", "body-1"]))
        self.assertAlmostEqual(values["边界最短距离"], 10)
        self.assertAlmostEqual(values["质量中心 XYZ"][0], 15)
        self.assertAlmostEqual(values["质心惯性矩 Ixx / Iyy / Izz"][1], 2 * .0027 * (200 / 12 + 100))

    def test_sphere_and_torus_with_periodic_and_degenerate_edges(self):
        sphere = u.create_sphere((0, 0, 0), 10)
        values = self.values(self.measure([sphere], ["body-0/face-0"]))
        self.assertEqual(values["曲面类型"], "曲面")
        self.assertAlmostEqual(values["所选面面积"], 400 * math.pi, delta=.4)
        # A periodic seam is an edge, not an inferred circle or a solid boundary.
        result = self.measure([sphere], ["body-0/edge-0"])
        self.assertTrue(result["visual"]["lines"])
        torus = u.create_torus((0, 0, 0), 20, 5)
        values = self.values(self.measure([torus]))
        self.assertAlmostEqual(values["实体体积"], 2 * math.pi**2 * 20 * 25, delta=5)
        self.assertAlmostEqual(values["质量中心 XYZ"][0], 0, delta=.01)

    def test_invalid_selection_density_accuracy_and_coordinates(self):
        body = u.create_box((0, 0, 0), 1, 2, 3)
        for options in ({"selection": ["body-99"]}, {"density_kg_m3": float("nan")}, {"relative_accuracy": 1e-8},
                        {"pick": {"point": [0, 0, float("inf")], "kind": "face", "tolerance_mm": .1}}):
            with self.assertRaises(ValueError):
                self.measure([body], **options)

    def test_section_half_body_and_empty_region(self):
        body = u.create_box((0, 0, 0), 10, 20, 30)
        result = self.measure([body], section={"point": [0, 0, 15], "normal": [0, 0, 2]})
        values = self.values(result)
        self.assertAlmostEqual(values["截面积"], 200)
        self.assertAlmostEqual(values["实体体积"], 3000)
        self.assertAlmostEqual(values["质量中心 XYZ"][2], 22.5)
        self.assertAlmostEqual(body.volume(), 6000)
        empty = self.values(self.measure([body], section={"point": [0, 0, 50], "normal": [0, 0, 1]}))
        self.assertEqual(empty["质量"], 0)
        self.assertNotIn("质量中心 XYZ", empty)
        full = self.values(self.measure([body], section={"point": [0, 0, -50], "normal": [0, 0, 1]}))
        self.assertAlmostEqual(full["实体体积"], 6000)

    def test_oblique_section_and_holed_section(self):
        body = u.create_box((0, 0, 0), 10, 10, 10)
        values = self.values(self.measure([body], section={"point": [5, 5, 0], "normal": [1, 1, 0]}))
        self.assertAlmostEqual(values["截面积"], 100 * math.sqrt(2), delta=.01)
        self.assertAlmostEqual(values["实体体积"], 500, delta=.01)
        hollow = u.boolean_difference(u.create_box((0, 0, 0), 20, 20, 10), u.create_cylinder((10, 10, -1), 2, 12))
        values = self.values(self.measure([hollow], section={"point": [0, 0, 5], "normal": [0, 0, 1]}))
        self.assertAlmostEqual(values["截面积"], 400 - 4 * math.pi, delta=.01)
        self.assertAlmostEqual(values["实体体积"], (400 - 4 * math.pi) * 5, delta=.2)

    def test_selected_hole_wall_exposes_neighbor_evidence_and_queryable_parameters(self):
        body = u.boolean_difference(u.create_box((0, 0, 0), 20, 20, 10), u.create_cylinder((10, 10, -1), 2, 12))
        index = next(i for i, face in enumerate(body.faces()) if not face.surface().is_planar())
        identity = f"body-0/face-{index}"
        result = self.measure([body], [identity])
        selected = result["selectionContext"]["selected"][0]
        self.assertEqual(selected["cylinderEvidence"]["radialOrientation"], "inward")
        self.assertTrue(selected["adjacentFaceIds"])
        self.assertTrue(selected["boundaryLoops"])
        self.assertIn(identity + ":diameter", [item["id"] for item in result["availableMetrics"]])
        measured = self.measure([body], [identity], metricIds=[identity + ":diameter", identity + ":axial_span"])
        self.assertEqual(len(measured["properties"]), 2)
        self.assertAlmostEqual(measured["properties"][0]["value"], 4, delta=1e-6)
        self.assertAlmostEqual(measured["properties"][1]["value"], 10, delta=1e-6)
        self.assertIn("容差", measured["properties"][0]["method"])

    def test_planar_face_context_includes_hole_rims_and_explicit_plane_gap(self):
        body = u.boolean_difference(u.create_box((0, 0, 0), 20, 20, 10), u.create_cylinder((10, 10, -1), 2, 12))
        result = self.measure([body], pick={"point": [3, 3, 10], "kind": "face", "tolerance_mm": .01})
        context = result["selectionContext"]
        self.assertTrue(context["selected"][0]["planar"])
        self.assertTrue(any(item.get("cylinderEvidence", {}).get("radialOrientation") == "inward" for item in context["related"]))
        self.assertTrue(any(item["id"].endswith(":diameter") for item in result["availableMetrics"]))
        gaps = [item for item in result["availableMetrics"] if ":plane_gap:" in item["id"]]
        self.assertTrue(gaps)
        self.assertIn("不等于壁厚", gaps[0]["description"])

    def test_sphere_is_not_identified_as_cylinder_and_unknown_metrics_are_not_executed(self):
        sphere = u.create_sphere((0, 0, 0), 10)
        result = self.measure([sphere], ["body-0/face-0"], metricIds=["body-0/face-0:diameter", "__import__('os')"])
        self.assertNotIn("cylinderEvidence", result["selectionContext"]["selected"][0])
        self.assertEqual(result["properties"], [])
        self.assertEqual(len(result["metricErrors"]), 2)


if __name__ == "__main__":
    unittest.main()
