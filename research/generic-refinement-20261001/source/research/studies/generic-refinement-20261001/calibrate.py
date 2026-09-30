"""Fit one source-balanced development temperature before external evaluation."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[variable] = "1"

import argparse
import hashlib
import json

import joblib
import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import logsumexp


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--oof", type=Path, required=True)
    parser.add_argument("--groups", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    plan = dict(schema="source-balanced-temperature-plan-v1", objective="Single scalar, label/source-balanced softmax NLL",
                beta_bounds=[.001, 1000.], source_hashes={str(path): sha(path) for path in
                (Path(__file__), Path(__file__).with_name("CALIBRATION_PROTOCOL.md"), args.oof, args.groups, args.artifact)},
                evaluation_inputs_opened=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_name("calibration-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    data = np.load(args.oof)
    ids, group_ids, scores, truth = list(data["model_ids"]), list(data["group_ids"]), data["scores"], data["y"]
    artifact = joblib.load(args.artifact)
    if (artifact["model_ids"] != ids or artifact["reference_sha256"] !=
            "5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4"):
        raise ValueError("Development gallery/reference differs from the selected artifact")
    groups = json.loads(args.groups.read_text())
    if isinstance(groups, dict):
        groups = groups["groups"]
    by_id = {group["id"]: group for group in groups}
    if (scores.shape != (716, 53) or len(ids) != 53 or len(group_ids) != 716 or len(set(group_ids)) != 716
            or len(by_id) != 716 or set(group_ids) != set(by_id) or truth.shape != (716,)
            or not np.issubdtype(truth.dtype, np.integer) or np.any((truth < 0) | (truth >= 53))):
        raise ValueError("Temperature requires the complete 53-label, 716-group development panel")
    if not np.isfinite(scores).all():
        raise ValueError("Non-finite development scores")
    domains = []
    for index, group_id in enumerate(group_ids):
        group = by_id[group_id]
        if ids[truth[index]] != group["model"]:
            raise ValueError("Development group truth mismatch")
        domain = group.get("domain", group.get("source"))
        if not isinstance(domain, str) or not domain:
            raise ValueError("Each group requires its actual collection source")
        domains.append(domain)
    domains = np.asarray(domains)
    weights = np.zeros(len(truth))
    cells = []
    for label, model in enumerate(ids):
        source_names = sorted(set(domains[truth == label]))
        if not source_names:
            raise ValueError("Development panel omits a gallery label")
        for domain in source_names:
            mask = (truth == label) & (domains == domain)
            weights[mask] = 1. / (len(ids) * len(source_names) * mask.sum())
            cells.append(dict(model=model, domain=domain, groups=int(mask.sum()), total_weight=float(weights[mask].sum())))
    if not np.isclose(weights.sum(), 1):
        raise ValueError("Calibration weights must sum to one")
    def objective(log_beta):
        logits = scores * np.exp(log_beta)
        return float(weights @ (logsumexp(logits, axis=1) - logits[np.arange(len(truth)), truth]))
    fitted = minimize_scalar(objective, bounds=(np.log(.001), np.log(1000.)), method="bounded")
    if not fitted.success or not np.isfinite(fitted.fun):
        raise ValueError("Temperature optimization did not converge")
    result = dict(schema="source-balanced-temperature-v1", beta=float(np.exp(fitted.x)), weighted_nll=float(fitted.fun),
                  calibration_scope="Selected OOF development; 53-label closed set, not verified model identity.",
                  artifact_sha256=sha(args.artifact), oof_sha256=sha(args.oof), groups_sha256=sha(args.groups),
                  calibrator_sha256=sha(Path(__file__)), protocol_sha256=sha(Path(__file__).with_name("CALIBRATION_PROTOCOL.md")),
                  cells=cells, evaluation_inputs_opened=False)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(json.dumps(dict(beta=result["beta"], weighted_nll=result["weighted_nll"], cells=len(cells))))


if __name__ == "__main__":
    main()
