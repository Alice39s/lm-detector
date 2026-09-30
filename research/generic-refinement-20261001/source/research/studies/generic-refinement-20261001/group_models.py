# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.1", "joblib>=1.5,<2", "threadpoolctl>=3"]
# ///
"""Reference-only classifiers for symmetric three-reply group statistics.

Inference uses ordinary array dictionaries: load_artifact(path),
score_groups(artifact, groups). No external evaluation data are opened.
"""
from __future__ import annotations

import os
for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[name] = "1"

import argparse
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import sklearn
from scipy.linalg import eigh
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "research/studies/sequence-generalization"), str(ROOT / "projects/offline")]
from classifiers import (excluded_rows, metrics, fit_temperature, confidence_metrics,
                         read_rows, reference_panel, save, sha)
from fingerprint import count_numbers, hellinger_feature, ordered_block_feature
from positional import position_moments, sequence_features

REFERENCE_SHA = "5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4"
OUT = ROOT / "research/reports/generic-refinement-20261001/groups"
TRIPLES_PER_CLASS = 64
SEED = 20261001
LAYOUTS = {"existing": {"frequency": .75, "ordered": .25},
           "selected_position": {"frequency": .6, "ordered": .15, "kernel": .125, "sequence": .125}}
SUMMARIES = {"mean": {"mean": 1.}, "mean_std": {"mean": .7, "std": .3},
             "mean_std_distance": {"mean": .6, "std": .3, "distance": .1}}


def specs():
    return [dict(id=f"{layout}_{summary}_{kind}{parameter:g}", layout=layout, summary=summary,
                 kind=kind, parameter=parameter)
            for layout in LAYOUTS for summary in SUMMARIES
            for kind, parameters in (("lda", (.15, .5, .85)), ("ridge", (1., 10.)))
            for parameter in parameters]


def raw_blocks(replies):
    return {"frequency": np.stack([hellinger_feature(count_numbers(reply)) for reply in replies]),
            "ordered": np.stack([ordered_block_feature(reply) for reply in replies]),
            "kernel": np.stack([position_moments(reply) for reply in replies]),
            "sequence": np.stack([sequence_features(reply) for reply in replies])}


def fit_reply_scaler(blocks, labels, classes):
    weights = 1. / np.bincount(labels, minlength=classes)[labels]
    weights /= weights.sum()
    params = {}
    for name, values in blocks.items():
        mean = weights @ values
        scale = np.sqrt(weights @ ((values - mean) ** 2))
        scale[scale < 1e-10] = 1.
        params[name] = dict(mean=mean, scale=scale)
    return params


def reply_transform(blocks, params, layout):
    result = {}
    for name, weight in LAYOUTS[layout].items():
        values = (blocks[name] - params[name]["mean"]) / params[name]["scale"]
        result[name] = values / np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-12) * np.sqrt(weight)
    return result


def group_blocks(transformed, triples):
    means, spreads, distances = [], [], []
    for values in transformed.values():
        group = values[triples]
        means.append(group.mean(axis=1))
        spreads.append(group.std(axis=1))
        pair_distances = np.stack([np.linalg.norm(group[:, first] - group[:, second], axis=1)
                                  for first, second in ((0, 1), (0, 2), (1, 2))], axis=1)
        distances.append(np.c_[pair_distances.mean(axis=1), pair_distances.std(axis=1),
                               pair_distances.min(axis=1), pair_distances.max(axis=1)])
    return dict(mean=np.concatenate(means, axis=1), std=np.concatenate(spreads, axis=1),
                distance=np.concatenate(distances, axis=1))


def fit_group_scaler(blocks, summary):
    params = {}
    for name, weight in SUMMARIES[summary].items():
        values = blocks[name]
        scale = values.std(axis=0)
        scale[scale < 1e-10] = 1.
        params[name] = dict(mean=values.mean(axis=0), scale=scale, weight=weight)
    return params


def group_transform(blocks, params):
    # Static dimension scaling retains absolute dispersion, unlike unit normalization.
    return np.concatenate([(blocks[name] - param["mean"]) / param["scale"]
                            * np.sqrt(param["weight"] / blocks[name].shape[1])
                            for name, param in params.items()], axis=1)


def bootstrap_triples(labels, available, formal, classes, seed):
    """Keep every formal group and cover every eligible row before random draws."""
    rng, triples, truth = np.random.default_rng(seed), [], []
    for label in range(classes):
        pool = np.flatnonzero(available & (labels == label))
        label_groups = [list(group) for group in formal if labels[group[0]] == label and available[group].all()]
        shuffled = rng.permutation(pool)
        for start in range(0, len(shuffled), 3):
            members = list(shuffled[start:start + 3])
            if len(members) < 3:
                members += rng.choice(np.setdiff1d(pool, members), 3 - len(members), replace=False).tolist()
            label_groups.append(members)
        while len(label_groups) < TRIPLES_PER_CLASS:
            label_groups.append(rng.choice(pool, 3, replace=False).tolist())
        if len(label_groups) != TRIPLES_PER_CLASS:
            raise ValueError("The fixed bootstrap budget is smaller than row coverage")
        triples.extend(label_groups)
        truth.extend([label] * len(label_groups))
    triples, truth = np.asarray(triples), np.asarray(truth)
    if not available[triples].all() or not (labels[triples] == truth[:, None]).all():
        raise ValueError("Bootstrap includes an excluded row or mixes labels")
    if any(len(set(group)) != 3 for group in triples) or set(triples.ravel()) != set(np.flatnonzero(available)):
        raise ValueError("Bootstrap must use distinct replies and cover every eligible row")
    return triples, truth


def geometry(features, labels, classes):
    centres = np.stack([features[labels == label].mean(axis=0) for label in range(classes)])
    residual = features - centres[labels]
    covariance = residual.T @ residual / len(features)
    lda_values, lda_vectors = eigh(covariance, check_finite=False)
    target = max(float(np.trace(covariance) / features.shape[1]), 1e-12)
    mean = features.mean(axis=0)
    centred = features - mean
    ridge_values, ridge_vectors = eigh(centred.T @ centred, check_finite=False)
    cross = centred.T @ (np.eye(classes)[labels] - 1. / classes)
    return dict(centres=centres, lda_values=lda_values, lda_vectors=lda_vectors, target=target,
                mean=mean, ridge_values=ridge_values, ridge_vectors=ridge_vectors, cross=cross)


def linear_head(fitted, spec, classes):
    parameter = spec["parameter"]
    if spec["kind"] == "lda":
        denominator = (1 - parameter) * np.maximum(fitted["lda_values"], 0) + parameter * fitted["target"]
        vectors, centres = fitted["lda_vectors"], fitted["centres"]
        coefficient = (vectors @ ((vectors.T @ centres.T) / denominator[:, None])).T
        intercept = -.5 * np.sum(centres * coefficient, axis=1)
    else:
        vectors = fitted["ridge_vectors"]
        coefficient = (vectors @ ((vectors.T @ fitted["cross"]) /
                                  (np.maximum(fitted["ridge_values"], 0) + parameter)[:, None])).T
        intercept = np.full(classes, 1. / classes) - coefficient @ fitted["mean"]
    return coefficient, intercept


def load_artifact(path):
    return joblib.load(path)


def score_groups(artifact, groups):
    if any(len(group) != 3 for group in groups):
        raise ValueError("The frozen group model requires exactly three replies")
    replies = [reply for group in groups for reply in group]
    if any(len(reply) < 80 or any(type(value) is not int or not 1 <= value <= 355 for value in reply) for reply in replies):
        raise ValueError("Replies need at least 80 parsed integers in 1..355")
    transformed = reply_transform(raw_blocks(replies), artifact["reply_params"], artifact["spec"]["layout"])
    summaries = group_blocks(transformed, np.arange(len(replies)).reshape(-1, 3))
    features = group_transform(summaries, artifact["group_params"])
    return features @ artifact["coefficient"].T + artifact["intercept"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    output, started = args.output, time.monotonic()
    output.mkdir(parents=True, exist_ok=True)
    reference, bank_path = ROOT / "projects/data/unified_reference.jsonl", ROOT / "projects/data/unified_bank.json"
    if sha(reference) != REFERENCE_SHA:
        raise ValueError("Reference differs from the frozen first package")
    import json
    bank = json.loads(bank_path.read_text())
    ids = [model["id"] for model in bank["models"]]
    rows, specifications = read_rows(reference), specs()
    panel = reference_panel(rows, ids)
    positions = {row["row_id"]: i for i, row in enumerate(rows)}
    formal = np.asarray([[positions[row_id] for row_id in group["row_ids"]] for group in panel])
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    truth = np.asarray([ids.index(group["model"]) for group in panel])
    environments = np.asarray([group["environment"] for group in panel])
    if len(ids) != 53 or len(rows) != 1948 or formal.shape != (636, 3) or bank["reference_sha256"] != REFERENCE_SHA:
        raise ValueError("Expected the frozen 53-label reference and 636 formal groups")
    sources = [Path(__file__), reference, bank_path, ROOT / "research/studies/sequence-generalization/classifiers.py",
               ROOT / "research/studies/sequence-generalization/positional.py",
               *[ROOT / "projects/offline" / name for name in ("fingerprint.py", "bank_builder.py", "reference_data.py", "shared_verifier_core.py")]]
    hashes = {str(path.relative_to(ROOT)): sha(path) for path in sources}
    baseline_path = ROOT / "research/reports/sequence-generalization/20260930/fusion/reference-oof.npz"
    save(output / "plan.json", dict(source_hashes=hashes, reference_sha256=REFERENCE_SHA, model_ids=ids,
        candidates=specifications, candidate_count=len(specifications), triples_per_class=TRIPLES_PER_CLASS, seed=SEED,
        panel=panel, reference_rows=len(rows), training_only_extras=len(rows) - formal.size,
        selection="All-library 636-group Top-1, MRR, then stable candidate index; named pair diagnostic only.",
        folds="Twelve held environments; preserved excluded_rows removes held query IDs, condition prefixes, exact text and sequence duplicates.",
        sampling="Equal 64 groups per label. Keep eligible formal triples, cover every eligible row with shuffled same-label triples, then sample without replacement inside random triples. Synthetic triples are not independent new observations.",
        preprocessing="Training-only class-balanced reply mean/std, per-block unit normalization; training-only group mean/std, static sqrt(weight/dimension) scaling retains dispersion magnitude.",
        reply_layouts=LAYOUTS, group_summaries=SUMMARIES, aggregation="Reply-permutation-invariant mean, population std, and per-block pair-distance mean/std/min/max.",
        baseline_reference_oof_sha256=sha(baseline_path), external_data="No holdout, previous paired or prospective datasets are read.",
        confidence="Selected OOF temperature is development-only; no production installation or high-confidence claim.",
        versions=dict(python=sys.version, numpy=np.__version__, sklearn=sklearn.__version__)))
    raw = raw_blocks([row["numbers"] for row in rows])
    candidate_scores = np.full((len(specifications), len(panel), len(ids)), np.nan)
    fold_records, fold_triplets = [], []
    with threadpool_limits(limits=1):
        for environment in range(1, 13):
            held_groups = np.flatnonzero(environments == environment)
            available = ~excluded_rows(rows, environment, formal[held_groups].ravel())
            triples, bootstrap_y = bootstrap_triples(labels, available, formal, len(ids), SEED + environment)
            fold_triplets.append(triples)
            params = fit_reply_scaler({name: values[available] for name, values in raw.items()}, labels[available], len(ids))
            fold_records.append(dict(environment=environment, available_rows=int(available.sum()), excluded_rows=int((~available).sum()),
                held_row_ids=[rows[index]["row_id"] for index in formal[held_groups].ravel()],
                train_row_ids=[row["row_id"] for row, keep in zip(rows, available) if keep], bootstrap_groups=len(triples)))
            for layout in LAYOUTS:
                transformed = reply_transform(raw, params, layout)
                train = group_blocks(transformed, triples)
                held = group_blocks(transformed, formal[held_groups])
                for summary in SUMMARIES:
                    group_params = fit_group_scaler(train, summary)
                    features = group_transform(train, group_params)
                    held_features = group_transform(held, group_params)
                    fitted = geometry(features, bootstrap_y, len(ids))
                    for index, spec in enumerate(specifications):
                        if (spec["layout"], spec["summary"]) != (layout, summary):
                            continue
                        coefficient, intercept = linear_head(fitted, spec, len(ids))
                        candidate_scores[index, held_groups] = held_features @ coefficient.T + intercept
            print(f"Environment {environment}/12: {time.monotonic() - started:.1f}s", flush=True)
            save(output / "folds.json", fold_records)
        if not np.isfinite(candidate_scores).all():
            raise ValueError("Incomplete or non-finite group OOF scores")
        leaderboard = [dict(index=index, spec=spec, cv=metrics(scores, truth, ids))
                       for index, (spec, scores) in enumerate(zip(specifications, candidate_scores))]
        leaderboard.sort(key=lambda row: (-row["cv"]["correct"], -row["cv"]["mrr"], row["index"]))
        winner, selected = leaderboard[0], candidate_scores[leaderboard[0]["index"]]
        params = fit_reply_scaler(raw, labels, len(ids))
        triples, bootstrap_y = bootstrap_triples(labels, np.ones(len(rows), dtype=bool), formal, len(ids), SEED)
        transformed = reply_transform(raw, params, winner["spec"]["layout"])
        train = group_blocks(transformed, triples)
        group_params = fit_group_scaler(train, winner["spec"]["summary"])
        fitted = geometry(group_transform(train, group_params), bootstrap_y, len(ids))
        coefficient, intercept = linear_head(fitted, winner["spec"], len(ids))
        artifact = dict(schema="generic-three-reply-group-v1", model_ids=ids, reference_sha256=REFERENCE_SHA,
            source_hashes=hashes, spec=winner["spec"], reply_params=params, group_params=group_params,
            coefficient=coefficient, intercept=intercept, beta=fit_temperature(selected, truth),
            training_groups=len(triples), training_rows=len(rows), seed=SEED)
        joblib.dump(artifact, output / "fitted.joblib", compress=3)
    group_ids = np.asarray([group["id"] for group in panel])
    np.savez_compressed(output / "candidates.npz", scores=candidate_scores, names=np.asarray([spec["id"] for spec in specifications]),
                        y=truth, model_ids=np.asarray(ids), group_ids=group_ids, environment=environments)
    np.savez_compressed(output / "reference-oof.npz", scores=selected, y=truth, model_ids=np.asarray(ids),
                        group_ids=group_ids, environment=environments)
    np.savez_compressed(output / "bootstrap-triplets.npz", triplets=np.stack(fold_triplets), final_triplets=triples,
                        row_ids=np.asarray([row["row_id"] for row in rows]), row_labels=labels)
    baseline = np.load(baseline_path)
    if list(baseline["model_ids"]) != ids or list(baseline["group_ids"]) != list(group_ids) or not np.array_equal(baseline["y"], truth):
        raise ValueError("Frozen first-winner OOF alignment differs")
    base_correct, selected_correct = baseline["scores"].argmax(axis=1) == truth, selected.argmax(axis=1) == truth
    roundtrip = score_groups(load_artifact(output / "fitted.joblib"), [[rows[index]["numbers"] for index in formal[0]]])
    if roundtrip.shape != (1, len(ids)) or not np.isfinite(roundtrip).all():
        raise ValueError("Invalid artifact inference roundtrip")
    summary = dict(selected=winner, candidate_count=len(specifications), leaderboard=leaderboard,
        baseline=metrics(baseline["scores"], truth, ids), reference_sha256=REFERENCE_SHA, source_hashes=hashes,
        gains=int(np.sum(selected_correct & ~base_correct)), losses=int(np.sum(~selected_correct & base_correct)),
        calibration=confidence_metrics(selected, truth, artifact["beta"], ids), artifact_sha256=sha(output / "fitted.joblib"),
        artifact_bytes=(output / "fitted.joblib").stat().st_size, inference_features=coefficient.shape[1],
        elapsed_seconds=time.monotonic() - started, limitation="Reference-only development selection and synthetic bootstrap; no external validation or high-confidence identity claim.")
    save(output / "summary.json", summary)
    report = ["# 通用三回答组特征", "", f"固定 {len(specifications)} 个候选；参考库 SHA {REFERENCE_SHA}。",
        f"全库 636 组选择：{winner['spec']['id']}，命中 {winner['cv']['correct']}/636；上一冻结融合 {summary['baseline']['correct']}/636。",
        f"相对上一方案新增正确 {summary['gains']} 组、退步 {summary['losses']} 组。三回答特征维度 {coefficient.shape[1]}；artifact {summary['artifact_bytes']} bytes。", "",
        "十二环境外折均排除相同挑战、环境、原始文本和解析序列。每类固定 64 组；保留可用正式组并覆盖所有训练回答，包括额外参考行。全部缩放只拟合折内训练数据。", "",
        "均值、总体标准差和距离统计对回答排列不敏感。所有模型采用同一特征和训练规则，Astra/Sol 只列为诊断，未参与参数选择。", "",
        f"所选模型 Astra/Sol 全库命中 {winner['cv']['pair']['all_library_correct']}/24；参考库温度属于开发校准，不能据此称为已验证身份置信度。", "",
        "没有打开已有测试集、配对数据或调用 API。完整候选分数、折内训练行和三元组索引分别保存为 candidates.npz、folds.json、bootstrap-triplets.npz。", ""]
    (output / "report.md").write_text("\n".join(report))
    print(winner["spec"]["id"], winner["cv"], "gains/losses", summary["gains"], summary["losses"], flush=True)


if __name__ == "__main__":
    main()
