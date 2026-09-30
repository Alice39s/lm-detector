"""Invoke the unchanged frozen study inference code from this package."""
from pathlib import Path
import runpy
import sys

study = Path(__file__).resolve().parent / "source/research/studies/sequence-generalization"
sys.path.insert(0, str(study))
runpy.run_path(str(study / "infer.py"), run_name="__main__")
