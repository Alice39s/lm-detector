"""V2 developmental study with matched paired cohorts in a whole-bank gallery.

Usage: uv run --no-project --with numpy --with scipy --with scikit-learn \
  --with joblib --with threadpoolctl python research/studies/sequence-generalization/enriched.py

The v1 prospective collection is reused as development data here. This changes
only the derivative protocol, never its original manifest or frozen v1 evidence.
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
from scipy.linalg import eigh, solve
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "projects/offline"))
from bank_builder import read_rows  # noqa: E402
from ensemble_confidence_core import Ensemble  # noqa: E402
from fingerprint import count_numbers, parse_numbers  # noqa: E402
from shared_verifier_core import reference_panel  # noqa: E402
from rerank import feature_blocks  # noqa: E402

OUT = ROOT / "research/reports/sequence-generalization/20260930/enriched"
REFERENCE = ROOT / "projects/data/unified_reference.jsonl"
COHORTS = {
    "openrouter": ROOT / "research/reports/astra-sol-separation/paired-low-01/samples.jsonl",
    "direct_v1_reused": ROOT / "research/reports/sequence-generalization/20260930/prospective/samples.jsonl",
}
REPORT_PAIR = ("gpt-6-astra", "gpt-6.1-sol")
CONFIGS = [{"id": "ensemble", "method": "ensemble"}]
CONFIGS += [{"id": f"local_{layout}_s{shrink:g}", "method": "local", "layout": layout,
             "shrinkage": shrink, "gate": .5}
            for layout in ("frequency", "frequency_order", "position4") for shrink in (.3, .7)]
CONFIGS += [{"id": f"lda_{layout}_s0.3", "method": "lda", "layout": layout, "shrinkage": .3}
            for layout in ("frequency", "frequency_order", "compact")]
CONFIGS += [{"id": f"qda_compact_s{shrink:g}", "method": "qda", "layout": "compact",
             "shrinkage": shrink} for shrink in (.3, .7)]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    def default(x):
        if isinstance(x, np.ndarray):
            return x.tolist()
        if isinstance(x, np.generic):
            return x.item()
        raise TypeError(type(x).__name__)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False,
                               default=default) + "\n")


def load_cohort(path, cohort):
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    first = {}
    for r in sorted(records, key=lambda r: r["attempt"]):
        if r["status"] == "accepted":
            first.setdefault(r["sample_id"], r)
    rows = []
    for r in first.values():
        numbers = parse_numbers(r["text"])
        if len(numbers) < max(80, np.ceil(r["expected_count"] * .55)):
            raise ValueError("Accepted cohort sample fails product parser")
        rows.append({"row_id": f"{cohort}:{r['sample_id']}", "source": r["model"],
                     "challenge_id": f"{cohort}:{r['challenge_id']}", "condition_id": f"{cohort}:{r['round_id']}",
                     "cohort": cohort, "round": r["round_id"], "text": r["text"], "numbers": numbers,
                     "counts": count_numbers(numbers)})
    if len(rows) != 120:
        raise ValueError(f"Expected120 accepted answers in {cohort}, found{len(rows)}")
    return rows


def class_weights(y, classes):
    counts = np.bincount(y, minlength=classes)
    if np.any(counts == 0):
        raise ValueError("Gallery loses a registered label")
    return 1 / (classes * counts[y])


def compact(numbers, blocks):
    marginal = []
    for n in numbers:
        x = np.asarray(n, int)
        bins = np.minimum(15, (x - 1) * 16 // 355)
        counts = np.bincount(bins, minlength=16) + .5
        digits = np.bincount(x % 10, minlength=10) + .5
        marginal.append(np.r_[np.sqrt(counts / counts.sum()), np.sqrt(digits / digits.sum())])
    return np.c_[marginal, blocks["dense"], blocks["position4"]]


def all_features(numbers):
    parts = feature_blocks(numbers)
    parts["compact"] = compact(numbers, parts)
    return parts


def fit_geometry(parts, y, classes, layout):
    weight = class_weights(y, classes)
    layouts = {"frequency": {"frequency": .75, "ordered": .25},
               "frequency_order": {"frequency": .6, "ordered": .2, "dense": .2},
               "position4": {"position4": 1.},
               "compact": {"compact": 1.}}
    params, pieces = {}, []
    for name, block_weight in layouts[layout].items():
        x = parts[name]
        mean = weight @ x
        scale = np.sqrt(weight @ ((x - mean) ** 2))
        scale[scale < 1e-10] = 1
        z = (x - mean) / scale
        if layout != "compact":
            z /= np.maximum(np.linalg.norm(z, axis=1, keepdims=True), 1e-12)
        params[name] = {"mean": mean, "scale": scale, "weight": block_weight}
        pieces.append(z * np.sqrt(block_weight))
    z = np.concatenate(pieces, axis=1)
    projection = None
    if layout == "compact":
        # Fit a24-dimensional projection only on training data. Per-label sample
        # weights keep the enriched labels from dominating covariance geometry.
        covariance = (z * weight[:, None]).T @ z
        _, vectors = eigh(covariance, check_finite=False)
        projection = vectors[:, -24:]
        z = z @ projection
    centres = np.stack([z[y == k].mean(0) for k in range(classes)])
    residual = z - centres[y]
    pooled = (residual * weight[:, None]).T @ residual
    return {"layout": layout, "params": params, "projection": projection,
            "centres": centres, "pooled": pooled, "z": z}


def transform_geometry(parts, geometry):
    pieces = []
    for name, p in geometry["params"].items():
        z = (parts[name] - p["mean"]) / p["scale"]
        if geometry["layout"] != "compact":
            z /= np.maximum(np.linalg.norm(z, axis=1, keepdims=True), 1e-12)
        pieces.append(z * np.sqrt(p["weight"]))
    z = np.concatenate(pieces, axis=1)
    return z @ geometry["projection"] if geometry["projection"] is not None else z


def fit_head(geometry, y, config):
    p = geometry["pooled"].shape[0]
    centres = geometry["centres"]
    shrink = config["shrinkage"]
    target = max(np.trace(geometry["pooled"]) / p, 1e-12)
    if config["method"] == "lda":
        covariance = (1 - shrink) * geometry["pooled"] + shrink * target * np.eye(p)
        coefficient = solve(covariance, centres.T, assume_a="pos", check_finite=False).T
        return {"method": "lda", "coefficient": coefficient,
                "intercept": -.5 * np.sum(centres * coefficient, axis=1)}
    inverse, logdet = [], []
    for k in range(len(centres)):
        residual = geometry["z"][y == k] - centres[k]
        covariance = residual.T @ residual / len(residual)
        covariance = (1 - shrink) * covariance + shrink * geometry["pooled"] + .02 * target * np.eye(p)
        values, vectors = eigh(covariance, check_finite=False)
        inverse.append((vectors / values) @ vectors.T)
        logdet.append(np.log(values).sum())
    return {"method": "qda", "inverse": np.stack(inverse), "logdet": np.asarray(logdet)}


def score_head(geometry, head, parts):
    z = transform_geometry(parts, geometry)
    if head["method"] == "lda":
        return z @ head["coefficient"].T + head["intercept"]
    difference = z[:, None, :] - geometry["centres"]
    return -.5 * (np.einsum("nkd,kde,nke->nk", difference, head["inverse"], difference) + head["logdet"])


def fit_local_balanced(parts, labels, pair, layout, shrink):
    local_labels = np.asarray([pair.index(k) for k in labels if k in pair])
    local = {name: x[np.isin(labels, pair)] for name, x in parts.items()}
    geometry = fit_geometry(local, local_labels, 2, layout)
    head = fit_head(geometry, local_labels, {"method": "lda", "shrinkage": shrink})
    geometry.pop("z")
    return {"geometry": geometry, "head": head, "pair": pair, "layout": layout}


def local_scores(model, parts):
    return score_head(model["geometry"], model["head"], parts)


def score_fold(train_rows, train_parts, y, ids, test_groups, test_parts):
    baseline = Ensemble(train_rows, ids)
    base = np.stack([s[0] for s in baseline.score_groups(test_groups)])
    results = [base]
    local_cache, geometry_cache = {}, {}
    for config in CONFIGS[1:]:
        if config["method"] == "local":
            output = base.copy()
            for i, scores in enumerate(base):
                first, second = np.argsort(-scores, kind="stable")[:2]
                if scores[first] - scores[second] > config["gate"]:
                    continue
                pair = tuple(sorted([int(first), int(second)]))
                key = (pair, config["layout"], config["shrinkage"])
                if key not in local_cache:
                    local_cache[key] = fit_local_balanced(train_parts, y, pair,
                                                        config["layout"], config["shrinkage"])
                parts = {name: x[i * 3:i * 3 + 3] for name, x in test_parts.items()}
                evidence = local_scores(local_cache[key], parts).mean(0)
                winner = pair[int(evidence.argmax())]
                if winner == second:
                    output[i, first], output[i, second] = scores[second], scores[first]
            results.append(output)
        else:
            layout = config["layout"]
            if layout not in geometry_cache:
                geometry_cache[layout] = fit_geometry(train_parts, y, len(ids), layout)
            geometry = geometry_cache[layout]
            head = fit_head(geometry, y, config)
            single = score_head(geometry, head, test_parts)
            results.append(single.reshape(-1, 3, len(ids)).mean(1))
    return np.stack(results)


def metrics(scores, groups, ids):
    truth = np.asarray([ids.index(g["model"]) for g in groups])
    ranking = np.argsort(-scores, axis=1, kind="stable")
    correct = ranking[:, 0] == truth
    pair = np.isin(truth, [ids.index(p) for p in REPORT_PAIR])
    return {"groups": len(groups), "hits": int(correct.sum()), "top1": float(correct.mean()),
            "macro_top1": float(np.mean([correct[truth == k].mean() for k in np.unique(truth)])),
            "top3": float(np.any(ranking[:, :3] == truth[:, None], axis=1).mean()),
            "pair": {"groups": int(pair.sum()), "hits": int(correct[pair].sum()),
                     "top1": float(correct[pair].mean()) if pair.any() else None,
                     "by_model": {p: {"hits": int(correct[truth == ids.index(p)].sum()),
                                      "groups": int((truth == ids.index(p)).sum())} for p in REPORT_PAIR}}}


def excluded_train(rows, test_indices, held_challenges=(), held_prefix=None):
    texts = {rows[i]["text"].strip() for i in test_indices}
    sequences = {tuple(rows[i]["numbers"]) for i in test_indices}
    return [i for i, r in enumerate(rows) if i not in test_indices and r["challenge_id"] not in held_challenges
            and not (held_prefix and r["condition_id"].startswith(held_prefix))
            and r["text"].strip() not in texts and tuple(r["numbers"]) not in sequences]


def main():
    started = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / "results.json").exists() and not (OUT / "previous-results-with-primary-reference.json").exists():
        (OUT / "previous-results-with-primary-reference.json").write_bytes((OUT / "results.json").read_bytes())
        (OUT / "previous-plan-with-primary-reference.json").write_bytes((OUT / "plan.json").read_bytes())
    hashes = {str(p.relative_to(ROOT)): sha(p) for p in (REFERENCE, *COHORTS.values(), Path(__file__))}
    plan = {"version": 2, "hashes": hashes, "configs": CONFIGS,
            "v1_reuse": "The prospective direct v1 answers are now developmental inputs in this derivative study. Original manifests and v1 results remain unchanged.",
            "features": "Only parsed numeric outputs. No source, request metadata, elapsed time, speed, or model IDs as features.",
            "gallery": "All53 registered labels; enriched paired cohorts remain research-only.",
            "reference_cv": "12 held environments; standard636groups; all variants held by challenge and environment prefix.",
            "paired_cv": "Leave one cohort+round acrossboth labels; all6 matched answers withheld. Others remain training-only.",
            "cross_cohort": "Remove all primary reference rows of labels observed in held cohort. Train those labels only on the opposite matched cohort; keep every other gallery label.",
            "preprocessing": "Train-only class-balanced feature mean/scale/covariance; uniform class priors. Ensemble uses its existing preprocessing with uniform LDA priors.",
            "selection": "Primary best all-library reference CV. Pair results are developmental diagnostics, never independent validation."}
    save(OUT / "plan.json", plan)
    reference = read_rows(REFERENCE)
    ids = [m["id"] for m in json.loads((ROOT / "projects/data/unified_bank.json").read_text())["models"]]
    panel = reference_panel(reference, ids)
    cohort_rows = [r for cohort, path in COHORTS.items() for r in load_cohort(path, cohort)]
    rows = reference + cohort_rows
    by_id = {r["row_id"]: i for i, r in enumerate(rows)}
    groups = [{**p, "cohort": "reference"} for p in panel]
    for cohort in COHORTS:
        for round_id in sorted({r["round"] for r in cohort_rows if r["cohort"] == cohort}):
            for label in ids:
                selected = [r for r in cohort_rows if r["cohort"] == cohort and r["round"] == round_id and r["source"] == label]
                if selected:
                    if len(selected) != 3:
                        raise ValueError("Incomplete matched cohort group")
                    groups.append({"id": f"{cohort}:{label}:{round_id}", "model": label, "cohort": cohort,
                                   "round": round_id, "row_ids": [r["row_id"] for r in selected]})
    group_indices = [[by_id[r] for r in g["row_ids"]] for g in groups]
    parts = all_features([r["numbers"] for r in rows])
    y = np.asarray([ids.index(r["source"]) for r in rows])
    scores = np.full((len(CONFIGS), len(groups), len(ids)), np.nan)
    fold_plans = []
    folds = []
    for environment in range(1, 13):
        held = [i for i, g in enumerate(groups) if g["cohort"] == "reference" and g["environment"] == environment]
        indices = {j for i in held for j in group_indices[i]}
        challenges = {rows[i]["challenge_id"] for i in indices}
        train = excluded_train(rows, indices, challenges, f"environment-{environment:02d}")
        folds.append((f"reference:{environment}", held, train))
    for cohort in COHORTS:
        for round_id in sorted({g["round"] for g in groups if g["cohort"] == cohort}):
            held = [i for i, g in enumerate(groups) if g["cohort"] == cohort and g["round"] == round_id]
            indices = {j for i in held for j in group_indices[i]}
            train = excluded_train(rows, indices)
            folds.append((f"{cohort}:{round_id}", held, train))
    for n, (name, held, train) in enumerate(folds, 1):
        test = [j for i in held for j in group_indices[i]]
        values = score_fold([rows[i] for i in train], {k: x[train] for k, x in parts.items()}, y[train], ids,
                            [[rows[j]["numbers"] for j in group_indices[i]] for i in held],
                            {k: x[test] for k, x in parts.items()})
        scores[:, held] = values
        fold_plans.append({"id": name, "training_row_ids": [rows[i]["row_id"] for i in train],
                           "held_group_ids": [groups[i]["id"] for i in held]})
        if n % 4 == 0:
            print(f"ENRICHED fold{n}/{len(folds)} {time.time() - started:.1f}s", flush=True)
    if not np.isfinite(scores).all():
        raise ValueError("Missing/nonfinite developmental OOF scores")
    transfer = {}
    transfer_plans = []
    for cohort in COHORTS:
        held = [i for i, g in enumerate(groups) if g["cohort"] == cohort]
        test = [j for i in held for j in group_indices[i]]
        held_labels = {rows[j]["source"] for j in test}
        train = [i for i, r in enumerate(rows) if r.get("cohort") != cohort
                 and (r.get("cohort") is not None or r["source"] not in held_labels)]
        train = [i for i in train if rows[i]["text"].strip() not in {rows[j]["text"].strip() for j in test}
                 and tuple(rows[i]["numbers"]) not in {tuple(rows[j]["numbers"]) for j in test}]
        transfer[cohort] = score_fold([rows[i] for i in train], {k: x[train] for k, x in parts.items()}, y[train], ids,
            [[rows[j]["numbers"] for j in group_indices[i]] for i in held], {k: x[test] for k, x in parts.items()})
        transfer_plans.append({"held_cohort": cohort, "labels_with_primary_references_removed": sorted(held_labels),
                               "training_row_ids": [rows[i]["row_id"] for i in train],
                               "held_group_ids": [groups[i]["id"] for i in held]})
    results = []
    for k, config in enumerate(CONFIGS):
        result = {**config}
        for cohort in ("reference", *COHORTS):
            held = [i for i, g in enumerate(groups) if g["cohort"] == cohort]
            result[cohort] = metrics(scores[k, held], [groups[i] for i in held], ids)
            if cohort in transfer:
                result[f"transfer_to_{cohort}"] = metrics(transfer[cohort][k], [groups[i] for i in held], ids)
        results.append(result)
    winner = max(results, key=lambda r: (r["reference"]["hits"], r["reference"]["macro_top1"], r["id"] == "ensemble"))
    substantive = [r for r in results if all(r[c]["top1"] >= .8 for c in COHORTS)
                   and r["reference"]["top1"] >= results[0]["reference"]["top1"] - .02]
    save(OUT / "results.json", {"hashes": hashes, "model_ids": ids, "training_rows": len(rows),
                               "candidates": results, "winner_all_library": winner,
                               "substantive_developmental_candidates": [r["id"] for r in substantive],
                               "elapsed_seconds": time.time() - started,
                               "independent_evaluation_available": False})
    np.savez_compressed(OUT / "candidates.npz", scores=scores, names=[c["id"] for c in CONFIGS],
                        model_ids=ids, group_ids=[g["id"] for g in groups], y=[ids.index(g["model"]) for g in groups],
                        transfer_openrouter=transfer["openrouter"], transfer_direct=transfer["direct_v1_reused"])
    save(OUT / "groups.json", groups)
    save(OUT / "folds.json", fold_plans)
    save(OUT / "transfer-folds.json", transfer_plans)
    # Store a fully usable whole-library candidate only if development contains
    # a sizable signal. A new independent collection is required to confirm it.
    if substantive:
        chosen = max(substantive, key=lambda r: (r["reference"]["hits"], min(r[c]["hits"] for c in COHORTS)))
        index = next(i for i, c in enumerate(CONFIGS) if c["id"] == chosen["id"])
        fit = {"config": CONFIGS[index], "model_ids": ids, "reference_sha256": hashes[str(REFERENCE.relative_to(ROOT))],
               "developmental_cohort_hashes": hashes, "parts": parts, "labels": y, "rows": rows,
               "base": Ensemble(rows, ids)}
        if chosen["method"] not in ("ensemble", "local"):
            geometry = fit_geometry(parts, y, len(ids), chosen["layout"])
            fit["head"] = fit_head(geometry, y, chosen)
            geometry.pop("z")
            fit["geometry"] = geometry
        joblib.dump(fit, OUT / "frozen.joblib")
        save(OUT / "freeze.json", {"config": CONFIGS[index], "artifact_sha256": sha(OUT / "frozen.joblib"),
                                   "hashes": hashes, "prospective_v2_not_opened": True,
                                   "confidence": "Unavailable: developmental ranking fit only"})
    table = "\n".join(f"| {r['id']} | {r['reference']['hits']}/636 | {r['openrouter']['hits']}/40 | "
                      f"{r['direct_v1_reused']['hits']}/40 | {r['transfer_to_openrouter']['hits']}/40 | "
                      f"{r['transfer_to_direct_v1_reused']['hits']}/40 |" for r in results)
    (OUT / "report.md").write_text("# V2：匹配来源的补充训练与全库序列识别\n\n"
        "本轮把 v1 新直连配对集改作开发数据，原始 manifest 和 v1 验证结果保持原样。"
        "任何本轮命中率都不是独立验证结果。训练库含全部53标签、1948正式参考和两来源各120条配对回答。"
        "数值特征不使用渠道、速度、接口或其他元数据。\n\n"
        "参考验证按12固定环境留出，共636组。配对开发验证分别按来源+轮次同时留出两个标签的六条回答。"
        "跨来源列删除被留来源所含标签的全部正式参考，只用另一匹配来源训练这些标签；其余51标签参考完整保留。"
        "因此不会通过Astra直连正式参考或Sol的OR正式参考泄露同来源回答。标准化、投影和协方差仅拟合训练行；"
        "通用分类器使用均匀标签先验。QDA在训练拟合的24维紧凑投影上使用类内协方差向全库协方差收缩。\n\n"
        "| 方法 | 全库参考 | OR留轮 | 直连留轮 | 跨来源至OR | 跨来源至直连 |\n"
        f"|---|---:|---:|---:|---:|---:|\n{table}\n\n"
        f"按全库参考命中选择：`{winner['id']}`。两个开发来源都达到80%且全库不低于基线2个百分点的候选："
        f"{', '.join(r['id'] for r in substantive) or '无'}。置信度仍未验证。\n")
    print(json.dumps({"winner": winner["id"], "substantive": [r["id"] for r in substantive],
                      "elapsed": time.time() - started}, ensure_ascii=False), flush=True)


def score_groups(artifact, groups):
    """Frozen v2 ranking inference on arbitrary whole-bank answer groups."""
    config = artifact["config"]
    if config["method"] == "ensemble":
        return np.stack([s[0] for s in artifact["base"].score_groups(groups)])
    parts = all_features([n for group in groups for n in group])
    if config["method"] != "local":
        single = score_head(artifact["geometry"], artifact["head"], parts)
        output, start = [], 0
        for group in groups:
            output.append(single[start:start + len(group)].mean(0))
            start += len(group)
        return np.stack(output)
    output, start, cache = [], 0, {}
    for group, (base, _) in zip(groups, artifact["base"].score_groups(groups)):
        result = base.copy()
        first, second = np.argsort(-base, kind="stable")[:2]
        pair = tuple(sorted([int(first), int(second)]))
        if base[first] - base[second] <= config["gate"]:
            if pair not in cache:
                cache[pair] = fit_local_balanced(artifact["parts"], artifact["labels"], pair,
                                                config["layout"], config["shrinkage"])
            group_parts = {k: x[start:start + len(group)] for k, x in parts.items()}
            evidence = local_scores(cache[pair], group_parts).mean(0)
            if pair[int(evidence.argmax())] == second:
                result[first], result[second] = base[second], base[first]
        output.append(result)
        start += len(group)
    return np.stack(output)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        main()
