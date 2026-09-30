"""Reference-only screening of generic relative-position and sequence fingerprints.

Usage: uv run --no-project --with numpy --with scipy --with joblib python \
    research/studies/sequence-generalization/positional.py

Every candidate learns all registered labels. A reference response's environment
is held out as a unit, including supplementary responses from that environment.
The fixed holdout and prospective samples are never opened by this program.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from itertools import combinations
from pathlib import Path

import joblib
import numpy as np
from scipy.linalg import eigh
from scipy.optimize import minimize_scalar
from scipy.special import logsumexp, softmax
from scipy.stats import beta

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "projects/offline"))
from bank_builder import read_rows  # noqa: E402
from fingerprint import count_numbers, hellinger_feature, ordered_block_feature  # noqa: E402
from shared_verifier_core import reference_panel  # noqa: E402

OUT = ROOT / "research/reports/sequence-generalization/20260930/positional"
REFERENCE = ROOT / "projects/data/unified_reference.jsonl"
PAIR = ("gpt-6-astra", "gpt-6.1-sol")


def save(path: Path, value) -> None:
    def convert(item):
        if isinstance(item, np.ndarray):
            return item.tolist()
        if isinstance(item, np.generic):
            return item.item()
        raise TypeError(type(item).__name__)

    path.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                               allow_nan=False, default=convert) + "\n")


def environment(condition: str) -> int:
    match = re.match(r"environment-(\d+)(?:\b|-|:)", condition)
    return int(match.group(1)) if match else -1


def load():
    bank = json.loads((ROOT / "projects/data/unified_bank.json").read_text())
    ids = [model["id"] for model in bank["models"]]
    rows = read_rows(REFERENCE)
    panel = reference_panel(rows, ids)
    by_id = {row["row_id"]: i for i, row in enumerate(rows)}
    groups = [[by_id[row_id] for row_id in entry["row_ids"]] for entry in panel]
    y = np.asarray([ids.index(row["source"]) for row in rows])
    env = np.asarray([environment(row["condition_id"]) for row in rows])
    panel_indices = np.asarray(groups).ravel()
    if len(set(panel_indices)) != len(panel_indices):
        raise ValueError("Reference panel reuses a response")
    if any(len(rows[i]["numbers"]) < 80 for i in panel_indices):
        raise ValueError("Unscorable panel response")
    return ids, rows, panel, groups, y, env, panel_indices


def relative_basis(n: int) -> np.ndarray:
    t = (np.arange(n) + .5) * 2 / n - 1
    return np.c_[t, .5 * (3 * t * t - 1), .5 * (5 * t ** 3 - 3 * t)]


def position_histogram(numbers, positions=4, values=16, residual=False):
    """Joint normalized position/value histogram; residual removes marginals."""
    x = np.asarray(numbers, int)
    p = np.minimum(positions - 1, (np.arange(len(x)) * positions) // len(x))
    v = np.minimum(values - 1, (x - 1) * values // 355)
    joint = np.bincount(p * values + v, minlength=positions * values).reshape(positions, values)
    joint = (joint + .5) / (len(x) + .5 * joint.size)
    if residual:
        joint -= joint.sum(1, keepdims=True) * joint.sum(0, keepdims=True)
        return joint.ravel()
    return np.sqrt(joint).ravel()


def position_moments(numbers, full_values=False):
    """Per-value preference for early/late, central/edge, and cubic positions."""
    x = np.asarray(numbers, int)
    basis = relative_basis(len(x))
    if full_values:
        one_hot = np.eye(355)[x - 1]
        return (one_hot.T @ basis[:, :2] / len(x)).ravel()
    numeric_centres = np.linspace(1, 355, 24)
    rbf = np.exp(-.5 * ((x[:, None] - numeric_centres) / 20) ** 2)
    last_digit = np.eye(10)[x % 10]
    # Multiplication by a positional polynomial gives a low-rank product-kernel
    # mean embedding over ordered (value, relative-position) observations.
    return (np.c_[rbf, last_digit].T @ basis / len(x)).ravel()


def sequence_features(numbers):
    x = np.asarray(numbers, float)
    n = len(x)
    z = (x - x.mean()) / max(x.std(), 1)
    features = []
    for lag in (1, 2, 3, 5, 8, 13, 21, 34):
        d = x[lag:] - x[:-lag]
        features.extend([np.mean(z[lag:] * z[:-lag]), np.mean(np.abs(d)) / 355,
                         np.mean(d > 0), np.mean(d == 0), np.mean(np.abs(d) <= 5),
                         np.mean(np.abs(d) <= 20)])
    difference = np.diff(x)
    signs = np.sign(difference)
    for bins, symbols in ((8, np.minimum(7, (x.astype(int) - 1) * 8 // 355)),
                          (10, x.astype(int) % 10)):
        transitions = np.bincount(symbols[:-1] * bins + symbols[1:], minlength=bins ** 2).reshape(bins, bins)
        joint = (transitions + .5) / (n - 1 + .5 * transitions.size)
        # Centered transitions encode adjacency over and above marginal biases.
        joint -= joint.sum(1, keepdims=True) * joint.sum(0, keepdims=True)
        features.extend(joint.ravel())
    features.extend([np.mean(signs[1:] == signs[:-1]), np.mean(difference[1:] == difference[:-1]),
                     np.mean(x[:-1].astype(int) % 10 == x[1:].astype(int) % 10),
                     np.mean(np.abs(np.diff(z)) > 1), np.mean(np.abs(np.diff(z)) > 2)])
    for width in (4, 8, 16):
        buckets = np.minimum(15, (x.astype(int) - 1) * 16 // 355)
        features.append(np.mean([len(set(buckets[i:i + width])) / width for i in range(n - width + 1)]))
    return np.asarray(features)


def first_occurrence(numbers):
    """First-position ordering, neutral for missing values and count-centered.

    Under random permutations, a value appearing c times first occurs near
    1/(c+1) of the sequence. Subtracting that expectation separates placement
    from the propensity to appear repeatedly. A presence flag lets training
    distinguish an unobserved value from an observed zero residual.
    """
    x = np.asarray(numbers, int) - 1
    counts = np.bincount(x, minlength=355)
    first = np.full(355, len(x), int)
    np.minimum.at(first, x, np.arange(len(x)))
    present = counts > 0
    relative = np.zeros(355)
    relative[present] = (first[present] + .5) / len(x) - 1 / (counts[present] + 1)
    return np.r_[relative, present.astype(float)]


def blocks(numbers):
    return {
        "frequency": hellinger_feature(count_numbers(numbers)),
        "ordered": ordered_block_feature(numbers),
        "position4": position_histogram(numbers, 4),
        "position8": position_histogram(numbers, 8),
        "association": np.r_[position_histogram(numbers, 4, residual=True),
                                position_histogram(numbers, 8, residual=True)],
        "kernel": position_moments(numbers),
        "value_moments": position_moments(numbers, full_values=True),
        "first_occurrence": first_occurrence(numbers),
        "sequence": sequence_features(numbers),
    }


def candidates():
    layouts = [
        ("frequency", {"frequency": 1.0}),
        ("existing_blocks", {"frequency": .75, "ordered": .25}),
        ("position4_only", {"position4": 1.0}),
        ("kernel_only", {"kernel": 1.0}),
        ("sequence_only", {"sequence": 1.0}),
        ("frequency_position4", {"frequency": .8, "position4": .2}),
        ("frequency_position8", {"frequency": .8, "position8": .2}),
        ("frequency_association", {"frequency": .8, "association": .2}),
        ("frequency_kernel", {"frequency": .8, "kernel": .2}),
        ("frequency_sequence", {"frequency": .8, "sequence": .2}),
        ("existing_kernel", {"frequency": .65, "ordered": .2, "kernel": .15}),
        ("existing_sequence", {"frequency": .65, "ordered": .2, "sequence": .15}),
        ("all_sequence", {"frequency": .6, "ordered": .15, "kernel": .125, "sequence": .125}),
    ]
    result = []
    for name, weights in layouts:
        for shrink in (.15, .5, .85):
            result.append(dict(id=f"{name}_lda_s{shrink:g}", layout=name, weights=weights,
                               shrinkage=shrink, classifier="lda"))
    for name, weights in layouts[:2] + layouts[7:10]:
        result.append(dict(id=name + "_centroid", layout=name, weights=weights,
                           shrinkage=1.0, classifier="centroid"))
    for shrink in (.5, .85):
        result.append(dict(id=f"frequency_value_moments_lda_s{shrink:g}", layout="frequency_value_moments",
                           weights={"frequency": .9, "value_moments": .1},
                           shrinkage=shrink, classifier="lda"))
        result.append(dict(id=f"frequency_first_occurrence_lda_s{shrink:g}", layout="frequency_first_occurrence",
                           weights={"frequency": .9, "first_occurrence": .1},
                           shrinkage=shrink, classifier="lda"))
    return result


def transform(parts, params, weights):
    output = []
    for name, weight in weights.items():
        z = (parts[name] - params[name]["mean"]) / params[name]["scale"]
        norm = np.linalg.norm(z, axis=1, keepdims=True)
        z /= np.maximum(norm, 1e-12)
        output.append(z * np.sqrt(weight))
    return np.c_[tuple(output)]


def fit_geometry(parts, y, classes, weights):
    params = {}
    for name in weights:
        x = parts[name]
        scale = x.std(0)
        scale[scale < 1e-10] = 1
        params[name] = dict(mean=x.mean(0), scale=scale)
    x = transform(parts, params, weights)
    centres = np.stack([x[y == k].mean(0) for k in range(classes)])
    residual = x - centres[y]
    covariance = residual.T @ residual / len(residual)
    values, vectors = eigh(covariance, check_finite=False)
    target = max(np.trace(covariance) / covariance.shape[0], 1e-12)
    return params, centres, values, vectors, target


def head(geometry, shrinkage):
    _, centres, values, vectors, target = geometry
    denominator = (1 - shrinkage) * np.maximum(values, 0) + shrinkage * target
    coefficient = (vectors @ ((vectors.T @ centres.T) / denominator[:, None])).T
    intercept = -.5 * np.sum(centres * coefficient, axis=1)
    return coefficient, intercept


def score(geometry, parts, config):
    transformed = transform(parts, geometry[0], config["weights"])
    coefficient, intercept = head(geometry, config["shrinkage"])
    return transformed @ coefficient.T + intercept


def zscore(scores):
    return (scores - scores.mean(1, keepdims=True)) / np.maximum(scores.std(1, keepdims=True), 1e-12)


def metrics(scores, truth, ids):
    order = np.argsort(-scores, axis=1, kind="stable")
    correct = order[:, 0] == truth
    pair_mask = np.isin(truth, [ids.index(p) for p in PAIR])
    pair_indices = [ids.index(p) for p in PAIR]
    pair_prediction = np.asarray(pair_indices)[scores[pair_mask][:, pair_indices].argmax(1)]
    return dict(n=len(truth), top1=float(correct.mean()), hits=int(correct.sum()),
                top3=float(np.any(order[:, :3] == truth[:, None], axis=1).mean()),
                macro_top1=float(np.mean([correct[truth == k].mean() for k in range(len(ids))])),
                pair_n=int(pair_mask.sum()), pair_top1=float(correct[pair_mask].mean()),
                pair_binary_accuracy=float(np.mean(pair_prediction == truth[pair_mask])),
                per_model={label: dict(n=int((truth == k).sum()),
                                      correct=int(correct[truth == k].sum())) for k, label in enumerate(ids)})


def fit_temperature(scores, truth):
    def objective(log_beta):
        evidence = scores * np.exp(log_beta)
        return float(np.mean(logsumexp(evidence, axis=1) - evidence[np.arange(len(truth)), truth]))
    solution = minimize_scalar(objective, bounds=(-6, 6), method="bounded")
    return float(np.exp(solution.x))


def confidence_metrics(probability, truth, ids):
    prediction = probability.argmax(1)
    confidence = probability.max(1)
    correct = prediction == truth
    errors = ~correct
    ece = 0.
    reliability = []
    for lo, hi in zip(np.arange(0, 1, .1), np.arange(.1, 1.1, .1)):
        mask = (confidence >= lo) & (confidence < hi + (1e-10 if hi > .99 else 0))
        if not mask.any():
            continue
        accuracy = float(correct[mask].mean())
        ece += float(mask.mean()) * abs(accuracy - confidence[mask].mean())
        reliability.append(dict(lo=float(lo), hi=float(hi), n=int(mask.sum()),
                                mean_confidence=float(confidence[mask].mean()), accuracy=accuracy))
    selective = {}
    pair = np.isin(truth, [ids.index(p) for p in PAIR])
    for scope, mask in (("all", np.ones(len(truth), bool)), ("pair", pair)):
        selective[scope] = []
        for threshold in (.8, .9, .95, .99):
            selected = mask & (confidence >= threshold)
            n, wrong = int(selected.sum()), int(errors[selected].sum())
            upper = float(beta.ppf(.95, wrong + 1, n - wrong)) if n and wrong < n else (1.0 if n else None)
            selective[scope].append(dict(threshold=threshold, accepted=n, errors=wrong,
                                        coverage=n / int(mask.sum()), error_upper95=upper))
    return dict(nll=float(-np.log(np.maximum(probability[np.arange(len(truth)), truth], 1e-300)).mean()),
                brier=float(np.mean(np.sum(probability ** 2, axis=1) - 2 * probability[np.arange(len(truth)), truth] + 1)),
                ece10=float(ece), reliability=reliability, selective=selective,
                high_confidence_scope="closed registered reference labels; no identity authentication")


def grouped(sample_scores, groups):
    return np.stack([zscore(sample_scores[index]).mean(0) for index in groups])


def run_screen(out, ids, rows, panel, groups, y, env, panel_indices, parts, configs):
    path = out / "candidates.npz"
    signature = hashlib.sha256(json.dumps(configs, sort_keys=True).encode()).hexdigest()
    reference_hash = hashlib.sha256(REFERENCE.read_bytes()).hexdigest()
    if path.exists():
        data = np.load(path)
        if str(data["reference_sha256"]) != reference_hash or str(data["config_sha256"]) != signature:
            raise ValueError("Cached candidate configuration or reference has changed")
        return data["candidate_scores"]
    predictions = np.empty((len(configs), len(rows), len(ids)))
    predictions[:] = np.nan
    layouts = list(dict.fromkeys(config["layout"] for config in configs))
    start = time.monotonic()
    for held_environment in range(1, 13):
        held = env == held_environment
        train = ~held
        training = {name: values[train] for name, values in parts.items()}
        query = {name: values[held] for name, values in parts.items()}
        for layout in layouts:
            members = [(i, c) for i, c in enumerate(configs) if c["layout"] == layout]
            geometry = fit_geometry(training, y[train], len(ids), members[0][1]["weights"])
            for i, config in members:
                predictions[i, held] = score(geometry, query, config)
        print(f"screen environment {held_environment:02d}/12; elapsed {time.monotonic()-start:.1f}s", flush=True)
    if not np.isfinite(predictions[:, panel_indices]).all():
        raise ValueError("Reference panel has a missing fold prediction")
    np.savez_compressed(path, candidate_scores=predictions[:, panel_indices],
                        y=y[panel_indices], row_ids=np.asarray([rows[i]["row_id"] for i in panel_indices]),
                        environment=env[panel_indices], model_ids=np.asarray(ids),
                        config_sha256=signature, reference_sha256=reference_hash)
    return predictions[:, panel_indices]


def nested_confidence(out, ids, rows, panel, groups, y, env, parts, config, sample_scores):
    """Inner calibration predictions exclude the outer and inner environments."""
    group_y = np.asarray([ids.index(entry["model"]) for entry in panel])
    group_env = np.asarray([entry["environment"] for entry in panel])
    outer_scores = grouped(sample_scores, groups)
    nested = {}
    cache = out / "nested-cache"
    cache.mkdir(exist_ok=True)
    signature = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()[:12]
    for count, excluded in enumerate(combinations(range(1, 13), 2), 1):
        path = cache / (signature + "-exclude-" + "-".join(map(str, excluded)) + ".npz")
        held = np.isin(env, excluded)
        group_indices = np.flatnonzero(np.isin(group_env, excluded))
        if path.exists():
            data = np.load(path)
            if not np.array_equal(data["indices"], group_indices):
                raise ValueError("Nested cached groups differ")
            nested[excluded] = dict(indices=group_indices, scores=data["scores"])
            continue
        geometry = fit_geometry({name: x[~held] for name, x in parts.items()}, y[~held], len(ids), config["weights"])
        query_scores = np.full((len(rows), len(ids)), np.nan)
        query_scores[held] = score(geometry, {name: x[held] for name, x in parts.items()}, config)
        scores = grouped(query_scores, [groups[i] for i in group_indices])
        np.savez_compressed(path, indices=group_indices, scores=scores)
        nested[excluded] = dict(indices=group_indices, scores=scores)
        if count % 6 == 0:
            print(f"nested confidence {count}/66 fits", flush=True)
    probabilities = np.empty_like(outer_scores)
    calibrators = []
    for outer in range(1, 13):
        scores, targets = [], []
        for inner in range(1, 13):
            if inner == outer:
                continue
            record = nested[tuple(sorted((outer, inner)))]
            take = group_env[record["indices"]] == inner
            scores.extend(record["scores"][take])
            targets.extend(group_y[record["indices"]][take])
        inverse_temperature = fit_temperature(np.asarray(scores), np.asarray(targets))
        take = group_env == outer
        probabilities[take] = softmax(outer_scores[take] * inverse_temperature, axis=1)
        calibrators.append(dict(outer_environment=outer, inverse_temperature=inverse_temperature,
                                calibration_environments=[i for i in range(1, 13) if i != outer]))
    save(out / "calibrators.json", calibrators)
    final_temperature = fit_temperature(outer_scores, group_y)
    return probabilities, final_temperature


def infer_artifact(artifact, sequences):
    """Return raw and calibrated all-library group scores from one to three replies."""
    feature_rows = [blocks(numbers) for numbers in sequences]
    parts = {name: np.stack([row[name] for row in feature_rows]) for name in artifact["weights"]}
    x = transform(parts, artifact["params"], artifact["weights"])
    sample_scores = x @ artifact["coefficient"].T + artifact["intercept"]
    group_scores = zscore(sample_scores).mean(0)
    return group_scores, softmax(group_scores * artifact["inverse_temperature"])


def load_artifact(path):
    return joblib.load(path)


def score_groups(artifact, groups):
    if artifact["schema"] == "generic-positional-ensemble-fusion-v1":
        baseline = np.asarray([value for value, _ in artifact["baseline"].score_groups(groups)])
        candidate = score_groups(artifact["candidate"], groups)
        return combine_fusion(baseline, candidate, artifact["spec"])
    return np.stack([infer_artifact(artifact, sequences)[0] for sequences in groups])


def combine_fusion(baseline, candidate, config):
    b, c = zscore(baseline), zscore(candidate)
    weight = np.full((len(b), 1), config["candidate_weight"])
    if config["gap_threshold"] is not None:
        sorted_scores = np.sort(b, axis=1)
        uncertain = sorted_scores[:, -1] - sorted_scores[:, -2] <= config["gap_threshold"]
        weight *= uncertain[:, None]
    return (1 - weight) * b + weight * c


def fitted_candidate(ids, rows, y, parts, config, temperature):
    geometry = fit_geometry(parts, y, len(ids), config["weights"])
    coefficient, intercept = head(geometry, config["shrinkage"])
    return dict(schema="generic-positional-lda-v1", model_ids=ids, config=config,
                reference_sha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),
                weights=config["weights"], params=geometry[0], coefficient=coefficient,
                intercept=intercept, inverse_temperature=temperature, beta=temperature, spec=config,
                train_row_ids=[row["row_id"] for row in rows],
                probability_scope="closed registered labels; post-selection reference calibration")


def run_ensemble_fusion(out, baseline_path):
    from ensemble_confidence_core import Ensemble

    source = out
    out = out / "ensemble-fusion"
    out.mkdir(exist_ok=True)
    ids, rows, panel, groups, y, env, panel_indices = load()
    baseline_data = np.load(baseline_path)
    group_ids = np.asarray([entry["id"] for entry in panel])
    truth = np.asarray([ids.index(entry["model"]) for entry in panel])
    group_env = np.asarray([entry["environment"] for entry in panel])
    if (not np.array_equal(baseline_data["model_ids"], ids)
            or not np.array_equal(baseline_data["group_ids"], group_ids)
            or not np.array_equal(baseline_data["y"], truth)):
        raise ValueError("Fusion baseline/reference panel order differs")
    baseline = baseline_data["baseline_scores"]
    configs = json.loads((source / "configs.json").read_text())
    config_by_id = {config["id"]: config for config in configs}
    data = np.load(source / "candidates.npz")
    expected_hash = hashlib.sha256(REFERENCE.read_bytes()).hexdigest()
    if str(data["reference_sha256"]) != expected_hash:
        raise ValueError("Positional scores reference changed")
    panel_groups = [list(range(3*i, 3*i+3)) for i in range(len(panel))]
    # Two generic families fixed before opening independent answers: the best
    # all-feature family and the best pure normalized-position family by Top1.
    positional_winner = json.loads((source / "summary.json").read_text())["winner"]["id"]
    position_entries = [c for c in configs if c["layout"] == "position4_only"]
    position_scores = {c["id"]: grouped(data["candidate_scores"][configs.index(c)], panel_groups)
                       for c in position_entries}
    position_winner = max(position_entries, key=lambda c: (metrics(position_scores[c["id"]], truth, ids)["top1"],
                                                          metrics(position_scores[c["id"]], truth, ids)["top3"]))["id"]
    component_scores = {name: grouped(data["candidate_scores"][configs.index(config_by_id[name])], panel_groups)
                        for name in dict.fromkeys((positional_winner, position_winner))}
    fusions = [dict(id=f"{name}_w{weight:g}_gap{gap}", candidate=name, candidate_weight=weight,
                    gap_threshold=gap) for name in component_scores for weight in (.25, .5, .75)
               for gap in (None, .25, .5)]
    reports = []
    scores = []
    for config in fusions:
        combined = combine_fusion(baseline, component_scores[config["candidate"]], config)
        scores.append(combined)
        reports.append(dict(config=config, metrics=metrics(combined, truth, ids)))
    order = sorted(range(len(reports)), key=lambda i: (reports[i]["metrics"]["top1"], reports[i]["metrics"]["top3"]), reverse=True)
    reports = [reports[i] for i in order]
    save(out / "candidates.json", reports)
    config = reports[0]["config"]
    candidate_config = config_by_id[config["candidate"]]
    raw = scores[order[0]]
    beta_final = fit_temperature(raw, truth)
    np.savez_compressed(out / "candidates.npz", candidate_scores=np.asarray(scores), baseline_scores=baseline,
                        model_ids=np.asarray(ids), group_ids=group_ids, y=truth, environment=group_env)
    save(out / "frozen-selection.json", dict(config=config, candidate_config=candidate_config,
        reference_sha256=expected_hash, selection_scope="overall 636-group reference Top1 then Top3; pair not used",
        baseline=metrics(baseline, truth, ids), winner=reports[0]["metrics"], beta=beta_final))
    print("frozen fusion", config, {k: v for k, v in reports[0]["metrics"].items() if k != "per_model"}, flush=True)
    feature_rows = [blocks(row["numbers"]) for row in rows]
    parts = {name: np.stack([row[name] for row in feature_rows]) for name in feature_rows[0]}
    cache = out / "nested-cache"
    cache.mkdir(exist_ok=True)
    signature = hashlib.sha256(json.dumps(candidate_config, sort_keys=True).encode()).hexdigest()[:12]
    nested = {}
    for count, excluded in enumerate(combinations(range(1, 13), 2), 1):
        path = cache / (signature + "-exclude-" + "-".join(map(str, excluded)) + ".npz")
        indices = np.flatnonzero(np.isin(group_env, excluded))
        if path.exists():
            cached = np.load(path)
            if not np.array_equal(cached["indices"], indices):
                raise ValueError("Fusion nested cache order changed")
            nested[excluded] = dict(indices=indices, scores=cached["scores"])
            continue
        held = np.isin(env, excluded)
        query_groups = [[rows[i]["numbers"] for i in groups[j]] for j in indices]
        engine = Ensemble([row for i, row in enumerate(rows) if not held[i]], ids)
        base = np.asarray([value for value, _ in engine.score_groups(query_groups)])
        positional_cache = source / "nested-cache" / path.name
        if positional_cache.exists():
            cached = np.load(positional_cache)
            if not np.array_equal(cached["indices"], indices):
                raise ValueError("Positional nested cache order differs")
            candidate = cached["scores"]
        else:
            geometry = fit_geometry({name: value[~held] for name, value in parts.items()}, y[~held], len(ids), candidate_config["weights"])
            query_scores = np.full((len(rows), len(ids)), np.nan)
            query_scores[held] = score(geometry, {name: value[held] for name, value in parts.items()}, candidate_config)
            candidate = grouped(query_scores, [groups[i] for i in indices])
        fused = combine_fusion(base, candidate, config)
        np.savez_compressed(path, indices=indices, scores=fused, baseline=base, candidate=candidate)
        nested[excluded] = dict(indices=indices, scores=fused)
        if count % 6 == 0:
            print(f"fusion nested confidence {count}/66 fits", flush=True)
    probability = np.empty_like(raw)
    calibrators = []
    for outer in range(1, 13):
        inner_scores, inner_truth = [], []
        for inner in range(1, 13):
            if inner == outer:
                continue
            record = nested[tuple(sorted((outer, inner)))]
            take = group_env[record["indices"]] == inner
            inner_scores.extend(record["scores"][take])
            inner_truth.extend(truth[record["indices"]][take])
        temperature = fit_temperature(np.asarray(inner_scores), np.asarray(inner_truth))
        take = group_env == outer
        probability[take] = softmax(raw[take] * temperature, axis=1)
        calibrators.append(dict(outer_environment=outer, beta=temperature))
    candidate = fitted_candidate(ids, rows, y, parts, candidate_config, 1.)
    artifact = dict(schema="generic-positional-ensemble-fusion-v1", model_ids=ids, candidate=candidate,
                    baseline=Ensemble(rows, ids), spec=config, beta=beta_final,
                    reference_sha256=expected_hash, probability_scope="closed registered labels; post-selection reference calibration")
    joblib.dump(artifact, out / "fitted.joblib", compress=3)
    np.savez_compressed(out / "reference-oof.npz", scores=raw, y=truth, model_ids=np.asarray(ids),
                        group_ids=group_ids, environment=group_env, probabilities=probability)
    confidence = confidence_metrics(probability, truth, ids)
    save(out / "calibrators.json", calibrators)
    save(out / "confidence.json", confidence)
    save(out / "summary.json", dict(config=config, candidate_config=candidate_config,
        baseline=metrics(baseline, truth, ids), winner=reports[0]["metrics"], confidence=confidence,
        artifact="fitted.joblib", beta=beta_final, prospective_evaluated=False))
    lines = ["# Generic positional / existing Ensemble fusion", "",
        "Selection uses overall reference group Top1 then Top3. Both component candidates are all-library "
        "classifiers. Fixed weights are .25/.5/.75; optional gates use the baseline's standardized Top1–Top2 "
        "gap .25/.5 for every class. Fixed holdout and prospective answers are not read.", "",
        "| Config | Group Top1 | Top3 | Pair global Top1 | Pair conditional |", "|---|---:|---:|---:|---:|"]
    for entry in reports:
        m = entry["metrics"]
        lines.append(f"| {entry['config']['id']} | {m['top1']:.3%} | {m['top3']:.3%} | {m['pair_top1']:.3%} | {m['pair_binary_accuracy']:.3%} |")
    lines += ["", f"Selected `{config['id']}`. Nested leave-two-environment calibration NLL {confidence['nll']:.4f}, "
              f"Brier {confidence['brier']:.4f}, ECE10 {confidence['ece10']:.4f}.", "",
              "Feature/candidate selection precedes nested calibration, so calibration remains conditional "
              "on exploratory reference selection. Independent validation is required for a delivery claim."]
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("fusion artifact", out / "fitted.joblib", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--skip-nested", action="store_true")
    parser.add_argument("--ensemble-fusion", type=Path)
    args = parser.parse_args()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    if args.ensemble_fusion is not None:
        run_ensemble_fusion(out, args.ensemble_fusion)
        return
    ids, rows, panel, groups, y, env, panel_indices = load()
    print(f"reference {len(ids)} labels, {len(rows)} replies, {len(panel)} three-answer groups", flush=True)
    feature_rows = [blocks(row["numbers"]) for row in rows]
    parts = {name: np.stack([row[name] for row in feature_rows]) for name in feature_rows[0]}
    configs = candidates()
    save(out / "configs.json", configs)
    save(out / "panel.json", panel)
    save(out / "protocol.json", dict(reference_sha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),
        models=ids, reference_rows=len(rows), panel_rows=len(panel_indices), panel_groups=len(panel),
        supplemental_training_rows=len(rows)-len(panel_indices), folds=list(range(1, 13)),
        feature_dimensions={name: values.shape[1] for name, values in parts.items()},
        feature_fitting="training-only feature means/scales, block normalization, pooled shrinkage covariance",
        candidate_selection="exploratory reference LOEO accuracy; fixed holdout and prospective data never opened",
        confidence="winner: genuine leave-two-environment inner predictions calibrate held outer environment; candidate selection is post-selection",
        calibration_unit="three-answer environment group", random_seed=None))
    scores = run_screen(out, ids, rows, panel, groups, y, env, panel_indices, parts, configs)
    # Cached arrays use panel order, while fit/query arrays use reference row order.
    panel_groups = [list(range(3*i, 3*i+3)) for i in range(len(panel))]
    group_y = np.asarray([ids.index(entry["model"]) for entry in panel])
    group_env = np.asarray([entry["environment"] for entry in panel])
    reports = []
    for config, values in zip(configs, scores):
        group_scores = grouped(values, panel_groups)
        reports.append(dict(config=config, sample=metrics(values, y[panel_indices], ids),
                            group=metrics(group_scores, group_y, ids)))
    order = sorted(range(len(reports)), key=lambda i: (reports[i]["group"]["top1"], reports[i]["group"]["top3"]), reverse=True)
    save(out / "results.json", [reports[i] for i in order])
    winner_index = order[0]
    winner = configs[winner_index]
    print("winner", winner["id"], {k: v for k, v in reports[winner_index]["group"].items() if k != "per_model"}, flush=True)
    sample_scores = np.full((len(rows), len(ids)), np.nan)
    sample_scores[panel_indices] = scores[winner_index]
    probabilities = None
    if args.skip_nested:
        temperature = fit_temperature(grouped(scores[winner_index], panel_groups), group_y)
    else:
        probabilities, temperature = nested_confidence(out, ids, rows, panel, groups, y, env, parts, winner, sample_scores)
    geometry = fit_geometry(parts, y, len(ids), winner["weights"])
    coefficient, intercept = head(geometry, winner["shrinkage"])
    artifact = dict(schema="generic-positional-lda-v1", model_ids=ids, config=winner,
                    reference_sha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),
                    weights=winner["weights"], params=geometry[0], coefficient=coefficient,
                    intercept=intercept, inverse_temperature=temperature,
                    beta=temperature, spec=winner,
                    train_row_ids=[row["row_id"] for row in rows],
                    probability_scope="closed registered labels; post-selection reference calibration")
    joblib.dump(artifact, out / "fitted.joblib")
    winner_group_scores = grouped(scores[winner_index], panel_groups)
    np.savez_compressed(out / "reference-oof.npz", scores=winner_group_scores, y=group_y,
        model_ids=np.asarray(ids), group_ids=np.asarray([entry["id"] for entry in panel]),
        environment=group_env, sample_scores=scores[winner_index], sample_y=y[panel_indices],
        sample_row_ids=np.asarray([rows[i]["row_id"] for i in panel_indices]), sample_environment=env[panel_indices],
        probabilities=probabilities if probabilities is not None else np.empty((0, len(ids))))
    confidence = confidence_metrics(probabilities, group_y, ids) if probabilities is not None else None
    save(out / "confidence.json", confidence)
    summary = dict(winner=winner, metrics=reports[winner_index], confidence=confidence,
                   inverse_temperature=temperature, prospective_evaluated=False)
    save(out / "summary.json", summary)
    lines = ["# Generic sequence fingerprints: reference-only screen", "",
             f"{len(ids)} models, {len(rows)} reference answers, {len(panel)} three-answer groups. "
             "12 leave-one-environment-out folds; all responses in a held environment excluded from training.", "",
             "The grid is exploratory reference selection. Its best score is not an independent validation result. "
             "Neither the frozen holdout nor prospective samples were read. Confidence calibration uses "
             "leave-two-environment-out inner predictions, conditioned on the selected candidate.", "",
             "| Candidate | Single Top1 | Group Top1 | Group Top3 | Pair global Top1 | Pair conditional |",
             "|---|---:|---:|---:|---:|---:|"]
    for index in order:
        report = reports[index]
        single, group = report["sample"], report["group"]
        lines.append(f"| {report['config']['id']} | {single['top1']:.3%} | {group['top1']:.3%} | "
                     f"{group['top3']:.3%} | {group['pair_top1']:.3%} | {group['pair_binary_accuracy']:.3%} |")
    lines += ["", "Macro Top1 equals group Top1 because each model contributes 12 groups.", "",
              "Position histograms preserve normalized placement. Residual joint histograms remove marginals. "
              "Kernel moments correlate numeric RBF and last-digit basis functions with three relative-position "
              "Legendre polynomials. Exact-value moments use 355 indicators and two position polynomials. "
              "Sequence statistics include lagged autocorrelation, difference/rank tendencies and residual "
              "coarse-value/last-digit transitions.", "", f"Selected candidate: `{winner['id']}`."]
    if confidence:
        lines += [f"Nested calibration: NLL {confidence['nll']:.4f}; Brier {confidence['brier']:.4f}; "
                  f"ECE10 {confidence['ece10']:.4f}.", "",
                  "| Scope | Threshold | Accepted | Errors | Coverage | 95% error upper bound |",
                  "|---|---:|---:|---:|---:|---:|"]
        for scope, records in confidence["selective"].items():
            for record in records:
                upper = f"{record['error_upper95']:.3%}" if record["error_upper95"] is not None else "N/A"
                lines.append(f"| {scope} | {record['threshold']} | {record['accepted']} | {record['errors']} | "
                             f"{record['coverage']:.3%} | {upper} |")
        lines += ["", "These bounds summarize observed post-selection reference errors, not a guarantee for "
                  "new models, new providers, or new prompts. The pair has only 24 reference groups."]
    (out / "report.md").write_text("\n".join(lines) + "\n")
    print("artifact", out / "fitted.joblib", flush=True)


if __name__ == "__main__":
    main()
