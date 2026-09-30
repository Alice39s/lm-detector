"""Select a predeclared all-gallery fusion using reference development folds.

Inference accepts parsed integer triples only. Hash checks bind each component
to the frozen reference and the source code used during candidate selection.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "1"

import argparse
import importlib
import json

import joblib
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "projects/research/sequence-generalization-20260930"
SNAPSHOT = BUNDLE / "source"
STUDY = SNAPSHOT / "research/studies/sequence-generalization"
RUN = ROOT / "research/reports/generic-refinement-20261001"
sys.path[:0] = [str(STUDY), str(SNAPSHOT / "projects/offline")]
from classifiers import confidence_metrics, fit_temperature, metrics, save, sha, z
import fusion

NAMES = ("first_frozen", "groups", "rank_sequence", "source_robust")
REFERENCE_SHA = "5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4"


def component_module(name):
    return fusion if name == "first_frozen" else importlib.import_module(
        {"groups": "group_models"}.get(name, name))


def load_artifact(path):
    artifact = joblib.load(path)
    if artifact["schema"] != "generic-refinement-fusion-v1" or artifact["reference_sha256"] != REFERENCE_SHA:
        raise ValueError("Unexpected refinement artifact")
    for relative, digest in artifact["source_hashes"].items():
        if sha(ROOT / relative) != digest:
            raise ValueError(f"Frozen source changed: {relative}")
    loaded = {}
    for component, weight in zip(artifact["components"], artifact["weights"]):
        component_path = ROOT / component["path"]
        if sha(component_path) != component["sha256"]:
            raise ValueError(f"Frozen component changed: {component['name']}")
        if weight:
            fitted = component_module(component["name"]).load_artifact(component_path)
            if fitted["model_ids"] != artifact["model_ids"] or fitted["reference_sha256"] != REFERENCE_SHA:
                raise ValueError("Component gallery or reference differs")
            loaded[component["name"]] = fitted
    artifact["_loaded"] = loaded
    return artifact


def score_groups(artifact, groups):
    if any(len(group) != 3 for group in groups):
        raise ValueError("This artifact requires exactly three replies per group")
    output = np.zeros((len(groups), len(artifact["model_ids"])))
    for component, weight in zip(artifact["components"], artifact["weights"]):
        if weight:
            name = component["name"]
            output += weight * z(component_module(name).score_groups(artifact["_loaded"][name], groups))
    return output


def align(data, ids, group_ids, truth, values):
    if list(data["model_ids"]) != ids:
        raise ValueError("Component model order differs")
    source_ids = list(data["group_ids"])
    if len(source_ids) != len(set(source_ids)) or set(source_ids) != set(group_ids):
        raise ValueError("Component group IDs differ or repeat")
    positions = {group_id: index for index, group_id in enumerate(source_ids)}
    order = np.asarray([positions[group_id] for group_id in group_ids])
    if not np.array_equal(data["y"][order], truth):
        raise ValueError("Component truth differs")
    return np.asarray(values)[order]


def select():
    output = RUN / "fusion"
    output.mkdir(parents=True, exist_ok=True)
    paths = [ROOT / "research/reports/sequence-generalization/20260930/fusion/reference-oof.npz",
             RUN / "groups/reference-oof.npz", RUN / "rank-sequence/reference-oof.npz",
             RUN / "source-robust/reference-oof.npz"]
    artifact_paths = [SNAPSHOT / "research/reports/sequence-generalization/20260930/fusion/fitted.joblib",
                      RUN / "groups/fitted.joblib", RUN / "rank-sequence/fitted.joblib",
                      RUN / "source-robust/fitted.joblib"]
    weights = [np.asarray((a, b, c, 4 - a - b - c)) / 4
               for a in range(5) for b in range(5 - a) for c in range(5 - a - b)]
    if len(weights) != 35:
        raise ValueError("The predefined grid must contain 35 weights")
    source_files = [Path(__file__), Path(__file__).with_name("PROTOCOL.md"), BUNDLE / "bundle.json",
                    BUNDLE / "requirements.txt", *[Path(__file__).with_name(name) for name in
                    ("group_models.py", "rank_sequence.py", "source_robust.py")]]
    source_hashes = {str(path.relative_to(ROOT)): sha(path) for path in source_files}
    plan = dict(component_names=NAMES, weights=[weight.tolist() for weight in weights],
                selection="Highest all-gallery Top1; then fewer nonzero components, then fixed grid order.",
                source_hashes=source_hashes,
                oof_hashes={str(path.relative_to(ROOT)): sha(path) for path in paths},
                fixed_holdout_opened=False, paired_cohort_used_for_weight_selection=False)
    save(output / "plan.json", plan)
    first = np.load(paths[0])
    ids, group_ids, truth = list(first["model_ids"]), list(first["group_ids"]), first["y"]
    scores = [np.asarray(first["scores"])]
    source_results = json.loads((RUN / "source-robust/results.json").read_text())
    for index, path in enumerate(paths[1:], 1):
        data = np.load(path)
        values = data["scores"]
        if index == 3:
            values = values[source_results["winner"]["index"]]
        scores.append(align(data, ids, group_ids, truth, values))
    scores = np.stack(scores)
    if scores.shape != (4, 636, 53) or not np.isfinite(scores).all():
        raise ValueError("Expected four finite 636 by 53 development panels")
    components = [dict(name=name, path=str(path.relative_to(ROOT)), sha256=sha(path))
                  for name, path in zip(NAMES, artifact_paths)]
    for component in components:
        fitted = component_module(component["name"]).load_artifact(ROOT / component["path"])
        if fitted["model_ids"] != ids or fitted["reference_sha256"] != REFERENCE_SHA:
            raise ValueError("Fitted artifact does not match development panel")
    normalized = z(scores)
    candidate_scores = np.stack([np.einsum("i,ijk->jk", weight, normalized) for weight in weights])
    candidates = [dict(index=index, weights=weight.tolist(), metrics=metrics(values, truth, ids))
                  for index, (weight, values) in enumerate(zip(weights, candidate_scores))]
    winner = min(candidates, key=lambda item: (-item["metrics"]["correct"],
                 np.count_nonzero(item["weights"]), item["index"]))
    selected = candidate_scores[winner["index"]]
    beta = fit_temperature(selected, truth)
    artifact = dict(schema="generic-refinement-fusion-v1", model_ids=ids, beta=beta,
                    reference_sha256=REFERENCE_SHA, components=components, weights=winner["weights"],
                    source_hashes=source_hashes,
                    calibration_scope="Selected reference OOF development; 53-label closed set only.")
    joblib.dump(artifact, output / "fitted.joblib", compress=3)
    load_artifact(output / "fitted.joblib")
    np.savez_compressed(output / "reference-oof.npz", scores=selected, model_ids=ids,
                        group_ids=group_ids, y=truth, environment=first["environment"])
    np.savez_compressed(output / "candidates.npz", scores=candidate_scores, weights=weights,
                        component_scores=scores, model_ids=ids, group_ids=group_ids, y=truth)
    save(output / "selection.json", dict(plan=plan, candidates=candidates, winner=winner,
         components=[dict(name=name, metrics=metrics(values, truth, ids)) for name, values in zip(NAMES, scores)],
         confidence=confidence_metrics(selected, truth, beta, ids)))
    hashes = dict(source_hashes)
    for component in components:
        hashes[component["path"]] = component["sha256"]
    for path in (output / "plan.json", output / "selection.json", output / "fitted.joblib", output / "reference-oof.npz"):
        hashes[str(path.relative_to(ROOT))] = sha(path)
    save(output / "freeze.json", dict(schema="generic-refinement-freeze-v1", hashes=hashes,
         reference_sha256=REFERENCE_SHA, beta=beta, weights=winner["weights"],
         fixed_holdout_opened=False, freeze_after_selection_before_regression=True))
    print(json.dumps(dict(winner=winner, baseline=metrics(scores[0], truth, ids), beta=beta), ensure_ascii=False))


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    select()
