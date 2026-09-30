# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.1", "joblib>=1.5,<2"]
# ///
"""Freeze a small reference-only fusion of already selected generic rankers."""
from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np

from classifiers import ROOT, confidence_metrics, fit_temperature, metrics, read_rows, reference_panel, save, sha, z

OUT = ROOT / "research/reports/sequence-generalization/20260930/fusion"
RUN = OUT.parent


def component_module(name):
    if name == "rerank":
        import rerank
        return rerank
    if name == "positional":
        import positional
        return positional
    import classifiers
    return classifiers


def load_artifact(path):
    artifact = joblib.load(path)
    loaded = {}
    for component, weight in zip(artifact["components"], artifact["spec"]["weights"]):
        component_path = ROOT / component["path"]
        if sha(component_path) != component["sha256"]:
            raise ValueError(f"Frozen component changed: {component['name']}")
        if not weight:
            continue
        module = component_module(component["name"])
        fitted = module.load_artifact(component_path)
        if fitted["model_ids"] != artifact["model_ids"]:
            raise ValueError("Frozen component model order mismatch")
        if fitted["reference_sha256"] != artifact["reference_sha256"]:
            raise ValueError("Frozen component reference mismatch")
        loaded[component["name"]] = fitted
    artifact["_loaded"] = loaded
    return artifact


def score_groups(artifact, groups):
    output = np.zeros((len(groups), len(artifact["model_ids"])))
    for component, weight in zip(artifact["components"], artifact["spec"]["weights"]):
        if not weight:
            continue
        name = component["name"]
        module = component_module(name)
        output += weight * z(module.score_groups(artifact["_loaded"][name], groups))
    return output


def align(data, canonical_ids, group_ids, truth, scores_key="scores", truth_key="y", ids_key="model_ids"):
    if list(data[ids_key]) != canonical_ids:
        raise ValueError("Component gallery order mismatch")
    source_ids = list(data["group_ids"])
    if len(source_ids) != len(set(source_ids)) or set(source_ids) != set(group_ids):
        raise ValueError("Component group IDs are duplicate or differ")
    positions = {name: index for index, name in enumerate(source_ids)}
    order = np.asarray([positions[name] for name in group_ids])
    if not np.array_equal(data[truth_key][order], truth):
        raise ValueError("Component group truth mismatch")
    return np.asarray(data[scores_key])[order]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    position_path = RUN / "positional/reference-oof.npz"
    rerank_path = RUN / "rerank/candidates.npz"
    dense_path = RUN / "classifiers/reference-oof.npz"
    position = np.load(position_path)
    ids, group_ids, truth = list(position["model_ids"]), list(position["group_ids"]), position["y"]
    rerank_data = np.load(rerank_path)
    rerank_selection = json.loads((RUN / "rerank/selection.json").read_text())
    rerank_index = list(rerank_data["names"]).index(rerank_selection["selected"]["id"])
    rerank_selected = {"scores": rerank_data["scores"][rerank_index], "truth": rerank_data["truth"],
                       "ids": rerank_data["ids"], "group_ids": rerank_data["group_ids"]}
    names = ("rerank", "positional", "dense")
    components = [dict(name=name, path=str(path.relative_to(ROOT)), sha256=sha(path))
                  for name, path in zip(names, (RUN / "rerank/frozen.joblib", RUN / "positional/fitted.joblib",
                                               RUN / "classifiers/fitted-winner.joblib"))]
    scores = np.stack((align(rerank_selected, ids, group_ids, truth, truth_key="truth", ids_key="ids"),
                       align(position, ids, group_ids, truth), align(np.load(dense_path), ids, group_ids, truth)))
    if len(truth) != 636 or scores.shape != (3, 636, 53) or not np.isfinite(scores).all():
        raise ValueError("Unexpected frozen reference panel")
    reference_hash = sha(ROOT / "projects/data/unified_reference.jsonl")
    for component in components:
        fitted = component_module(component["name"]).load_artifact(ROOT / component["path"])
        if fitted["model_ids"] != ids or fitted["reference_sha256"] != reference_hash:
            raise ValueError("Frozen component model order/reference mismatch")
    weights = [np.asarray((first, second, 4 - first - second)) / 4
               for first in range(5) for second in range(5 - first)]
    normalized = z(scores)
    candidate_scores = np.stack([np.einsum("i,ijk->jk", weight, normalized) for weight in weights])
    candidates = [dict(index=index, weights=weight.tolist(), metrics=metrics(values, truth, ids))
                  for index, (weight, values) in enumerate(zip(weights, candidate_scores))]
    # The tie rule uses only complexity and grid order, never pair diagnostics.
    winner = min(candidates, key=lambda entry: (-entry["metrics"]["correct"], np.count_nonzero(entry["weights"]), entry["index"]))
    selected = candidate_scores[winner["index"]]
    beta = fit_temperature(selected, truth)
    artifact = dict(schema="generic-reference-fusion-v1", model_ids=ids, beta=beta,
                    reference_sha256=reference_hash, components=components,
                    spec=dict(component_names=names, weights=winner["weights"], normalization="Within each group, z-score across all gallery labels."),
                    calibration_scope="Reference OOF development temperature; candidate components and weights selected on these folds.")
    component_metrics = [dict(name=name, metrics=metrics(values, truth, ids)) for name, values in zip(names, scores)]
    report = dict(components=component_metrics, candidates=candidates, winner=winner,
                  confidence=confidence_metrics(selected, truth, beta, ids), artifact=artifact,
                  sources={str(path.relative_to(ROOT)): sha(path) for path in (position_path, rerank_path, dense_path, Path(__file__))},
                  selection="Highest 636-group all-library Top-1; ties prefer fewer nonzero components, then fixed grid order.",
                  external_scores_opened=False, limitations=artifact["calibration_scope"])
    np.savez_compressed(OUT / "candidates.npz", scores=candidate_scores, weights=np.asarray(weights),
                        component_scores=scores, model_ids=np.asarray(ids), group_ids=np.asarray(group_ids), y=truth,
                        environment=position["environment"])
    np.savez_compressed(OUT / "reference-oof.npz", scores=selected, model_ids=np.asarray(ids),
                        group_ids=np.asarray(group_ids), y=truth, environment=position["environment"])
    save(OUT / "selection.json", report)
    improvement = winner["metrics"]["correct"] - max(entry["metrics"]["correct"] for entry in component_metrics)
    if improvement > 0:
        joblib.dump(artifact, OUT / "fitted.joblib", compress=3)
        loaded = load_artifact(OUT / "fitted.joblib")
        print("Frozen inference artifact:", OUT / "fitted.joblib", flush=True)
        if loaded["reference_sha256"] != reference_hash:
            raise ValueError("Artifact reload mismatch")
        reference_rows = read_rows(ROOT / "projects/data/unified_reference.jsonl")
        first_group = reference_panel(reference_rows, ids)[0]
        by_id = {row["row_id"]: row["numbers"] for row in reference_rows}
        verification_scores = score_groups(loaded, [[by_id[row_id] for row_id in first_group["row_ids"]]])
        if verification_scores.shape != (1, len(ids)) or not np.isfinite(verification_scores).all():
            raise ValueError("Frozen inference returned invalid scores")
    lines = ["# 已冻结通用排名器的参考库组合", "", "对三个已选定的通用排名器，比较 15 种步长 0.25、非负且总和为 1 的组合。",
             "选择只使用 636 个参考库三回答组的全库 Top-1。全部组件的模型顺序、组 ID 和真实标签逐一匹配。", "",
             "| 组件 | 首位命中 | Astra/Sol 命中 |", "|---|---:|---:|"]
    lines.extend(f"| {entry['name']} | {entry['metrics']['correct']}/636 | {entry['metrics']['pair']['all_library_correct']}/24 |"
                 for entry in component_metrics)
    lines.extend((f"| 选定组合 | {winner['metrics']['correct']}/636 | {winner['metrics']['pair']['all_library_correct']}/24 |", "",
                  f"组件顺序：{', '.join(names)}。权重：{winner['weights']}。较最佳单个组件增加 {improvement} 个命中。",
                  "温度只使用参考库 OOF 分数。组件、参数和组合都在这些参考折上选过，校准属于开发结果。",
                  "本脚本没有读取固定测试集、旧配对测试或新采样。Astra/Sol 只在选定后报告诊断指标。"))
    (OUT / "report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(dict(winner=winner, improvement=improvement, beta=beta, component_names=names), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
