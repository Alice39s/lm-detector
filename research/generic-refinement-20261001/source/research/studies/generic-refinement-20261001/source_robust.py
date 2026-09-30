"""Generic source-balanced discriminants; all external cohorts are development.

Run with the first bundle's pinned requirements and PYTHONDONTWRITEBYTECODE=1.
Inference accepts integer sequences only: load_artifact(path), score_groups(fit,
groups). Source names help train nuisance directions and balanced prototypes;
they are never required or accepted as inference features.
"""
from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "1"

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import joblib
import numpy as np
from scipy.linalg import eigh
from scipy.special import logsumexp
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "projects/research/sequence-generalization-20260930"
SNAPSHOT = BUNDLE / "source"
STUDY = SNAPSHOT / "research/studies/sequence-generalization"
RUN = SNAPSHOT / "research/reports/sequence-generalization/20260930"
sys.path[:0] = [str(STUDY), str(SNAPSHOT / "projects/offline")]
from bank_builder import read_rows  # noqa: E402
from fingerprint import count_numbers, parse_numbers  # noqa: E402
from shared_verifier_core import reference_panel  # noqa: E402
import fusion  # noqa: E402
import positional  # noqa: E402
import rerank  # noqa: E402

OUT = ROOT / "research/reports/generic-refinement-20261001/source-robust"
REFERENCE = SNAPSHOT / "projects/data/unified_reference.jsonl"
REFERENCE_SHA = "5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4"
COHORTS = {
    "previous_pair": SNAPSHOT / "research/reports/astra-sol-separation/paired-low-01",
    "prospective_v1_reused": RUN / "prospective",
}
WEIGHTS = {"frequency": .6, "ordered": .15, "kernel": .125, "sequence": .125}
HEADS = [
    {"id": "balanced_lda_zero", "method": "lda", "rank": 0, "removal": 0.},
    {"id": "balanced_lda_rank1_half", "method": "lda", "rank": 1, "removal": .5},
    {"id": "balanced_lda_rank2_full", "method": "lda", "rank": 2, "removal": 1.},
    {"id": "balanced_mixture_zero", "method": "mixture", "rank": 0, "removal": 0.},
    {"id": "balanced_mixture_rank1_half", "method": "mixture", "rank": 1, "removal": .5},
]
CONFIGS = [{"id": "first_frozen_fusion", "head": None, "candidate_weight": 0.}]
CONFIGS += [{"id": spec["id"], "head": index, "candidate_weight": 1.}
            for index, spec in enumerate(HEADS)]
CONFIGS += [{"id": "half_frozen_" + spec["id"], "head": index, "candidate_weight": .5}
            for index, spec in enumerate(HEADS)]
SHRINKAGE = .5
PROTOTYPE_SHRINKAGE = .5
REPORT_PAIR = ("gpt-6-astra", "gpt-6.1-sol")  # Diagnostics only.


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    def convert(item):
        if isinstance(item, np.ndarray):
            return item.tolist()
        if isinstance(item, np.generic):
            return item.item()
        raise TypeError(type(item).__name__)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                    allow_nan=False, default=convert) + "\n")


def channel_name(channel):
    return "openrouter" if channel.startswith("openrouter/") else channel


def sequence_key(row):
    return hashlib.sha256(np.asarray(row["numbers"], dtype=np.int16).tobytes()).hexdigest()


def load_inputs():
    if sha(REFERENCE) != REFERENCE_SHA:
        raise ValueError("Hydrated first-bundle reference differs from its freeze")
    bank = json.loads((SNAPSHOT / "projects/data/unified_bank.json").read_text())
    if bank["reference_sha256"] != REFERENCE_SHA:
        raise ValueError("First-bundle bank/reference mismatch")
    ids = [model["id"] for model in bank["models"]]
    reference = read_rows(REFERENCE)
    for row in reference:
        row.update(cohort="reference", domain=channel_name(row["channel"]))
    development, registry = [], []
    for cohort, folder in COHORTS.items():
        records = [json.loads(line) for line in (folder / "samples.jsonl").read_text().splitlines() if line]
        selected = {}
        for record in sorted(records, key=lambda item: item["attempt"]):
            if record["status"] == "accepted":
                selected.setdefault(record["sample_id"], record)
        if len(selected) != 120:
            raise ValueError("Matched development cohort must contain 120 accepted answers")
        adopted = []
        for record in selected.values():
            numbers = parse_numbers(record["text"])
            if len(numbers) < max(80, np.ceil(record["expected_count"] * .55)):
                raise ValueError("Accepted developmental answer fails the frozen parser")
            host = urlparse(record["endpoint"]).hostname
            domain = {"openrouter.ai": "openrouter", "api.openai.com": "openai/direct"}.get(host, host)
            if not domain:
                raise ValueError("Developmental answer has no acquisition endpoint")
            row = {"row_id": f"{cohort}:{record['sample_id']}", "source": record["model"],
                   "challenge_id": f"{cohort}:{record['challenge_id']}",
                   "condition_id": f"{cohort}:{record['round_id']}", "cohort": cohort,
                   "domain": domain, "round": record["round_id"], "text": record["text"],
                   "numbers": numbers, "counts": count_numbers(numbers)}
            development.append(row)
            adopted.append({"row_id": row["row_id"], "sample_id": record["sample_id"],
                            "attempt": record["attempt"], "model": record["model"],
                            "round": record["round_id"], "domain": domain,
                            "text_sha256": hashlib.sha256(record["text"].encode()).hexdigest(),
                            "sequence_sha256": sequence_key(row)})
        registry.append({"cohort": cohort, "purpose": "derived-development", "training_allowed": True,
                         "original_manifest": str((folder / "manifest.json").relative_to(ROOT)),
                         "original_manifest_sha256": sha(folder / "manifest.json"),
                         "original_samples": str((folder / "samples.jsonl").relative_to(ROOT)),
                         "original_samples_sha256": sha(folder / "samples.jsonl"), "selection": adopted})
    rows = reference + development
    by_id = {row["row_id"]: index for index, row in enumerate(rows)}
    if len(by_id) != len(rows) or len(ids) != 53 or len(reference) != 1948:
        raise ValueError("Unexpected frozen gallery size or duplicate row ID")
    groups = [{**group, "cohort": "reference"} for group in reference_panel(reference, ids)]
    for cohort in COHORTS:
        rounds = sorted({row["round"] for row in development if row["cohort"] == cohort})
        for round_id in rounds:
            for label in ids:
                selected = [row for row in development if row["cohort"] == cohort
                            and row["round"] == round_id and row["source"] == label]
                if selected:
                    if len(selected) != 3:
                        raise ValueError("Developmental matched group is incomplete")
                    groups.append({"id": f"{cohort}:{label}:{round_id}", "model": label,
                                   "cohort": cohort, "round": round_id,
                                   "row_ids": [row["row_id"] for row in selected]})
    indices = [[by_id[row_id] for row_id in group["row_ids"]] for group in groups]
    return ids, rows, groups, indices, registry


def balanced_weights(labels, domains, classes):
    weights = np.zeros(len(labels))
    for label in range(classes):
        source_names = sorted(set(domains[labels == label]))
        if not source_names:
            raise ValueError("Fold loses a gallery label")
        for domain in source_names:
            selected = (labels == label) & (domains == domain)
            weights[selected] = 1 / (classes * len(source_names) * selected.sum())
    return weights


def transform(parts, parameters):
    pieces = []
    for name, weight in WEIGHTS.items():
        values = (parts[name] - parameters[name]["mean"]) / parameters[name]["scale"]
        values /= np.maximum(np.linalg.norm(values, axis=1, keepdims=True), 1e-12)
        pieces.append(values * np.sqrt(weight))
    return np.concatenate(pieces, axis=1)


def fit_geometry(parts, labels, domains, classes):
    weights = balanced_weights(labels, domains, classes)
    parameters = {}
    for name in WEIGHTS:
        mean = weights @ parts[name]
        scale = np.sqrt(weights @ ((parts[name] - mean) ** 2))
        scale[scale < 1e-10] = 1
        parameters[name] = {"mean": mean, "scale": scale}
    values = transform(parts, parameters)
    centres, offsets, offset_weights, source_labels = [], [], [], []
    source_centres = []
    for label in range(classes):
        names = sorted(set(domains[labels == label]))
        cell_means = np.stack([values[(labels == label) & (domains == domain)].mean(0) for domain in names])
        centre = cell_means.mean(0)
        centres.append(centre)
        source_centres.extend(cell_means)
        source_labels.extend([label] * len(names))
        if len(names) > 1:
            offsets.extend(cell_means - centre)
            offset_weights.extend([1 / len(names)] * len(names))
    nuisance = np.empty((0, values.shape[1]))
    singular = np.empty(0)
    if offsets:
        _, singular, right = np.linalg.svd(np.stack(offsets) * np.sqrt(offset_weights)[:, None], full_matrices=False)
        rank = int(np.sum(singular > singular[0] * 1e-8)) if singular[0] else 0
        nuisance = right[:min(2, rank)]
    return {"parameters": parameters, "values": values, "weights": weights,
            "centres": np.stack(centres), "source_centres": np.stack(source_centres),
            "source_labels": np.asarray(source_labels), "nuisance": nuisance,
            "nuisance_singular_values": singular,
            "multisource_labels": sum(len(set(domains[labels == label])) > 1 for label in range(classes))}


def remove_nuisance(values, basis, strength):
    return values - strength * ((values @ basis.T) @ basis) if len(basis) else values


def fit_head(geometry, labels, domains, spec):
    basis = geometry["nuisance"][:spec["rank"]]
    values = remove_nuisance(geometry["values"], basis, spec["removal"])
    centres = remove_nuisance(geometry["centres"], basis, spec["removal"])
    source_centres = remove_nuisance(geometry["source_centres"], basis, spec["removal"])
    if spec["method"] == "lda":
        prototypes, prototype_labels = centres, np.arange(len(centres))
        residual = values - centres[labels]
    else:
        prototypes = (1 - PROTOTYPE_SHRINKAGE) * source_centres + PROTOTYPE_SHRINKAGE * centres[geometry["source_labels"]]
        prototype_labels = geometry["source_labels"]
        residual = values.copy()
        offset = 0
        for label in range(len(centres)):
            for domain in sorted(set(domains[labels == label])):
                selected = (labels == label) & (domains == domain)
                residual[selected] -= source_centres[offset]
                offset += 1
    covariance = (residual * geometry["weights"][:, None]).T @ residual
    eigenvalues, vectors = eigh(covariance, check_finite=False)
    target = max(float(np.trace(covariance) / covariance.shape[0]), 1e-12)
    denominator = (1 - SHRINKAGE) * np.maximum(eigenvalues, 0) + SHRINKAGE * target
    coefficient = (vectors @ ((vectors.T @ prototypes.T) / denominator[:, None])).T
    return {"spec": spec, "parameters": geometry["parameters"], "basis": basis,
            "coefficient": coefficient, "intercept": -.5 * np.sum(prototypes * coefficient, axis=1),
            "prototype_labels": prototype_labels, "classes": len(centres),
            "multisource_labels": geometry["multisource_labels"],
            "nuisance_singular_values": geometry["nuisance_singular_values"]}


def score_head(fitted, parts, group_sizes):
    values = remove_nuisance(transform(parts, fitted["parameters"]), fitted["basis"], fitted["spec"]["removal"])
    single = values @ fitted["coefficient"].T + fitted["intercept"]
    output, start = [], 0
    for size in group_sizes:
        total = single[start:start + size].sum(0)
        if fitted["spec"]["method"] == "mixture":
            total = np.asarray([logsumexp(total[fitted["prototype_labels"] == label])
                                - np.log(np.sum(fitted["prototype_labels"] == label))
                                for label in range(fitted["classes"])])
        output.append(total / size)
        start += size
    return np.stack(output)


def z(scores):
    return (scores - scores.mean(-1, keepdims=True)) / np.maximum(scores.std(-1, keepdims=True), 1e-12)


def combine(base, candidates):
    return np.stack([base if config["head"] is None else
                     (config["candidate_weight"] * z(candidates[config["head"]])
                      + (1 - config["candidate_weight"]) * z(base))
                     for config in CONFIGS])


def metrics(scores, groups, ids):
    truth = np.asarray([ids.index(group["model"]) for group in groups])
    order = np.argsort(-scores, axis=1, kind="stable")
    ranks = np.argmax(order == truth[:, None], axis=1) + 1
    result = {"groups": len(groups), "hits": int(np.sum(ranks == 1)), "top1": float(np.mean(ranks == 1)),
              "top3": float(np.mean(ranks <= 3)), "mrr": float(np.mean(1 / ranks)),
              "per_model": {ids[label]: {"groups": int(np.sum(truth == label)),
                                         "hits": int(np.sum((truth == label) & (ranks == 1)))}
                            for label in np.unique(truth)}}
    mask = np.isin(truth, [ids.index(label) for label in REPORT_PAIR])
    pair_ids = [ids.index(label) for label in REPORT_PAIR]
    result["pair"] = {"groups": int(mask.sum()), "all_library_hits": int(np.sum(ranks[mask] == 1)),
                      "conditional_hits": int(np.sum(np.asarray(pair_ids)[scores[mask][:, pair_ids].argmax(1)] == truth[mask]))}
    return result


def training_indices(rows, held_indices, environment=None, held_cohort=None):
    texts = {rows[index]["text"].strip() for index in held_indices}
    sequences = {sequence_key(rows[index]) for index in held_indices}
    query_ids = ({f"query-{index:02d}" for index in range(environment * 3 - 2, environment * 3 + 1)}
                 if environment else set())
    condition = re.compile(rf"environment-{environment:02d}(?:\b|-|:)") if environment else None
    affected = {rows[index]["source"] for index in held_indices} if held_cohort else set()
    return [index for index, row in enumerate(rows) if index not in held_indices
            and row["challenge_id"] not in query_ids
            and not (condition and condition.match(row["condition_id"]))
            and not (held_cohort and (row["cohort"] == held_cohort or
                     (row["cohort"] == "reference" and row["source"] in affected)))
            and row["text"].strip() not in texts and sequence_key(row) not in sequences]


def baseline_clean_transfer(rows, ids, groups):
    """Refit the existing algorithm after removing the held-source label rows."""
    config = json.loads((RUN / "rerank/selection.json").read_text())["selected"]
    local = rerank.fit_artifact(rows, ids, config)
    local_scores = rerank.score_groups(local, groups)
    config = json.loads((RUN / "positional/summary.json").read_text())["winner"]
    raw = [positional.blocks(row["numbers"]) for row in rows]
    parts = {name: np.stack([block[name] for block in raw]) for name in WEIGHTS}
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    geometry = positional.fit_geometry(parts, labels, len(ids), config["weights"])
    flat = [reply for group in groups for reply in group]
    raw = [positional.blocks(reply) for reply in flat]
    test_parts = {name: np.stack([block[name] for block in raw]) for name in WEIGHTS}
    single = positional.score(geometry, test_parts, config)
    position_scores = z(single).reshape(len(groups), 3, len(ids)).mean(1)
    return .5 * z(local_scores) + .5 * z(position_scores)


def load_artifact(path):
    fitted = joblib.load(path)
    if fitted["schema"] != "source-balanced-generic-v1" or fitted["reference_sha256"] != REFERENCE_SHA:
        raise ValueError("Unexpected source-balanced artifact")
    return fitted


def score_groups(fitted, groups):
    base = fusion.score_groups(fitted["baseline"], groups)
    if fitted["candidate"] is None:
        return base
    flat = [reply for group in groups for reply in group]
    raw = [positional.blocks(reply) for reply in flat]
    parts = {name: np.stack([block[name] for block in raw]) for name in WEIGHTS}
    candidate = score_head(fitted["candidate"], parts, [len(group) for group in groups])
    weight = fitted["config"]["candidate_weight"]
    return weight * z(candidate) + (1 - weight) * z(base)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    ids, rows, groups, indices, registry = load_inputs()
    hashes = {str(path.relative_to(ROOT)): sha(path) for path in
              (REFERENCE, SNAPSHOT / "projects/data/unified_bank.json", BUNDLE / "bundle.json", Path(__file__),
               STUDY / "positional.py", STUDY / "rerank.py", STUDY / "fusion.py", RUN / "fusion/reference-oof.npz")}
    plan = {"schema": "source-robust-development-plan-v1", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "hashes": hashes, "configs": CONFIGS, "heads": HEADS, "weights": WEIGHTS,
            "shrinkage": SHRINKAGE, "prototype_shrinkage": PROTOTYPE_SHRINKAGE,
            "selection": "Highest all-library 636-group reference Top1; then MRR; then predeclared grid order. No pair metric in selection.",
            "reference_cv": "12 environments; matching reference query IDs, condition variants and duplicate texts/sequences excluded; developmental cohorts are additional training rows.",
            "reference_baseline": "Original first-fusion reference-only OOF scores, aligned by gallery and group ID; never refitted using held reference answers.",
            "development_cv": "Leave cohort+round across both labels (6 matched answers), removing exact held text/sequence duplicates from every source.",
            "clean_transfer": "Leave one entire cohort and all primary reference rows of every label in that cohort; affected labels use only the opposite developmental cohort. Other labels remain gallery references. Baseline algorithm is refitted on this clean gallery.",
            "balance": "Each label receives equal total weight; its acquisition channels receive equal weight; answers divide their label/channel cell weight equally. Prototypes have equal source mixture weights and uniform class priors.",
            "nuisance": "Top1/2 SVD directions of training within-label source centroid offsets; only labels with multiple observed sources contribute; equal weight per such label and source. No held-source centroid enters fitting.",
            "inference": "Only parsed integer outputs; no provider/channel/time/endpoint/label-specific branches. All transforms fit training rows only.",
            "fixed_holdout": "Never opened, trained on, calibrated on or selected against by this study.",
            "independent_validation": False}
    save(OUT / "plan.json", plan)
    save(OUT / "derived-development-manifest.json", {"purpose": "derived-development", "reference_sha256": REFERENCE_SHA,
        "original_registry_unchanged": True, "original_first_bundle_role": "Holdout for frozen v1 replay only",
        "reuse": "These 240 matched answers were already reused by enriched v2; they are developmental for this derivative study and cannot serve as independent validation.",
        "fixed_104_holdout_training_allowed": False, "datasets": registry})
    if args.plan_only:
        print(json.dumps({"plan_saved": True, "configs": len(CONFIGS), "rows": len(rows)}), flush=True)
        return
    reference_groups = [group for group in groups if group["cohort"] == "reference"]
    frozen_oof = np.load(RUN / "fusion/reference-oof.npz")
    if list(frozen_oof["model_ids"]) != ids:
        raise ValueError("Frozen baseline label order differs")
    positions = {group_id: index for index, group_id in enumerate(frozen_oof["group_ids"])}
    base_reference = frozen_oof["scores"][[positions[group["id"]] for group in reference_groups]]
    if np.sum(base_reference.argmax(1) == np.asarray([ids.index(group["model"]) for group in reference_groups])) != 580:
        raise ValueError("Frozen 580/636 comparator differs")
    baseline = fusion.load_artifact(RUN / "fusion/fitted.joblib")
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    domains = np.asarray([row["domain"] for row in rows])
    raw = [positional.blocks(row["numbers"]) for row in rows]
    parts = {name: np.stack([block[name] for block in raw]) for name in WEIGHTS}
    scores = np.full((len(CONFIGS), len(groups), len(ids)), np.nan)
    folds, fold_records = [], []
    for environment in range(1, 13):
        held = [index for index, group in enumerate(groups) if group["cohort"] == "reference" and group["environment"] == environment]
        withheld = {index for group in held for index in indices[group]}
        folds.append((f"reference:{environment:02d}", held, training_indices(rows, withheld, environment)))
    for cohort in COHORTS:
        for round_id in sorted({group["round"] for group in groups if group["cohort"] == cohort}):
            held = [index for index, group in enumerate(groups) if group["cohort"] == cohort and group["round"] == round_id]
            withheld = {index for group in held for index in indices[group]}
            folds.append((f"{cohort}:{round_id}", held, training_indices(rows, withheld)))
    for fold_index, (name, held, train) in enumerate(folds, 1):
        test = [index for group in held for index in indices[group]]
        test_groups = [[rows[index]["numbers"] for index in indices[group]] for group in held]
        geometry = fit_geometry({key: block[train] for key, block in parts.items()}, labels[train], domains[train], len(ids))
        heads = [fit_head(geometry, labels[train], domains[train], spec) for spec in HEADS]
        candidates = [score_head(head, {key: block[test] for key, block in parts.items()}, [3] * len(held)) for head in heads]
        base = base_reference[held] if name.startswith("reference:") else fusion.score_groups(baseline, test_groups)
        scores[:, held] = combine(base, candidates)
        fold_records.append({"id": name, "training_row_ids": [rows[index]["row_id"] for index in train],
                             "held_group_ids": [groups[index]["id"] for index in held],
                             "multisource_labels": geometry["multisource_labels"],
                             "nuisance_singular_values": geometry["nuisance_singular_values"]})
        if fold_index % 4 == 0:
            print(f"SOURCE_ROBUST fold {fold_index}/{len(folds)} {time.time() - started:.1f}s", flush=True)
    if not np.isfinite(scores).all():
        raise ValueError("Missing source-robust OOF scores")
    transfers, transfer_records = {}, []
    for cohort in COHORTS:
        held = [index for index, group in enumerate(groups) if group["cohort"] == cohort]
        test = [index for group in held for index in indices[group]]
        train = training_indices(rows, set(test), held_cohort=cohort)
        test_groups = [[rows[index]["numbers"] for index in indices[group]] for group in held]
        base = baseline_clean_transfer([rows[index] for index in train], ids, test_groups)
        geometry = fit_geometry({key: block[train] for key, block in parts.items()}, labels[train], domains[train], len(ids))
        heads = [fit_head(geometry, labels[train], domains[train], spec) for spec in HEADS]
        candidates = [score_head(head, {key: block[test] for key, block in parts.items()}, [3] * len(held)) for head in heads]
        transfers[cohort] = combine(base, candidates)
        transfer_records.append({"held_cohort": cohort, "held_group_ids": [groups[index]["id"] for index in held],
                                 "removed_primary_labels": sorted({rows[index]["source"] for index in test}),
                                 "training_row_ids": [rows[index]["row_id"] for index in train],
                                 "multisource_labels": geometry["multisource_labels"]})
        print(f"SOURCE_ROBUST clean transfer {cohort} {time.time() - started:.1f}s", flush=True)
    results = []
    for index, config in enumerate(CONFIGS):
        result = {"index": index, "config": config}
        for cohort in ("reference", *COHORTS):
            held = [group_index for group_index, group in enumerate(groups) if group["cohort"] == cohort]
            result[cohort] = metrics(scores[index, held], [groups[group_index] for group_index in held], ids)
            if cohort in transfers:
                result["transfer_to_" + cohort] = metrics(transfers[cohort][index], [groups[group_index] for group_index in held], ids)
        results.append(result)
    winner = min(results, key=lambda item: (-item["reference"]["hits"], -item["reference"]["mrr"], item["index"]))
    chosen = winner["config"]
    candidate = None
    if chosen["head"] is not None:
        geometry = fit_geometry(parts, labels, domains, len(ids))
        candidate = fit_head(geometry, labels, domains, HEADS[chosen["head"]])
    artifact = {"schema": "source-balanced-generic-v1", "model_ids": ids, "reference_sha256": REFERENCE_SHA,
                "hashes": hashes, "config": chosen, "candidate": candidate, "baseline": baseline,
                "calibration": "Unavailable; developmental ranking only; fixed holdout never opened"}
    joblib.dump(artifact, OUT / "fitted.joblib", compress=3)
    synthetic = [[rows[index]["numbers"] for index in indices[0]]]
    if not np.array_equal(score_groups(artifact, synthetic), score_groups(load_artifact(OUT / "fitted.joblib"), synthetic)):
        raise ValueError("Artifact reload changes numeric inference")
    save(OUT / "freeze.json", {"hashes": hashes, "selected": chosen, "artifact_sha256": sha(OUT / "fitted.joblib"),
                               "development_manifest_sha256": sha(OUT / "derived-development-manifest.json"),
                               "fixed_holdout_opened": False, "api_requests": 0, "calibration": None})
    np.savez_compressed(OUT / "reference-oof.npz", scores=scores[:, :636], model_ids=ids,
                        group_ids=[group["id"] for group in groups[:636]], names=[config["id"] for config in CONFIGS],
                        y=[ids.index(group["model"]) for group in groups[:636]],
                        environment=[group["environment"] for group in groups[:636]])
    np.savez_compressed(OUT / "development-oof.npz", scores=scores[:, 636:], model_ids=ids,
                        group_ids=[group["id"] for group in groups[636:]], names=[config["id"] for config in CONFIGS],
                        y=[ids.index(group["model"]) for group in groups[636:]],
                        transfer_previous=transfers["previous_pair"], transfer_direct=transfers["prospective_v1_reused"])
    save(OUT / "groups.json", groups)
    save(OUT / "folds.json", fold_records)
    save(OUT / "transfer-folds.json", transfer_records)
    save(OUT / "results.json", {"hashes": hashes, "candidates": results, "winner": winner,
                                "elapsed_seconds": time.time() - started, "independent_validation": False,
                                "source_counts": {label: {domain: int(np.sum((labels == index) & (domains == domain)))
                                                         for domain in sorted(set(domains[labels == index]))}
                                                  for index, label in enumerate(ids)}})
    lines = ["# 通用来源平衡与偏移消除开发研究", "", "仅使用第一冻结包的正式参考（53 标签、1948 回答）和已转为开发的两个匹配来源（240 回答）。"
             "原始 manifest、首轮 freeze 与 v1 验证角色不变；这些配对数据在本派生研究中不是独立验证。固定104组从未打开。", "",
             "每类等权，每类内的来源等权；样本数量不改变类先验。来源方向仅从训练内同一标签的多来源均值差估计。"
             "来源混合用等权 log-mean-exp，并让三回答组共享同一个未知来源；推断输入只有数字。"
             "源标签能参与监督估计 nuisance，但没有提供渠道、速度或请求信息作为推断特征。", "",
             "11项在运行前写入plan，选择只看636个参考组三回答的Top1，其次MRR和固定顺序。所有缩放、投影、"
             "来源均值、协方差和原型只用折内训练行。参考留出同时排除题号、环境变体及文本/数字序列重复。", "",
             "配对留轮同时留出两标签6条；跨来源删除被留来源所含标签的全部正式参考，仅由另一匹配来源训练它们。"
             "其余51标签继续作为完整gallery；跨来源基线亦按该清理重新拟合原算法。", "",
             "| 配置 | 全库参考 | MRR | 参考pair | OR留轮 | 直连留轮 | 跨来源至OR | 跨来源至直连 |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for result in results:
        lines.append(f"| {result['config']['id']} | {result['reference']['hits']}/636 | {result['reference']['mrr']:.6f} | "
                     f"{result['reference']['pair']['all_library_hits']}/24 | {result['previous_pair']['hits']}/40 | "
                     f"{result['prospective_v1_reused']['hits']}/40 | {result['transfer_to_previous_pair']['hits']}/40 | "
                     f"{result['transfer_to_prospective_v1_reused']['hits']}/40 |")
    lines += ["", f"选定 `{chosen['id']}`，全库参考命中 {winner['reference']['hits']}/636；"
              f"较首轮冻结580/636变化 {winner['reference']['hits'] - 580:+d}。", "",
              "所有开发指标均用于观察。参考折已用于多轮方法选择，不能视为未接触测试；两匹配来源各只有同批会话，"
              "来源差也可能混入提示词与会话差。多来源仅覆盖极少标签，去除方向可能同时移除真正的模型差异。"
              "本轮没有独立概率校准或高置信模型身份认证。fitted.joblib保留选定全库排名器，可由load_artifact/score_groups调用。"]
    (OUT / "report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"winner": chosen["id"], "hits": winner["reference"]["hits"],
                      "elapsed_seconds": time.time() - started}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        main()
