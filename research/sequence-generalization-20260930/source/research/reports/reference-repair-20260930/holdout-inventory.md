# 固定验证集补全与来源审计

参考库共有 53 个标签。原 manifest 有 36 个目标，缺少 17 个。补全准备后 manifest 有 51 个目标，仍缺少 2 个。

此审计不调用模型 API，不评分回答，也不修改 manifest、参考库或回答。回答覆盖数仅是审计时快照；采集仍可能继续。

| 新增/缺失标签 | 实际 API 型号 | 格式 | 固定供应商路由 | 推理配置 |
|---|---|---|---|---|
| muse-spark-1.2 | meta/muse-spark-1.2 | openai | meta | {"effort": "low"} |
| muse-spark-1.3-contributor | meta/muse-spark-1.3-contributor | openai | meta | {"effort": "low"} |
| muse-spark-1.3 | meta/muse-spark-1.3 | openai | meta | {"effort": "low"} |
| kimi-k2.8-preview | kimi-for-coding | 原渠道 | OpenRouter 不可用 | 不替换身份 |
| grok-4.7 | x-ai/grok-4.7 | openai | xai | {"effort": "low"} |
| mimo-v2.5 | xiaomi/mimo-v2.5 | openai | xiaomi/fp8 | {"enabled": false} |
| mimo-v2.5-pro | xiaomi/mimo-v2.5-pro | openai | xiaomi/fp8 | {"enabled": false} |
| mimo-v2.6-flash | xiaomi/mimo-v2.6-flash | openai | xiaomi/fp8 | {"enabled": false} |
| mimo-v2.6-pro | xiaomi/mimo-v2.6-pro | openai | xiaomi/fp8 | {"enabled": false} |
| step-5-preview | step-5-preview | 原渠道 | OpenRouter 不可用 | 不替换身份 |
| claude-opus-5.5 | anthropic/claude-opus-5.5 | openai | anthropic | {"effort": "low"} |
| gpt-6-luna | openai/gpt-6-luna | openai | openai | {"effort": "low"} |
| glm-5.3-flashx | z-ai/glm-5.3-flashx | openai | z-ai/fp8 | "默认" |
| glm-5.3-flash | z-ai/glm-5.3-flash | openai | z-ai/fp8 | "默认" |
| gpt-6-sol | openai/gpt-6-sol | responses | openai | {"effort": "low"} |
| claude-sonnet-5.5 | anthropic/claude-sonnet-5.5 | openai | anthropic | "默认" |
| gpt-6.1-sol | openai/gpt-6.1-sol | openai | openai | {"effort": "low"} |

`kimi-k2.8-preview` 的原请求型号是 `kimi-for-coding`，来自 `kimi-code-subscription`。当前 OpenRouter 目录没有该身份，`moonshotai/kimi-k2.7-code` 不能作为替代。

`step-5-preview` 来自 `stepfun-api` 的 `step_plan/v1/chat/completions`。当前目录仅有其他 Step 型号，不能替换为 `stepfun/step-3.7-flash`。

Muses 的历史参考供应商未记录。新目标固定 `meta` 的依据是当前三个 endpoint 快照均仅含 Meta 官方供应商。此证据不能追溯证明旧参考供应商。历史参考混合 default/low，新增验证使用最新参考批次的 low，选择理由已保存在 target-preparation.json。

`gpt-6-sol` 参考来自 OpenAI 直连。新增固定验证通过 OpenRouter/OpenAI，所以必须记录渠道变化。其他新目标保持参考原格式；Claude Opus/Sonnet 5.5 和 GPT 6.1 Sol 使用 Chat Completions，不按家族强制改为 Messages/Responses。

Collector 复用现有 target 配置，保持原两组三题及所有旧尝试。它接受目录中精确 `api_model` 或 `canonical_slug`。返回的 `response_model` 保留原值。供应商名核对路由的供应商段，`xiaomi/fp8` 与 `z-ai/fp8` 的精度路由仍保存在原请求。

旧 suite 的存储提示词保持不变。新采集追加 `collection_runs` 和 `profile_history`，每条尝试记录实际 source hashes。历史 `source_hashes`、`resample_source_hashes` 和 profile 不覆写。哈希变化表示新的请求/解析实现，不能把新增数据当作旧 profile 的同批数据。

每条新 HTTP 尝试保存原请求 JSON、安全响应元数据和原始响应字节。`raw_response` 保存相对路径、SHA-256 与字节数。未保存认证请求头。网络失败没有响应字节时不伪造 raw response。

首轮 run 的 `blocked_missing_catalog` 附加诊断只检查参考原始请求名，未优先识别已有 manifest 的 OpenRouter 型号映射。它因此误报了 11 个仍有精确目录映射的历史标签。该诊断不参与目标过滤或模型请求。真正缺失的两个身份以本审计和 target-preparation.json 为准；不在运行中改写冻结 collector。

保留首次合格尝试；有效性只依据来源核对和合法数字数量，不根据识别结果重采。每个题位最多尝试数限制按单次命令执行计算，续采会继续增加编号；所有失败保留。

当前 evaluator 以所有参考模型计算计划分母。缺失两模型的 12 个题位不能从分母中消失。固定集曾用于反复回归验证，补齐后仍是回归集，不能称为全新的一次性泛化验证。

原 groups 保持一致：True。原 source hashes 保持一致：True。原 resample source hashes 保持一致：True。

完整 53 模型批次来源、真实请求型号、返回型号、供应商计数、target 配置与当前覆盖见 holdout-inventory.json。
