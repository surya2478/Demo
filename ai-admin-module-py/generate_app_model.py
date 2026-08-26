#!/usr/bin/env python3
"""
Convenience entry point for Application Model Generator.
"""
from pathlib import Path
import sys

root_script = Path(__file__).resolve().parents[1] / "generate_app_model.py"
if root_script.exists():
    import runpy
    runpy.run_path(str(root_script), run_name="__main__")
else:
    print(f"Error: Could not locate {root_script}", file=sys.stderr)
    sys.exit(1)
