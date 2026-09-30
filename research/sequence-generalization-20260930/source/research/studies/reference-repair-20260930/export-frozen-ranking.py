# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.5.3", "scipy==1.17.1", "scikit-learn==1.9.1", "joblib>=1.5,<2", "threadpoolctl>=3"]
# ///
"""Export the frozen CV-selected ranker as JSON without new data or selection."""
from __future__ import annotations

import os
for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[name] = "1"

import argparse
import gzip
import hashlib
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "research/studies/sequence-generalization"), str(ROOT / "projects/offline")]
from fusion import load_artifact
from rerank import fit_local


def convert(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    raise TypeError(type(value).__name__)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "research/reports/reference-repair-20260930/frozen-export")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    source_path = ROOT / "research/reports/sequence-generalization/20260930/fusion/fitted.joblib"
    artifact = load_artifact(source_path)
    local = artifact["_loaded"]["rerank"]
    position = artifact["_loaded"]["positional"]
    if artifact["spec"]["weights"] != [.5, .5, 0.] or local["config"]["layout"] != "frequency":
        raise ValueError("Expected the frozen general fusion and frequency local head")
    pairs = []
    with threadpool_limits(limits=1):
        for pair in itertools.combinations(range(len(artifact["model_ids"])), 2):
            fitted = fit_local(local["blocks"], local["labels"], pair, local["config"]["layout"], local["config"]["shrinkage"])
            pairs.append({key: fitted[key] for key in ("pair", "params", "coefficient", "intercept")})
    payload = dict(schema="generic-ranking-extension-v1", model_ids=artifact["model_ids"],
                   reference_sha256=artifact["reference_sha256"],
                   source_artifact_sha256=hashlib.sha256(source_path.read_bytes()).hexdigest(),
                   source_components=artifact["components"],
                   weights=dict(rerank=.5, positional=.5),
                   probability=dict(beta=artifact["beta"], scope="reference-development closed-set; requires new production calibration"),
                   rerank=dict(config=local["config"], block_weights=dict(frequency=.75, ordered=.25), pairs=pairs),
                   positional={key: position[key] for key in ("weights", "params", "coefficient", "intercept")})
    content = (json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False, default=convert) + "\n").encode()
    path = args.output / "ranking-extension.json"
    path.write_bytes(content)
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    path.with_suffix(".json.gz").write_bytes(compressed)
    summary = dict(model_ids=artifact["model_ids"], reference_sha256=artifact["reference_sha256"],
                   pairs=len(pairs), pair_features=len(pairs[0]["coefficient"]),
                   positional_features=position["coefficient"].shape[1], json_bytes=len(content), gzip_bytes=len(compressed),
                   sha256=hashlib.sha256(content).hexdigest(), elapsed_seconds=time.monotonic() - started,
                   scope="Compile all lazy local heads from the frozen reference artifact using its already selected parameters. No new reference, holdout, prospective data or parameter selection.")
    (args.output / "export-summary.json").write_text(json.dumps(summary, indent=2, default=convert) + "\n")
    print(json.dumps(summary, default=convert), flush=True)


if __name__ == "__main__":
    main()
