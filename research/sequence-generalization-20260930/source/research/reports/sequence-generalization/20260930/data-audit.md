# 数据审计：序列泛化研究（2026-09-30）

当前正式参考库有 53 个标签、159 个批次、1,948 条回答。全部通过产品解析器的有效数字门槛，共 648,471 个有效数字。每个标签都有完整的 query-01 至 query-36；各取一条固定挑战回答可组成 636 个三样本组。额外 40 条由 21 条固定挑战变体和 19 条历史补充探针组成。

## 可复现范围

在仓库父目录运行 `bun research/studies/sequence-generalization/audit-data.ts`。脚本读取现有文件，只写本目录的审计 JSON 与 Markdown。使用 `projects/shared/fingerprint-core.js` 的 `parseNumbers`，按最长连续数字段解析；有效门槛为 `max(80, ceil(expected_count * 0.55))`。完整逐条元数据、哈希和分层计数保存在 `data-audit.json`。采集日期按原始 UTC 时间记录。

## 重复与解析

- 正式参考库内，完全相同的有效数字序列为 0 组；原文去首尾空白后完全相同为 0 组。没有跨标签或跨环境的完全相同序列。
- 正式参考库与当前生效固定 holdout、paired-low-01、trap-pilot-01 的序列重复为 0。固定 holdout 和 paired-low-01 与参考库的精确提示词重复均为 0。
- 旧研究脚本的简单正则解析与产品解析器在 26 条参考回答上不同。字母会分隔数字段。新研究须使用产品解析，不能直接复用旧 general.py 的 parse。
- 19 条 `condition=holdout-clean` 是旧补充参考：claude-fable-5.1 为 11 条，claude-opus-5 为 8 条。来源为 2026-09-10 的 openrouter-claude-validation / openrouter-opus-original-fresh，schema-cutover 原行 558–576。现有 train-embedding.py 和 train-probability-classifier.py 明确把它们作为仅训练的历史补充行。它们与当前冻结 holdout 没有精确提示词、原文或序列重合；名称本身不能判定污染。

## Astra / Sol 的采集边界

| 集合 | gpt-6-astra | gpt-6.1-sol | 可隔离的因素 |
|---|---|---|---|
| 正式参考 | 36 条，1 批，OpenAI 直连 Responses，low，2026-09-30 UTC | 36 条，1 批，OpenRouter/OpenAI Chat Completions，low，2026-09-29 UTC | 两者 36 道挑战和系统提示逐条一致；渠道、接口、批次和时间与模型标签混杂 |
| paired-low-01 | 60 条，20 轮 | 60 条，20 轮 | 两者参数相同、OpenRouter 固定 OpenAI 且不回退；同轮同提示配对 |
| 当前固定 holdout | 6 条，2 个完整组三样本 | 0 条 | 不能评估两者的成对识别或 Sol 置信度 |
| trap-pilot-01 | 6 条 | 6 条 | 单一中文提示、相同接口和 low 参数；仅适合作为题型观察 |

paired-low-01 共 122 次尝试：120 accepted、1 failed、1 invalid。按样本 ID 取首个 accepted 后仍为 120 条；序列没有内部重复。固定 holdout 共 377 次记录：252 accepted、121 failed、4 invalid。按 manifest 的生效尝试编号取首个有效记录后为 216 条、36 个模型、72 个完整组。manifest 只含原始 36 标签；当前库展示口径为 106 计划组，所以覆盖率为 72/106 组、216/318 条，另 17 个当前标签没有固定 holdout 回答。

正式参考的留环境验证只隔离提示条件。Astra 与 Sol 各只有一个采集批次，也各只有一种渠道、接口和时间层。因此无法从正式参考构造两个标签都存在的留渠道或留会话验证。保留 12 个 prompt environment 的名字，不要把它们解释成 12 个独立采集会话。旧研究曾把跨渠道差异误当作模型差异；本轮仍需同参数外部配对集核验迁移。

参考元数据还存在 328 条接口格式缺失、1,281 条实际 provider 缺失和 4 条采集时间缺失。47 个标签只有一种已记录 source / endpoint / format / reasoning 组合；其余 6 个标签有两种。这些缺失限制会话或供应商隔离，不能用 batch ID 数量代替独立来源数。

## 评估划分建议

1. 全库算法选择使用 12 个留一固定环境外折。每折训练排除全部 held challenge ID、环境前缀变体、精确原文和产品解析序列重复。基准面板每标签每挑战取稳定的第一条参考，报告 636 组三样本结果。额外参考仅训练，不能充当额外评估组。
2. 特征标准化、位置投影、监督选择、模型中心和置信度校准都只拟合外折训练行。若选择参数后报告同一外折分数，明确标为开发交叉验证；独立泛化必须用选择后冻结的外部集合。
3. paired-low-01 用作全库模型的跨采集迁移回放，不加入正式参考或产品校准。若在其中做方法研究，按 round_id 同时留出两个标签的三条回答，避免同提示的配对答案落在训练和验证两侧。该数据已被多次研究，不能再称为未触碰测试集。
4. 冻结 holdout 只作回归验证。报告覆盖与识别结果；当前没有 Sol 回答，不能据此声称成对高置信度识别已获验证。当前报告是 60/72 完整组命中，60/106 全计划组命中。
5. 用户新授权的同参数直连前瞻配对采集，只在候选和置信度阈值冻结后打开评分。3 / 6 / 9 / 15 回答的确认指标使用不重叠轮次；重采样合并另列为探索估计。置信度报告同时给出覆盖、错误和按匹配轮聚类的不确定区间。

## 所有标签的当前样本与来源

“来源层”按已记录 channel / endpoint / format / reasoning 组合计数。holdout 列按产品标签别名归一后计数。

| 标签 | 有效 / 总数 | 批次数 | 渠道及样本数 | 来源层 | 生效 holdout |
|---|---:|---:|---|---:|---:|
| claude-fable-5 | 38/38 | 5 | mono (38) | 1 | 6 |
| claude-fable-5.1 | 49/49 | 16 | mono (49) | 1 | 6 |
| claude-haiku-4.5 | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| claude-opus-4.6 | 36/36 | 6 | oaipro (36) | 1 | 6 |
| claude-opus-4.7 | 36/36 | 5 | oaipro (36) | 1 | 6 |
| claude-opus-4.8 | 36/36 | 4 | oaipro (36) | 1 | 6 |
| claude-opus-5 | 61/61 | 12 | mono (25), oaipro (36) | 2 | 6 |
| claude-opus-5.5 | 36/36 | 1 | openrouter/anthropic (36) | 1 | 0 |
| claude-sonnet-4.6 | 36/36 | 8 | oaipro (36) | 1 | 6 |
| claude-sonnet-5 | 36/36 | 12 | oaipro (36) | 1 | 6 |
| claude-sonnet-5.5 | 36/36 | 1 | openrouter/anthropic (36) | 1 | 0 |
| deepseek-v3.2 | 36/36 | 1 | openrouter/novita (36) | 1 | 6 |
| deepseek-v4-flash | 36/36 | 1 | openrouter/novita (36) | 1 | 6 |
| deepseek-v4-flash-0731 | 36/36 | 1 | openrouter/novita (36) | 2 | 6 |
| deepseek-v4-pro | 36/36 | 1 | openrouter/novita (36) | 1 | 6 |
| deepseek-v4-pro-0813 | 36/36 | 1 | openrouter/deepseek (36) | 1 | 6 |
| deepseek-v4.1-flash | 36/36 | 1 | openrouter/deepseek (36) | 1 | 6 |
| gemini-2.5-pro | 36/36 | 4 | mono (36) | 1 | 6 |
| gemini-3.1-pro-preview | 36/36 | 3 | mono (36) | 1 | 6 |
| gemini-3.5-flash | 36/36 | 3 | mono (36) | 1 | 6 |
| gemini-3.6-flash | 36/36 | 4 | mono (36) | 1 | 6 |
| gemini-3.7-flash | 36/36 | 3 | mono (36) | 1 | 6 |
| gemini-3.8-flash | 36/36 | 4 | mono (36) | 1 | 6 |
| glm-5.2 | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| glm-5.3 | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| glm-5.3-flash | 36/36 | 1 | openrouter/z-ai/fp8 (36) | 1 | 0 |
| glm-5.3-flashx | 36/36 | 1 | openrouter/z-ai/fp8 (36) | 1 | 0 |
| gpt-4o | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| gpt-5.4 | 36/36 | 1 | openai/direct (36) | 1 | 6 |
| gpt-5.5 | 36/36 | 1 | openai/direct (36) | 1 | 6 |
| gpt-5.6-luna | 36/36 | 1 | openai/direct (36) | 1 | 6 |
| gpt-5.6-sol | 36/36 | 1 | openai/direct (36) | 1 | 6 |
| gpt-5.6-terra | 36/36 | 1 | openai/direct (36) | 1 | 6 |
| gpt-6-astra | 36/36 | 1 | openai/direct (36) | 1 | 6 |
| gpt-6-luna | 36/36 | 1 | openrouter/openai (36) | 1 | 0 |
| gpt-6-sol | 36/36 | 1 | openai/direct (36) | 1 | 0 |
| gpt-6.1-sol | 36/36 | 1 | openrouter/openai (36) | 1 | 0 |
| grok-4.5 | 36/36 | 4 | mono (36) | 1 | 6 |
| grok-4.6 | 36/36 | 3 | mono (36) | 1 | 6 |
| grok-4.7 | 36/36 | 2 | openrouter/xai (36) | 1 | 0 |
| hy4-preview | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| kimi-k2.8-preview | 36/36 | 1 | kimi-code-subscription (36) | 1 | 0 |
| kimi-k3 | 36/36 | 1 | openrouter/moonshotai (36) | 1 | 6 |
| mimo-v2.5 | 36/36 | 4 | openrouter/xiaomi/fp8 (36) | 1 | 0 |
| mimo-v2.5-pro | 36/36 | 2 | openrouter/xiaomi/fp8 (36) | 1 | 0 |
| mimo-v2.6-flash | 36/36 | 6 | openrouter/xiaomi/fp8 (36) | 1 | 0 |
| mimo-v2.6-pro | 36/36 | 10 | openrouter/xiaomi/fp8 (36) | 1 | 0 |
| muse-spark-1.2 | 36/36 | 2 | openrouter/unknown (36) | 2 | 0 |
| muse-spark-1.3 | 36/36 | 2 | openrouter/unknown (36) | 2 | 0 |
| muse-spark-1.3-contributor | 36/36 | 2 | openrouter/unknown (36) | 2 | 0 |
| qwen3.8-27b | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| qwen3.8-max-0902 | 36/36 | 1 | openrouter/unknown (36) | 1 | 6 |
| step-5-preview | 36/36 | 5 | stepfun-api (36) | 2 | 0 |

## 输入 SHA-256

| 文件 | SHA-256 |
|---|---|
| `projects/data/unified_reference.jsonl` | `5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4` |
| `projects/data/unified_bank.json` | `47b8ad67e8ad32095ac650b3a384420c06ef88bb6e78206be478a8cd62029968` |
| `projects/data/shared_detector.json` | `9e0502ce9f1fda99875d675d4a0b1fbd730138691eb42d4fa3f28c752cd1014d` |
| `research/evaluation/holdout/manifest.json` | `456f2b0fac6cec312042328cf16b7d6c0cdeccd2ab69f8faf3bf50c08f8806c7` |
| `research/evaluation/holdout/samples.jsonl` | `2241a2d46e549b338e3843b45b661ae740a0b95727f6a88339ad27d28bd2ae91` |
| `research/reports/astra-sol-separation/paired-low-01/manifest.json` | `e0b9cdd6c088518a587d3092e30f3bd2402572b3866b73ed7bd730f1cbcad543` |
| `research/reports/astra-sol-separation/paired-low-01/samples.jsonl` | `3f615be95a2bbcd65c350f4e9b414303507b2e0b8f1384767cc8759edbd98955` |
| `research/reports/astra-sol-separation/trap-pilot-01/samples.jsonl` | `65e3d2edeb4d67b0be2c7ed0776adf58366ff5700754703a35fcca9355d98a25` |
| `projects/shared/fingerprint-core.js` | `5a096c0e5638b9b7e266714725660549273b018e0b5eddbec3302ef96af21f16` |
