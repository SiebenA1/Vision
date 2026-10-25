"""One durable controller per workspace. Native work never holds a DB transaction."""
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from .processes import ControllerLock, ProcessTree
from .storage import Missing, packed
from . import verification


class Controller:
    def __init__(self, workspace, *, cad_timeout=240, fea_timeout=600):
        self.workspace = workspace
        self.timeouts = {"cad": cad_timeout, "fea": fea_timeout, "verification": 900}
        self.stop = threading.Event()
        self.lock = None
        self.thread = None

    def start(self):
        self.lock = ControllerLock(self.workspace.root / "controller.lock")
        try:
            self.workspace.recover()
            verification.recover(self.workspace)
            self.thread = threading.Thread(target=self.loop, name="vision-jobs", daemon=True)
            self.thread.start()
        except BaseException:
            self.lock.close()
            self.lock = None
            raise

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError("native controller did not stop; ownership lock retained")
        if self.lock:
            self.lock.close()
            self.lock = None

    def loop(self):
        while not self.stop.is_set():
            try:
                job = self.workspace.claim() or verification.claim(self.workspace)
                if job:
                    self.run(job)
            except Exception:
                logging.exception("workspace job controller failure")
            self.stop.wait(.1)

    def run(self, job):
        checking = job["kind"] == "verification"
        directory = self.workspace.root / ("verification-runs" if checking else "runs") / job["id"]
        read = (lambda run: verification.state(self.workspace, run)) if checking else self.workspace.job
        stage = (lambda run, detail: verification.stage(self.workspace, run, detail)) if checking else self.workspace.stage
        finish = (lambda *args, **kwargs: verification.finish(self.workspace, *args, **kwargs)) if checking else self.workspace.finish
        process, tree = None, None
        state, result, error = "failed", None, None
        try:
            directory.mkdir(parents=True)
            (directory / "job.json").write_text(packed(job), encoding="utf-8")
            env = os.environ.copy()
            env.pop("PYTHONPATH", None)
            env.pop("PYTHONHOME", None)
            env.pop("DEEPSEEK_API_KEY", None)
            env["PYTHONUTF8"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            with (directory / "stdout.log").open("w", encoding="utf-8") as stdout, (directory / "stderr.log").open("w", encoding="utf-8") as stderr:
                process = subprocess.Popen([sys.executable, "-I", "-X", "utf8", "-u", str(Path(__file__).with_name("verification_worker.py" if checking else "native.py")),
                                            str(self.workspace.root), str(directory)], cwd=directory,
                                           env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                           text=True, encoding="utf-8", start_new_session=os.name != "nt",
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                tree = ProcessTree(process, memory_limit_mib=job["input"]["execution"].get("memory_limit_mib"))
                process.stdin.write("start\n")
                process.stdin.close()
                deadline = time.monotonic() + self.timeouts[job["kind"]]
                offset, unfinished = 0, b""
                def stages():
                    nonlocal offset, unfinished
                    with (directory / "stdout.log").open("rb") as log:
                        log.seek(offset)
                        chunk = log.read(65536)
                        offset += len(chunk)
                    lines = (unfinished + chunk).split(b"\n")
                    unfinished = lines.pop()[-4096:]
                    for line in lines:
                        detail = line.decode("utf-8", errors="replace").strip()
                        if detail.startswith(("stage:", "assembly:", "solve:", "CG iteration")):
                            stage(job["id"], detail)
                while process.poll() is None:
                    stages()
                    if self.stop.is_set() or read(job["id"])["state"] == "cancelling":
                        state = "interrupted" if self.stop.is_set() else "cancelled"
                        tree.terminate()
                        process.wait(timeout=10)
                        break
                    if time.monotonic() > deadline:
                        state = "timed_out"
                        error = "native attempt exceeded its execution budget"
                        tree.terminate()
                        process.wait(timeout=10)
                        break
                    self.stop.wait(.1)
                else:
                    receipt_path = directory / "receipt.json"
                    if not receipt_path.exists():
                        raise RuntimeError(f"native worker exited {process.returncode} without a receipt; see run logs")
                    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                    if process.returncode or "error" in receipt:
                        raise RuntimeError(receipt.get("error", f"native worker exited {process.returncode}"))
                    result, state = receipt["result"], "succeeded"
                stages()
        except Exception as failure:
            error = f"{type(failure).__name__}: {failure}"
        finally:
            if process and process.poll() is None:
                if tree:
                    tree.terminate()
                else:
                    process.kill()
                process.wait(timeout=10)
            if tree:
                tree.close()
        try:
            finish(job["id"], state, result, error)
        except (ValueError, Missing, OSError) as failure:
            finish(job["id"], "failed", error=f"result verification failed: {failure}")
