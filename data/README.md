# 正式数据

此目录保存正式参考样本、派生指纹库、冻结检测参数和固定采样挑战。`unified_reference.jsonl` 每行一个版本 1 批次，共用模型、渠道与调用设置，回答放在 `samples` 数组中。`enrollment-suite.json` 是采样输入，不是参考回答。`import_manifest.json` 是历史清单，不代表当前数量。

新版 CLI 使用 `fpd sample`、`fpd enroll DIR` 和 `fpd retrain --data-dir DIR`，三者都可在仓库外运行。入库校验完整批次和原始证据，按模型、渠道、条件、题目与文本去重并重建派生库。重训从目标参考库离线拟合核验器与置信度；嵌套校准未通过时不替换 `shared_detector.json`，训练证据保存在 `.training/`。CLI 随包数据只读，维护目标必须显式指定或在交互入库时识别本仓库后确认。固定评估集不能加入参考库、模型中心或校准。

Web 构建会将脱敏数据写入 `../web/public/data/`。该目录是生成产物，不能作为另一份正式库维护。

`tokenizer_bank.json` 是分词器探测用的分词器库，由分词器归档工具 llm-tokenizer-fingerprint 的 `token-fp export-api-bank` 从 290 个开源分词器离线生成，`source.archive_manifest_sha256` 记录所用归档清单的哈希，`source.excluded` 列出因归档文件不可信而未导出的仓库及原因。文件包含固定前后缀（`wrapper`）、测试文本原文（`probes`）、每一类分词器对每条测试文本的计数差（`classes[].counts`，成员分歧时另列 `alternatives`）以及厂商型号到分词器类的映射（`api_models`，`class` 为 `null` 表示厂商未公开分词器）。类按作者实验室与系列归并：计数完全相同的分词器归为一类，同一谱系下只差少数文本的再合并。该文件与参考样本无关，更新时直接整体替换，不经过 `fpd enroll`。

`archive/` 保存已退出参考库的历史批次，`collections/` 保存采样请求、尝试和来源核验记录。两者不参与评分，也不复制到 Web 公开数据。2026-09-14 的 K3 更新使用 36 条固定 MoonshotAI 来源、关闭思考的回答，替换此前未固定提供方的 36 条回答。新旧批次分别位于 `collections/kimi-k3-moonshotai-20260914/` 和 `archive/kimi-k3-unpinned-20260914/`；前缀版本及生效尝试见新批次 manifest。

2026-09-26 将六个 DeepSeek 型号的 15 个未固定供应商批次（216 条）全部退出正式库，原始行保存在 `archive/deepseek-unpinned-20260926/unified_reference.rows.jsonl`，原采样尝试继续留在研究目录。新参考批次按型号独立保存在 `collections/deepseek-*-20260926/`：V4.1 Flash 与 V4 Pro 0813 各 36 条固定 `openrouter/deepseek`，Flash 0731、Pro 预览、Flash 预览、V3.2 各 36 条固定 `openrouter/novita`。Flash 0731 的 `query-11` 第 11 次和 `query-23` 第 12 次尝试只覆写 `reasoning_effort=low`，原始失败均保留；停用的 SiliconFlow 备用批次保留在 `collections/` 但没有入库。正式库只纳入完整且来源核对通过的批次，不让 OpenRouter 自动回退或混合供应商回答。

格式迁移前的 1,804 条参考行原样保存在 `archive/schema-cutover/unified_reference.rows.jsonl`。新格式保留全部样本 ID、回答、提示词和顺序，未知完整性不会补成成功。旧格式不再由运行时读取，历史请求与失败尝试仍保留。

2026-09-28 将原 `gpt-6-sol` 参考批次（2026-09-22 经 `openrouter/openai` 采集的 36 条回答）标为 `gpt-6-sol-20260922`，保留原请求模型名、渠道和采样证据。新 `gpt-6-sol` 批次在 Ikaleio-TYO 使用 OpenAI Key 直连 `api.openai.com` 的 Responses 接口，以 `reasoning_effort=low` 完成相同的 36 道固定挑战；34 条自然完成，2 条按采样上限截断。原始证据保存在 `collections/gpt-6-sol-openai-direct-20260928/`。首次 Chat Completions 请求因接口不支持 `max_tokens` 返回 HTTP 400，3 条失败记录保存在 `collections/gpt-6-sol-openai-direct-cc-20260928/`，未入库。两个标签分别参与评分；渠道和接口不同，不能仅凭参考库排名推断模型版本差异。

2026-09-29 新增 `claude-sonnet-5.5` 的 36 条固定挑战回答，证据保存在 `collections/claude-sonnet-5.5-openrouter-anthropic-20260929/`。请求 OpenRouter 正式型号 `anthropic/claude-sonnet-5.5`，使用 Chat Completions、默认推理强度和固定 `openrouter/anthropic` 渠道（禁止回退）；36 条均由返回型号及 Anthropic 供应商元数据核对，自然完成，无失败或截断。

2026-09-30 将 gpt-5.4、gpt-5.5、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-6-astra 的 16 个 `codex-subscription` 批次（216 条，推理强度未记录）全部退出正式库，原始行保存在 `archive/codex-subscription-20260930/unified_reference.rows.jsonl`。替换原因：配对研究（`research/studies/astra-sol-separation/`）发现，原参考库的采集渠道和推理设置不一致，会干扰 gpt-6-astra 与 gpt-6.1-sol 的指纹比较。新批次使用 OpenAI Key 从本机直连 `api.openai.com` 的 Responses 接口，流式、`reasoning_effort=low`，与 `gpt-6-sol` 一致；各完成 36 道固定挑战，提示词与系统提示和原批次逐条相同，证据保存在 `collections/<型号>-openai-direct-20260930/`。返回型号为 `gpt-5.4-2026-03-05`、`gpt-5.5-2026-04-23`，其余与请求名相同。截断（达到采样上限）：gpt-5.6-luna 7 条、gpt-5.6-terra 1 条、gpt-5.4 1 条，其余自然完成。失败尝试均保留：gpt-6-astra 4 次、gpt-5.4 3 次连接中断，gpt-5.6-terra 1 次、gpt-5.6-luna 2 次有效数字不足，均在下一次尝试成功。
