"""Score the complete, audited v2 cohort after technical retry continuation.

The original candidate, temperature and source freeze stay byte-identical.
This entry point only reads independently verified acquisition amendments.
"""
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

import portfolio
import source_robust as source
from evaluate import metrics, disjoint_accumulation
from fingerprint import parse_numbers

ROOT = source.ROOT
RUN = ROOT / "research/reports/generic-refinement-20261001"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=RUN / "prospective-v2")
    parser.add_argument("--output", type=Path, default=RUN / "evaluation/blind-v2.json")
    args = parser.parse_args()
    directory = args.directory.resolve()
    integrity_path = directory / "combined-integrity.json"
    integrity = json.loads(integrity_path.read_text())
    if (integrity["schema"] != "generic-refinement-combined-prospective-integrity-v1"
            or integrity["status"] != "complete" or integrity["errors"]
            or integrity["accepted_slots"] != 120 or integrity["complete_groups"] != 40):
        raise ValueError("A complete, current original-and-continuation audit is required")
    for path, digest in integrity["bindings"].items():
        if source.sha(ROOT / path) != digest:
            raise ValueError(f"Audited acquisition file changed: {path}")
    freeze_path = RUN / "portfolio/freeze.json"
    if source.sha(freeze_path) != integrity["candidate_freeze_sha256"]:
        raise ValueError("Candidate changed after blind sampling began")
    freeze = json.loads(freeze_path.read_text())
    for path, digest in freeze["hashes"].items():
        if source.sha(ROOT / path) != digest:
            raise ValueError(f"Original frozen candidate input changed: {path}")
    original = json.loads((directory / "manifest.json").read_text())
    records = {}
    for name, filename in (("original", "samples.jsonl"), ("supplemental", "supplemental-samples.jsonl")):
        for line in (directory / filename).read_text().splitlines():
            if line:
                row = json.loads(line)
                key = (name, row["sample_id"], row["attempt"])
                if key in records:
                    raise ValueError("Duplicate physical attempt identity")
                records[key] = row
    adoption = json.loads((directory / "adoption.json").read_text())
    if isinstance(adoption, dict):
        adoption = adoption["selection"]
    selected = {}
    for item in adoption:
        key = (item["record_source"], item["sample_id"], item["attempt"])
        row = records[key]
        if row["status"] != "accepted" or row["sample_id"] in selected:
            raise ValueError("Adoption must contain one accepted attempt per planned slot")
        numbers = parse_numbers(row["text"])
        compact = json.dumps(numbers, separators=(",", ":"))
        if hashlib.sha256(compact.encode()).hexdigest() != row["sequence_sha256"]:
            raise ValueError("Collector and Python integer parsing differ")
        earlier = [record for (_, sample_id, attempt), record in records.items()
                   if sample_id == row["sample_id"] and attempt < row["attempt"] and record["status"] == "accepted"]
        if earlier:
            raise ValueError("Adoption skipped an earlier eligible attempt")
        selected[row["sample_id"]] = row
    groups, expected_ids = [], set()
    for round in original["rounds"]:
        for model in original["models"]:
            numbers, sample_ids = [], []
            for position, challenge in enumerate(round["challenges"], 1):
                sample_id = f"{original['id']}__{model}__{round['id']}__{position}"
                expected_ids.add(sample_id)
                row = selected[sample_id]
                if (row["model"] != model or row["round_id"] != round["id"]
                        or row["challenge_id"] != challenge["id"] or row["prompt"] != challenge["prompt"]):
                    raise ValueError("Adopted response differs from the original matched challenge")
                numbers.append(parse_numbers(row["text"]))
                sample_ids.append(sample_id)
            groups.append(dict(id=f"{model}:{round['id']}", model=model, numbers=numbers,
                               sample_ids=sample_ids, cluster=round["id"]))
    if set(selected) != expected_ids or len(groups) != 40:
        raise ValueError("Expected all 120 original matched slots and 40 complete groups")
    artifact_path = RUN / "portfolio/fitted.joblib"
    artifact = portfolio.load_artifact(artifact_path)
    calibration = json.loads((RUN / "portfolio/calibration.json").read_text())
    if calibration["artifact_sha256"] != source.sha(artifact_path):
        raise ValueError("Temperature belongs to another ranker")
    first = source.fusion.load_artifact(source.RUN / "fusion/fitted.joblib")
    if first["model_ids"] != artifact["model_ids"] or first["reference_sha256"] != artifact["reference_sha256"]:
        raise ValueError("The frozen comparators use different galleries")
    ids = artifact["model_ids"]
    if len(ids) != 53 or len(set(ids)) != 53:
        raise ValueError("Blind evaluation requires the complete 53-label gallery")
    numbers = [group["numbers"] for group in groups]
    candidate_scores = portfolio.score_groups(artifact, numbers)
    first_scores = source.fusion.score_groups(first, numbers)
    baseline_scores = np.asarray([scores for scores, _ in first["_loaded"]["rerank"]["base"].score_groups(numbers)])
    result = dict(schema="generic-refinement-blind-v2-results-v1", role="blind-prospective",
                  complete_groups=40, accepted_answers=120, gallery_labels=53,
                  paired_clusters=20,
                  candidate_freeze_sha256=source.sha(freeze_path), artifact_sha256=source.sha(artifact_path),
                  combined_integrity_sha256=source.sha(integrity_path), evaluator_sha256=source.sha(Path(__file__)),
                  probability_scope="Development closed-set temperature; verified identity confidence unavailable.",
                  precision_interval_scope="Threshold binomial lower bounds are exploratory per-decision bounds, not matched-cluster-adjusted identity precision. Accumulated answers have only four matched blocks and no calibrated probability.",
                  fitting_performed=False, candidate_changed_after_sampling=False, methods={})
    for name, scores, beta in (("current_product", baseline_scores, None),
                               ("first_frozen_fusion", first_scores, first["beta"]),
                               ("candidate", candidate_scores, calibration["beta"])):
        if scores.shape != (40, 53) or not np.isfinite(scores).all():
            raise ValueError("Expected finite scores for 40 groups and 53 labels")
        probabilities = softmax(scores * (beta if beta is not None else 1), axis=1)
        summary = metrics(scores, probabilities, groups, ids)
        if beta is None:
            for key in ("selected", "multiclass_nll", "multiclass_brier", "ece"):
                summary.pop(key, None)
            for prediction in summary["predictions"]:
                for key in ("top_probability", "truth_probability", "probabilities"):
                    prediction.pop(key, None)
        summary["disjoint_accumulation"] = [row for row in disjoint_accumulation(scores, groups, ids) if row["answers"] in (3, 15)]
        for row in summary["disjoint_accumulation"]:
            row["paired_clusters"] = row["total"] // 2
        summary["probability_calibrated_on_development"] = beta is not None
        result["methods"][name] = summary
        print(json.dumps(dict(method=name, correct=summary["correct"], total=40,
                             accumulation=summary["disjoint_accumulation"])))
    truth = np.asarray([ids.index(group["model"]) for group in groups])
    before, after = first_scores.argmax(1) == truth, candidate_scores.argmax(1) == truth
    result["change_from_first"] = dict(gained=int(np.sum(~before & after)), lost=int(np.sum(before & ~after)))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    source.save(args.output, result)


if __name__ == "__main__":
    main()
