# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.1", "joblib==1.5.3", "threadpoolctl>=3"]
# ///
"""Thirteen predeclared source-balanced group rankers; development data only.

Artifacts are plain array dictionaries with a hash-bound first-ranker path.
Inference: load_artifact(path), score_groups(artifact, integer_triples).
"""
from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True
for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[name] = "1"

import argparse
import json
import time
from pathlib import Path

import joblib
import numpy as np
import scipy
from scipy.linalg import eigh
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
import source_robust as source
import group_models as group

OUT = ROOT / "research/reports/generic-refinement-20261001/domain-groups"
REFERENCE_SHA = source.REFERENCE_SHA
SEED = 2026100102
PER_CELL = 64
LAYOUT = "selected_position"
SUMMARIES = ("mean", "mean_std_distance")
HEADS = [dict(id=f"{summary}_lda{shrink:g}", summary=summary, layout=LAYOUT,
              kind="lda", parameter=shrink) for summary in SUMMARIES for shrink in (.15, .5, .85)]
CONFIGS = [dict(id="first_frozen_fusion", head=None, candidate_weight=0.)]
CONFIGS += [dict(id=spec["id"], head=index, candidate_weight=1.) for index, spec in enumerate(HEADS)]
CONFIGS += [dict(id="half_first_" + spec["id"], head=index, candidate_weight=.5) for index, spec in enumerate(HEADS)]


def weighted_scaler(blocks, weights, summary=None):
    params = {}
    for name in (group.SUMMARIES[summary] if summary else source.WEIGHTS):
        values = blocks[name]
        mean = weights @ values
        scale = np.sqrt(weights @ ((values - mean) ** 2))
        scale[scale < 1e-10] = 1.
        params[name] = dict(mean=mean, scale=scale)
        if summary:
            params[name]["weight"] = group.SUMMARIES[summary][name]
    return params


def bootstrap(labels, domains, available, formal, classes, seed):
    rng, triples, y, cells = np.random.default_rng(seed), [], [], []
    for label in range(classes):
        for domain in sorted(set(domains[available & (labels == label)])):
            pool = np.flatnonzero(available & (labels == label) & (domains == domain))
            if len(pool) < 3:
                raise ValueError("A training label/source cell needs three distinct replies")
            members = [list(indices) for indices in formal if labels[indices[0]] == label
                       and available[indices].all() and np.all(domains[indices] == domain)]
            shuffled = rng.permutation(pool)
            for start in range(0, len(shuffled), 3):
                chunk = list(shuffled[start:start + 3])
                if len(chunk) < 3:
                    chunk += rng.choice(np.setdiff1d(pool, chunk), 3 - len(chunk), replace=False).tolist()
                members.append(chunk)
            if len(members) > PER_CELL:
                raise ValueError("The declared 64-group cell budget cannot preserve formal groups and row coverage")
            while len(members) < PER_CELL:
                members.append(rng.choice(pool, 3, replace=False).tolist())
            triples.extend(members); y.extend([label] * PER_CELL); cells.extend([domain] * PER_CELL)
    triples, y, cells = np.asarray(triples, dtype=np.int32), np.asarray(y), np.asarray(cells)
    if (not available[triples].all() or not np.all(labels[triples] == y[:, None]) or
            not np.all(domains[triples] == cells[:, None]) or any(len(set(row)) != 3 for row in triples) or
            set(triples.ravel()) != set(np.flatnonzero(available))):
        raise ValueError("Bootstrap violates source/label/coverage/held-row isolation")
    return triples, y, cells, source.balanced_weights(y, cells, classes)


def fit_geometry(features, labels, weights, classes):
    centres = np.stack([weights[labels == label] @ features[labels == label] / weights[labels == label].sum()
                        for label in range(classes)])
    residual = features - centres[labels]
    covariance = (residual * weights[:, None]).T @ residual
    values, vectors = eigh(covariance, check_finite=False)
    return dict(centres=centres, lda_values=values, lda_vectors=vectors,
                target=max(float(np.trace(covariance) / features.shape[1]), 1e-12))


def head_scores(fitted, numbers):
    replies = [reply for triple in numbers for reply in triple]
    if any(len(triple) != 3 for triple in numbers) or any(len(reply) < 80 for reply in replies):
        raise ValueError("Three scorable replies per group are required")
    parts = group.reply_transform(group.raw_blocks(replies), fitted["reply_params"], LAYOUT)
    blocks = group.group_blocks(parts, np.arange(len(replies)).reshape(-1, 3))
    features = group.group_transform(blocks, fitted["group_params"])
    return features @ fitted["coefficient"].T + fitted["intercept"]


def load_artifact(path):
    artifact = joblib.load(path)
    if artifact["schema"] != "generic-domain-group-v1" or artifact["reference_sha256"] != REFERENCE_SHA:
        raise ValueError("Unexpected domain-group artifact")
    for path, digest in artifact["source_hashes"].items():
        if source.sha(ROOT / path) != digest:
            raise ValueError(f"Frozen source/input changed: {path}")
    if source.sha(ROOT / artifact["baseline"]["path"]) != artifact["baseline"]["sha256"]:
        raise ValueError("First-ranker baseline changed")
    return artifact


def score_groups(artifact, groups):
    if any(len(triple) != 3 for triple in groups):
        raise ValueError("This frozen method requires exactly three replies")
    weight = artifact["config"]["candidate_weight"]
    if weight < 1:
        if "_baseline" not in artifact:
            artifact["_baseline"] = source.fusion.load_artifact(ROOT / artifact["baseline"]["path"])
        baseline = source.fusion.score_groups(artifact["_baseline"], groups)
        if not weight:
            return baseline
    candidate = source.z(head_scores(artifact["head"], groups))
    return candidate if weight == 1 else weight * candidate + (1 - weight) * source.z(baseline)


def development_metrics(scores, truth, domains, ids):
    order = np.argsort(-scores, axis=1, kind="stable")
    ranks = np.argmax(order == truth[:, None], axis=1) + 1
    correct = ranks == 1
    weights = source.balanced_weights(truth, domains, len(ids))
    per_model = {}
    for label, name in enumerate(ids):
        cells = {}
        for domain in sorted(set(domains[truth == label])):
            selected = (truth == label) & (domains == domain)
            cells[domain] = dict(groups=int(selected.sum()), correct=int(correct[selected].sum()),
                                 accuracy=float(correct[selected].mean()), mrr=float((1 / ranks[selected]).mean()))
        per_model[name] = dict(sources=cells, source_mean_top1=float(np.mean([cell["accuracy"] for cell in cells.values()])))
    return dict(groups=len(truth), label_source_macro_top1=float(weights @ correct),
                label_source_macro_mrr=float(weights @ (1 / ranks)), raw_correct=int(correct.sum()),
                raw_top1=float(correct.mean()), raw_top3=float((ranks <= 3).mean()), per_model=per_model)


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    ids, rows, groups, indices, registry = source.load_inputs()
    formal = np.asarray(indices)
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    domains = np.asarray([row["domain"] for row in rows])
    truth = np.asarray([ids.index(record["model"]) for record in groups])
    group_domains = []
    for triple in formal:
        actual = set(domains[triple])
        if len(actual) != 1:
            raise ValueError("A development group spans actual acquisition sources")
        group_domains.append(next(iter(actual)))
    group_domains = np.asarray(group_domains)
    if len(rows) != 2188 or formal.shape != (716, 3) or len(ids) != 53:
        raise ValueError("Expected 1948 reference + 240 derived-development replies")
    reference = np.load(source.OUT / "reference-oof.npz")
    development = np.load(source.OUT / "development-oof.npz")
    for data, selected in ((reference, groups[:636]), (development, groups[636:])):
        if list(data["model_ids"]) != ids or list(data["group_ids"]) != [record["id"] for record in selected]:
            raise ValueError("Frozen 52-fold comparator differs from the input groups")
    baseline_scores = np.concatenate((reference["scores"][0], development["scores"][0]))
    folds = []
    for environment in range(1, 13):
        held = [i for i, record in enumerate(groups) if record["cohort"] == "reference" and record["environment"] == environment]
        folds.append((f"reference:{environment:02d}", held, source.training_indices(rows, set(formal[held].ravel()), environment)))
    for cohort in source.COHORTS:
        for round_id in sorted({record["round"] for record in groups if record["cohort"] == cohort}):
            held = [i for i, record in enumerate(groups) if record["cohort"] == cohort and record["round"] == round_id]
            folds.append((f"{cohort}:{round_id}", held, source.training_indices(rows, set(formal[held].ravel()))))
    old_folds = json.loads((source.OUT / "folds.json").read_text())
    if len(folds) != 52 or any(set(record["training_row_ids"]) != {rows[i]["row_id"] for i in train}
            or record["held_group_ids"] != [groups[i]["id"] for i in held]
            for record, (_, held, train) in zip(old_folds, folds)):
        raise ValueError("The declared 52-fold exclusion procedure differs")
    files = [Path(__file__), Path(__file__).with_name("DOMAIN_PROTOCOL.md"), Path(group.__file__), Path(source.__file__),
             source.REFERENCE, source.SNAPSHOT / "projects/data/unified_bank.json", source.BUNDLE / "bundle.json", source.BUNDLE / "requirements.txt",
             source.STUDY / "positional.py", *[source.SNAPSHOT / "projects/offline" / name for name in
             ("fingerprint.py", "bank_builder.py", "reference_data.py", "shared_verifier_core.py")],
             *[source.OUT / name for name in ("reference-oof.npz", "development-oof.npz", "folds.json", "groups.json", "derived-development-manifest.json")],
             *[ROOT / dataset["original_" + kind] for dataset in registry for kind in ("manifest", "samples")]]
    hashes = {str(path.relative_to(ROOT)): source.sha(path) for path in files}
    plan = dict(schema="generic-domain-group-plan-v1", reference_sha256=REFERENCE_SHA, model_ids=ids,
        reference_rows=1948, derived_development_rows=240, total_rows=2188, reference_groups=636, development_groups=80,
        source_hashes=hashes, configs=CONFIGS, heads=HEADS, seed=SEED, bootstrap_per_label_source=PER_CELL,
        feature_layout=source.WEIGHTS, summaries={name: group.SUMMARIES[name] for name in SUMMARIES},
        summary_dimensions=dict(mean=751, mean_std_distance=1518),
        group_distance="Each of four blocks: mean/std/min/max of the three pairwise Euclidean distances; population std.",
        bootstrap="Distinct same-label/same-actual-source replies, retain eligible formal triples, cover all available rows, then random draws; 64 groups per cell, not 64 independent observations.",
        selection="53 labels equal; each label actual sources equal; Top1 then equally weighted MRR then fixed index. Same-source batches merge. No named-pair metric in selection.",
        preprocessing="Label/source-balanced fold-training-only reply/group mean/std, centres and pooled covariance; static group dimension scaling preserves dispersion.",
        folds="Reuse 12 reference environment + 40 both-label matched-round exclusion sets and frozen first-ranker baseline scores. Exact held text/sequence/query/environment rows removed.",
        calibration=None, fixed_holdout_opened=False, independent_validation=False,
        diagnostics="Original636 and matched80 cohorts reported separately; clean-transfer is not added as another sample.",
        versions=dict(python=sys.version, numpy=np.__version__, scipy=scipy.__version__, joblib=joblib.__version__), threads=1)
    source.save(OUT / "plan.json", plan)
    evaluation_weights = source.balanced_weights(truth, group_domains, len(ids))
    source.save(OUT / "groups.json", [{**record, "domain": str(domain), "evaluation_weight": float(weight)}
                                     for record, domain, weight in zip(groups, group_domains, evaluation_weights)])
    raw = group.raw_blocks([row["numbers"] for row in rows])
    head_oof = np.full((len(HEADS), len(groups), len(ids)), np.nan)
    fold_records, triplets_by_fold = [], []
    with threadpool_limits(limits=1):
        for fold_number, (name, held, train) in enumerate(folds, 1):
            available = np.zeros(len(rows), dtype=bool); available[train] = True
            triples, bootstrap_y, cells, weights = bootstrap(labels, domains, available, formal, len(ids), SEED + fold_number)
            triplets_by_fold.append(triples)
            reply_params = weighted_scaler({key: values[train] for key, values in raw.items()},
                                           source.balanced_weights(labels[train], domains[train], len(ids)))
            transformed = group.reply_transform(raw, reply_params, LAYOUT)
            training, query = group.group_blocks(transformed, triples), group.group_blocks(transformed, formal[held])
            for summary in SUMMARIES:
                group_params = weighted_scaler(training, weights, summary)
                fitted = fit_geometry(group.group_transform(training, group_params), bootstrap_y, weights, len(ids))
                features = group.group_transform(query, group_params)
                for index, spec in enumerate(HEADS):
                    if spec["summary"] == summary:
                        coefficient, intercept = group.linear_head(fitted, spec, len(ids))
                        head_oof[index, held] = features @ coefficient.T + intercept
            fold_records.append(dict(id=name, training_row_ids=[rows[i]["row_id"] for i in train],
                held_group_ids=[groups[i]["id"] for i in held], bootstrap_groups=len(triples),
                source_cells=len(triples) // PER_CELL, class_weight_max_delta=float(np.max(np.abs(np.bincount(bootstrap_y, weights=weights, minlength=len(ids)) - 1 / len(ids))))))
            if fold_number % 4 == 0:
                print(f"DOMAIN fold {fold_number}/52: {time.monotonic() - started:.1f}s", flush=True)
        scores = np.stack([baseline_scores if config["head"] is None else
            config["candidate_weight"] * source.z(head_oof[config["head"]]) +
            (1 - config["candidate_weight"]) * source.z(baseline_scores) for config in CONFIGS])
        if not np.isfinite(scores).all():
            raise ValueError("Missing or non-finite domain OOF scores")
        # Save every candidate before selecting a single development winner.
        source.save(OUT / "folds.json", fold_records)
        np.savez_compressed(OUT / "candidates.npz", scores=scores, head_scores=head_oof, y=truth,
            model_ids=ids, group_ids=[record["id"] for record in groups], domains=group_domains,
            evaluation_weights=evaluation_weights, names=[config["id"] for config in CONFIGS])
        leaderboard = [dict(index=index, config=config, metrics=development_metrics(values, truth, group_domains, ids),
            reference=source.metrics(values[:636], groups[:636], ids),
            development=source.metrics(values[636:], groups[636:], ids)) for index, (config, values) in enumerate(zip(CONFIGS, scores))]
        winner = min(leaderboard, key=lambda entry: (-entry["metrics"]["label_source_macro_top1"],
            -entry["metrics"]["label_source_macro_mrr"], entry["index"]))
        final_triples, final_y, final_cells, final_weights = bootstrap(labels, domains, np.ones(len(rows), dtype=bool), formal, len(ids), SEED)
        selected_head = None
        if winner["config"]["head"] is not None:
            spec = HEADS[winner["config"]["head"]]
            reply_params = weighted_scaler(raw, source.balanced_weights(labels, domains, len(ids)))
            transformed = group.reply_transform(raw, reply_params, LAYOUT)
            training = group.group_blocks(transformed, final_triples)
            group_params = weighted_scaler(training, final_weights, spec["summary"])
            fitted = fit_geometry(group.group_transform(training, group_params), final_y, final_weights, len(ids))
            coefficient, intercept = group.linear_head(fitted, spec, len(ids))
            selected_head = dict(spec=spec, reply_params=reply_params, group_params=group_params,
                                 coefficient=coefficient, intercept=intercept)
        baseline_path = source.RUN / "fusion/fitted.joblib"
        artifact = dict(schema="generic-domain-group-v1", model_ids=ids, reference_sha256=REFERENCE_SHA,
            config=winner["config"], head=selected_head, baseline=dict(path=str(baseline_path.relative_to(ROOT)), sha256=source.sha(baseline_path)),
            source_hashes=hashes, calibration=None, development_input_rows=len(rows),
            training_rows=1948 if selected_head is None else len(rows),
            training_groups=0 if selected_head is None else len(final_triples),
            final_bootstrap_groups=len(final_triples), seed=SEED)
        joblib.dump(artifact, OUT / "fitted.joblib", compress=3)
    selected = scores[winner["index"]]
    for filename, values, records, actual_y, actual_domains in (
            ("selected-oof.npz", selected, groups, truth, group_domains),
            ("reference-oof.npz", selected[:636], groups[:636], truth[:636], group_domains[:636]),
            ("development-oof.npz", selected[636:], groups[636:], truth[636:], group_domains[636:])):
        np.savez_compressed(OUT / filename, scores=values, model_ids=ids, group_ids=[record["id"] for record in records], y=actual_y, domains=actual_domains)
    offsets = np.r_[0, np.cumsum([len(triples) for triples in triplets_by_fold])]
    np.savez_compressed(OUT / "bootstrap-triplets.npz", triplets=np.concatenate(triplets_by_fold), offsets=offsets,
        fold_ids=[record[0] for record in folds], row_ids=[row["row_id"] for row in rows], labels=labels, domains=domains,
        final_triplets=final_triples)
    baseline_correct, chosen_correct = baseline_scores[:636].argmax(1) == truth[:636], selected[:636].argmax(1) == truth[:636]
    result = dict(winner=winner, candidates=leaderboard, source_hashes=hashes, reference_sha256=REFERENCE_SHA,
        original_reference_gains=int(np.sum(chosen_correct & ~baseline_correct)), original_reference_losses=int(np.sum(~chosen_correct & baseline_correct)),
        artifact_sha256=source.sha(OUT / "fitted.joblib"), elapsed_seconds=time.monotonic() - started,
        calibration=None, independent_validation=False, limitation="Source-aware developmental selection; only a few labels have multiple sources. Matched rounds and synthetic triples are not independent fresh observations.")
    source.save(OUT / "selection.json", result)
    check = score_groups(load_artifact(OUT / "fitted.joblib"), [[rows[i]["numbers"] for i in formal[0]]])
    if check.shape != (1, len(ids)) or not np.isfinite(check).all():
        raise ValueError("Artifact inference roundtrip failed")
    frozen_hashes = dict(hashes)
    for name in ("plan.json", "groups.json", "folds.json", "candidates.npz", "selected-oof.npz", "reference-oof.npz", "development-oof.npz", "bootstrap-triplets.npz", "selection.json", "fitted.joblib"):
        frozen_hashes[str((OUT / name).relative_to(ROOT))] = source.sha(OUT / name)
    source.save(OUT / "freeze.json", dict(schema="generic-domain-group-freeze-v1", hashes=frozen_hashes,
        selected=winner["config"], reference_sha256=REFERENCE_SHA, calibration=None, fixed_holdout_opened=False,
        freeze_after_selection_before_regression=True))
    lines = ["# 来源均衡的通用三回答组开发研究", "", "固定13项：原融合、六个LDA头及六个等权组合。没有打开固定holdout或调用API。", "",
        "| 候选 | 53标签/实际来源均衡Top1 | 同权MRR | 原636命中 | 已见匹配80命中 |", "|---|---:|---:|---:|---:|"]
    for entry in leaderboard:
        lines.append(f"| {entry['config']['id']} | {entry['metrics']['label_source_macro_top1']:.6f} | {entry['metrics']['label_source_macro_mrr']:.6f} | {entry['reference']['hits']} | {entry['development']['hits']} |")
    lines += ["", f"选择 {winner['config']['id']}；原636相对580新增正确{result['original_reference_gains']}、退步{result['original_reference_losses']}。", "",
        "全部2188回答用于候选开发。每label/source生成64组三元组，三成员不重复且同来源，覆盖可用训练行；reply/group尺度、中心与协方差均只在训练折按标签和来源均衡拟合。所选原融合仍只用1948条参考回答训练；新增240条匹配回答影响开发选型，没有加入所选原模型。", "",
        "52个折沿用参考环境与同时留出两个标签的匹配轮次，原始文本/整数序列/相同题号和环境排除规则保持。均衡指标合并同实际来源的批次，每标签内来源等权，再对53标签等权。", "",
        "没有新增温度。selected-oof.npz包含716组，可供另行预声明的开发校准；不能复制原温度解释新分数。原636和匹配80分开列出，匹配资料不是独立测试，来源推广证据仅覆盖很少标签。", ""]
    (OUT / "report.md").write_text("\n".join(lines))
    print(json.dumps(dict(winner=winner["config"], macro=winner["metrics"]["label_source_macro_top1"], reference=winner["reference"]["hits"],
        development=winner["development"]["hits"], artifact_sha256=result["artifact_sha256"], elapsed_seconds=result["elapsed_seconds"]), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
