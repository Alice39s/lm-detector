# 固定测试集评估

完整三样本组命中 **60/106**；已完成 **72/106** 组、**216/318** 条有效回答。

核验器最高分候选命中 **60/72**（83.3%）；与排名器首位不同 **5** 组。相同回答配对比较，核验命中数变化：0。

第一候选置信度的二元误差：NLL 0.2622；Brier 0.0920；ECE 0.0778。本段只评估当前库内固定测试，库外误报需另行回放。

证据标识：完整组中 72/72 组标为证据不足，仍保留候选排名。使用冻结的排名器 A、核验器 B 与排名温度校准层（tau 5.099，.training/20260930T030115116234Z/calibration）。置信度是 53 个参考身份上的闭集概率，按留出环境的参考预测拟合，不含库外概率项；不按固定阈值自动确认身份。

完整组条件准确率：83.3%；Top-3：93.1%；家族准确率：93.1%。首次已记录尝试按当前网页评分流程计分：34.0%。

| 模型 | 第 1 组 | 第 2 组 |
|---|---|---|
| claude-haiku-4.5 | ✗ mimo-v2.6-pro（真值第 45）；核验：deepseek-v4-pro | ✗ deepseek-v4-pro（真值第 26） |
| claude-sonnet-4.6 | ✓ claude-sonnet-4.6（真值第 1） | ✓ claude-sonnet-4.6（真值第 1） |
| claude-sonnet-5 | ✓ claude-sonnet-5（真值第 1） | ✓ claude-sonnet-5（真值第 1） |
| claude-opus-4.6 | ✓ claude-opus-4.6（真值第 1） | ✓ claude-opus-4.6（真值第 1） |
| claude-opus-4.7 | ✓ claude-opus-4.7（真值第 1） | ✓ claude-opus-4.7（真值第 1） |
| claude-opus-4.8 | ✓ claude-opus-4.8（真值第 1） | ✓ claude-opus-4.8（真值第 1） |
| claude-opus-5 | ✓ claude-opus-5（真值第 1） | ✓ claude-opus-5（真值第 1） |
| claude-fable-5.1 | ✓ claude-fable-5.1（真值第 1） | ✓ claude-fable-5.1（真值第 1） |
| claude-fable-5 | ✓ claude-fable-5（真值第 1） | ✓ claude-fable-5（真值第 1） |
| gemini-2.5-pro | ✓ gemini-2.5-pro（真值第 1） | ✓ gemini-2.5-pro（真值第 1） |
| gemini-3.1-pro-preview | ✓ gemini-3.1-pro-preview（真值第 1） | ✓ gemini-3.1-pro-preview（真值第 1） |
| gemini-3.5-flash | ✓ gemini-3.5-flash（真值第 1） | ✓ gemini-3.5-flash（真值第 1） |
| gemini-3.6-flash | ✗ gemini-3.8-flash（真值第 2）；核验：gemini-3.6-flash | ✓ gemini-3.6-flash（真值第 1） |
| gemini-3.7-flash | ✓ gemini-3.7-flash（真值第 1） | ✗ gemini-3.8-flash（真值第 2） |
| gemini-3.8-flash | ✓ gemini-3.8-flash（真值第 1） | ✓ gemini-3.8-flash（真值第 1） |
| grok-4.5 | ✓ grok-4.5（真值第 1） | ✓ grok-4.5（真值第 1） |
| grok-4.6 | ✓ grok-4.6（真值第 1） | ✓ grok-4.6（真值第 1） |
| gpt-4o | ✓ gpt-4o（真值第 1） | ✓ gpt-4o（真值第 1） |
| glm-5.2 | ✓ glm-5.2（真值第 1） | ✓ glm-5.2（真值第 1） |
| glm-5.3 | ✓ glm-5.3（真值第 1） | ✓ glm-5.3（真值第 1） |
| qwen3.8-max-0902 | ✓ qwen3.8-max-0902（真值第 1） | ✓ qwen3.8-max-0902（真值第 1） |
| qwen3.8-27b | ✓ qwen3.8-27b（真值第 1） | ✓ qwen3.8-27b（真值第 1） |
| kimi-k3 | ✗ deepseek-v4-flash（真值第 4） | ✗ glm-5.3-flash（真值第 6） |
| hy4-preview | ✓ hy4-preview（真值第 1） | ✓ hy4-preview（真值第 1） |
| muse-spark-1.2 | 未齐 0/3 | 未齐 0/3 |
| muse-spark-1.3-contributor | 未齐 0/3 | 未齐 0/3 |
| muse-spark-1.3 | 未齐 0/3 | 未齐 0/3 |
| kimi-k2.8-preview | 未齐 0/3 | 未齐 0/3 |
| grok-4.7 | 未齐 0/3 | 未齐 0/3 |
| mimo-v2.5 | 未齐 0/3 | 未齐 0/3 |
| mimo-v2.5-pro | 未齐 0/3 | 未齐 0/3 |
| mimo-v2.6-flash | 未齐 0/3 | 未齐 0/3 |
| mimo-v2.6-pro | 未齐 0/3 | 未齐 0/3 |
| step-5-preview | 未齐 0/3 | 未齐 0/3 |
| claude-opus-5.5 | 未齐 0/3 | 未齐 0/3 |
| gpt-6-luna | 未齐 0/3 | 未齐 0/3 |
| glm-5.3-flashx | 未齐 0/3 | 未齐 0/3 |
| glm-5.3-flash | 未齐 0/3 | 未齐 0/3 |
| deepseek-v4.1-flash | ✓ deepseek-v4.1-flash（真值第 1） | ✓ deepseek-v4.1-flash（真值第 1） |
| deepseek-v4-flash | ✓ deepseek-v4-flash（真值第 1） | ✗ deepseek-v4-flash-0731（真值第 2） |
| deepseek-v4-pro-0813 | ✓ deepseek-v4-pro-0813（真值第 1）；核验：deepseek-v4-pro | ✗ deepseek-v4-pro（真值第 2） |
| deepseek-v4-pro | ✗ deepseek-v4-pro-0813（真值第 2）；核验：deepseek-v4-pro | ✓ deepseek-v4-pro（真值第 1） |
| deepseek-v4-flash-0731 | ✓ deepseek-v4-flash-0731（真值第 1） | ✗ deepseek-v4-flash（真值第 2） |
| deepseek-v3.2 | ✓ deepseek-v3.2（真值第 1） | ✓ deepseek-v3.2（真值第 1）；核验：kimi-k3 |
| gpt-6-sol | 未齐 0/3 | 未齐 0/3 |
| claude-sonnet-5.5 | 未齐 0/3 | 未齐 0/3 |
| gpt-6.1-sol | 未齐 0/3 | 未齐 0/3 |
| gpt-6-astra | ✓ gpt-6-astra（真值第 1） | ✗ gpt-6.1-sol（真值第 2） |
| gpt-5.4 | ✓ gpt-5.4（真值第 1） | ✗ deepseek-v4-pro（真值第 43） |
| gpt-5.5 | ✓ gpt-5.5（真值第 1） | ✓ gpt-5.5（真值第 1） |
| gpt-5.6-sol | ✓ gpt-5.6-sol（真值第 1） | ✓ gpt-5.6-sol（真值第 1） |
| gpt-5.6-terra | ✓ gpt-5.6-terra（真值第 1） | ✓ gpt-5.6-terra（真值第 1） |
| gpt-5.6-luna | ✓ gpt-5.6-luna（真值第 1） | ✓ gpt-5.6-luna（真值第 1） |

与上次报告使用相同回答配对比较，完整组命中数变化 0；评分方法相同。

本次没有可列出的预测变动。

未获得有效回答：

- muse-spark-1.2 group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.2 group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.2 group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.2 group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.2 group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.2 group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3-contributor group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3-contributor group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3-contributor group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3-contributor group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3-contributor group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3-contributor group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3 group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3 group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3 group-1：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3 group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3 group-2：尚无有效回答（已记录 0 次尝试）
- muse-spark-1.3 group-2：尚无有效回答（已记录 0 次尝试）
- kimi-k2.8-preview group-1：尚无有效回答（已记录 0 次尝试）
- kimi-k2.8-preview group-1：尚无有效回答（已记录 0 次尝试）
- kimi-k2.8-preview group-1：尚无有效回答（已记录 0 次尝试）
- kimi-k2.8-preview group-2：尚无有效回答（已记录 0 次尝试）
- kimi-k2.8-preview group-2：尚无有效回答（已记录 0 次尝试）
- kimi-k2.8-preview group-2：尚无有效回答（已记录 0 次尝试）
- grok-4.7 group-1：尚无有效回答（已记录 0 次尝试）
- grok-4.7 group-1：尚无有效回答（已记录 0 次尝试）
- grok-4.7 group-1：尚无有效回答（已记录 0 次尝试）
- grok-4.7 group-2：尚无有效回答（已记录 0 次尝试）
- grok-4.7 group-2：尚无有效回答（已记录 0 次尝试）
- grok-4.7 group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5 group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5 group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5 group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5 group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5 group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5 group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5-pro group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5-pro group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5-pro group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5-pro group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5-pro group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.5-pro group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-flash group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-flash group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-flash group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-flash group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-flash group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-flash group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-pro group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-pro group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-pro group-1：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-pro group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-pro group-2：尚无有效回答（已记录 0 次尝试）
- mimo-v2.6-pro group-2：尚无有效回答（已记录 0 次尝试）
- step-5-preview group-1：尚无有效回答（已记录 0 次尝试）
- step-5-preview group-1：尚无有效回答（已记录 0 次尝试）
- step-5-preview group-1：尚无有效回答（已记录 0 次尝试）
- step-5-preview group-2：尚无有效回答（已记录 0 次尝试）
- step-5-preview group-2：尚无有效回答（已记录 0 次尝试）
- step-5-preview group-2：尚无有效回答（已记录 0 次尝试）
- claude-opus-5.5 group-1：尚无有效回答（已记录 0 次尝试）
- claude-opus-5.5 group-1：尚无有效回答（已记录 0 次尝试）
- claude-opus-5.5 group-1：尚无有效回答（已记录 0 次尝试）
- claude-opus-5.5 group-2：尚无有效回答（已记录 0 次尝试）
- claude-opus-5.5 group-2：尚无有效回答（已记录 0 次尝试）
- claude-opus-5.5 group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6-luna group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6-luna group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6-luna group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6-luna group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6-luna group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6-luna group-2：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flashx group-1：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flashx group-1：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flashx group-1：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flashx group-2：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flashx group-2：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flashx group-2：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flash group-1：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flash group-1：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flash group-1：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flash group-2：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flash group-2：尚无有效回答（已记录 0 次尝试）
- glm-5.3-flash group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6-sol group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6-sol group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6-sol group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6-sol group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6-sol group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6-sol group-2：尚无有效回答（已记录 0 次尝试）
- claude-sonnet-5.5 group-1：尚无有效回答（已记录 0 次尝试）
- claude-sonnet-5.5 group-1：尚无有效回答（已记录 0 次尝试）
- claude-sonnet-5.5 group-1：尚无有效回答（已记录 0 次尝试）
- claude-sonnet-5.5 group-2：尚无有效回答（已记录 0 次尝试）
- claude-sonnet-5.5 group-2：尚无有效回答（已记录 0 次尝试）
- claude-sonnet-5.5 group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6.1-sol group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6.1-sol group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6.1-sol group-1：尚无有效回答（已记录 0 次尝试）
- gpt-6.1-sol group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6.1-sol group-2：尚无有效回答（已记录 0 次尝试）
- gpt-6.1-sol group-2：尚无有效回答（已记录 0 次尝试）

未覆盖模型：muse-spark-1.2、muse-spark-1.3-contributor、muse-spark-1.3、kimi-k2.8-preview、grok-4.7、mimo-v2.5、mimo-v2.5-pro、mimo-v2.6-flash、mimo-v2.6-pro、step-5-preview、claude-opus-5.5、gpt-6-luna、glm-5.3-flashx、glm-5.3-flash、gpt-6-sol、claude-sonnet-5.5、gpt-6.1-sol。疑似训练重合：0 条输出、0 条提示词。

用户授权的混用前缀修订：11 次，按实际尝试保留原始及新提示词。

采集当前输出上限：8192。历史请求上限与数量：{"4096":53,"8192":324}。用户更改上限前的完整回答保留；首次尝试指标使用首次已落盘记录，不包含切换配置时未完成落盘的在途请求。

每模型仅两组，结果用于观察回归，不代表稳定的真实准确率。测试集反复用于调整算法后属于回归验证集，不能继续作为一次性独立泛化评估。失败和缺失不从总计划组数中消失；条件准确率仅使用完整组。所有模型按 OpenRouter 标签记录，不能据此独立认证后端身份。

报告时间：2026-09-30T14:38:22.741Z。参考数据 SHA-256：`5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4`。
