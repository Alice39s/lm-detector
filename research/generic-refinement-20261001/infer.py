"""Score three replies with the frozen development-selected general ranker."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "1"

import argparse
import hashlib
import json

import numpy as np
from scipy.special import softmax

BUNDLE = Path(__file__).resolve().parent
SOURCE = BUNDLE / "source"
STUDY = SOURCE / "research/studies/generic-refinement-20261001"
sys.path.insert(0, str(STUDY))
import portfolio


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="JSON array with three texts or integer arrays")
    args = parser.parse_args()
    run = SOURCE / "research/reports/generic-refinement-20261001/portfolio"
    artifact_path, calibration_path, freeze_path = run / "fitted.joblib", run / "calibration.json", run / "freeze.json"
    freeze = json.loads(freeze_path.read_text())
    for path, digest in freeze["hashes"].items():
        if sha(SOURCE / path) != digest:
            raise ValueError(f"Frozen inference input changed: {path}")
    replies = json.loads(args.input.read_text())
    if not isinstance(replies, list) or len(replies) != 3:
        raise ValueError("Input must contain exactly three replies")
    from fingerprint import parse_numbers
    numbers = []
    for reply in replies:
        if isinstance(reply, str):
            values = parse_numbers(reply)
        elif isinstance(reply, list) and all(isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 355 for value in reply):
            values = reply
        else:
            raise ValueError("Each reply must be text or a 1..355 integer array")
        if len(values) < 80:
            raise ValueError("Each reply requires at least 80 parsed integers")
        numbers.append(values)
    artifact = portfolio.load_artifact(artifact_path)
    calibration = json.loads(calibration_path.read_text())
    if calibration["artifact_sha256"] != sha(artifact_path):
        raise ValueError("Temperature belongs to another ranker")
    scores = portfolio.score_groups(artifact, [numbers])[0]
    probabilities = softmax(scores * calibration["beta"])
    if not np.isfinite(scores).all() or not np.isfinite(probabilities).all():
        raise ValueError("Invalid frozen scores")
    order = np.argsort(-scores, kind="stable")
    print(json.dumps(dict(algorithm=artifact["schema"], reference_sha256=artifact["reference_sha256"],
        artifact_sha256=sha(artifact_path), answers=3,
        probability_scope="Development closed-set ranking over 53 labels; verified identity confidence unavailable.",
        top5=[dict(model=artifact["model_ids"][index], score=float(scores[index]),
                   development_probability=float(probabilities[index])) for index in order[:5]]), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
