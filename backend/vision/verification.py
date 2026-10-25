"""Independent solver checks and analytic references; never edit project geometry."""
import hashlib
import json
import time

from .runtime import ROOT, execution_settings, profile
from .storage import Conflict, Missing, identity, packed


def solver_profile():
    value = profile("fea")
    value["files"].update({name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
        ("backend/vision/verification.py", "backend/vision/benchmarks.py", "backend/vision/verification_worker.py", "backend/vision/jobs.py")})
    return value


def beam_reference(values):
    from .contracts import BeamReference
    inputs = BeamReference.model_validate(values).model_dump()
    length, width, height = (inputs[key] for key in ("length_mm", "width_mm", "height_mm"))
    elastic, force = inputs["elastic_modulus_mpa"], inputs["force_n"]
    area, inertia = width * height, width * height ** 3 / 12
    axial = inputs["kind"] == "axial"
    displacement = force * length / (elastic * area) if axial else force * length ** 3 / (3 * elastic * inertia)
    stress = force / area if axial else force * length * height / (2 * inertia)
    warnings = []
    if length / height < 10 and not axial:
        warnings.append("长高比小于10，Euler–Bernoulli细长梁假设可能不适用。")
    if displacement / length > .05:
        warnings.append("理论位移超过长度的5%，小变形假设需进一步核对。")
    return {"schema": "vision.beam-reference/1", "inputs": inputs, "area_mm2": area, "inertia_mm4": inertia,
        "displacement_mm": displacement, "stress_mpa": stress, "mass_kg": area * length * 1e-9 * inputs["density_kg_m3"],
        "strain_energy_mj": .5 * force * displacement, "formula": "δ = FL / (EA)" if axial else "δ = FL³ / (3EI), I = bh³ / 12",
        "warnings": warnings, "meaning": "独立矩形等截面梁理论参考；X为梁轴、Y为宽、Z为高，弯曲载荷沿Z。不是当前CAD零件的仿真结果。"}


def create(workspace, request):
    execution = execution_settings("fea")
    execution["profile"] = solver_profile()
    def action(db):
        if db.execute("SELECT 1 FROM verification_runs WHERE state IN ('queued','running','cancelling') LIMIT 1").fetchone():
            raise Conflict("已有求解器校核排队或执行，请等待完成或先取消。")
        run, now = identity(), time.time()
        db.execute("INSERT INTO verification_runs VALUES(?,?,?, ?,NULL,NULL,NULL,?,?)",
                   (run, request["suite"], "queued", packed({"execution": execution}), now, now))
        return {"run_id": run, "state": "queued"}
    return workspace.command("workspace", request, action)


def get(workspace, run):
    with workspace.db() as db:
        row = db.execute("SELECT * FROM verification_runs WHERE id=?", (run,)).fetchone()
    if not row:
        raise Missing("solver verification unavailable")
    value = dict(row)
    value["result"] = json.loads(value["result"]) if value["result"] else None
    value["current_runtime"] = json.loads(value.pop("input"))["execution"]["profile"] == solver_profile()
    return value


def state(workspace, run):
    with workspace.db() as db:
        row = db.execute("SELECT state FROM verification_runs WHERE id=?", (run,)).fetchone()
    if not row:
        raise Missing("solver verification unavailable")
    return {"state": row[0]}


def list_runs(workspace):
    with workspace.db() as db:
        rows = db.execute("SELECT id,suite,state,error,phase,created,updated,result,input FROM verification_runs ORDER BY created DESC LIMIT 20").fetchall()
    current = solver_profile()
    result = []
    for row in rows:
        value = dict(row)
        report = json.loads(value.pop("result")) if value["result"] else None
        value["passed"] = report.get("passed") if report else None
        value["current_runtime"] = json.loads(value.pop("input"))["execution"]["profile"] == current
        result.append(value)
    return result


def claim(workspace):
    with workspace.db() as db:
        row = db.execute("SELECT * FROM verification_runs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
        if not row:
            return None
        db.execute("UPDATE verification_runs SET state='running',updated=? WHERE id=?", (time.time(), row["id"]))
    return {**dict(row), "kind": "verification", "input": json.loads(row["input"])}


def cancel(workspace, run):
    with workspace.db() as db:
        row = db.execute("SELECT state FROM verification_runs WHERE id=?", (run,)).fetchone()
        if not row:
            raise Missing("solver verification unavailable")
        if row[0] in ("cancelled", "cancelling"):
            return {"state": row[0]}
        if row[0] not in ("queued", "running"):
            raise Conflict("verification is already terminal")
        state = "cancelled" if row[0] == "queued" else "cancelling"
        db.execute("UPDATE verification_runs SET state=?,updated=? WHERE id=?", (state, time.time(), run))
    return {"state": state}


def stage(workspace, run, detail):
    with workspace.db() as db:
        db.execute("UPDATE verification_runs SET phase=?,updated=? WHERE id=? AND state IN ('running','cancelling')", (detail[:500], time.time(), run))


def validate_report(report, expected):
    from .benchmarks import acceptance
    if report.get("schema") != "vision.solver-check/1" or report.get("profile") != expected:
        raise ValueError("solver verification identity mismatch")
    try:
        if report.get("passed") is not acceptance(report):
            raise ValueError("solver verification conclusion mismatch")
    except (KeyError, TypeError) as error:
        raise ValueError("incomplete solver verification evidence") from error
    # Reject non-finite or invalid JSON before committing numerical evidence.
    packed(report)


def finish(workspace, run, state, result=None, error=None):
    with workspace.db() as db:
        row = db.execute("SELECT * FROM verification_runs WHERE id=?", (run,)).fetchone()
    if not row:
        raise Missing("solver verification unavailable")
    if state == "succeeded":
        expected = json.loads(row["input"])["execution"]["profile"]
        validate_report(result, expected)
        if expected != solver_profile() or result.get("suite") != row["suite"]:
            raise ValueError("implementation changed during verification; rerun checks")
    with workspace.db() as db:
        current = db.execute("SELECT state FROM verification_runs WHERE id=?", (run,)).fetchone()
        if current[0] not in ("running", "cancelling"):
            raise Conflict("verification is not running")
        if current[0] == "cancelling":
            state, result = "cancelled", None
        db.execute("UPDATE verification_runs SET state=?,result=?,error=?,updated=? WHERE id=?",
            (state, packed(result) if result else None, error, time.time(), run))


def recover(workspace):
    with workspace.db() as db:
        db.execute("UPDATE verification_runs SET state='interrupted',error='校核被中断，需手动重新运行。',updated=? WHERE state IN ('running','cancelling')", (time.time(),))


def latest_evidence(workspace):
    current = next((run for run in list_runs(workspace) if run["state"] == "succeeded" and run["current_runtime"]), None)
    return {"report": get(workspace, current["id"])["result"] if current else None,
            "meaning": "求解器独立基准证据；不代表当前零件已经求解或满足要求。"}
