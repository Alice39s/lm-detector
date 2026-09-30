# 训练样本频率异常审计（2026-09-30）

全训练库 **1948 条回答、53 个模型、159 个批次，按当前产品规则命中 0 条**。全部 1948 条满足产品评分的有效数字数量门槛。冻结快照与审计时的正式参考库 SHA-256 一致。

本报告直接调用 `projects/shared/sample-distribution.ts` 的 `anomalousSamples`，其内部调用产品 `parseNumbers`。唯一判定条件为：解析后的有效数字序列非空，且最小值 **≥ 200**。扫描包含全训练库，不根据分类结果或模型标签筛选。没有扩大到其他异常规则。

## 命中样本

无命中样本。逐条详情集合为 `[]`，不需要改提示词重采或替换训练样本。

JSON 报告为命中样本预留标签、批次、query、condition、有效数字 count/min/max、实际及记录来源、provider、请求及返回 model、reasoning、原始提示和证据路径等字段；本次集合为空。没有读取或输出任何凭据。

## Web 与 CLI 的实际调用

- Web：`projects/web/src/routes/detect.tsx:25` 导入同一个 `anomalousSamples`；`:265` 在显示结果时仅传入 diagnostics.accepted 的回答文本，其他文本传空串。
- CLI：`projects/cli/detect-ui.tsx:4` 导入同一个函数；`:76` 对已有分析结果的 outputs 调用。`projects/cli/detect-run.ts:68` 与 `:119` 已将未接纳回答的输出文本置为空串。
- 两端没有各自实现阈值或数字解析。两端使用同一 ≥ 200、非空规则。

## DeepSeek v4 Pro 的数值覆盖

以下是相同解析结果的描述统计，不构成新异常规则。两版参考样本都包含大量小于 200 的数字，因此按当前规则无命中。JSON 另为每个模型保存同样的总数、低于 200 的计数及比例、整体 min/max 和逐条 min/max 范围。

| 标签 | 训练回答 | 命中 | 有效数字总数 | 小于 200 | 比例 | 每条最小值范围 |
|---|---:|---:|---:|---:|---:|---:|
| deepseek-v4-pro | 36 | 0 | 10584 | 5523 | 52.1825% | 1–16 |
| deepseek-v4-pro-0813 | 36 | 0 | 10584 | 5591 | 52.8250% | 1–8 |

## 未来定点替换的最小约束

本次无命中，所以不执行替换。若未来同一规则出现命中，保留原批次、所有原始及失败尝试；先将正式参考和派生数据归档，并按 sample ID 定点替换。新的回答使用新的批次 ID，保持公开标签、query ID、expected_count 和实际 provider / request model / response model / reasoning 的记录。只改受影响提示；保留原提示、修订理由和实际生效尝试编号。

当前 CLI 的 `schema_version: 1` / `purpose: reference` 批次包含 model、source、request、plan 和 samples。采集目录保存不可随意修改的 manifest fingerprint、`attempts/query-XX/NNNN.json`、`trace/query-XX/NNNN`、`attempts.jsonl` 和 `result.json`。已选中的挑战不能在原批次上 refine，源码要求创建新批次。enroll 会追加并去重，不会删除旧参考；直接 enroll 新回答不会完成坏样本替换。完成定点替换后必须重建 bank、重训匹配的评分及校准参数，并运行固定 holdout 离线评估。

## 各模型覆盖

| 标签 | 训练回答 | 命中 |
|---|---:|---:|
| claude-fable-5 | 38 | 0 |
| claude-fable-5.1 | 49 | 0 |
| claude-haiku-4.5 | 36 | 0 |
| claude-opus-4.6 | 36 | 0 |
| claude-opus-4.7 | 36 | 0 |
| claude-opus-4.8 | 36 | 0 |
| claude-opus-5 | 61 | 0 |
| claude-opus-5.5 | 36 | 0 |
| claude-sonnet-4.6 | 36 | 0 |
| claude-sonnet-5 | 36 | 0 |
| claude-sonnet-5.5 | 36 | 0 |
| deepseek-v3.2 | 36 | 0 |
| deepseek-v4-flash | 36 | 0 |
| deepseek-v4-flash-0731 | 36 | 0 |
| deepseek-v4-pro | 36 | 0 |
| deepseek-v4-pro-0813 | 36 | 0 |
| deepseek-v4.1-flash | 36 | 0 |
| gemini-2.5-pro | 36 | 0 |
| gemini-3.1-pro-preview | 36 | 0 |
| gemini-3.5-flash | 36 | 0 |
| gemini-3.6-flash | 36 | 0 |
| gemini-3.7-flash | 36 | 0 |
| gemini-3.8-flash | 36 | 0 |
| glm-5.2 | 36 | 0 |
| glm-5.3 | 36 | 0 |
| glm-5.3-flash | 36 | 0 |
| glm-5.3-flashx | 36 | 0 |
| gpt-4o | 36 | 0 |
| gpt-5.4 | 36 | 0 |
| gpt-5.5 | 36 | 0 |
| gpt-5.6-luna | 36 | 0 |
| gpt-5.6-sol | 36 | 0 |
| gpt-5.6-terra | 36 | 0 |
| gpt-6-astra | 36 | 0 |
| gpt-6-luna | 36 | 0 |
| gpt-6-sol | 36 | 0 |
| gpt-6.1-sol | 36 | 0 |
| grok-4.5 | 36 | 0 |
| grok-4.6 | 36 | 0 |
| grok-4.7 | 36 | 0 |
| hy4-preview | 36 | 0 |
| kimi-k2.8-preview | 36 | 0 |
| kimi-k3 | 36 | 0 |
| mimo-v2.5 | 36 | 0 |
| mimo-v2.5-pro | 36 | 0 |
| mimo-v2.6-flash | 36 | 0 |
| mimo-v2.6-pro | 36 | 0 |
| muse-spark-1.2 | 36 | 0 |
| muse-spark-1.3 | 36 | 0 |
| muse-spark-1.3-contributor | 36 | 0 |
| qwen3.8-27b | 36 | 0 |
| qwen3.8-max-0902 | 36 | 0 |
| step-5-preview | 36 | 0 |

## 冻结快照 SHA-256

| 文件 | SHA-256 |
|---|---|
| `research/reports/reference-repair-20260930/baseline/unified_reference.jsonl` | `5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4` |
| `research/reports/reference-repair-20260930/baseline/unified_bank.json` | `47b8ad67e8ad32095ac650b3a384420c06ef88bb6e78206be478a8cd62029968` |
| `research/reports/reference-repair-20260930/baseline/shared_detector.json` | `9e0502ce9f1fda99875d675d4a0b1fbd730138691eb42d4fa3f28c752cd1014d` |
| `research/reports/reference-repair-20260930/baseline/holdout-manifest.json` | `456f2b0fac6cec312042328cf16b7d6c0cdeccd2ab69f8faf3bf50c08f8806c7` |
| `research/reports/reference-repair-20260930/baseline/holdout-samples.jsonl` | `2241a2d46e549b338e3843b45b661ae740a0b95727f6a88339ad27d28bd2ae91` |

运行：`bun research/studies/reference-repair-20260930/audit.ts`。脚本只读取正式数据和 baseline 快照，只写本报告目录的审计 JSON / Markdown。不调用模型 API，不改共享数据，也不运行或新增测试。
