"""Choose one predeclared source-balanced ranker, before external evaluation."""
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
RUN = ROOT / "research/reports/generic-refinement-20261001"
import source_robust as source
import domain_groups


def load_artifact(path):
    artifact = joblib.load(path)
    if artifact["schema"] != "domain-development-portfolio-v1":
        raise ValueError("Unexpected portfolio artifact")
    for relative, digest in artifact["source_hashes"].items():
        if source.sha(ROOT / relative) != digest:
            raise ValueError(f"Frozen source changed: {relative}")
    component = artifact["component"]
    component_path = ROOT / component["path"]
    if source.sha(component_path) != component["sha256"]:
        raise ValueError("Selected component changed")
    module = importlib.import_module(component["module"])
    fitted = module.load_artifact(component_path)
    if fitted["model_ids"] != artifact["model_ids"] or fitted["reference_sha256"] != artifact["reference_sha256"]:
        raise ValueError("Selected component gallery/reference differs")
    if component["module"] == "source_robust" and fitted.get("baseline") is None:
        baseline = ROOT / fitted["baseline_path"]
        if source.sha(baseline) != fitted["baseline_sha256"]:
            raise ValueError("Frozen original baseline changed")
        fitted["baseline"] = source.fusion.load_artifact(baseline)
    artifact["_loaded"] = fitted
    return artifact


def score_groups(artifact, groups):
    if any(len(group) != 3 for group in groups):
        raise ValueError("The portfolio requires exactly three replies per group")
    module = importlib.import_module(artifact["component"]["module"])
    return module.score_groups(artifact["_loaded"], groups)


def align(data, ids, group_ids, truth):
    if list(data["model_ids"]) != ids:
        raise ValueError("Candidate gallery differs")
    source_ids = list(data["group_ids"])
    if len(source_ids) != len(set(source_ids)) or set(source_ids) != set(group_ids):
        raise ValueError("Candidate groups differ or repeat")
    positions = {group_id: index for index, group_id in enumerate(source_ids)}
    order = np.asarray([positions[group_id] for group_id in group_ids])
    if not np.array_equal(data["y"][order], truth):
        raise ValueError("Candidate group truth differs")
    return data["scores"][:, order]


def select():
    output = RUN / "portfolio"
    output.mkdir(parents=True, exist_ok=True)
    path = RUN / "domain-groups/candidates.npz"
    canonical = np.load(path)
    ids, group_ids, truth = list(canonical["model_ids"]), list(canonical["group_ids"]), canonical["y"]
    groups = json.loads((RUN / "domain-groups/groups.json").read_text())
    if [group["id"] for group in groups] != group_ids or len(groups) != 716:
        raise ValueError("Canonical source-balanced panel differs")
    domains = np.asarray([group["domain"] for group in groups])
    reference = np.asarray([group["cohort"] == "reference" for group in groups])
    input_paths = [RUN / "source-robust/reference-oof.npz", RUN / "source-robust/development-oof.npz",
                   path, RUN / "source-local/candidates.npz", RUN / "domain-groups/groups.json"]
    code_paths = [Path(__file__), Path(__file__).with_name("PORTFOLIO_PROTOCOL.md"),
                  Path(__file__).with_name("DOMAIN_PROTOCOL.md"), *[Path(__file__).with_name(name) for name in
                  ("source_robust.py", "domain_groups.py", "group_models.py", "source_local.py")]]
    hashes = {str(item.relative_to(ROOT)): source.sha(item) for item in input_paths + code_paths}
    source.save(output / "plan.json", dict(candidate_count=37, branch_order=["source_robust", "domain_groups", "source_local"],
                metric="53 labels equal; actual channels within label equal; MacroTop1 then equally weighted MRR then stable index.",
                hashes=hashes, external_evaluation_opened=False))
    old, extra = np.load(input_paths[0]), np.load(input_paths[1])
    if not np.array_equal(old["model_ids"], extra["model_ids"]) or not np.array_equal(old["names"], extra["names"]):
        raise ValueError("Source-robust partitions differ")
    merged = dict(model_ids=old["model_ids"], group_ids=np.r_[old["group_ids"], extra["group_ids"]],
                  y=np.r_[old["y"], extra["y"]], scores=np.concatenate((old["scores"], extra["scores"]), axis=1))
    branches = [("source_robust", list(old["names"]), align(merged, ids, group_ids, truth)),
                ("domain_groups", list(canonical["names"]), canonical["scores"])]
    local = np.load(input_paths[3])
    branches.append(("source_local", list(local["names"]), align(local, ids, group_ids, truth)))
    candidates, all_scores = [], []
    for module, names, scores in branches:
        for index, (name, values) in enumerate(zip(names, scores)):
            if values.shape != (716, 53) or not np.isfinite(values).all():
                raise ValueError("Candidate scores are incomplete")
            metric = domain_groups.development_metrics(values, truth, domains, ids)
            candidates.append(dict(index=len(candidates), module=module, branch_index=index, name=str(name), metrics=metric,
                                   reference_correct=int(np.sum(values[reference].argmax(1) == truth[reference])),
                                   extra_development_correct=int(np.sum(values[~reference].argmax(1) == truth[~reference]))))
            all_scores.append(values)
    if len(candidates) != 37:
        raise ValueError("The predefined portfolio must have exactly 37 candidates")
    winner = min(candidates, key=lambda row: (-row["metrics"]["label_source_macro_top1"],
                 -row["metrics"]["label_source_macro_mrr"], row["index"]))
    module = winner["module"]
    if module == "source_robust":
        _, rows, _, _, _ = source.load_inputs()
        config = source.CONFIGS[winner["branch_index"]]
        candidate = None
        if config["head"] is not None:
            raw = [source.positional.blocks(row["numbers"]) for row in rows]
            parts = {name: np.stack([item[name] for item in raw]) for name in source.WEIGHTS}
            labels = np.asarray([ids.index(row["source"]) for row in rows])
            actual_domains = np.asarray([row["domain"] for row in rows])
            geometry = source.fit_geometry(parts, labels, actual_domains, len(ids))
            candidate = source.fit_head(geometry, labels, actual_domains, source.HEADS[config["head"]])
        baseline_path = source.RUN / "fusion/fitted.joblib"
        fitted = dict(schema="source-balanced-generic-v1", model_ids=ids, reference_sha256=source.REFERENCE_SHA,
                      config=config, candidate=candidate, baseline=None,
                      candidate_training_rows=len(rows) if candidate is not None else 0,
                      baseline_training_rows=1948, development_input_rows=len(rows), calibration=None,
                      baseline_path=str(baseline_path.relative_to(ROOT)), baseline_sha256=source.sha(baseline_path))
        component_path = output / "selected-source.joblib"
        joblib.dump(fitted, component_path, compress=3)
    else:
        directory = "domain-groups" if module == "domain_groups" else "source-local"
        selection = json.loads((RUN / directory / "selection.json").read_text())
        chosen = selection["winner"]
        if chosen["index"] != winner["branch_index"]:
            raise ValueError("The selected branch artifact differs from the portfolio criterion")
        component_path = RUN / directory / "fitted.joblib"
    artifact = dict(schema="domain-development-portfolio-v1", model_ids=ids, reference_sha256=source.REFERENCE_SHA,
                    component=dict(module=module, path=str(component_path.relative_to(ROOT)), sha256=source.sha(component_path)),
                    source_hashes={str(path.relative_to(ROOT)): source.sha(path) for path in code_paths}, calibration=None)
    joblib.dump(artifact, output / "fitted.joblib", compress=3)
    load_artifact(output / "fitted.joblib")
    source.save(output / "selection.json", dict(winner=winner, candidates=candidates, external_evaluation_opened=False,
                hashes=hashes, selection="All-gallery label/source-balanced development only; pair diagnostics never used."))
    source.save(output / "groups.json", groups)
    np.savez_compressed(output / "selected-oof.npz", scores=all_scores[winner["index"]], model_ids=ids,
                        group_ids=group_ids, y=truth, domains=domains)
    source.save(output / "freeze-inputs.json", dict(hashes=hashes,
                files={str(path.relative_to(ROOT)): source.sha(path) for path in
                (output / "fitted.joblib", component_path, output / "selected-oof.npz", output / "groups.json", output / "selection.json")},
                fixed_holdout_opened=False))
    print(json.dumps(winner, ensure_ascii=False))


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    select()
