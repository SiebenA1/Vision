"""One native attempt, invoked only by the durable controller."""
import base64
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "server"))
from backend.vision.storage import Artifacts, packed
from backend.vision.runtime import profile
from backend.vision.studies import native_study
from backend.vision.validation import validate_cad


class CadScriptFailure(RuntimeError):
    """A completed CAD attempt failed deterministically inside the user script."""


def run_cad(request, directory):
    request_path = directory / "cad-request.json"
    response_path = directory / "cad-response.json"
    request_path.write_text(packed(request), encoding="utf-8")
    process = subprocess.run([str(ROOT / ".python312/python.exe"), "-I", "-X", "faulthandler", "-X", "utf8", str(ROOT / "server/usd_brep_worker.py"),
                              str(request_path), str(response_path)], capture_output=True,
                             encoding="utf-8", errors="replace", timeout=240)
    if not response_path.exists():
        code = process.returncode & 0xffffffff
        reason = "原生 CAD 内核发生访问冲突；请检查布尔运算后是否复用了已消耗的对象" if code == 0xc0000005 else "原生 CAD 进程未生成结果"
        detail = (process.stderr or process.stdout).strip()[-3000:]
        raise RuntimeError(f"{reason}（退出码 0x{code:08X}）。{detail}")
    result = json.loads(response_path.read_text(encoding="utf-8"))
    if process.returncode or "error" in result:
        error_type = CadScriptFailure if result.get('error_kind') == 'cad_script' else RuntimeError
        raise error_type((result.get("error") or result.get("trace") or process.stderr or "native CAD worker failed")[-4000:])
    return result


def execute(workspace, job, directory):
    artifacts = Artifacts(workspace / "artifacts")
    inputs = job["input"]
    if inputs["execution"]["profile"] != profile(job["kind"]):
        raise ValueError("implementation or numerical packages changed since submission; submit a new job")
    document, command = inputs["document"], inputs["command"]
    provenance = {"revision_id": job["revision"], "input_sha256": hashlib.sha256(packed(inputs).encode()).hexdigest(),
                  "memory_limit_mib": inputs["execution"].get("memory_limit_mib"),
                  "python": sys.version, "solver_sha256": hashlib.sha256((ROOT / "server/fea_solver.py").read_bytes()).hexdigest()}
    if job["kind"] == "cad":
        print("stage: native CAD build", flush=True)
        names, sources = [], None
        source_id = document["geometry"] if command["use_current"] else None
        parameters = command["parameters"]
        if command.get("replay_of"):
            original = artifacts.manifest(command["replay_of"])
            source_id = original["provenance"]["resolved_source"]
            parameters = {**original["parameters"], **parameters}
        # Keep the received input JSON unchanged; record derived replay state separately.
        provenance["resolved_source"] = source_id
        if source_id:
            previous = artifacts.manifest(source_id)
            names = [body["name"] for body in previous["bodies"]]
            sources = [str(artifacts.file(source_id,previous.get('module_files',{}).get(name,f'body-{i}.brep')
                                           if command.get('_module_execution') else f'body-{i}.brep')) for i,name in enumerate(names)]
        options = {key: command[key] for key in ("parameters", "tolerance_mm", "angle_deg")}
        options["parameters"] = parameters
        options["source_names"] = names
        if command.get('_module_execution'):
            options['module_component_names']=[item['component_id'] for item in command['_module_execution']['components']]
            options['module_placements']={item['component_id']:{key:item[key] for key in ('translation','rotation_deg')}
                                          for item in command['_module_execution']['components']}
            if source_id and all(previous.get('settings',{}).get(key)==options[key] for key in ('tolerance_mm','angle_deg')):
                options['module_mesh_sources']={item['component_id']:str(artifacts.file(source_id,previous['module_mesh_files'][item['component_id']]))
                     for item in command['_module_execution']['components'] if item['reused'] and item['component_id'] in previous.get('module_mesh_files',{})}
        provenance["density_kg_m3"] = document["study"]["material"]["rho"] if document["study"] else 2700
        provenance["density_origin"] = "study-material" if document["study"] else "default-preview"
        result = run_cad({"script": command["script"], "options": options, "source_breps": sources,
                          "density_kg_m3": provenance["density_kg_m3"]}, directory)
        validate_cad(result)
        result.pop("stlBase64")
        result.pop("stlBytes")
        if command.get('_module_execution'):
            result['module_execution'] = command['_module_execution']
        (directory / "source.py").write_text(command["script"], encoding="utf-8")
        (directory / "input.json").write_text(packed(inputs), encoding="utf-8")
        files = ["model.usda", "preview.stl", "source.py", "input.json"]
        files.extend(result.get('module_files',{}).values())
        files.extend(result.get('module_mesh_files',{}).values())
        for i in range(len(result["bodies"])):
            files.extend([f"body-{i}.brep", f"body-{i}.stl"])
        manifest = artifacts.publish(directory, files, {**result, "kind": "cad", "provenance": provenance})
        response = {"artifact_id": manifest["artifactId"], "metrics": manifest["metrics"]}
        if command.get('_module_execution'):
            response['module_rebuild'] = {key:command['_module_execution'][key] for key in ('rebuilt','reused')}
        return response

    # Native face queries inside the verified solver resolve against this workspace.
    import cad_artifacts
    import engineering_server
    import numpy as np
    import scipy
    import skfem
    import tetgen
    original_path = sys.path[:]
    try:
        # The legacy module adds Windows Store fallback paths. This isolated
        # worker has pinned packages already loaded; do not retain those paths.
        import fea_solver
    finally:
        sys.path[:] = original_path
    versions = {"numpy": np.__version__, "scipy": scipy.__version__, "scikit-fem": skfem.__version__, "tetgen": tetgen.__version__}
    if any(inputs["execution"]["profile"]["packages"][name] != value for name, value in versions.items()):
        raise ValueError("loaded numerical packages differ from the admitted runtime")
    cad_artifacts.ROOT = artifacts.root
    engineering_server.ROOT = directory
    engineering_server.run_cad_worker = lambda request, folder: run_cad(request, Path(folder))
    fea_solver.WORK_ROOT = directory / "meshes"
    fea_solver.WORK_ROOT.mkdir()
    geometry = artifacts.manifest(document["geometry"])
    study = native_study(document)
    if any((item.get("region") or {}).get("type") == "cad-face" for item in study["supports"] + study["loads"] if item.get("enabled", True)):
        for index in range(len(geometry["bodies"])):
            artifacts.file(document["geometry"], f"body-{index}.brep")
    selected = study.get("body_ids") or [body["id"] for body in geometry["bodies"] if body["kind"] == "solid"]
    bodies = {body["id"]: body for body in geometry["bodies"]}
    if not selected or any(key not in bodies or bodies[key]["kind"] != "solid" for key in selected):
        raise ValueError("select current closed solids for analysis")
    holes, chunks, count, volume = [], [], 0, 0.0
    for key in selected:
        body = bodies[key]
        if (body.get("materialCensus") or {}).get("void_count", 0) and not body.get("holePoints"):
            raise ValueError("enclosed cavities require mesh_holes seeds")
        holes.extend(body.get("holePoints", []))
        volume += body["volume_mm3"]
        data = artifacts.file(document["geometry"], body["stlFile"]).read_bytes()
        count += struct.unpack_from("<I", data, 80)[0]
        chunks.append(data[84:])
    if len(selected) > 1:
        run_cad({"operation": "validate_separation", "source_breps": [str(artifacts.file(document["geometry"], f"{key}.brep")) for key in selected],
                 "clearance_mm": geometry["settings"]["tolerance_mm"] * 2}, directory)
    surface = b"VISION workspace".ljust(80, b" ") + struct.pack("<I", count) + b"".join(chunks)
    print("stage: volume meshing and boundary selection", flush=True)
    result = fea_solver._solve_impl(base64.b64encode(surface).decode(), study["material"],
                                  study["supports"], study["loads"], study["mesh_size"],
                                  holes=holes, expected_volume=volume, max_elements=inputs["execution"]["max_elements"], surface_topology=True)
    fields = {key: np.asarray(result.pop(key), dtype=np.float32) for key in ("positions", "displacement", "vonMises")}
    triangles = np.asarray(result.pop("surfaceTriangles"), dtype=np.uint32)
    for key, values in fields.items():
        expected = result["nodes"] * (1 if key == "vonMises" else 3)
        if values.size != expected or not np.isfinite(values).all():
            raise ValueError(f"invalid numerical field: {key}")
    from backend.vision.fields import write_surface
    display = write_surface(directory / "surface.bin", fields, triangles)
    np.savez_compressed(directory / "field.npz", **fields, surfaceTriangles=triangles)
    (directory / "surface.stl").write_bytes(surface)
    (directory / "input.json").write_text(packed(inputs), encoding="utf-8")
    provenance["versions"] = versions
    provenance["max_elements"] = inputs["execution"]["max_elements"]
    manifest = artifacts.publish(directory, ["field.npz", "surface.stl", "input.json"] + (["surface.bin"] if display["available"] else []),
                                 {"kind": "fea", "schema": "vision.analysis/2", "result": result,
                                  "display": display,
                                  "geometry": document["geometry"], "study": study, "provenance": provenance})
    return {"artifact_id": manifest["artifactId"], "summary": result}


if __name__ == "__main__":
    # Parent assigns the process to a termination group before allowing any native work.
    if sys.stdin.readline().strip() != "start":
        raise SystemExit("controller handshake missing")
    workspace, directory = map(Path, sys.argv[1:3])
    def write_receipt(value):
        pending = directory / "receipt.tmp"
        pending.write_text(packed(value), encoding="utf-8")
        pending.replace(directory / "receipt.json")
    try:
        job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
        result = execute(workspace, job, directory)
        write_receipt({"result": result})
    except Exception as error:
        write_receipt({"error": f"{type(error).__name__}: {error}"})
        raise
