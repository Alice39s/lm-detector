"""Generic local-covariance reranking; reference-only selection across all labels.

Usage: uv run --no-project --with numpy --with scipy --with scikit-learn \
  --with joblib --with threadpoolctl python research/studies/sequence-generalization/rerank.py

The fixed holdout and external paired answers are never read by this program.
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import joblib
import numpy as np
from scipy.linalg import solve
from scipy.optimize import minimize_scalar
from scipy.special import logsumexp
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "projects/offline"))
from bank_builder import read_rows  # noqa: E402
from ensemble_confidence_core import Ensemble  # noqa: E402
from fingerprint import count_numbers, hellinger_feature, ordered_block_feature  # noqa: E402
from shared_verifier_core import reference_panel  # noqa: E402

OUT = ROOT / "research/reports/sequence-generalization/20260930/rerank"
REFERENCE = ROOT / "projects/data/unified_reference.jsonl"


def save(path, value):
    def default(x):
        if isinstance(x, np.ndarray):
            return x.tolist()
        if isinstance(x, np.generic):
            return x.item()
        raise TypeError(type(x).__name__)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=default,
                               allow_nan=False) + "\n")


def dense_order(numbers):
    """44 dense sequence statistics, independent of model or collection labels."""
    x = np.asarray(numbers, float)
    result = []
    for lag in (1, 2, 3, 4, 5, 8, 12, 20, 30):
        d = np.abs(x[lag:] - x[:-lag])
        result.extend([np.mean(d <= 5), np.mean(d <= 20), d.mean() / 100])
    centred = x - x.mean()
    denominator = max(centred @ centred, 1e-12)
    result.extend([centred[lag:] @ centred[:-lag] / denominator for lag in (1, 2, 3, 5, 10)])
    high = (x > 178).astype(int)
    runs = np.diff(np.flatnonzero(np.r_[1, high[1:] != high[:-1], 1]))
    signs = np.sign(np.diff(x))
    direction_runs = np.diff(np.flatnonzero(np.r_[1, signs[1:] != signs[:-1], 1]))
    result.extend([np.mean(high[1:] != high[:-1]), runs.mean(), np.mean(runs >= 3),
                   direction_runs.mean(), np.mean(direction_runs >= 3)])
    buckets = np.minimum(15, (np.asarray(numbers) - 1) * 16 // 355)
    result.extend([np.mean([len(set(buckets[i:i + width])) / width
                            for i in range(len(x) - width + 1)]) for width in (4, 8, 16)])
    result.extend([np.mean(x[1:] % 10 == x[:-1] % 10),
                   np.mean((x[1:] // 10) % 10 == (x[:-1] // 10) % 10)])
    quarters = np.array_split(x, 4)
    result.extend([(quarters[3].mean() - quarters[0].mean()) / 100,
                   (quarters[3].std() - quarters[0].std()) / 100])
    return np.asarray(result)


def feature_blocks(numbers):
    return {"frequency": np.stack([hellinger_feature(count_numbers(n)) for n in numbers]),
            "ordered": np.stack([ordered_block_feature(n) for n in numbers]),
            "dense": np.stack([dense_order(n) for n in numbers]),
            "position4": np.stack([position_histogram(n) for n in numbers])}


def position_histogram(numbers):
    x = np.asarray(numbers, int)
    position = np.minimum(3, np.arange(len(x)) * 4 // len(x))
    value = np.minimum(15, (x - 1) * 16 // 355)
    counts = np.bincount(position * 16 + value, minlength=64)
    return np.sqrt((counts + .5) / (len(x) + 32))


LAYOUTS = {"frequency": {"frequency": .75, "ordered": .25},
           "frequency_order": {"frequency": .60, "ordered": .20, "dense": .20},
           "position4": {"position4": 1.0}}


def transform(blocks, params, layout):
    output = []
    for name, weight in LAYOUTS[layout].items():
        z = (blocks[name] - params[name]["mean"]) / params[name]["scale"]
        z /= np.maximum(np.linalg.norm(z, axis=1, keepdims=True), 1e-12)
        output.append(z * np.sqrt(weight))
    return np.concatenate(output, axis=1)


def fit_local(blocks, labels, pair, layout, shrink):
    """Two-label scaler and pooled covariance fitted only on training answers."""
    mask = np.isin(labels, pair)
    train = {name: value[mask] for name, value in blocks.items()}
    y = labels[mask]
    params = {}
    for name in LAYOUTS[layout]:
        x = train[name]
        scale = x.std(0)
        scale[scale < 1e-10] = 1
        params[name] = {"mean": x.mean(0), "scale": scale}
    z = transform(train, params, layout)
    mu = np.stack([z[y == k].mean(0) for k in pair])
    residual = z - mu[(y == pair[1]).astype(int)]
    difference = mu[1] - mu[0]
    target = max(np.sum(residual * residual) / (len(residual) * z.shape[1]), 1e-12)
    ridge = shrink * target
    coefficient = (1 - shrink) / len(residual)
    # Woodbury solves a <= 100-response matrix rather than a 473-feature matrix.
    matrix = np.eye(len(residual)) + (coefficient / ridge) * residual @ residual.T
    correction = solve(matrix, residual @ difference, assume_a="pos", check_finite=False)
    w = difference / ridge - coefficient / ridge ** 2 * (residual.T @ correction)
    return {"pair": pair, "layout": layout, "params": params, "coefficient": w,
            "intercept": -.5 * (mu[0] + mu[1]) @ w, "training_answers": len(y)}


def local_score(model, blocks):
    z = transform(blocks, model["params"], model["layout"])
    return z @ model["coefficient"] + model["intercept"]


def rerank_scores(base, pair, margin, gate):
    result = base.copy()
    first, second = np.argsort(-base, kind="stable")[:2]
    if base[first] - base[second] <= gate and margin * (1 if second == pair[1] else -1) > 0:
        # Swapping the first two scores changes ranking without fabricating a
        # stronger numerical confidence from a small local training subset.
        result[first], result[second] = base[second], base[first]
    return result


def metrics(scores, truth):
    ranking = np.argsort(-scores, axis=1, kind="stable")
    correct = ranking[:, 0] == truth
    return {"groups": len(truth), "hits": int(correct.sum()), "top1": float(correct.mean()),
            "macro_top1": float(np.mean([correct[truth == k].mean() for k in np.unique(truth)])),
            "top3": float(np.mean(np.any(ranking[:, :3] == truth[:, None], axis=1)))}


def config_grid():
    return [{"id": f"{layout}_shrink{shrink:g}_gate{gate:g}", "layout": layout,
             "shrinkage": shrink, "gate": gate}
            for layout in LAYOUTS for shrink in (.1, .3, .7) for gate in (.25, .5, 1., 10.)]


def temperature(scores, truth):
    def loss(log_tau):
        scaled = scores / np.exp(log_tau)
        return np.mean(logsumexp(scaled, axis=1) - scaled[np.arange(len(truth)), truth])
    fitted = minimize_scalar(loss, bounds=(-4, 5), method="bounded")
    return {"tau": float(np.exp(fitted.x)), "nll": float(fitted.fun),
            "scope": "Reference OOF development calibration; conditional on registered labels"}


def fit_artifact(rows, ids, config):
    return {"ids": ids, "config": config, "base": Ensemble(rows, ids),
            "blocks": feature_blocks([r["numbers"] for r in rows]),
            "labels": np.asarray([ids.index(r["source"]) for r in rows]), "models": {}}


def score_artifact(artifact, groups):
    """Score a frozen dictionary artifact loaded by joblib; update head cache only."""
    output = []
    for numbers, (base, absolute) in zip(groups, artifact["base"].score_groups(groups)):
        pair = tuple(sorted(np.argsort(-base, kind="stable")[:2].tolist()))
        if pair not in artifact["models"]:
            artifact["models"][pair] = fit_local(artifact["blocks"], artifact["labels"], pair,
                artifact["config"]["layout"], artifact["config"]["shrinkage"])
        margin = float(local_score(artifact["models"][pair], feature_blocks(numbers)).mean())
        score = rerank_scores(base, pair, margin, artifact["config"]["gate"])
        output.append((score, absolute))
    return output


def load_artifact(path):
    path = Path(path)
    artifact = joblib.load(path)
    frozen = json.loads((path.parent / "freeze.json").read_text())
    artifact["model_ids"] = artifact["ids"]
    artifact["beta"] = 1 / frozen["calibration"]["tau"]
    artifact["reference_sha256"] = frozen["hashes"]["projects/data/unified_reference.jsonl"]
    return artifact


def score_groups(artifact, groups):
    return np.asarray([scores for scores, _ in score_artifact(artifact, groups)])


def main():
    started = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = read_rows(REFERENCE)
    ids = [r["id"] for r in json.loads((ROOT / "projects/data/unified_bank.json").read_text())["models"]]
    panel = reference_panel(rows, ids)
    by_id = {row["row_id"]: i for i, row in enumerate(rows)}
    groups = [[by_id[row_id] for row_id in entry["row_ids"]] for entry in panel]
    truth = np.asarray([ids.index(entry["model"]) for entry in panel])
    labels = np.asarray([ids.index(row["source"]) for row in rows])
    blocks = feature_blocks([row["numbers"] for row in rows])
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (REFERENCE, ROOT / "projects/data/unified_bank.json", Path(__file__))}
    configs = config_grid()
    base_all = np.zeros((len(groups), len(ids)))
    predictions = {c["id"]: base_all.copy() for c in configs}
    group_details, folds = [], []
    sequence_hash = lambda r: hashlib.sha256(json.dumps(r["numbers"], separators=(",", ":")).encode()).hexdigest()
    sequence_keys = [sequence_hash(r) for r in rows]
    for environment in range(1, 13):
        group_indices = [i for i, entry in enumerate(panel) if entry["environment"] == environment]
        held_indices = {j for i in group_indices for j in groups[i]}
        challenges = {rows[i]["challenge_id"] for i in held_indices}
        texts = {rows[i]["text"].strip() for i in held_indices}
        sequences = {sequence_keys[i] for i in held_indices}
        prefix = f"environment-{environment:02d}"
        train_indices = [i for i, row in enumerate(rows) if row["challenge_id"] not in challenges
                         and not row["condition_id"].startswith(prefix) and row["text"].strip() not in texts
                         and sequence_keys[i] not in sequences]
        train_rows = [rows[i] for i in train_indices]
        train_blocks = {name: value[train_indices] for name, value in blocks.items()}
        train_labels = labels[train_indices]
        baseline = Ensemble(train_rows, ids)
        held_groups = [[rows[j]["numbers"] for j in groups[i]] for i in group_indices]
        base = np.stack([s[0] for s in baseline.score_groups(held_groups)])
        models = {}
        for k, i in enumerate(group_indices):
            base_all[i] = base[k]
            pair = tuple(sorted(np.argsort(-base[k], kind="stable")[:2].tolist()))
            held_blocks = {name: value[groups[i]] for name, value in blocks.items()}
            margins = {}
            for layout in LAYOUTS:
                for shrink in (.1, .3, .7):
                    key = (pair, layout, shrink)
                    if key not in models:
                        models[key] = fit_local(train_blocks, train_labels, pair, layout, shrink)
                    margin = float(local_score(models[key], held_blocks).mean())
                    margins[f"{layout}:{shrink:g}"] = margin
                    for config in configs:
                        if config["layout"] == layout and config["shrinkage"] == shrink:
                            predictions[config["id"]][i] = rerank_scores(base[k], pair, margin, config["gate"])
            group_details.append({**panel[i], "truth": ids[truth[i]], "top_two": [ids[k] for k in pair],
                                  "base_scores": base[k].tolist(), "local_margins": margins})
        folds.append({"environment": environment, "training_rows": len(train_rows),
                      "held_groups": len(group_indices), "training_row_ids": [r["row_id"] for r in train_rows],
                      "excluded_challenges": sorted(challenges), "local_models": len(models)})
        print(f"RERANK environment {environment}/12; {time.time() - started:.1f}s", flush=True)
    results = [{**config, **metrics(predictions[config["id"]], truth)} for config in configs]
    # Selection never inspects specific labels, external answers, or API metadata.
    selected = max(results, key=lambda r: (r["hits"], r["macro_top1"], -r["gate"], r["shrinkage"], r["layout"] == "frequency"))
    selected_scores = predictions[selected["id"]]
    baseline_metrics = metrics(base_all, truth)
    selected_metrics = metrics(selected_scores, truth)
    config = {k: selected[k] for k in ("id", "layout", "shrinkage", "gate")}
    frozen = fit_artifact(rows, ids, config)
    artifact = OUT / "frozen.joblib"
    joblib.dump(frozen, artifact)
    tau = temperature(selected_scores, truth)
    record = {"hashes": hashes, "ids": ids, "baseline": baseline_metrics, "selected": selected,
              "candidates": results, "selection_scope": "All-label 636-group development OOF Top-1; no pair-specific selection",
              "calibration": tau, "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
              "external_scores_opened": False, "elapsed_seconds": time.time() - started,
              "limitations": "OOF results were used for selection; local reranking only swaps top-two baseline score magnitudes."}
    save(OUT / "selection.json", record)
    save(OUT / "oof.json", {"ids": ids, "panel": panel, "truth": truth,
                           "baseline_scores": base_all, "selected_scores": selected_scores,
                           "selected_config": config, "calibration": tau})
    save(OUT / "folds.json", folds)
    save(OUT / "group-details.json", group_details)
    np.savez_compressed(OUT / "candidates.npz", ids=ids, group_ids=[p["id"] for p in panel],
                        truth=truth, baseline=base_all, names=[c["id"] for c in configs],
                        scores=np.stack([predictions[c["id"]] for c in configs]))
    save(OUT / "freeze.json", {"hashes": hashes, "config": config, "calibration": tau,
                              "artifact_sha256": record["artifact_sha256"], "external_scores_opened": False})
    table = "\n".join(f"| {r['id']} | {r['hits']}/636 | {r['top1']:.3f} |" for r in results)
    (OUT / "report.md").write_text(f"# 全库候选前两名的局部判别重排\n\n"
        f"基线 Ensemble：{baseline_metrics['hits']}/636；选择后：{selected_metrics['hits']}/636。"
        f"选择候选：`{selected['id']}`。参数选择只使用全部模型的留环境开发预测。\n\n"
        "每组先由全库排名器选择前两名。两标签的训练回答单独拟合缩放和收缩协方差，"
        "再合并三条回答的线性判别方向。序列版添加 44 个致密顺序统计；位置版使用四段 × 16 值桶的联合分布。"
        "局部判别只可交换前两名的排名分数，因此不会凭局部训练人为提高分数幅度。\n\n"
        "12 个外折排除同挑战、环境前缀变体、精确原文和数字序列。预处理只用外折训练。"
        "当前 OOF 用于筛选，结果属于开发估计。外部配对集和冻结 holdout 尚未打开。\n\n"
        f"| 方法 | 三回答命中 | Top-1 |\n|---|---:|---:|\n{table}\n")
    print(json.dumps(record, default=lambda x: x.item() if isinstance(x, np.generic) else x, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        main()
