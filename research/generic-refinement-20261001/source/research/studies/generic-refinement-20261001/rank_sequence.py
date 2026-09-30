# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.1", "joblib==1.5.3"]
# ///
"""Reference-only empirical-rank sequence discriminants.

Inference: load_artifact(path), score_groups(artifact, groups). Artifacts contain
ordinary dictionaries and numeric arrays; no fitted estimator classes are kept.
"""
from __future__ import annotations

import os

for thread_variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[thread_variable] = "1"
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import argparse
import hashlib
import itertools
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
import scipy
import sklearn
from scipy.special import gammaln

ROOT = Path(__file__).resolve().parents[3]
BUNDLE = ROOT / "projects/research/sequence-generalization-20260930"
SOURCE = BUNDLE / "source"
if not SOURCE.exists() and (ROOT / "projects/offline").exists():
    SOURCE = ROOT
sys.path.insert(0, str(SOURCE / "research/studies/sequence-generalization"))
sys.path.insert(0, str(SOURCE / "projects/offline"))
from classifiers import (confidence_metrics, decision, excluded_rows, fit_estimator,
                         fit_temperature, metrics, save)
from bank_builder import read_rows
from fingerprint import count_numbers, hellinger_feature, ordered_block_feature
from shared_verifier_core import reference_panel

OUT = ROOT / "research/reports/generic-refinement-20261001/rank-sequence"
REFERENCE_SHA = "5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4"
BANK_SHA = "47b8ad67e8ad32095ac650b3a384420c06ef88bb6e78206be478a8cd62029968"
LAGS = (1, 2, 4, 7, 11, 17, 29)
RUN_LENGTHS = (2, 3, 4, 5, 8)
GAP_THRESHOLDS = (.25, .5, 1., 2., 4.)
ORDINAL_CODES = {
    width: np.asarray([sum(value * width**i for i, value in enumerate(pattern))
                       for pattern in itertools.product(range(width), repeat=width)
                       if set(pattern) == set(range(max(pattern) + 1))])
    for width in (3, 4)
}
ORDINAL_COUNTS = {
    width: [tuple(np.bincount([(int(code) // width**i) % width for i in range(width)])[:
                              max((int(code) // width**i) % width for i in range(width)) + 1])
            for code in codes]
    for width, codes in ORDINAL_CODES.items()
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def midranks(values):
    unique, inverse, counts = np.unique(values, return_inverse=True, return_counts=True)
    positions = (np.cumsum(counts) - counts / 2) / len(values)
    return positions[inverse], counts, inverse


def normalized(values):
    centred = values - values.mean()
    scale = np.sqrt(np.mean(centred**2))
    return centred / scale if scale > 1e-12 else np.zeros_like(values)


def assignment_probability(composition, counts, n):
    """Exact weak-order probability under permutation of fixed marginal counts."""
    state = None
    for multiplicity in composition:
        weights = np.ones(len(counts))
        for decrement in range(multiplicity):
            weights *= np.maximum(counts - decrement, 0) / n
        state = weights if state is None else weights * np.r_[0., np.cumsum(state)[:-1]]
    width = sum(composition)
    denominator = np.prod([(n - decrement) / n for decrement in range(width)])
    return float(state.sum() / denominator)


def equal_window_rate(values, width):
    windows = np.lib.stride_tricks.sliding_window_view(values, width)
    return float(np.mean(np.all(windows == windows[:, :1], axis=1)))


def ordinal_features(values, q, counts):
    n = len(values)
    output = []
    for width in (3, 4):
        windows = np.lib.stride_tricks.sliding_window_view(values, width)
        dense = np.sum(windows[:, :, None] > windows[:, None, :], axis=2)
        # Dense ordinal ranks must count distinct lower values, not their repeats.
        dense = np.stack([np.unique(window, return_inverse=True)[1] for window in windows])
        codes = dense @ (width ** np.arange(width))
        observed = np.bincount(codes, minlength=width**width)[ORDINAL_CODES[width]] / len(windows)
        null = {composition: assignment_probability(composition, counts, n)
                for composition in set(ORDINAL_COUNTS[width])}
        expected = np.asarray([null[composition] for composition in ORDINAL_COUNTS[width]])
        output.extend((observed - expected) / np.sqrt(np.maximum(expected, 1 / n)))
    z = normalized(q)
    for channel in (z, normalized(z**2)):
        for lag in LAGS:
            output.append(float(np.mean(channel[lag:] * channel[:-lag]) +
                                (1 / (n - 1) if np.any(channel) else 0)))
    difference = np.diff(q)
    equal_probability = float(np.sum(counts * (counts - 1)) / (n * (n - 1)))
    output.extend((np.mean(difference < 0) - (1 - equal_probability) / 2,
                   np.mean(difference == 0) - equal_probability,
                   np.mean(difference > 0) - (1 - equal_probability) / 2))
    probability = counts / n
    unique_q = (np.cumsum(counts) - counts / 2) / n
    expected_abs = 2 * np.sum(probability * (unique_q * np.r_[0., np.cumsum(probability)[:-1]] -
                                             np.r_[0., np.cumsum(probability * unique_q)[:-1]])) * n / (n - 1)
    output.extend((np.mean(np.abs(difference)) - expected_abs,
                   np.mean(difference**2) - 2 * np.var(q) * n / (n - 1)))
    for threshold in (1 / 3, .5, 2 / 3):
        bits = q > threshold
        marginal = np.asarray([np.sum(~bits), np.sum(bits)])
        for width in RUN_LENGTHS:
            null = assignment_probability((width,), marginal, n)
            output.append(equal_window_rate(bits, width) - null)
    signs = np.sign(difference)
    for length in RUN_LENGTHS:
        windows = np.lib.stride_tricks.sliding_window_view(signs, length)
        observed = np.mean(np.all(windows > 0, axis=1) | np.all(windows < 0, axis=1))
        expected = 2 * assignment_probability((1,) * (length + 1), counts, n)
        output.append(observed - expected)
    return np.asarray(output)


def recurrence_features(symbols):
    n = len(symbols)
    _, inverse, counts = np.unique(symbols, return_inverse=True, return_counts=True)
    intervals, interval_counts = [], []
    for symbol, count in enumerate(counts):
        if count > 1:
            intervals.extend(np.diff(np.flatnonzero(inverse == symbol)))
            interval_counts.extend([count] * (count - 1))
    output = []
    if intervals:
        gaps = np.asarray(intervals, dtype=float)
        multiplicities = np.asarray(interval_counts, dtype=float)
        z = gaps * (multiplicities + 1) / (n + 1)
        variance = multiplicities * (n - multiplicities) / ((n + 1) * (multiplicities + 2))
        output.extend((z.mean() - 1, np.mean(z**2 - 1 - variance)))
        denominator = gammaln(n + 1) - gammaln(multiplicities + 1) - gammaln(n - multiplicities + 1)
        for threshold in GAP_THRESHOLDS:
            first_ge = np.ceil(threshold * (n + 1) / (multiplicities + 1)).astype(int)
            available = n - first_ge + 1
            survival = np.zeros(len(gaps))
            valid = available >= multiplicities
            survival[valid] = np.exp(gammaln(available[valid] + 1) - gammaln(multiplicities[valid] + 1) -
                                     gammaln(available[valid] - multiplicities[valid] + 1) - denominator[valid])
            output.append(float(np.mean(z < threshold) - np.mean(1 - survival)))
    else:
        output.extend([0.] * (2 + len(GAP_THRESHOLDS)))
    null_equal = np.sum(counts * (counts - 1)) / (n * (n - 1))
    output.extend(float(np.mean(symbols[lag:] == symbols[:-lag]) - null_equal) for lag in LAGS)
    return np.asarray(output)


def phase_features(channel):
    z = normalized(channel)
    position = (np.arange(len(z)) + .5) / len(z)
    dct = np.sqrt(2) * np.mean(z[:, None] * np.cos(np.pi * position[:, None] * np.arange(1, 17)), axis=0)
    basis = np.exp(-2j * np.pi * position[:, None] * np.arange(1, 13))
    fourier = np.sqrt(2) * np.mean(z[:, None] * basis, axis=0)
    return np.r_[dct, fourier.real, fourier.imag]


def spectral_features(q):
    z = normalized(q)
    output = list(np.r_[phase_features(q), phase_features((np.diff(q) == 0).astype(float))])
    powers = np.abs(np.fft.rfft(z) / np.sqrt(len(z)))**2
    for low, high in ((1, 5), (5, 9), (9, 17), (17, 33), (33, 65), (65, len(powers))):
        band = powers[low:min(high, len(powers))]
        output.append(float(band.mean() - len(z) / (len(z) - 1)) if len(band) and np.any(z) else 0.)
    return np.asarray(output)


def blocks(numbers):
    values = np.asarray(numbers, dtype=np.int16)
    if len(values) < 80 or np.any((values < 1) | (values > 355)):
        raise ValueError("A reply must contain at least 80 integers in 1..355")
    q, counts, _ = midranks(values)
    result = dict(frequency=hellinger_feature(count_numbers(numbers)), order=ordered_block_feature(numbers),
                  ordinal=ordinal_features(values, q, counts),
                  recurrence=np.r_[recurrence_features(values), recurrence_features(np.minimum(7, (q * 8).astype(int))),
                                   recurrence_features(np.minimum(15, (q * 16).astype(int)))], spectral=spectral_features(q))
    if any(not np.isfinite(value).all() for value in result.values()):
        raise ValueError("Non-finite rank-sequence feature")
    return result


def candidates():
    layouts = [
        ("ordinal", dict(frequency=.6, order=.15, ordinal=.25)),
        ("recurrence", dict(frequency=.6, order=.15, recurrence=.25)),
        ("spectral", dict(frequency=.6, order=.15, spectral=.25)),
        ("all_balanced", dict(frequency=.5, order=.1, ordinal=.15, recurrence=.1, spectral=.15)),
        ("all_sequence_heavy", dict(frequency=.35, order=.1, ordinal=.2, recurrence=.15, spectral=.2)),
        ("sequence_only", dict(ordinal=.4, recurrence=.25, spectral=.35)),
    ]
    return [dict(id=f"{layout}_{kind}_{parameter:g}", layout=layout, weights=weights, kind=kind, parameter=parameter)
            for layout, weights in layouts for kind, parameters in (("lda", (.15, .5, .85)), ("ridge", (1., 10.)))
            for parameter in parameters]


def geometry(parts, weights, parameters=None):
    fitted, transformed = {}, []
    for name, weight in weights.items():
        values = parts[name]
        if parameters is None:
            mean, scale = values.mean(axis=0), values.std(axis=0)
            scale[scale < 1e-10] = 1
            fitted[name] = dict(mean=mean, scale=scale)
        else:
            fitted[name] = parameters[name]
        standardized = (values - fitted[name]["mean"]) / fitted[name]["scale"]
        standardized /= np.maximum(np.linalg.norm(standardized, axis=1, keepdims=True), 1e-12)
        transformed.append(standardized * np.sqrt(weight))
    return np.concatenate(transformed, axis=1), fitted


def load_artifact(path):
    return joblib.load(path)


def score_groups(artifact, groups):
    replies = [reply for group in groups for reply in group]
    raw = [blocks(reply) for reply in replies]
    parts = {name: np.stack([row[name] for row in raw]) for name in artifact["spec"]["weights"]}
    features, _ = geometry(parts, artifact["spec"]["weights"], artifact["preprocessing"])
    single = features @ artifact["coefficient"].T + artifact["intercept"]
    output, offset = [], 0
    for group in groups:
        output.append(single[offset:offset + len(group)].mean(axis=0))
        offset += len(group)
    return np.asarray(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.time()
    reference = SOURCE / "projects/data/unified_reference.jsonl"
    bank_path = SOURCE / "projects/data/unified_bank.json"
    if sha(reference) != REFERENCE_SHA or sha(bank_path) != BANK_SHA:
        raise ValueError("First frozen reference/bank bytes differ")
    ids = [model["id"] for model in json.loads(bank_path.read_text())["models"]]
    rows = read_rows(reference)
    panel = reference_panel(rows, ids)
    index_of = {row["row_id"]: index for index, row in enumerate(rows)}
    slots = [[index_of[row_id] for row_id in group["row_ids"]] for group in panel]
    panel_indices = np.asarray([index for group in slots for index in group])
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    truth = np.asarray([ids.index(group["model"]) for group in panel])
    environments = np.asarray([group["environment"] for group in panel])
    specifications = candidates()
    dependency_paths = [Path(__file__), BUNDLE / "requirements.txt", reference, bank_path,
                        SOURCE / "research/studies/sequence-generalization/classifiers.py",
                        *[SOURCE / "projects/offline" / name for name in ("fingerprint.py", "bank_builder.py", "reference_data.py", "shared_verifier_core.py")]]
    sources = {str(path.relative_to(ROOT)): sha(path) for path in dependency_paths}
    plan = dict(schema="rank-sequence-reference-plan-v1", reference_rows=len(rows), panel_rows=len(panel_indices),
                training_only_extras=len(rows) - len(panel_indices), model_ids=ids, panel=panel, candidates=specifications,
                source_hashes=sources, reference_sha256=REFERENCE_SHA, bank_sha256=BANK_SHA,
                feature_dimensions=dict(frequency=355, order=74, ordinal=127, recurrence=42, spectral=86),
                null="Ordinal/run/recurrence statistics subtract exact random-permutation expectations conditional on each reply's marginal counts. PIT uses midranks and preserves ties.",
                spectral="Relative-position DCT 1..16 and complex Fourier 1..12 on empirical midranks and adjacent-tie indicators; six frequency bands subtract permutation power expectation.",
                folds="First frozen classifiers.excluded_rows: remove held query IDs/environment prefixes and exact text/parsed-sequence duplicates; 40 extras train only where permitted.",
                preprocessing="All block means/std fit on fold training only; per-reply block L2 normalization and predeclared weights.",
                aggregation="First stable query sample; exactly three replies; mean raw linear classifier scores.",
                selection="636 all-library group Top1, macro Top1, MRR, then stable predeclared candidate order. Pair diagnostics never select.",
                calibration="Winner temperature fitted to reference OOF development scores only; post-selection, not independently authenticated identity probability.",
                external_data_opened=False, versions=dict(python=sys.version, numpy=np.__version__, scipy=scipy.__version__, sklearn=sklearn.__version__, joblib=joblib.__version__),
                threads=1)
    plan_path = args.output / "plan.json"
    if plan_path.exists() and json.loads(plan_path.read_text()) != plan:
        raise ValueError("Existing predeclared plan changed; use a new study directory")
    save(plan_path, plan)
    print(f"Frozen plan: {len(specifications)} candidates, {len(panel)} groups, {len(ids)} labels", flush=True)
    feature_rows = [blocks(row["numbers"]) for row in rows]
    parts = {name: np.stack([row[name] for row in feature_rows]) for name in feature_rows[0]}
    if {name: value.shape[1] for name, value in parts.items()} != plan["feature_dimensions"]:
        raise ValueError("Declared feature dimensions differ")
    scores = np.full((len(specifications), len(panel), len(ids)), np.nan)
    sample_scores = np.full((len(specifications), len(panel_indices), len(ids)), np.nan)
    panel_positions = {index: position for position, index in enumerate(panel_indices)}
    folds = []
    for environment in range(1, 13):
        group_indices = np.flatnonzero(environments == environment)
        held = np.asarray([index for group in group_indices for index in slots[group]])
        positions = np.asarray([panel_positions[index] for index in held])
        excluded = excluded_rows(rows, environment, held)
        folds.append(dict(environment=environment, training_rows=int(np.sum(~excluded)), excluded_rows=int(excluded.sum()),
                          held_row_ids=[rows[index]["row_id"] for index in held]))
        for layout in dict.fromkeys(spec["layout"] for spec in specifications):
            members = [(index, spec) for index, spec in enumerate(specifications) if spec["layout"] == layout]
            weights = members[0][1]["weights"]
            training, preprocessing = geometry({name: value[~excluded] for name, value in parts.items()}, weights)
            query, _ = geometry({name: value[held] for name, value in parts.items()}, weights, preprocessing)
            for index, spec in members:
                fitted = fit_estimator(spec, training, labels[~excluded], len(ids))
                single = decision(fitted, query, spec)
                scores[index, group_indices] = single.reshape(-1, 3, len(ids)).mean(axis=1)
                sample_scores[index, positions] = single
        print(f"Environment {environment}/12: {time.time() - started:.1f}s", flush=True)
    if not np.isfinite(scores).all():
        raise ValueError("Non-finite or missing reference OOF scores")
    leaderboard = [dict(index=index, spec=spec, cv=metrics(value, truth, ids))
                   for index, (spec, value) in enumerate(zip(specifications, scores))]
    leaderboard.sort(key=lambda entry: (-entry["cv"]["top1"], -entry["cv"]["macro_top1"], -entry["cv"]["mrr"]))
    np.savez_compressed(args.output / "candidates.npz", candidate_scores=scores, sample_scores=sample_scores,
                        y=truth, model_ids=np.asarray(ids), group_ids=np.asarray([group["id"] for group in panel]),
                        environment=environments, sample_row_ids=np.asarray([rows[index]["row_id"] for index in panel_indices]))
    save(args.output / "folds.json", folds)
    save(args.output / "leaderboard.json", leaderboard)
    selected = [leaderboard[0], *[next(entry for entry in leaderboard if entry["spec"]["kind"] == kind)
                                for kind in ("lda", "ridge")]]
    artifacts = []
    for name, entry in zip(("winner", "lda", "ridge"), selected):
        spec, index = entry["spec"], entry["index"]
        training, preprocessing = geometry(parts, spec["weights"])
        fitted = fit_estimator(spec, training, labels, len(ids))
        coefficient, intercept = fitted.coef_, fitted.intercept_
        if not np.allclose(training @ coefficient.T + intercept, decision(fitted, training, spec), rtol=1e-12, atol=1e-12):
            raise ValueError("Plain-array linear head does not match fitted estimator")
        beta = fit_temperature(scores[index], truth)
        artifact = dict(schema="generic-rank-sequence-linear-v1", model_ids=ids, spec=spec, preprocessing=preprocessing,
                        coefficient=coefficient, intercept=intercept, beta=beta, reference_sha256=REFERENCE_SHA,
                        bank_sha256=BANK_SHA, source_hashes=sources, train_row_ids=[row["row_id"] for row in rows],
                        probability_scope=plan["calibration"])
        path = args.output / ("fitted.joblib" if name == "winner" else f"fitted-{name}.joblib")
        joblib.dump(artifact, path, compress=3)
        artifacts.append(dict(name=name, path=str(path.relative_to(ROOT)), sha256=sha(path), index=index,
                              spec=spec, cv=entry["cv"], beta=beta))
    winner = leaderboard[0]
    np.savez_compressed(args.output / "reference-oof.npz", scores=scores[winner["index"]], y=truth,
                        model_ids=np.asarray(ids), group_ids=np.asarray([group["id"] for group in panel]), environment=environments,
                        sample_scores=sample_scores[winner["index"]], sample_row_ids=np.asarray([rows[index]["row_id"] for index in panel_indices]))
    confidence = confidence_metrics(scores[winner["index"]], truth, artifacts[0]["beta"], ids)
    summary = dict(winner=winner, confidence=confidence, artifacts=artifacts, plan_sha256=sha(plan_path),
                   elapsed_seconds=time.time() - started, external_data_opened=False,
                   limitations=plan["calibration"] + "; candidate selection shares the reference folds and retains collection-channel confounding.")
    save(args.output / "summary.json", summary)
    lines = ["# Empirical-rank sequence refinement", "", "Thirty predeclared generic candidates used only the frozen 53-label reference library.",
             "Ordinal, run and recurrence nulls condition on each reply's own marginal counts. Midranks retain ties; Fourier coefficients retain phase.", "",
             "Selection uses all-library Top1, macro Top1 and MRR. Astra/Sol metrics are reported after selection.", "",
             "| Candidate | Top1 / 636 | Top3 / 636 | MRR | Pair / 24 |", "|---|---:|---:|---:|---:|"]
    for entry in leaderboard:
        value = entry["cv"]
        lines.append(f"| {entry['spec']['id']} | {value['correct']} | {round(value['top3'] * 636)} | {value['mrr']:.5f} | {value['pair']['all_library_correct']} |")
    lines.extend(("", summary["limitations"], "No fixed holdout, matched pair or new prospective data was read. No model API was called."))
    (args.output / "report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(dict(winner=winner, artifacts=artifacts, elapsed_seconds=summary["elapsed_seconds"]), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
