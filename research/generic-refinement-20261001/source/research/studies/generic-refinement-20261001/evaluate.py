"""Evaluate a frozen candidate; never train or select against evaluation inputs."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "1"

import argparse
import hashlib
import importlib
import json

import numpy as np
from scipy.special import softmax

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "projects/research/sequence-generalization-20260930"
SNAPSHOT = BUNDLE / "source"
sys.path[:0] = [str(SNAPSHOT / "research/studies/sequence-generalization"), str(SNAPSHOT / "projects/offline")]
from classifiers import save, sha
from evaluate import metrics, disjoint_accumulation
from fingerprint import parse_numbers
import fusion

OUT = ROOT / "research/reports/generic-refinement-20261001/evaluation"


def verify_freeze(path):
    freeze = json.loads(path.read_text())
    for relative, digest in freeze["hashes"].items():
        if sha(ROOT / relative) != digest:
            raise ValueError(f"Frozen input changed: {relative}")
    return freeze


def prospective_groups(directory, ids, freeze_path):
    manifest_path, sample_path = directory / "manifest.json", directory / "samples.jsonl"
    integrity_path = directory / "integrity.json"
    integrity = json.loads(integrity_path.read_text())
    verifier_path = Path(__file__).with_name("verify-prospective.ts")
    if (integrity.get("schema") != "generic-refinement-prospective-integrity-v1"
            or integrity.get("status") != "complete" or integrity.get("errors")
            or integrity.get("current_source_hashes_match") is not True
            or integrity.get("manifest_sha256") != sha(manifest_path)
            or integrity.get("samples_sha256") != sha(sample_path)
            or integrity.get("candidate_freeze_sha256") != sha(freeze_path)
            or integrity.get("verifier_sha256") != sha(verifier_path)
            or integrity.get("collector_sha256") != sha(Path(__file__).with_name("collect.ts"))
            or integrity.get("protocol_sha256") != sha(Path(__file__).with_name("collection-protocol.json"))):
        raise ValueError("A complete, current, independently replayed blind-collection audit is required")
    for path, digest in integrity["current_source_hashes"].items():
        if sha(ROOT / path) != digest:
            raise ValueError(f"Collection source changed after its integrity audit: {path}")
    if (directory / ".collect-lock").exists():
        raise ValueError("The prospective collector is still locked")
    manifest = json.loads(manifest_path.read_text())
    if manifest["candidate_freeze_sha256"] != sha(freeze_path):
        raise ValueError("Blind cohort belongs to a different candidate freeze")
    selected = {}
    for record in sorted([json.loads(line) for line in sample_path.read_text().splitlines() if line],
                         key=lambda row: row["attempt"]):
        if record["status"] == "accepted":
            numbers = parse_numbers(record["text"])
            compact = json.dumps(numbers, separators=(",", ":"))
            if hashlib.sha256(compact.encode()).hexdigest() != record["sequence_sha256"]:
                raise ValueError("Python and collector integer-sequence parsing differ")
            selected.setdefault(record["sample_id"], record)
    groups = []
    for round_id in sorted({record["round_id"] for record in selected.values()}):
        for label in ids:
            records = sorted([record for record in selected.values() if record["round_id"] == round_id
                              and record["model"] == label], key=lambda row: row["challenge_id"])
            if len(records) == 3:
                groups.append(dict(id=f"{label}:{round_id}", model=label,
                                   numbers=[parse_numbers(record["text"]) for record in records],
                                   sample_ids=[record["sample_id"] for record in records],
                                   round_id=round_id, cluster=round_id))
    if len(selected) != 120 or len(groups) != 40:
        raise ValueError("Blind evaluation requires all 120 planned answers and 40 complete groups")
    return groups, dict(manifest_sha256=sha(manifest_path), samples_sha256=sha(sample_path),
                        integrity_sha256=sha(integrity_path),
                        accepted_answers=len(selected), attempts=sum(1 for line in sample_path.read_text().splitlines() if line))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--freeze", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--module", required=True)
    parser.add_argument("--calibration", type=Path)
    parser.add_argument("--prospective", type=Path)
    parser.add_argument("--output", type=Path, default=OUT / "results.json")
    args = parser.parse_args()
    args.freeze, args.artifact = args.freeze.resolve(), args.artifact.resolve()
    if args.calibration:
        args.calibration = args.calibration.resolve()
    if args.prospective:
        args.prospective = args.prospective.resolve()
    freeze = verify_freeze(args.freeze)
    if freeze["hashes"].get(str(args.artifact.relative_to(ROOT))) != sha(args.artifact):
        raise ValueError("Evaluation artifact is not bound by the freeze")
    module = importlib.import_module(args.module)
    candidate = module.load_artifact(args.artifact)
    if args.calibration:
        if freeze["hashes"].get(str(args.calibration.relative_to(ROOT))) != sha(args.calibration):
            raise ValueError("Calibration is not bound by the candidate freeze")
        calibration = json.loads(args.calibration.read_text())
        if calibration["artifact_sha256"] != sha(args.artifact):
            raise ValueError("Calibration belongs to a different artifact")
        candidate["beta"] = calibration["beta"]
    first_path = SNAPSHOT / "research/reports/sequence-generalization/20260930/fusion/fitted.joblib"
    first = fusion.load_artifact(first_path)
    if candidate["model_ids"] != first["model_ids"] or candidate["reference_sha256"] != first["reference_sha256"]:
        raise ValueError("Candidate and comparator use different galleries or references")
    ids = candidate["model_ids"]
    data_path = SNAPSHOT / "research/reports/sequence-generalization/20260930/evaluation-data.json"
    data = json.loads(data_path.read_text())
    if data["model_ids"] != ids:
        raise ValueError("Regression gallery differs")
    datasets = {name: dict(groups=dataset["groups"], role="seen-regression",
                          planned_groups=dataset["planned_groups"])
                for name, dataset in data["datasets"].items()}
    prospective_binding = None
    if args.prospective:
        groups, prospective_binding = prospective_groups(args.prospective, ids, args.freeze)
        datasets["prospective_v2"] = dict(groups=groups, role="blind-prospective", planned_groups=40)
    result = dict(candidate_freeze_sha256=sha(args.freeze), artifact_sha256=sha(args.artifact),
                  evaluator_sha256=sha(Path(__file__)), evaluation_data_sha256=sha(data_path),
                  reference_sha256=candidate["reference_sha256"], prospective=prospective_binding,
                  probability_scope="53-label development closed-set temperature; identity confidence is unverified.",
                  fitting_performed=False, candidate_changed_after_evaluation=False, datasets={})
    for name, dataset in datasets.items():
        groups = dataset["groups"]
        numbers = [group["numbers"] for group in groups]
        scores = module.score_groups(candidate, numbers)
        first_scores = fusion.score_groups(first, numbers)
        baseline_scores = np.asarray([score for score, _ in first["_loaded"]["rerank"]["base"].score_groups(numbers)])
        values = {}
        for method, ranking, beta in (("current_product", baseline_scores, None),
                                     ("first_frozen_fusion", first_scores, first["beta"]),
                                     ("candidate", scores, candidate.get("beta"))):
            if beta is None:
                # Accuracy is still meaningful; no fabricated calibrated probabilities.
                probabilities = softmax(ranking, axis=1)
            else:
                probabilities = softmax(beta * ranking, axis=1)
            values[method] = metrics(ranking, probabilities, groups, ids)
            if beta is None:
                for key in ("selected", "confidence_bins", "multiclass_nll", "multiclass_brier", "ece"):
                    values[method].pop(key, None)
                for prediction in values[method].get("predictions", []):
                    for key in ("top_probability", "truth_probability", "probabilities"):
                        prediction.pop(key, None)
            values[method]["disjoint_accumulation"] = disjoint_accumulation(ranking, groups, ids)
            if name == "prospective_v2":
                values[method]["disjoint_accumulation"] = [row for row in values[method]["disjoint_accumulation"]
                                                         if row["answers"] in (3, 15)]
            values[method]["probability_calibrated_on_development"] = beta is not None
        truth = np.asarray([ids.index(group["model"]) for group in groups])
        before, after = first_scores.argmax(1) == truth, scores.argmax(1) == truth
        values["change_from_first"] = dict(gained=int(np.sum(~before & after)), lost=int(np.sum(before & ~after)))
        result["datasets"][name] = dict(role=dataset["role"], planned_groups=dataset["planned_groups"],
                                      complete_groups=len(groups), methods=values)
        print(json.dumps(dict(dataset=name, role=dataset["role"],
              product=values["current_product"]["correct"], first=values["first_frozen_fusion"]["correct"],
              candidate=values["candidate"]["correct"], total=len(groups), change=values["change_from_first"])))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    save(args.output, result)


if __name__ == "__main__":
    main()
