"""Real USD BRep and TetGen/scikit-fem regression. No mocked kernel calls."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from engineering_server import execute_usd_brep, cad_capabilities, run_cad_worker
import cad_artifacts
import tempfile

CASES = {
    "boolean": "result = u.boolean_difference(u.create_box((0,0,0),40,20,10), u.create_cylinder((20,10,-1),3,12))",
    "extrusion": "result = u.linear_sweep(u.create_rectangle((0,0,0),20,10), (0,0,1), 30)",
    "revolution": "points=[(10,0,0),(15,0,0),(15,0,20),(10,0,20)]; curves=[u.create_line_segment(points[i],points[(i+1)%4]) for i in range(4)]; result=u.rotational_sweep(curves,(0,0,0),(0,0,1),360)",
    "pipe": "result = u.pipe_sweep(u.create_arc((0,0,0),30,0,90),radius=3)",
    "loft": "a=u.create_rectangle((0,0,0),20,10); b=u.create_rectangle((3,0,30),10,6); result=u.create_skin_primitive([4,4],a+b)",
    "fillet": "result=u.circular_fillet(u.create_box((0,0,0),30,20,10),1)",
    "chamfer": "result=u.chamfer_fillet(u.create_box((0,0,0),30,20,10),1)",
    "shell": "body=u.create_box((0,0,0),30,20,10); top=max(body.faces(),key=lambda f:f.centroid()[2]); result=u.shell_brep(body,-1,faces_to_shell=[top])",
    "offset": "result=u.offset_brep(u.create_box((0,0,0),30,20,10),1)",
    "stitch_heal": "body=u.create_box((0,0,0),20,10,8); body,solid,*_=u.stitch_into_solid(body); assert solid; result=u.heal_brep(body)",
    "sheet": "result=u.create_planar_circle((0,0,0),10)",
    "nurbs_sheet": "pts=[(0,0,0),(10,0,0),(10,10,3),(0,10,0)]; surface=u.create_surface_from_corner_points(pts[0],pts[1],pts[3],pts[2]); curves=[u.create_line_segment(pts[i],pts[(i+1)%4]) for i in range(4)]; result=u.trim_surface_with_3d_curves(surface,[4],curves)",
    "multi_body": "result={'left':u.create_box((0,0,0),20,10,8),'right':u.create_box((30,0,0),20,10,8)}",
}


def cad_tests():
    api = cad_capabilities()
    assert api["version"] == "1.0.0"
    assert not set(api["groups"]) & {"os", "sys", "importlib", "types"}
    assert any(entry["name"] == "Face.closest_point" for entry in api["entries"])
    results = {}
    for name, script in CASES.items():
        result = execute_usd_brep("import usd_brep as u\n" + script, options={"tolerance_mm": 0.1})
        assert result["schema"] == "vision.cad/3" and result["stlBytes"] > 84
        assert all(body["kind"] == ("sheet" if name in {"sheet", "nurbs_sheet"} else "solid") for body in result["bodies"])
        assert result["metrics"]["volume_mm3"] >= 0
        assert cad_artifacts.read_file(result["artifactId"], "model.usda")
        results[name] = result
        print("PASS CAD", name, result["metrics"]["triangles"], flush=True)
    multi = results["multi_body"]
    imported = execute_usd_brep("", source_artifact=multi["artifactId"])
    assert [b["name"] for b in imported["bodies"]] == ["left", "right"]
    assert abs(imported["metrics"]["volume_mm3"] - multi["metrics"]["volume_mm3"]) < 1e-6
    edited = execute_usd_brep("result={'left':parts['left'], 'right':u.translate(parts['right'],(0,10,0))}", source_artifact=multi["artifactId"])
    assert len(edited["bodies"]) == 2
    parameterized = execute_usd_brep("length=parameters.setdefault('length',40); result=u.create_box((0,0,0),length,10,8)", options={"parameters":{"length":50}})
    assert abs(parameterized["metrics"]["volume_mm3"] - 4000) < 1e-6
    print("PASS CAD native round-trip, source edit and parameter replay", flush=True)
    box = results["stitch_heal"]
    bottom = min(box["bodies"][0]["faces"], key=lambda f: f["bbox_mm"]["max"][2])
    with tempfile.TemporaryDirectory(dir=cad_artifacts.ROOT) as temp:
        selection = run_cad_worker({"operation":"select_faces", "source_usd":str(cad_artifacts.artifact_path(box["artifactId"])/"model.usda"),
            "points":[[1,1,0],[1,1,4],[1,1,8]], "regions":[{"faceIds":[bottom["id"]],"toleranceMm":0.01}]},temp)
    assert selection["selections"] == [[0]], selection
    print("PASS CAD native trimmed-face selection", flush=True)
    for name, offset, separate in [("separate", 30, True), ("touching", 20, False), ("overlap", 15, False)]:
        assembly = execute_usd_brep(f"result=[u.create_box((0,0,0),20,10,8),u.create_box(({offset},0,0),20,10,8)]")
        with tempfile.TemporaryDirectory(dir=cad_artifacts.ROOT) as temp:
            try:
                check=run_cad_worker({"operation":"validate_separation","source_breps":[str(cad_artifacts.artifact_path(assembly["artifactId"])/f"body-{i}.brep") for i in range(2)],"clearance_mm":.1},temp)
                assert separate and check["separate"]
            except RuntimeError as error:
                assert not separate and "contact/bonding is not implemented" in str(error), str(error)
        print("PASS CAD analysis separation guard",name,flush=True)
    return results


def fea_tests():
    from fea_solver import solve
    from engineering_server import _box_stl_base64
    material={"E":210000,"nu":0.3,"rho":7850,"yieldStrength":235}
    supports=[{"face":"x-min","enabled":True}]
    loads=[{"face":"x-max","vector":[1,0,0],"magnitude":100,"enabled":True}]
    stl=_box_stl_base64()
    baseline=solve(stl,material,supports,loads,4)
    doubled=solve(stl,material,supports,loads+loads,4)
    assert abs(doubled["maxDisplacement"]/baseline["maxDisplacement"]-2)<1e-6
    assert doubled["appliedForce"] == [200.0,0.0,0.0]
    assert len(doubled["boundaries"])==3
    reference=100*100/(210000*200)
    assert abs(baseline["maxDisplacement"]-reference)/reference<0.1
    print("PASS FEA axial benchmark and additive loads",baseline["maxDisplacement"],reference,flush=True)
    assert baseline["relativeResidual"] < 1e-6 and baseline["equilibriumError"] < 1e-6
    beam = execute_usd_brep("result=u.create_box((-50,-10,-5),100,20,10)")
    faces=beam["bodies"][0]["faces"]
    left=min(faces,key=lambda f:f["bbox_mm"]["max"][0])
    right=max(faces,key=lambda f:f["bbox_mm"]["min"][0])
    def native_region(cad, face):
        return {"type":"cad-face", "artifactId":cad["artifactId"], "faceIds":[face["id"]], "toleranceMm":.1}
    native_supports=[{"face":"x-min","region":native_region(beam,left),"enabled":True}]
    native_loads=[{**loads[0],"region":native_region(beam,right)}]
    native=solve(beam["stlBase64"],material,native_supports,native_loads,4)
    axis=solve(beam["stlBase64"],material,supports,loads,4)
    assert abs(native["maxDisplacement"] / axis["maxDisplacement"] - 1)<1e-6
    print("PASS FEA native trimmed faces",native["boundaries"],flush=True)
    cavity=execute_usd_brep("mesh_holes={'housing':[(10,10,10)]};result={'housing':u.boolean_difference(u.create_box((0,0,0),20,20,20),u.create_box((5,5,5),10,10,10))}")
    hollow=solve(cavity["stlBase64"],material,supports,loads,3,holes=[[10,10,10]],expected_volume=7000)
    assert abs(hollow["volume_mm3"]-7000)<1e-3
    print("PASS FEA enclosed cavity",hollow["volume_mm3"],flush=True)
    manifold=execute_usd_brep((Path(__file__).resolve().parents[1]/"server/examples/flow_manifold_usd.py").read_text(),options={"tolerance_mm":.1})
    mf=manifold["bodies"][0]["faces"]
    bottom=min(mf,key=lambda f:f["bbox_mm"]["max"][2])
    branch=max(mf,key=lambda f:f["bbox_mm"]["min"][0])
    complex_result=solve(manifold["stlBase64"],material,[{"face":"z-min","region":native_region(manifold,bottom),"enabled":True}],
        [{"face":"x-max","region":native_region(manifold,branch),"vector":[0,0,-1],"magnitude":100,"enabled":True}],
        5,expected_volume=manifold["metrics"]["volume_mm3"])
    assert complex_result["converged"] and complex_result["equilibriumError"]<1e-6
    print("PASS FEA complex manifold",complex_result["elements"],complex_result["maxDisplacement"],complex_result["equilibriumError"],flush=True)



if __name__ == "__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--cad-only",action="store_true");args=parser.parse_args()
    cad_tests()
    if not args.cad_only: fea_tests()
