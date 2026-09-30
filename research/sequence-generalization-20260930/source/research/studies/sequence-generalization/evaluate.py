"""Evaluate frozen generic procedures without parameter or gallery updates.

Run after export-evaluation.ts. Fresh matched prompts are evaluation data only.
"""
from __future__ import annotations

import hashlib
import importlib
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.special import softmax
from scipy.stats import beta, binomtest

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "research/reports/sequence-generalization/20260930"
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
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                    allow_nan=False, default=convert) + "\n")


def lower95(hits, total):
    return float(beta.ppf(.05, hits, total - hits + 1)) if hits else 0.0


def cluster_interval(correct, groups):
    """Matched prompts, rather than both model answers, are bootstrap units."""
    clusters = defaultdict(list)
    for i, group in enumerate(groups):
        clusters[group["cluster"]].append(i)
    if len(clusters) < 3:
        return None
    values = np.array([np.mean(correct[indices]) for indices in clusters.values()])
    rng = np.random.default_rng(20260930)
    draws = values[rng.integers(0, len(values), (10000, len(values)))].mean(1)
    return dict(clusters=len(values), interval95=np.quantile(draws, [.025, .975]),
                method="matched-prompt cluster bootstrap; exploratory with small cluster count")


def metrics(scores, probabilities, groups, ids):
    truth = np.array([ids.index(group["model"]) for group in groups])
    order = np.argsort(-scores, axis=1, kind="stable")
    predicted = order[:, 0]
    correct = predicted == truth
    top_probability = probabilities[np.arange(len(groups)), predicted]
    per_model = {}
    for label in sorted({group["model"] for group in groups}):
        mask = truth == ids.index(label)
        hits, total = int(correct[mask].sum()), int(mask.sum())
        per_model[label] = dict(correct=hits, total=total, accuracy=hits / total,
                                one_sided_lower95=lower95(hits, total))
    selected = {}
    for threshold in (.8, .9, .95, .99):
        accepted = top_probability >= threshold
        hits, total = int(correct[accepted].sum()), int(accepted.sum())
        selected[str(threshold)] = dict(accepted=total, correct=hits, errors=total - hits,
                                        coverage=total / len(groups),
                                        one_sided_precision_lower95=lower95(hits, total) if total else None)
    confidence_bins = []
    for i in range(10):
        mask = (top_probability >= i / 10) & (top_probability < (i + 1) / 10 if i < 9 else top_probability <= 1)
        if mask.any():
            confidence_bins.append(dict(n=int(mask.sum()), confidence=float(top_probability[mask].mean()),
                                        accuracy=float(correct[mask].mean())))
    pair_indices = [ids.index(label) for label in PAIR]
    binary = np.asarray(pair_indices)[scores[:, pair_indices].argmax(1)]
    pair_mask = np.isin(truth, pair_indices)
    return dict(total=len(groups), correct=int(correct.sum()), accuracy=float(correct.mean()),
                top3=float(np.mean(np.any(order[:, :3] == truth[:, None], axis=1))),
                macro_accuracy=float(np.mean([row["accuracy"] for row in per_model.values()])),
                multiclass_nll=float(-np.log(np.clip(probabilities[np.arange(len(groups)), truth], 1e-15, 1)).mean()),
                multiclass_brier=float(np.mean(np.sum((probabilities - np.eye(len(ids))[truth]) ** 2, axis=1))),
                ece=float(sum(row["n"] * abs(row["confidence"] - row["accuracy"]) for row in confidence_bins) / len(groups)),
                selected=selected, per_model=per_model,
                pair_binary_accuracy=float(np.mean(binary[pair_mask] == truth[pair_mask])) if pair_mask.any() else None,
                cluster_uncertainty=cluster_interval(correct, groups),
                predictions=[dict(id=group["id"], model=group["model"], prediction=ids[predicted[i]],
                                  truth_rank=int(np.where(order[i] == truth[i])[0][0]) + 1,
                                  top_probability=float(top_probability[i]), truth_probability=float(probabilities[i, truth[i]]),
                                  scores=scores[i], probabilities=probabilities[i]) for i, group in enumerate(groups)])


def disjoint_accumulation(scores, groups, ids):
    by_model = defaultdict(list)
    for i, group in enumerate(groups):
        by_model[group["model"]].append(i)
    results = []
    for rounds in (1, 2, 3, 5):
        correct = total = 0
        per_model = {}
        for model, indices in sorted(by_model.items()):
            # Preserve manifest order; every round belongs to only one group.
            hits = count = 0
            for start in range(0, len(indices) - rounds + 1, rounds):
                chosen = indices[start:start + rounds]
                prediction = ids[int(scores[chosen].mean(0).argmax())]
                hits += prediction == model
                count += 1
            correct += hits; total += count
            per_model[model] = dict(correct=hits, total=count)
        results.append(dict(answers=rounds * 3, correct=correct, total=total,
                            accuracy=correct / total if total else None, per_model=per_model,
                            confidence="not recalibrated for accumulated rounds; accuracy only"))
    return results


def main():
    data_path = OUT / "evaluation-data.json"
    data = json.loads(data_path.read_text())
    freeze = json.loads((OUT / "candidate-freeze.json").read_text())
    if data["candidate_freeze_sha256"] != sha(OUT / "candidate-freeze.json"):
        raise ValueError("Evaluation data uses a different candidate freeze")
    for path, expected in freeze["source_hashes"].items():
        if sha(ROOT / path) != expected:
            raise ValueError(f"Frozen procedure changed: {path}")
    ids = data["model_ids"]
    candidates = []
    for candidate in freeze["candidates"]:
        path = ROOT / candidate["artifact"]
        if sha(path) != candidate["artifact_sha256"]:
            raise ValueError(f"Candidate changed after freeze: {candidate['id']}")
        module = importlib.import_module(candidate["module"])
        artifact = module.load_artifact(path)
        if artifact["model_ids"] != ids or artifact["reference_sha256"] != freeze["reference_sha256"]:
            raise ValueError("Candidate gallery or reference hash mismatch")
        candidates.append((candidate["id"], module, artifact))
    results = {"candidate_freeze_sha256": sha(OUT / "candidate-freeze.json"),
               "evaluation_data_sha256": sha(data_path), "datasets": {}}
    for name, dataset in data["datasets"].items():
        groups = dataset["groups"]
        raw_groups = [group["numbers"] for group in groups]
        methods = [("current_product", np.array([group["baseline_scores"] for group in groups]),
                    np.array([group["baseline_probabilities"] for group in groups]))]
        for method_id, module, artifact in candidates:
            scores = module.score_groups(artifact, raw_groups)
            probabilities = softmax(scores * artifact["beta"], axis=1)
            methods.append((method_id, scores, probabilities))
        result = dict(planned_groups=dataset["planned_groups"], complete_groups=len(groups), methods={})
        baseline_correct = methods[0][1].argmax(1) == np.array([ids.index(group["model"]) for group in groups])
        for method_id, scores, probabilities in methods:
            if not np.isfinite(scores).all() or not np.isfinite(probabilities).all() or not np.allclose(probabilities.sum(1), 1):
                raise ValueError(f"Invalid score/probability: {method_id}")
            summary = metrics(scores, probabilities, groups, ids)
            correct = scores.argmax(1) == np.array([ids.index(group["model"]) for group in groups])
            gained = int(np.sum(correct & ~baseline_correct))
            lost = int(np.sum(~correct & baseline_correct))
            summary["paired_baseline_change"] = dict(gained=gained, lost=lost, net=gained - lost,
                                                       exact_mcnemar_p=binomtest(gained, gained + lost).pvalue if gained + lost else 1.0)
            if name != "holdout":
                summary["disjoint_accumulation"] = disjoint_accumulation(scores, groups, ids)
            result["methods"][method_id] = summary
            print(name, method_id, summary["correct"], "/", len(groups), "p>=.95", summary["selected"]["0.95"], flush=True)
        results["datasets"][name] = result
    save(OUT / "evaluation-results.json", results)


if __name__ == "__main__":
    main()
