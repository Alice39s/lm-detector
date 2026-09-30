"""Read provenance and fixed-suite coverage without collecting or scoring answers."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "research/reports/reference-repair-20260930"
CACHE = {}


def content(path):
    path = Path(path)
    if path not in CACHE:
        CACHE[path] = path.read_bytes()
    return CACHE[path]


def read(path):
    return json.loads(content(path))


def lines(path):
    return [json.loads(line) for line in content(path).decode().splitlines() if line.strip()]


def sha(path):
    return hashlib.sha256(content(path)).hexdigest()


def label(value):
    return re.sub(r"-(\d)-(\d)(?:-\d{8})?$", r"-\1.\2", value) if value.startswith("claude-") else value


def main():
    bank_path = ROOT / "projects/data/unified_bank.json"
    reference_path = ROOT / "projects/data/unified_reference.jsonl"
    manifest_path = ROOT / "research/evaluation/holdout/manifest.json"
    original_path = OUT / "baseline/holdout-manifest.json"
    sample_path = ROOT / "research/evaluation/holdout/samples.jsonl"
    catalogue_path = OUT / "catalogue/models.json"
    bank, reference, manifest, original = read(bank_path), lines(reference_path), read(manifest_path), read(original_path)
    catalogue = {entry["id"]: entry for entry in read(catalogue_path)["data"]}
    preparation = {entry["label"]: entry for entry in read(OUT / "target-preparation.json")["evidence"]}
    by_label = {label(target["label"]): target for target in manifest["models"]}
    original_targets = {label(target["label"]): target for target in original["models"]}
    attempts = {}
    for row in lines(sample_path):
        attempts.setdefault(row["sample_id"], []).append(row)
    result = []
    for model in bank["models"]:
        mid = model["id"]
        batches = [batch for batch in reference if batch["model"]["id"] == mid]
        target = by_label.get(mid)
        coverage = []
        if target:
            for group in manifest["groups"]:
                for challenge in group["challenges"]:
                    sid = f"{manifest['id']}:{target['label']}:{group['id']}:{challenge['id']}"
                    floor = manifest.get("resample_from_attempt", {}).get(sid, 1)
                    current = sorted([row for row in attempts.get(sid, []) if row["attempt"] >= floor], key=lambda row: row["attempt"])
                    selected = next((row for row in current if row["status"] == "accepted"), None)
                    coverage.append(dict(sample_id=sid, from_attempt=floor, attempts=len(current),
                        selected_attempt=selected["attempt"] if selected else None,
                        response_model=selected.get("response_model") if selected else None,
                        provider_reported=selected.get("provider_reported") if selected else None,
                        request_reasoning=selected.get("request", {}).get("reasoning") if selected else None,
                        status="accepted" if selected else "attempted" if current else "missing"))
        evidence = []
        for batch in batches:
            evidence.append(dict(batch_id=batch["id"], samples=len(batch["samples"]), source=batch["source"], request=batch["request"],
                actual_channels=dict(Counter(str(sample.get("actual_channel")) for sample in batch["samples"])),
                response_models=dict(Counter(str(sample.get("response_model")) for sample in batch["samples"])),
                reported_providers=dict(Counter(str(sample.get("provider_reported")) for sample in batch["samples"])),
                effort_overrides=dict(Counter(str(sample.get("reasoning_effort", batch["request"].get("reasoning_effort"))) for sample in batch["samples"]))))
        result.append(dict(model=mid, family=model["family"], original_target=original_targets.get(mid), target=target,
            current_catalogue=catalogue.get(target["api_model"]) if target else None,
            reference_batches=evidence, preparation=preparation.get(mid), coverage=coverage,
            accepted=int(sum(row["status"] == "accepted" for row in coverage))))
    missing_original = [entry["model"] for entry in result if not entry["original_target"]]
    missing_now = [entry["model"] for entry in result if not entry["target"]]
    latest_run = manifest.get("collection_runs", [{}])[-1]
    reported_blocked = latest_run.get("blocked_missing_catalog", [])
    false_blocked = [entry["label"] for entry in reported_blocked
        if by_label.get(entry["label"], {}).get("api_model") in catalogue]
    summary = dict(captured_at=datetime.now(timezone.utc).isoformat(), reference_models=len(result),
        original_manifest_models=len(original["models"]), current_manifest_models=len(manifest["models"]),
        missing_original=missing_original, missing_current=missing_now,
        planned_reference_suite_answers=len(result) * 6,
        accepted_snapshot=sum(entry["accepted"] for entry in result),
        fixed_groups_unchanged=manifest["groups"] == original["groups"],
        original_source_hashes_unchanged=manifest["source_hashes"] == original["source_hashes"],
        original_resample_source_hashes_unchanged=manifest.get("resample_source_hashes") == original.get("resample_source_hashes"),
        latest_run_diagnostic=dict(run_id=latest_run.get("id"), reported_blocked=reported_blocked,
                                  false_blocked_with_exact_manifest_mapping=false_blocked),
        hashes={str(path.relative_to(ROOT)): sha(path) for path in (bank_path, reference_path, manifest_path, original_path, sample_path, catalogue_path)},
        models=result)
    (OUT / "holdout-inventory.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    text = ["# 固定验证集补全与来源审计", "",
        f"参考库共有 {len(result)} 个标签。原 manifest 有 {len(original['models'])} 个目标，缺少 {len(missing_original)} 个。"
        f"补全准备后 manifest 有 {len(manifest['models'])} 个目标，仍缺少 {len(missing_now)} 个。", "",
        "此审计不调用模型 API，不评分回答，也不修改 manifest、参考库或回答。回答覆盖数仅是审计时快照；采集仍可能继续。", "",
        "| 新增/缺失标签 | 实际 API 型号 | 格式 | 固定供应商路由 | 推理配置 |", "|---|---|---|---|---|"]
    for entry in result:
        if entry["original_target"]:
            continue
        target = entry["target"]
        if target:
            route = ",".join(target.get("provider_override", {}).get("only", [])) or "未固定"
            effort = json.dumps(target.get("reasoning_override", "默认"), ensure_ascii=False)
            text.append(f"| {entry['model']} | {target['api_model']} | {target['format']} | {route} | {effort} |")
        else:
            requests = sorted({str(batch["request"].get("model")) for batch in entry["reference_batches"]})
            text.append(f"| {entry['model']} | {'、'.join(requests)} | 原渠道 | OpenRouter 不可用 | 不替换身份 |")
    text += ["", "`kimi-k2.8-preview` 的原请求型号是 `kimi-for-coding`，来自 `kimi-code-subscription`。"
        "当前 OpenRouter 目录没有该身份，`moonshotai/kimi-k2.7-code` 不能作为替代。", "",
        "`step-5-preview` 来自 `stepfun-api` 的 `step_plan/v1/chat/completions`。"
        "当前目录仅有其他 Step 型号，不能替换为 `stepfun/step-3.7-flash`。", "",
        "Muses 的历史参考供应商未记录。新目标固定 `meta` 的依据是当前三个 endpoint 快照均仅含 Meta 官方供应商。"
        "此证据不能追溯证明旧参考供应商。历史参考混合 default/low，新增验证使用最新参考批次的 low，选择理由已保存在 target-preparation.json。", "",
        "`gpt-6-sol` 参考来自 OpenAI 直连。新增固定验证通过 OpenRouter/OpenAI，所以必须记录渠道变化。"
        "其他新目标保持参考原格式；Claude Opus/Sonnet 5.5 和 GPT 6.1 Sol 使用 Chat Completions，不按家族强制改为 Messages/Responses。", "",
        "Collector 复用现有 target 配置，保持原两组三题及所有旧尝试。它接受目录中精确 `api_model` 或 `canonical_slug`。"
        "返回的 `response_model` 保留原值。供应商名核对路由的供应商段，`xiaomi/fp8` 与 `z-ai/fp8` 的精度路由仍保存在原请求。", "",
        "旧 suite 的存储提示词保持不变。新采集追加 `collection_runs` 和 `profile_history`，每条尝试记录实际 source hashes。"
        "历史 `source_hashes`、`resample_source_hashes` 和 profile 不覆写。哈希变化表示新的请求/解析实现，不能把新增数据当作旧 profile 的同批数据。", "",
        "每条新 HTTP 尝试保存原请求 JSON、安全响应元数据和原始响应字节。`raw_response` 保存相对路径、SHA-256 与字节数。"
        "未保存认证请求头。网络失败没有响应字节时不伪造 raw response。", "",
        "首轮 run 的 `blocked_missing_catalog` 附加诊断只检查参考原始请求名，未优先识别已有 manifest 的 OpenRouter 型号映射。"
        f"它因此误报了 {len(false_blocked)} 个仍有精确目录映射的历史标签。该诊断不参与目标过滤或模型请求。"
        "真正缺失的两个身份以本审计和 target-preparation.json 为准；不在运行中改写冻结 collector。", "",
        "保留首次合格尝试；有效性只依据来源核对和合法数字数量，不根据识别结果重采。"
        "每个题位最多尝试数限制按单次命令执行计算，续采会继续增加编号；所有失败保留。", "",
        "当前 evaluator 以所有参考模型计算计划分母。缺失两模型的 12 个题位不能从分母中消失。"
        "固定集曾用于反复回归验证，补齐后仍是回归集，不能称为全新的一次性泛化验证。", "",
        f"原 groups 保持一致：{summary['fixed_groups_unchanged']}。原 source hashes 保持一致：{summary['original_source_hashes_unchanged']}。"
        f"原 resample source hashes 保持一致：{summary['original_resample_source_hashes_unchanged']}。", "",
        "完整 53 模型批次来源、真实请求型号、返回型号、供应商计数、target 配置与当前覆盖见 holdout-inventory.json。"]
    (OUT / "holdout-inventory.md").write_text("\n".join(text) + "\n")
    print(json.dumps({key: value for key, value in summary.items() if key not in ("models", "hashes")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
