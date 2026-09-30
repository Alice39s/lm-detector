"""Replay the first frozen fusion against exported evaluation inputs, without fitting."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from scipy.special import softmax

BUNDLE = Path(__file__).resolve().parent
SOURCE = BUNDLE / "source"
RUN = SOURCE / "research/reports/sequence-generalization/20260930"
sys.path.insert(0, str(SOURCE / "research/studies/sequence-generalization"))
from evaluate import metrics, save  # noqa: E402
from fusion import load_artifact, score_groups  # noqa: E402


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=RUN / "evaluation-data.json")
    parser.add_argument("--output", type=Path, default=BUNDLE / "generated/frozen-fusion-replay.json")
    args = parser.parse_args()
    bundle = json.loads((BUNDLE / "bundle.json").read_text())
    data = json.loads(args.data.read_text())
    freeze = RUN / "candidate-freeze.json"
    if data["candidate_freeze_sha256"] != sha(freeze):
        raise ValueError("Evaluation data uses a different original candidate freeze")
    artifact_path = BUNDLE / bundle["winner"]["artifact"]
    if sha(artifact_path) != bundle["winner"]["artifact_sha256"]:
        raise ValueError("The pre-expansion winner changed")
    artifact = load_artifact(artifact_path)
    if artifact["model_ids"] != data["model_ids"] or artifact["reference_sha256"] != bundle["reference"]["reference_sha256"]:
        raise ValueError("Artifact gallery/reference mismatch")
    result = {"schema": "frozen-fusion-package-replay-v1", "artifact_sha256": sha(artifact_path),
              "evaluation_data_sha256": sha(args.data), "reference_sha256": artifact["reference_sha256"],
              "selection": bundle["winner"]["selection"], "training_performed": False, "datasets": {}}
    for name, dataset in data["datasets"].items():
        groups = dataset["groups"]
        scores = score_groups(artifact, [group["numbers"] for group in groups])
        probabilities = softmax(scores * artifact["beta"], axis=1)
        if not np.isfinite(scores).all() or not np.allclose(probabilities.sum(axis=1), 1):
            raise ValueError("Invalid frozen scores")
        baseline_scores = np.asarray([group["baseline_scores"] for group in groups])
        baseline_probabilities = np.asarray([group["baseline_probabilities"] for group in groups])
        result["datasets"][name] = {"planned_groups": dataset["planned_groups"], "complete_groups": len(groups),
            "methods": {"current_product": metrics(baseline_scores, baseline_probabilities, groups, artifact["model_ids"]),
                        "generic_fusion": metrics(scores, probabilities, groups, artifact["model_ids"])}}
        print(name, "generic_fusion", result["datasets"][name]["methods"]["generic_fusion"]["correct"], "/", len(groups), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    save(args.output, result)


if __name__ == "__main__":
    main()
