# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.0", "joblib>=1.5,<2"]
# ///
"""Compare general discriminants on reference-only environment folds.

Inference API: load_artifact(path), score_groups(artifact, groups). Each group is
a list of replies, and each reply contains the product-parsed integers 1..355.
Serialized artifacts contain ordinary dictionaries and scikit-learn estimators.
"""
from __future__ import annotations

import os

for thread_variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[thread_variable] = "1"

import argparse
import hashlib
import json
import re
import sys
import time
import warnings
from pathlib import Path

import joblib
import numpy as np
import sklearn
from scipy.optimize import minimize_scalar
from scipy.special import logsumexp, softmax
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.preprocessing import normalize
from sklearn.svm import LinearSVC, SVC

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "projects/offline"))
from bank_builder import read_rows
from ensemble_confidence_core import Ensemble, z
from fingerprint import count_numbers, hellinger_feature, ordered_block_feature
from shared_verifier_core import reference_panel

DEFAULT_OUT = ROOT / "research/reports/sequence-generalization/20260930/classifiers"
PAIR = ("gpt-6-astra", "gpt-6.1-sol")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    def convert(item):
        if isinstance(item, np.ndarray):
            return item.tolist()
        if isinstance(item, np.generic):
            return item.item()
        raise TypeError(type(item).__name__)

    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=convert, allow_nan=False) + "\n")
    temporary.replace(path)


def dense_order(numbers):
    """The existing 44 dense lag, run, coverage, and drift statistics."""
    values = np.asarray(numbers, dtype=float)
    output = []
    for lag in (1, 2, 3, 4, 5, 8, 12, 20, 30):
        differences = np.abs(values[lag:] - values[:-lag])
        output.extend((np.mean(differences <= 5), np.mean(differences <= 20), differences.mean() / 100))
    centred = values - values.mean()
    denominator = max(float(centred @ centred), 1e-12)
    output.extend(centred[lag:] @ centred[:-lag] / denominator for lag in (1, 2, 3, 5, 10))
    high = values > 178
    runs = np.diff(np.flatnonzero(np.r_[True, high[1:] != high[:-1], True]))
    signs = np.sign(np.diff(values))
    direction_runs = np.diff(np.flatnonzero(np.r_[True, signs[1:] != signs[:-1], True]))
    output.extend((np.mean(high[1:] != high[:-1]), runs.mean(), np.mean(runs >= 3),
                   direction_runs.mean(), np.mean(direction_runs >= 3)))
    buckets = np.minimum(15, (values.astype(int) - 1) * 16 // 355)
    output.extend(np.mean([len(set(buckets[i:i + width])) for i in range(len(values) - width + 1)]) / width
                  for width in (4, 8, 16))
    output.extend((np.mean(values[1:] % 10 == values[:-1] % 10),
                   np.mean((values[1:] // 10) % 10 == (values[:-1] // 10) % 10)))
    quarters = np.array_split(values, 4)
    output.extend(((quarters[3].mean() - quarters[0].mean()) / 100,
                   (quarters[3].std() - quarters[0].std()) / 100))
    result = np.asarray(output)
    if not np.isfinite(result).all():
        raise ValueError("Dense order statistics require at least 31 parsed numbers")
    return result


def raw_features(numbers, feature):
    if feature.endswith("head"):
        numbers = [reply[:128] for reply in numbers]
    blocks = [np.stack([hellinger_feature(count_numbers(reply)) for reply in numbers])]
    if not feature.startswith("frequency"):
        blocks.append(np.stack([ordered_block_feature(reply) for reply in numbers]))
    if feature.startswith("dense"):
        blocks.append(np.stack([dense_order(reply) for reply in numbers]))
    return blocks


def block_weights(feature):
    if feature.startswith("frequency"):
        return (1.,)
    if feature.startswith("dense"):
        return (.6, .2, .2)
    return (.75, .25)


def fit_preprocessing(blocks, feature):
    parameters, output = [], []
    for block, weight in zip(blocks, block_weights(feature)):
        mean, scale = block.mean(axis=0), block.std(axis=0)
        scale[scale < 1e-10] = 1
        parameters.append(dict(mean=mean, scale=scale, weight=weight))
        output.append(normalize((block - mean) / scale) * np.sqrt(weight))
    return np.concatenate(output, axis=1), parameters


def transform(blocks, parameters):
    return np.concatenate([normalize((block - parameter["mean"]) / parameter["scale"])
                           * np.sqrt(parameter["weight"])
                           for block, parameter in zip(blocks, parameters)], axis=1)


def estimator(spec, classes):
    kind, parameter = spec["kind"], spec["parameter"]
    if kind == "lda":
        return LinearDiscriminantAnalysis(solver="lsqr", shrinkage=parameter,
                                           priors=np.full(classes, 1 / classes))
    if kind == "ridge":
        return Ridge(alpha=parameter)
    if kind == "logistic":
        return LogisticRegression(C=parameter, class_weight="balanced", max_iter=1200, tol=1e-5)
    if kind == "linear_svm":
        return LinearSVC(C=parameter, class_weight="balanced", dual="auto", max_iter=15000, tol=1e-5, random_state=42)
    return SVC(C=parameter, gamma=1., kernel="rbf", class_weight="balanced", decision_function_shape="ovr")


def fit_estimator(spec, features, labels, classes):
    fitted = estimator(spec, classes)
    with warnings.catch_warnings():
        warnings.simplefilter("error", ConvergenceWarning)
        if spec["kind"] == "ridge":
            frequencies = np.bincount(labels, minlength=classes)
            fitted.fit(features, np.eye(classes)[labels], sample_weight=len(labels) / (classes * frequencies[labels]))
        else:
            fitted.fit(features, labels)
    return fitted


def decision(fitted, features, spec):
    return fitted.predict(features) if spec["kind"] == "ridge" else fitted.decision_function(features)


def fit_model(spec, rows, ids):
    blocks = raw_features([row["numbers"] for row in rows], spec["feature"])
    features, preprocessing = fit_preprocessing(blocks, spec["feature"])
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    fitted = fit_estimator(spec, features, labels, len(ids))
    return dict(schema="general-discriminant-v1", model_ids=ids, spec=spec,
                preprocessing=preprocessing, estimator=fitted)


def load_artifact(path):
    return joblib.load(path)


def score_groups(artifact, groups):
    if artifact["schema"] == "general-ranker-fusion-v1":
        candidate = score_groups(artifact["candidate"], groups)
        baseline = np.asarray([score for score, _ in artifact["baseline"].score_groups(groups)])
        weight = artifact["candidate_weight"]
        return weight * z(candidate) + (1 - weight) * z(baseline)
    numbers = [reply for group in groups for reply in group]
    blocks = raw_features(numbers, artifact["spec"]["feature"])
    single = decision(artifact["estimator"], transform(blocks, artifact["preprocessing"]), artifact["spec"])
    output, offset = [], 0
    for group in groups:
        output.append(single[offset:offset + len(group)].mean(axis=0))
        offset += len(group)
    return np.asarray(output)


def metrics(scores, truth, ids):
    order = np.argsort(-scores, axis=1, kind="stable")
    ranks = np.argmax(order == truth[:, None], axis=1) + 1
    correct = ranks == 1
    recalls = [correct[truth == label].mean() for label in range(len(ids)) if np.any(truth == label)]
    result = dict(groups=len(truth), correct=int(correct.sum()), top1=float(correct.mean()),
                  macro_top1=float(np.mean(recalls)), top3=float(np.mean(ranks <= 3)), mrr=float(np.mean(1 / ranks)))
    if all(label in ids for label in PAIR):
        pair_indices = [ids.index(label) for label in PAIR]
        selected = np.isin(truth, pair_indices)
        local_truth = np.asarray([pair_indices.index(label) for label in truth[selected]])
        pair_choice = scores[selected][:, pair_indices].argmax(axis=1)
        result["pair"] = dict(groups=int(selected.sum()), all_library_correct=int(correct[selected].sum()),
                              conditional_correct=int(np.sum(pair_choice == local_truth)),
                              per_model={ids[label]: dict(groups=int(np.sum(truth == label)),
                                   all_library_correct=int(correct[truth == label].sum())) for label in pair_indices})
    return result


def fit_temperature(scores, truth):
    def loss(log_beta):
        scaled = np.exp(log_beta) * scores
        return np.mean(logsumexp(scaled, axis=1) - scaled[np.arange(len(truth)), truth])
    fitted = minimize_scalar(loss, bounds=(np.log(.001), np.log(1000)), method="bounded")
    return float(np.exp(fitted.x))


def confidence_metrics(scores, truth, beta, ids):
    probability = softmax(beta * scores, axis=1)
    correct, top = probability.argmax(axis=1) == truth, probability.max(axis=1)
    summaries = []
    for threshold in (.5, .7, .8, .9, .95, .99):
        accepted = top >= threshold
        pair = accepted & np.isin(truth, [ids.index(label) for label in PAIR])
        summaries.append(dict(threshold=threshold, accepted=int(accepted.sum()),
                              correct=int(np.sum(correct & accepted)), coverage=float(accepted.mean()),
                              precision=float(correct[accepted].mean()) if accepted.any() else None,
                              pair_accepted=int(pair.sum()), pair_correct=int(np.sum(pair & correct))))
    return dict(beta=beta, nll=float(np.mean(-np.log(np.maximum(probability[np.arange(len(truth)), truth], 1e-300)))),
                thresholds=summaries)


def sequence_key(row):
    return hashlib.sha256(np.asarray(row["numbers"], dtype=np.int16).tobytes()).hexdigest()


def excluded_rows(rows, environment, held_indices):
    query_ids = {f"query-{query:02d}" for query in range(environment * 3 - 2, environment * 3 + 1)}
    condition = re.compile(rf"environment-{environment:02d}(?:\b|-|:)")
    held_texts = {rows[index]["text"].strip() for index in held_indices}
    held_sequences = {sequence_key(rows[index]) for index in held_indices}
    return np.asarray([row["challenge_id"] in query_ids or bool(condition.match(row["condition_id"]))
                       or row["text"].strip() in held_texts or sequence_key(row) in held_sequences for row in rows])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    arguments = parser.parse_args()
    output = arguments.output
    output.mkdir(parents=True, exist_ok=True)
    started = time.time()
    reference_path, bank_path = ROOT / "projects/data/unified_reference.jsonl", ROOT / "projects/data/unified_bank.json"
    hashes = {str(path.relative_to(ROOT)): sha(path) for path in (reference_path, bank_path, Path(__file__))}
    bank = json.loads(bank_path.read_text())
    if bank["reference_sha256"] != hashes[str(reference_path.relative_to(ROOT))]:
        raise ValueError("Bank/reference hash mismatch")
    ids = [model["id"] for model in bank["models"]]
    rows = read_rows(reference_path)
    panel = reference_panel(rows, ids)
    row_of = {row["row_id"]: index for index, row in enumerate(rows)}
    slots = [[row_of[row_id] for row_id in group["row_ids"]] for group in panel]
    panel_indices = np.asarray([index for group in slots for index in group])
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    truth = np.asarray([ids.index(group["model"]) for group in panel])
    environments = np.asarray([group["environment"] for group in panel])
    features = ("frequency_full", "legacy_head", "legacy_full", "dense_full", "dense_head")
    specifications = []
    for feature in features:
        for kind, parameters in (("lda", (.05, .3, .7)), ("ridge", (1., 10.)),
                                 ("linear_svm", (.1, 1.)), ("logistic", (1.,))):
            specifications.extend(dict(feature=feature, kind=kind, parameter=parameter) for parameter in parameters)
    specifications.extend(dict(feature=feature, kind="rbf_svm", parameter=parameter)
                          for feature in ("legacy_full", "dense_full") for parameter in (1., 10.))
    plan = dict(reference_rows=len(rows), panel_rows=len(panel_indices), training_only_extras=len(rows) - len(panel_indices),
                model_ids=ids, panel=panel, source_hashes=hashes, candidates=specifications,
                selection="Reference leave-one-environment-out group Top-1, macro Top-1, MRR, then stable candidate order.",
                pair_policy="Named pair is a diagnostic only; it never enters feature, parameter, or fusion selection.",
                folds="Exclude all held query IDs and condition prefixes, then remove held exact text/parsed-sequence duplicates.",
                aggregation="First stable sample for each query; exactly three challenges. Average classifier scores across replies.",
                preprocessing="Fit mean/std on fold training only; normalize each block, use weights 1 or .75/.25 or .6/.2/.2.",
                confidence="Temperature fits reference crossfit scores only. These are conditional library weights, not backend identity probabilities.",
                limitations="Candidate and blend selection share reference folds; reported CV and calibration contain development selection bias.",
                versions=dict(python=sys.version, numpy=np.__version__, sklearn=sklearn.__version__))
    save(output / "plan.json", plan)
    raw = {feature: raw_features([row["numbers"] for row in rows], feature) for feature in features}
    scores = np.full((len(specifications), len(panel), len(ids)), np.nan)
    sample_scores = np.full((len(specifications), len(panel_indices), len(ids)), np.nan)
    baseline = np.full((len(panel), len(ids)), np.nan)
    baseline_sample = np.full((len(panel_indices), len(ids)), np.nan)
    fold_diagnostics = []
    panel_sample_of = {row_index: index for index, row_index in enumerate(panel_indices)}
    for environment in range(1, 13):
        held_groups = np.flatnonzero(environments == environment)
        held_indices = np.asarray([index for group in held_groups for index in slots[group]])
        held_positions = np.asarray([panel_sample_of[index] for index in held_indices])
        excluded = excluded_rows(rows, environment, held_indices)
        training_rows = [row for row, held in zip(rows, excluded) if not held]
        fold_diagnostics.append(dict(environment=environment, training_rows=len(training_rows), excluded_rows=int(excluded.sum()),
                                     held_row_ids=[rows[index]["row_id"] for index in held_indices]))
        engine = Ensemble(training_rows, ids)
        groups = [[rows[index]["numbers"] for index in slots[group]] for group in held_groups]
        baseline[held_groups] = np.asarray([score for score, _ in engine.score_groups(groups)])
        baseline_sample[held_positions] = np.asarray([score for score, _ in engine.score_groups([[rows[index]["numbers"]] for index in held_indices])])
        for feature in features:
            train_blocks = [block[~excluded] for block in raw[feature]]
            train_features, preprocessing = fit_preprocessing(train_blocks, feature)
            held_features = transform([block[held_indices] for block in raw[feature]], preprocessing)
            for index, spec in enumerate(specifications):
                if spec["feature"] != feature:
                    continue
                fitted = fit_estimator(spec, train_features, labels[~excluded], len(ids))
                single = decision(fitted, held_features, spec)
                scores[index, held_groups] = single.reshape(-1, 3, len(ids)).mean(axis=1)
                sample_scores[index, held_positions] = single
        print(f"Environment {environment}/12: {time.time() - started:.1f}s", flush=True)
    if not np.isfinite(scores).all() or not np.isfinite(baseline).all():
        raise ValueError("Incomplete or non-finite reference folds")
    save(output / "folds.json", fold_diagnostics)
    base_metrics = metrics(baseline, truth, ids)
    leaderboard = [dict(index=index, spec=spec, cv=metrics(values, truth, ids))
                   for index, (spec, values) in enumerate(zip(specifications, scores))]
    sort_key = lambda entry: (-entry["cv"]["top1"], -entry["cv"]["macro_top1"], -entry["cv"]["mrr"])
    leaderboard.sort(key=sort_key)
    family_winners = [next(entry for entry in leaderboard if entry["spec"]["kind"] == kind)
                      for kind in ("lda", "ridge", "linear_svm", "logistic", "rbf_svm")]
    fusion_candidates = []
    for entry in family_winners:
        for weight in (.25, .5, .75):
            combined = weight * z(scores[entry["index"]]) + (1 - weight) * z(baseline)
            fusion_candidates.append(dict(index=entry["index"], spec=entry["spec"], candidate_weight=weight,
                                          cv=metrics(combined, truth, ids)))
    fusion_candidates.sort(key=sort_key)
    best_fusion = fusion_candidates[0]
    fusion_scores = best_fusion["candidate_weight"] * z(scores[best_fusion["index"]]) + (1 - best_fusion["candidate_weight"]) * z(baseline)
    np.savez_compressed(output / "candidates.npz", candidate_scores=scores, candidate_sample_scores=sample_scores,
                        baseline_scores=baseline, baseline_sample_scores=baseline_sample,
                        y=truth, model_ids=np.asarray(ids), group_ids=np.asarray([group["id"] for group in panel]),
                        environment=environments, sample_y=labels[panel_indices],
                        sample_row_ids=np.asarray([rows[index]["row_id"] for index in panel_indices]),
                        sample_environment=np.repeat(environments, 3))
    final_engine = Ensemble(rows, ids)
    selected = []
    for entry in family_winners:
        artifact = fit_model(entry["spec"], rows, ids)
        beta = fit_temperature(scores[entry["index"]], truth)
        artifact.update(beta=beta, reference_sha256=hashes[str(reference_path.relative_to(ROOT))])
        name = entry["spec"]["kind"]
        joblib.dump(artifact, output / f"fitted-{name}.joblib", compress=3)
        selected.append(dict(name=name, **entry, artifact=f"fitted-{name}.joblib",
                             confidence=confidence_metrics(scores[entry["index"]], truth, beta, ids)))
    artifact = dict(schema="general-ranker-fusion-v1", model_ids=ids, candidate=fit_model(best_fusion["spec"], rows, ids),
                    baseline=final_engine, candidate_weight=best_fusion["candidate_weight"],
                    reference_sha256=hashes[str(reference_path.relative_to(ROOT))], beta=fit_temperature(fusion_scores, truth))
    joblib.dump(artifact, output / "fitted-fusion.joblib", compress=3)
    selected.append(dict(name="fusion", **best_fusion, artifact="fitted-fusion.joblib",
                         confidence=confidence_metrics(fusion_scores, truth, artifact["beta"], ids)))
    winner = min(selected, key=sort_key)
    winner_scores = fusion_scores if winner["name"] == "fusion" else scores[winner["index"]]
    joblib.dump(load_artifact(output / winner["artifact"]), output / "fitted-winner.joblib", compress=3)
    winner_sample = z(sample_scores[winner["index"]]) if winner["name"] == "fusion" else sample_scores[winner["index"]]
    if winner["name"] == "fusion":
        winner_sample = winner["candidate_weight"] * winner_sample + (1 - winner["candidate_weight"]) * z(baseline_sample)
    np.savez_compressed(output / "reference-oof.npz", scores=winner_scores, y=truth,
                        model_ids=np.asarray(ids), group_ids=np.asarray([group["id"] for group in panel]), environment=environments,
                        sample_scores=winner_sample, sample_y=labels[panel_indices],
                        sample_row_ids=np.asarray([rows[index]["row_id"] for index in panel_indices]),
                        sample_environment=np.repeat(environments, 3))
    report = dict(plan=plan, baseline=base_metrics, leaderboard=leaderboard, fusions=fusion_candidates,
                  selected=selected, winner=winner, elapsed_seconds=time.time() - started)
    save(output / "summary.json", report)
    lines = ["# 通用分类器参考库实验", "", f"当前参考库 {len(rows)} 条、{len(ids)} 类；固定首个挑战样本组成 {len(panel)} 个三回答组。",
             "每折排除一个环境的全部挑战及变体。额外参考只用于训练。所有预处理在折内拟合。", "",
             "| 方法 | 特征 | 参数 | 首位命中 | Top-3 | Astra/Sol 库内命中 |", "|---|---|---|---:|---:|---:|",
             f"| 当前 Ensemble | 原配置 | 固定 | {base_metrics['correct']}/{len(panel)} | {base_metrics['top3']:.1%} | {base_metrics['pair']['all_library_correct']}/24 |"]
    for entry in selected:
        spec, result = entry["spec"], entry["cv"]
        parameter = str(spec["parameter"])
        if entry["name"] == "fusion":
            parameter += f"；分类器权重 {entry['candidate_weight']}"
        lines.append(f"| {entry['name']} | {spec['feature']} | {parameter} | {result['correct']}/{len(panel)} | {result['top3']:.1%} | {result['pair']['all_library_correct']}/24 |")
    lines.extend(("", "选参目标为全部模型的 Top-1、宏平均 Top-1 和 MRR。Astra/Sol 指标只用于诊断。",
                  "温度只拟合参考库跨折分数。候选参数和融合权重也使用这些折，CV 与校准有开发选择偏差。",
                  "库内 softmax 权重不能证明上游身份，也不能保证拒绝未知模型。固定测试集和新采样未进入本脚本。",
                  "", "`candidates.npz` 保留全部候选和当前 Ensemble 的逐组、逐回答分数。",
                  "`fitted-winner.joblib` 是参考库选定模型。使用 `load_artifact(path)` 和 `score_groups(artifact, groups)` 推断。",
                  "各回答传入产品解析后的 1..355 整数列表。返回按 `artifact['model_ids']` 排列的组分数。"))
    (output / "report.md").write_text("\n".join(lines) + "\n")
    for path_name, expected in hashes.items():
        if sha(ROOT / path_name) != expected:
            raise ValueError(f"Frozen input changed during run: {path_name}")
    print(json.dumps(dict(baseline=base_metrics, winner=winner, output=str(output)), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
