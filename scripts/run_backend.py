"""Launch the project-local numerical runtime if installed."""
import subprocess
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
runtime = root / ".python313" / "python.exe"
python = str(runtime) if runtime.is_file() else sys.executable
try:
    sys.exit(subprocess.call([python, str(root / "server" / "engineering_server.py")]))
except KeyboardInterrupt:
    sys.exit(130)
