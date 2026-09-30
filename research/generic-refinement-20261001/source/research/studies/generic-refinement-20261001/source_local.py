"""Uniform all-gallery top-two reranking using source-balanced local LDA.

Inference takes integer reply groups only. Acquisition channels balance the
frozen training cells; no channel is needed when scoring a new query.
"""
from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "1"

import argparse
import json
import time
from fractions import Fraction

import joblib
import numpy as np
from scipy.linalg import cho_factor, cho_solve
from threadpoolctl import threadpool_limits

import source_robust as shared

OUT = shared.ROOT / "research/reports/generic-refinement-20261001/source-local"
LAYOUTS = {"frequency_order429": {"frequency": .75, "ordered": .25},
           "position751": shared.WEIGHTS}
CONFIGS = [{"id": "first_frozen_fusion", "layout": None, "shrinkage": None, "gate": None}]
CONFIGS += [{"id": f"{layout}_s{shrink:g}_gate{gate:g}", "layout": layout,
             "shrinkage": shrink, "gate": gate}
            for layout in LAYOUTS for shrink in (.15, .5, .85) for gate in (.10, .25)]


def transform(parts, parameters, layout):
    pieces = []
    for name, weight in LAYOUTS[layout].items():
        values = (parts[name] - parameters[name]["mean"]) / parameters[name]["scale"]
        values /= np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-12)
        pieces.append(values * np.sqrt(weight))
    return np.concatenate(pieces, axis=1)


def fit_pair_geometry(parts, labels, domains, pair, layout):
    mask = np.isin(labels, pair)
    local_labels = np.asarray([pair.index(label) for label in labels[mask]])
    weights = shared.balanced_weights(local_labels, domains[mask], 2)
    train = {name: values[mask] for name, values in parts.items() if name in LAYOUTS[layout]}
    parameters = {}
    for name, values in train.items():
        mean = weights @ values
        scale = np.sqrt(weights @ ((values - mean) ** 2))
        scale[scale < 1e-10] = 1
        parameters[name] = {"mean": mean, "scale": scale}
    values = transform(train, parameters, layout)
    centres = np.stack([np.average(values[local_labels == label], axis=0,
                                   weights=weights[local_labels == label]) for label in range(2)])
    residual = (values - centres[local_labels]) * np.sqrt(weights)[:, None]
    return {"pair": pair, "layout": layout, "parameters": parameters, "centres": centres,
            "residual": residual, "gram": residual @ residual.T,
            "target": max(float(np.sum(residual ** 2) / residual.shape[1]), 1e-12),
            "source_counts": [{domain: int(np.sum((local_labels == label) & (domains[mask] == domain)))
                               for domain in sorted(set(domains[mask][local_labels == label]))}
                              for label in range(2)]}


def fit_pair_head(geometry, shrinkage):
    residual = geometry["residual"]
    difference = geometry["centres"][1] - geometry["centres"][0]
    ridge = shrinkage * geometry["target"]
    coefficient = 1 - shrinkage
    matrix = np.eye(len(residual)) + coefficient / ridge * geometry["gram"]
    correction = cho_solve(cho_factor(matrix, lower=True, check_finite=False),
                           residual @ difference, check_finite=False)
    direction = difference / ridge - coefficient / ridge ** 2 * (residual.T @ correction)
    return {"pair": geometry["pair"], "layout": geometry["layout"], "parameters": geometry["parameters"],
            "coefficient": direction, "intercept": -.5 * (geometry["centres"][0] + geometry["centres"][1]) @ direction,
            "source_counts": geometry["source_counts"]}


def margin(head, parts):
    return float(np.mean(transform(parts, head["parameters"], head["layout"]) @ head["coefficient"]
                         + head["intercept"]))


def rerank(base, head, evidence):
    result = base.copy()
    if evidence == 0:
        return result
    first, second = np.argsort(-base, kind="stable")[:2]
    winner = head["pair"][int(evidence > 0)]
    if winner == second:
        result[first], result[second] = base[second], base[first]
    return result


def evaluate_fold(base, train_parts, labels, domains, test_parts):
    result = np.repeat(base[None, :, :], len(CONFIGS), axis=0)
    standardized = shared.z(base)
    geometries, heads = {}, {}
    for group_index, scores in enumerate(base):
        first, second = np.argsort(-scores, kind="stable")[:2]
        gap = standardized[group_index, first] - standardized[group_index, second]
        if gap > .25:
            continue
        pair = tuple(sorted((int(first), int(second))))
        group_parts = {name: values[group_index * 3:group_index * 3 + 3] for name, values in test_parts.items()}
        for config_index, config in enumerate(CONFIGS[1:], 1):
            if gap > config["gate"]:
                continue
            geometry_key = (pair, config["layout"])
            if geometry_key not in geometries:
                geometries[geometry_key] = fit_pair_geometry(train_parts, labels, domains, pair, config["layout"])
            head_key = (*geometry_key, config["shrinkage"])
            if head_key not in heads:
                heads[head_key] = fit_pair_head(geometries[geometry_key], config["shrinkage"])
            fitted = heads[head_key]
            result[config_index, group_index] = rerank(scores, fitted, margin(fitted, group_parts))
    return result


def selection_weights(groups, ids):
    truth = np.asarray([ids.index(group["model"]) for group in groups])
    domains = np.asarray([group["domain"] for group in groups])
    result = []
    for label, domain in zip(truth, domains):
        sources = set(domains[truth == label])
        count = int(np.sum((truth == label) & (domains == domain)))
        result.append(Fraction(1, len(ids) * len(sources) * count))
    if sum(result) != 1:
        raise ValueError("Domain selection weights do not sum to one")
    return result


def metric(scores, groups, ids, weights):
    truth = np.asarray([ids.index(group["model"]) for group in groups])
    ranking = np.argsort(-scores, axis=1, kind="stable")
    ranks = np.argmax(ranking == truth[:, None], axis=1) + 1
    macro = sum(weight * int(rank == 1) for weight, rank in zip(weights, ranks))
    mrr = sum(weight * Fraction(1, int(rank)) for weight, rank in zip(weights, ranks))
    result = {"macro_top1": float(macro), "macro_top1_fraction": str(macro),
              "macro_mrr": float(mrr), "macro_mrr_fraction": str(mrr),
              "raw_hits": int(np.sum(ranks == 1)), "raw_groups": len(groups),
              "reference": shared.metrics(scores[:636], groups[:636], ids),
              "development": shared.metrics(scores[636:], groups[636:], ids)}
    result["reference_delta_vs_first"] = result["reference"]["hits"] - 580
    result["source_cells"] = []
    for label in ids:
        for domain in sorted({group["domain"] for group in groups if group["model"] == label}):
            selected = np.asarray([group["model"] == label and group["domain"] == domain for group in groups])
            result["source_cells"].append({"model": label, "domain": domain, "groups": int(selected.sum()),
                                           "hits": int(np.sum(ranks[selected] == 1))})
    return result


def load_artifact(path):
    fitted = joblib.load(path)
    if fitted["schema"] != "source-balanced-local-rerank-v1" or fitted["reference_sha256"] != shared.REFERENCE_SHA:
        raise ValueError("Unexpected source-balanced local artifact")
    return fitted


def score_groups(fitted, groups):
    base = shared.fusion.score_groups(fitted["baseline"], groups)
    config = fitted["config"]
    if config["layout"] is None:
        return base
    standardized = shared.z(base)
    output = base.copy()
    for index, replies in enumerate(groups):
        first, second = np.argsort(-base[index], kind="stable")[:2]
        if standardized[index, first] - standardized[index, second] > config["gate"]:
            continue
        pair = tuple(sorted((int(first), int(second))))
        if pair not in fitted["heads"]:
            geometry = fit_pair_geometry(fitted["parts"], fitted["labels"], fitted["domains"], pair, config["layout"])
            fitted["heads"][pair] = fit_pair_head(geometry, config["shrinkage"])
        raw = [shared.positional.blocks(reply) for reply in replies]
        parts = {name: np.stack([block[name] for block in raw]) for name in LAYOUTS[config["layout"]]}
        head = fitted["heads"][pair]
        output[index] = rerank(base[index], head, margin(head, parts))
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    ids, rows, groups, indices, registry = shared.load_inputs()
    for group, group_indices in zip(groups, indices):
        sources = {rows[index]["domain"] for index in group_indices}
        if len(sources) != 1:
            raise ValueError("Evaluation group mixes acquisition domains")
        group["domain"] = sources.pop()
    paths = [shared.REFERENCE, shared.BUNDLE / "bundle.json", shared.BUNDLE / "requirements.txt",
             shared.ROOT / "research/studies/generic-refinement-20261001/source_robust.py",
             shared.ROOT / "research/studies/generic-refinement-20261001/source_local.py",
             shared.ROOT / "research/studies/generic-refinement-20261001/DOMAIN_PROTOCOL.md",
             shared.OUT / "reference-oof.npz", shared.OUT / "development-oof.npz"]
    hashes = {str(path.relative_to(shared.ROOT)): shared.sha(path) for path in paths}
    plan = {"schema": "source-local-development-plan-v1", "hashes": hashes, "configs": CONFIGS, "layouts": LAYOUTS,
            "inputs": {"reference_rows": 1948, "development_rows": 240, "registered_labels": 53, "evaluation_groups": 716},
            "folds": "12 reference environments plus 40 cohort/round folds; same round withheld across both labels. Held reference queries/condition variants and all held text/sequence duplicates excluded.",
            "baseline": "Original frozen first-fusion reference OOF plus its predictions on matched developmental cohorts; no fixed104 inputs.",
            "preprocessing": "Within current top2 only: equal class total weights, equal acquisition domains within class, equal rows within each class/domain cell. Mean/scale, unit block normalization, centres and pooled covariance use training rows only.",
            "decision": "Base-z top2 gap gate; generic local shrinkage LDA mean linear margin across three answers. If local winner differs, swap original first/second scores; retain all other scores and score magnitudes.",
            "selection": "DOMAIN actual-source-balanced 53-class macro Top1, then identically weighted MRR, then fixed config index; reference636 change reported alongside; no pair objective or extra reference guard.",
            "development": "240 matched answers explicitly derived-development, original v1 manifests and evidence unchanged; no independent validation available.",
            "inference": "Integer sequences only; no label-specific method branches, no channel/provider/time/request input.",
            "fixed_holdout_opened": False, "api_requests": 0}
    shared.save(OUT / "plan.json", plan)
    shared.save(OUT / "derived-development-manifest.json", {"purpose": "derived-development", "original_registry_unchanged": True,
        "reference_sha256": shared.REFERENCE_SHA, "datasets": registry, "fixed104_training_allowed": False})
    (OUT / "protocol.md").write_text("# 通用来源均衡的局部二候选开发协议\n\n"
        "本协议和13配置plan在拟合前保存。基线为原第一冻结fusion；两个匹配来源的240回答已明确转为开发，"
        "原manifest及v1独立证据不变。固定104组不打开、不训练、不校准。\n\n"
        "比较频率+顺序429维和已选位置751维，各用0.15/0.5/0.85 shrinkage及0.10/0.25 base-z gap gate，"
        "共12项加基线13项。每组先由全53标签基线挑前2，仅在gate内按相同规则拟合局部LDA。标签等权，"
        "标签内实际来源等权；缩放、中心和pooled covariance均只用外折训练行。协方差朝trace/d的单位矩阵收缩，"
        "通过Woodbury和Cholesky解线性margin。三回答margin均值决定局部赢家，仅交换原前2分数，不放大分值。\n\n"
        "沿用12参考环境及40来源/轮次折；同轮两标签同时留出，题号、环境变体、文本和数字序列重复全部排除。"
        "选择依据DOMAIN协议的53标签/实际来源等权macro Top1，其次同权MRR、最后固定index。"
        "参考636变化和各来源表现同时报告，不用pair结果选择，不临时增加reference退步guard。\n\n"
        "来源只用于训练权重，推断只读数字。训练多来源3标签，开发评估双来源2标签，不能据此证明全部渠道泛化。\n")
    if args.plan_only:
        print(json.dumps({"plan_saved": True, "configs": len(CONFIGS), "rows": len(rows)}), flush=True)
        return
    original_reference = np.load(shared.OUT / "reference-oof.npz")
    original_development = np.load(shared.OUT / "development-oof.npz")
    if list(original_reference["group_ids"]) + list(original_development["group_ids"]) != [group["id"] for group in groups]:
        raise ValueError("Original baseline groups differ")
    if list(original_reference["model_ids"]) != ids or list(original_development["model_ids"]) != ids:
        raise ValueError("Original baseline gallery differs")
    base = np.concatenate((original_reference["scores"][0], original_development["scores"][0]), axis=0)
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    domains = np.asarray([row["domain"] for row in rows])
    raw = [shared.positional.blocks(row["numbers"]) for row in rows]
    parts = {name: np.stack([block[name] for block in raw]) for name in shared.WEIGHTS}
    folds = []
    for environment in range(1, 13):
        held = [index for index, group in enumerate(groups) if group["cohort"] == "reference" and group["environment"] == environment]
        withheld = {index for group in held for index in indices[group]}
        folds.append((f"reference:{environment:02d}", held, shared.training_indices(rows, withheld, environment)))
    for cohort in shared.COHORTS:
        for round_id in sorted({group["round"] for group in groups if group["cohort"] == cohort}):
            held = [index for index, group in enumerate(groups) if group["cohort"] == cohort and group["round"] == round_id]
            withheld = {index for group in held for index in indices[group]}
            folds.append((f"{cohort}:{round_id}", held, shared.training_indices(rows, withheld)))
    scores = np.full((len(CONFIGS), len(groups), len(ids)), np.nan)
    fold_records = []
    for fold_index, (name, held, train) in enumerate(folds, 1):
        test = [index for group in held for index in indices[group]]
        scores[:, held] = evaluate_fold(base[held], {key: values[train] for key, values in parts.items()},
                                       labels[train], domains[train], {key: values[test] for key, values in parts.items()})
        fold_records.append({"id": name, "held_group_ids": [groups[index]["id"] for index in held],
                             "training_row_ids": [rows[index]["row_id"] for index in train]})
        if fold_index % 4 == 0:
            print(f"SOURCE_LOCAL fold {fold_index}/{len(folds)} {time.time() - started:.1f}s", flush=True)
    if not np.isfinite(scores).all():
        raise ValueError("Missing or nonfinite source-local OOF scores")
    weights = selection_weights(groups, ids)
    candidates = [{"index": index, "config": config, "metrics": metric(values, groups, ids, weights)}
                  for index, (config, values) in enumerate(zip(CONFIGS, scores))]
    winner = min(candidates, key=lambda item: (-Fraction(item["metrics"]["macro_top1_fraction"]),
                                             -Fraction(item["metrics"]["macro_mrr_fraction"]), item["index"]))
    config = winner["config"]
    artifact = {"schema": "source-balanced-local-rerank-v1", "model_ids": ids, "reference_sha256": shared.REFERENCE_SHA,
                "config": config, "hashes": hashes, "baseline": shared.fusion.load_artifact(shared.RUN / "fusion/fitted.joblib"),
                "parts": {name: values for name, values in parts.items() if config["layout"] is not None and name in LAYOUTS[config["layout"]]},
                "labels": labels, "domains": domains, "heads": {},
                "calibration": "Unavailable: ranking development only; score swap preserves baseline magnitudes"}
    joblib.dump(artifact, OUT / "fitted.joblib", compress=3)
    synthetic = [[[((index * 37 + reply * 19) % 355) + 1 for index in range(320)] for reply in range(3)]]
    if not np.array_equal(score_groups(artifact, synthetic), score_groups(load_artifact(OUT / "fitted.joblib"), synthetic)):
        raise ValueError("Local artifact reload changes inference")
    np.savez_compressed(OUT / "candidates.npz", scores=scores, names=[config["id"] for config in CONFIGS],
                        model_ids=ids, group_ids=[group["id"] for group in groups],
                        y=[ids.index(group["model"]) for group in groups], domains=[group["domain"] for group in groups])
    np.savez_compressed(OUT / "reference-oof.npz", scores=scores[winner["index"], :636], model_ids=ids,
                        group_ids=[group["id"] for group in groups[:636]],
                        y=[ids.index(group["model"]) for group in groups[:636]],
                        environment=[group["environment"] for group in groups[:636]])
    shared.save(OUT / "groups.json", groups)
    shared.save(OUT / "folds.json", fold_records)
    shared.save(OUT / "selection.json", {"hashes": hashes, "candidates": candidates, "winner": winner,
        "group_selection_weights": [str(weight) for weight in weights], "elapsed_seconds": time.time() - started,
        "independent_validation": False, "fixed_holdout_opened": False})
    shared.save(OUT / "freeze.json", {"hashes": hashes, "selected": config, "selected_index": winner["index"],
        "artifact_sha256": shared.sha(OUT / "fitted.joblib"), "candidates_sha256": shared.sha(OUT / "candidates.npz"),
        "plan_sha256": shared.sha(OUT / "plan.json"), "protocol_sha256": shared.sha(OUT / "protocol.md"),
        "development_manifest_sha256": shared.sha(OUT / "derived-development-manifest.json"),
        "fixed_holdout_opened": False, "api_requests": 0, "calibration": None})
    lines = ["# 全库通用来源平衡的局部二候选重排", "", "13项在运行前声明；所有716组只作为开发。选择为53标签及标签内实际来源等权Macro Top1，"
             "其次同权MRR及固定index。固定104从未打开。", "", "| 配置 | 宏Top1 | 宏MRR | 参考 | 开发 | 参考pair |", "|---|---:|---:|---:|---:|---:|"]
    for item in candidates:
        values = item["metrics"]
        lines.append(f"| {item['config']['id']} | {values['macro_top1']:.10f} | {values['macro_mrr']:.10f} | "
                     f"{values['reference']['hits']}/636 | {values['development']['hits']}/80 | {values['reference']['pair']['all_library_hits']}/24 |")
    lines += ["", f"选定 `{config['id']}`；参考变化 {winner['metrics']['reference_delta_vs_first']:+d}/636。", "",
              "每个训练局部头只含当前全库前2标签，标签内的采集来源等权；尺度、中心和协方差只用折内训练行。"
              "推断只需数字。局部赢家变化仅交换原前2分数，不根据局部margin放大概率；没有独立高置信认证。"
              "首次加载时选定配置对新的top2组合可从冻结训练矩阵惰性计算同一确定性头，查询回答不参与拟合。", "",
              "仅3标签具有多来源训练、2标签有多来源开发留出；参考与匹配开发资料已经多轮使用，这些指标不能替代新盲测。"]
    (OUT / "report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"winner": config["id"], "macro_top1": winner["metrics"]["macro_top1"],
                      "reference_hits": winner["metrics"]["reference"]["hits"],
                      "development_hits": winner["metrics"]["development"]["hits"],
                      "elapsed_seconds": time.time() - started}), flush=True)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        main()
