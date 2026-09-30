from pathlib import Path
import hashlib
import json
import subprocess

from bank_builder import build_bank, read_rows

PROJECT = Path(__file__).resolve().parent.parent
DATA_FILE = PROJECT / "projects" / "data" / "unified_reference.jsonl"
BANK_FILE = PROJECT / "projects" / "data" / "unified_bank.json"


def rebuild_bank(data_file: Path = DATA_FILE) -> dict:
    bank = build_bank(read_rows(data_file))
    bank["reference_sha256"] = hashlib.sha256(data_file.read_bytes()).hexdigest()
    content = json.dumps(bank, ensure_ascii=False, indent=2) + "\n"
    temporary = BANK_FILE.with_suffix(".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(BANK_FILE)
    subprocess.run(
        ["bun", "run", "sync-data"],
        cwd=PROJECT / "projects",
        check=True,
    )
    subprocess.run(["bun", "research/scripts/evaluate-holdout.ts"], cwd=PROJECT, check=True)
    return bank


if __name__ == "__main__":
    bank = rebuild_bank()
    print(json.dumps({"models": len(bank["models"]), "responses": bank["robust"]["training_rows"], "sources": bank["sources"], "calibration": bank["calibration"]}, ensure_ascii=False, indent=2))
