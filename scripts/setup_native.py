"""Install project-local portable Python runtimes; no machine-wide changes."""
import argparse
import hashlib
import json
import concurrent.futures
import subprocess
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def package_wheel(target, name="usd-brep", version="1.0.0", tag="cp312-cp312-win_amd64.whl"):
    with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=30) as response:
        metadata = json.load(response)
    wheel = next(item for item in metadata["urls"] if item["filename"].endswith(tag))
    output = target / wheel["filename"]
    if output.is_file() and hashlib.sha256(output.read_bytes()).hexdigest() == wheel["digests"]["sha256"]:
        return output
    size, chunk = wheel["size"], 1024 * 1024
    def fetch(start):
        end = min(size, start + chunk) - 1
        request = urllib.request.Request(wheel["url"], headers={"Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 206:
                raise RuntimeError("package host does not support ranged downloads")
            data = response.read()
        if len(data) != end - start + 1:
            raise RuntimeError("truncated wheel download")
        print(f"{name} wheel {end + 1}/{size}", flush=True)
        return data
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        data = b"".join(pool.map(fetch, range(0, size, chunk)))
    if hashlib.sha256(data).hexdigest() != wheel["digests"]["sha256"]:
        raise RuntimeError("wheel SHA-256 does not match PyPI metadata")
    output.write_bytes(data)
    return output


def install(version, directory, requirements):
    target = ROOT / directory
    target.mkdir(exist_ok=True)
    executable = target / "python.exe"
    if not executable.exists():
        archive = target / "python.nupkg"
        url = f"https://api.nuget.org/v3-flatcontainer/python/{version}/python.{version}.nupkg"
        print(f"Downloading official CPython NuGet {version}", flush=True)
        with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as output:
            import shutil
            shutil.copyfileobj(response, output)
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                if info.filename.startswith("tools/") and not info.is_dir():
                    destination = target / info.filename[len("tools/"):]
                    if not destination.resolve().is_relative_to(target.resolve()):
                        raise ValueError("invalid runtime archive path")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(bundle.read(info))
        archive.unlink()
    if subprocess.run([str(executable), "-m", "pip", "--version"], capture_output=True).returncode:
        subprocess.run([str(executable), "-m", "ensurepip"], check=True)
    if requirements.endswith("requirements-usd-brep.txt"):
        wheel = package_wheel(target)
        subprocess.run([str(executable), "-m", "pip", "install", "--no-warn-script-location", str(wheel)], check=True)
    else:
        for name, version, tag in [("numpy", "2.2.6", "cp313-cp313-win_amd64.whl"), ("scipy", "1.15.3", "cp313-cp313-win_amd64.whl"), ("tetgen", "0.8.4", "cp312-abi3-win_amd64.whl")]:
            wheel = package_wheel(target, name, version, tag)
            subprocess.run([str(executable), "-m", "pip", "install", "--no-deps", "--no-warn-script-location", str(wheel)], check=True)
        subprocess.run([str(executable), "-m", "pip", "install", "--no-warn-script-location", "-r", str(ROOT / requirements)], check=True)
    print(f"Ready: {executable}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fea", action="store_true")
    args = parser.parse_args()
    install("3.12.10", ".python312", "server/requirements-usd-brep.txt")
    if args.fea:
        install("3.13.2", ".python313", "server/requirements.txt")
