"""Run the research ranker on exactly three replies without enrolling data."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.special import softmax

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "projects/offline"))
from fingerprint import parse_numbers
from fusion import load_artifact, score_groups


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="JSON array of three reply texts or integer arrays")
    parser.add_argument("--artifact", type=Path, default=ROOT / "research/reports/sequence-generalization/20260930/fusion/fitted.joblib")
    args = parser.parse_args()
    replies = json.loads(args.input.read_text())
    if not isinstance(replies, list) or len(replies) != 3:
        raise ValueError("Provide exactly three replies")
    numbers = [parse_numbers(reply) if isinstance(reply, str) else reply for reply in replies]
    if any(not isinstance(reply, list) or len(reply) < 80 or
           any(type(value) is not int or not 1 <= value <= 355 for value in reply) for reply in numbers):
        raise ValueError("Each reply needs at least 80 integers in 1..355")
    artifact = load_artifact(args.artifact)
    scores = score_groups(artifact, [numbers])[0]
    probabilities = softmax(artifact["beta"] * scores)
    order = np.argsort(-scores, kind="stable")
    result = dict(prediction=artifact["model_ids"][order[0]],
                  probability_scope="53-label closed set; reference-development calibration; not authenticated identity",
                  results=[dict(model=artifact["model_ids"][i], score=float(scores[i]), probability=float(probabilities[i])) for i in order[:5]])
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
