"""Run: .python313/python.exe -m backend.vision --port 8112."""
import argparse
from pathlib import Path

import uvicorn

from .api import create_app


def main():
    parser = argparse.ArgumentParser(description="VISION local v2 engineering core")
    parser.add_argument("--port", type=int, default=8112)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[2] / ".vision-workspace")
    args = parser.parse_args()
    uvicorn.run(create_app(args.workspace), host="127.0.0.1", port=args.port, workers=1)


if __name__ == "__main__":
    main()
