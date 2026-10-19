"""Immutable local CAD artifacts. All filenames and IDs are checked at the boundary."""
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent / ".cad_artifacts"
FILES = {"model.usda", "preview.stl", "manifest.json", "source.py", "request.json"}


def artifact_path(identity):
    if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise ValueError("invalid CAD artifact id")
    path = ROOT / identity
    if not (path / "manifest.json").is_file():
        raise FileNotFoundError("CAD artifact is unavailable on this backend; import its USD/archive or rebuild")
    return path


def publish(directory, manifest):
    directory = Path(directory)
    digest = hashlib.sha256()
    files = FILES | {file.name for file in directory.glob("body-*.*")}
    for name in sorted(files - {"manifest.json"}):
        file = directory / name
        if file.is_file():
            digest.update(name.encode())
            digest.update(file.read_bytes())
    identity = digest.hexdigest()
    destination = ROOT / identity
    destination.mkdir(parents=True, exist_ok=True)
    for name in files - {"manifest.json"}:
        file = directory / name
        if file.is_file():
            (destination / name).write_bytes(file.read_bytes())
    manifest = {**manifest, "artifactId": identity}
    # Manifest is the commit marker: failed builds are never published.
    temp = destination / "manifest.tmp"
    temp.write_text(json.dumps(manifest, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temp.replace(destination / "manifest.json")
    return manifest


def read_file(identity, filename):
    if filename not in FILES and not re.fullmatch(r"body-[0-9]+\.(stl|brep)", filename):
        raise ValueError("unsupported CAD artifact file")
    return (artifact_path(identity) / filename).read_bytes()


def archive(identity):
    path = artifact_path(identity)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as output:
        for name in sorted(FILES | {file.name for file in path.glob("body-*.*")}):
            if (path / name).is_file():
                output.write(path / name, name)
    return buffer.getvalue()


def import_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        if sum(info.file_size for info in bundle.infolist()) > 128 * 1024 * 1024:
            raise ValueError("CAD archive expands beyond 128 MiB")
        if "model.usda" not in bundle.namelist():
            raise ValueError("CAD archive has no model.usda")
        # Never extract or execute a stored script. Import only the geometric USD.
        return bundle.read("model.usda")
