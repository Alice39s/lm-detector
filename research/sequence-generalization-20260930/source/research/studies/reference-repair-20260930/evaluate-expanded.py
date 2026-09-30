# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.1", "joblib>=1.5,<2", "threadpoolctl>=3"]
# ///
"""Evaluate only the already frozen general fusion; never fit or select parameters."""
from __future__ import annotations

import os
for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[name] = "1"

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.special import softmax
from scipy.stats import binomtest
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "research/studies/sequence-generalization"), str(ROOT / "projects/offline")]
from fusion import load_artifact, score_groups
from evaluate import metrics, save, sha

OUT = ROOT / "research/reports/reference-repair-20260930"
RUN = ROOT / "research/reports/sequence-generalization/20260930"
PAIR = ("gpt-6-astra", "gpt-6.1-sol")


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    data_path = OUT / "expanded-fusion-input.json"
    data = json.loads(data_path.read_text())
    freeze_path = RUN / "candidate-freeze.json"
    freeze = json.loads(freeze_path.read_text())
    if data["hashes"]["candidate_freeze_sha256"] != sha(freeze_path):
        raise ValueError("Candidate freeze changed")
    for path, expected in freeze["source_hashes"].items():
        if sha(ROOT / path) != expected:
            raise ValueError(f"Frozen source changed: {path}")
    candidate = next(row for row in freeze["candidates"] if row["id"] == "generic_fusion")
    artifact_path = ROOT / candidate["artifact"]
    if sha(artifact_path) != candidate["artifact_sha256"]:
        raise ValueError("Frozen fusion artifact changed")
    artifact = load_artifact(artifact_path)
    if artifact["reference_sha256"] != data["hashes"]["reference_sha256"] or artifact["spec"]["weights"] != [.5, .5, 0.]:
        raise ValueError("Reference or fixed weights changed")
    ids, groups = artifact["model_ids"], data["groups"]
    if len(ids) != 53 or data["coverage"]["planned_groups"] != 106 or len(groups) != data["coverage"]["complete_groups"]:
        raise ValueError("Expected the 53-label gallery and recorded fixed-group coverage")
    if sum(group["cohort"] == "old_72" for group in groups) != 72:
        raise ValueError("The preserved 72 baseline groups must remain complete")
    numbers = [group["numbers"] for group in groups]
    with threadpool_limits(limits=1):
        baseline = np.asarray([scores for scores, _ in artifact["_loaded"]["rerank"]["base"].score_groups(numbers)])
        scores = score_groups(artifact, numbers)
    probabilities = softmax(artifact["beta"] * scores, axis=1)
    if not np.isfinite(scores).all() or not np.isfinite(probabilities).all():
        raise ValueError("Non-finite frozen inference")
    truth = np.asarray([ids.index(group["model"]) for group in groups])
    base_order = np.argsort(-baseline, axis=1, kind="stable")
    order = np.argsort(-scores, axis=1, kind="stable")
    baseline_correct, correct = base_order[:, 0] == truth, order[:, 0] == truth
    baseline_mismatches = [dict(id=group["id"], artifact_prediction=ids[base_order[i, 0]],
        formal_product_prediction=group["formal_product_prediction"]) for i, group in enumerate(groups)
        if ids[base_order[i, 0]] != group["formal_product_prediction"]]
    results = {}
    for name in ("old_72", "added_34", "all_106"):
        mask = np.ones(len(groups), dtype=bool) if name == "all_106" else np.asarray([group["cohort"] == name for group in groups])
        cohort = [group for group, keep in zip(groups, mask) if keep]
        summary = metrics(scores[mask], probabilities[mask], cohort, ids)
        summary["planned_groups"] = {"old_72": 72, "added_34": 34, "all_106": 106}[name]
        gained, lost = int(np.sum(correct[mask] & ~baseline_correct[mask])), int(np.sum(~correct[mask] & baseline_correct[mask]))
        summary["baseline"] = dict(correct=int(baseline_correct[mask].sum()), total=int(mask.sum()),
                                   top3_correct=int(np.any(base_order[mask, :3] == truth[mask, None], axis=1).sum()))
        summary["paired_change"] = dict(gained=gained, lost=lost, net=gained - lost,
                                         exact_mcnemar_p=float(binomtest(gained, gained + lost).pvalue) if gained + lost else 1.)
        pair_predictions = [row for row in summary["predictions"] if row["model"] in PAIR]
        summary["astra_sol"] = dict(total=len(pair_predictions), correct=sum(row["model"] == row["prediction"] for row in pair_predictions),
            confusion={truth_label: {prediction: sum(row["model"] == truth_label and row["prediction"] == prediction for row in pair_predictions)
                        for prediction in sorted({row["prediction"] for row in pair_predictions})} for truth_label in PAIR},
            development_probability_thresholds={str(threshold): dict(accepted=sum(row["top_probability"] >= threshold for row in pair_predictions),
                correct=sum(row["top_probability"] >= threshold and row["model"] == row["prediction"] for row in pair_predictions))
                for threshold in (.8, .9, .95, .99)}, predictions=pair_predictions)
        results[name] = summary
    result = dict(input_sha256=sha(data_path), hashes=data["hashes"], coverage=data["coverage"], candidate=candidate,
                  baseline_product_agreement=dict(total=len(groups), matched=len(groups) - len(baseline_mismatches),
                                                  mismatches=baseline_mismatches),
                  beta=artifact["beta"], weights=artifact["spec"]["weights"], model_ids=ids,
                  probability_scope="Frozen reference-development 53-label closed-set temperature; not production-calibrated identity confidence",
                  policy="No fitting, parameter selection, threshold changes, reference enrollment or API requests. Baseline is the original Ensemble inside the same frozen artifact.",
                  cohorts=results)
    save(OUT / "expanded-fusion-results.json", result)
    np.savez_compressed(OUT / "expanded-fusion-scores.npz", scores=scores, baseline_scores=baseline,
                        probabilities=probabilities, truth=truth, model_ids=np.asarray(ids),
                        group_ids=np.asarray([group["id"] for group in groups]), cohorts=np.asarray([group["cohort"] for group in groups]))
    coverage = data["coverage"]
    lines = ["# 冻结通用融合的当前已完成固定测试集评估", "", result["probability_scope"], "",
             f"覆盖 {coverage['complete_groups']}/106 组、{coverage['selected_samples']}/318 条回答；已完成组包含 {coverage['observed_truth_labels']}/53 个真实标签，候选模型库仍为全部 53 标签。", "",
             f"冻结 artifact 内的原 Ensemble 与当前正式产品报告逐组预测一致：{len(groups) - len(baseline_mismatches)}/{len(groups)}。不一致详情见 JSON。", "",
             "| 部分 | 原 Ensemble Top-1 | 冻结融合 Top-1 | 原 Top-3 | 融合 Top-3 | 净变化 |", "|---|---:|---:|---:|---:|---:|"]
    for name, row in results.items():
        lines.append(f"| {name} | {row['baseline']['correct']}/{row['total']} | {row['correct']}/{row['total']} | {row['baseline']['top3_correct']}/{row['total']} | {round(row['top3'] * row['total'])}/{row['total']} | {row['paired_change']['net']:+d} |")
    lines += ["", "| 部分 | 原错→融合对 | 原对→融合错 | 逐组精确 McNemar p |", "|---|---:|---:|---:|"]
    for name, row in results.items():
        change = row["paired_change"]
        lines.append(f"| {name} | {change['gained']} | {change['lost']} | {change['exact_mcnemar_p']:.6f} |")
    lines += ["", "该 p 值按单组配对计算；每模型两个固定组可能相关，应以实际命中变化为主。", ""]
    pair = results["all_106"]["astra_sol"]
    lines += ["", f"Astra/Sol 全库 Top-1 命中 {pair['correct']}/{pair['total']}。", "",
              "| 固定组 | 真实型号 | 预测 | 开发闭集概率 |", "|---|---|---|---:|"]
    for row in pair["predictions"]:
        lines.append(f"| {row['id']} | {row['model']} | {row['prediction']} | {row['top_probability']:.4f} |")
    lines += ["", "此型号对在开发概率 ≥0.8、0.9、0.95、0.99 时均没有覆盖；本次结果不支持高置信区分。阈值保持冻结值。", "",
              "| 全库开发概率阈值 | 覆盖 | 正确 | 错误 |", "|---|---:|---:|---:|"]
    for threshold, row in results["all_106"]["selected"].items():
        lines.append(f"| {threshold} | {row['accepted']}/{results['all_106']['total']} | {row['correct']} | {row['errors']} |")
    lines += ["", "这些概率只用于描述冻结开发温度的外部表现，不能当成已安装的产品身份置信度。", "",
              "旧 72 组与计划新增 34 组分别报告；缺失组不进入命中率分母。所有参数、权重和 beta 均保持此前参考库冻结值；本次仅做外部评估，不据此选择候选。", ""]
    if coverage["incomplete_groups"]:
        lines += ["缺失组：" + "、".join(row["id"] for row in coverage["incomplete_groups"]) + "。", ""]
    (OUT / "expanded-fusion-results.md").write_text("\n".join(lines))
    print(json.dumps({name: {"baseline": row["baseline"]["correct"], "fusion": row["correct"], "total": row["total"],
        "pair": {key: value for key, value in row["astra_sol"].items() if key != "predictions"}}
        for name, row in results.items()}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
