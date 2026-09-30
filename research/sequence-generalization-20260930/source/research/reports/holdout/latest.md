# 固定测试集评估

完整三样本组命中 **81/106**；已完成 **104/106** 组、**312/318** 条有效回答。

核验器最高分候选命中 **84/104**（80.8%）；与排名器首位不同 **9** 组。相同回答配对比较，核验命中数变化：无可比较基线。

第一候选置信度的二元误差：NLL 0.2965；Brier 0.1065；ECE 0.1214。本段只评估当前库内固定测试，库外误报需另行回放。

证据标识：完整组中 104/104 组标为证据不足，仍保留候选排名。使用冻结的排名器 A、核验器 B 与排名温度校准层（tau 5.099，.training/20260930T030115116234Z/calibration）。置信度是 53 个参考身份上的闭集概率，按留出环境的参考预测拟合，不含库外概率项；不按固定阈值自动确认身份。

完整组条件准确率：77.9%；Top-3：92.3%；家族准确率：92.3%。首次已记录尝试按当前网页评分流程计分：38.7%。

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
| muse-spark-1.2 | ✓ muse-spark-1.2（真值第 1） | ✓ muse-spark-1.2（真值第 1） |
| muse-spark-1.3-contributor | ✗ muse-spark-1.3（真值第 2）；核验：muse-spark-1.3-contributor | ✓ muse-spark-1.3-contributor（真值第 1） |
| muse-spark-1.3 | ✗ muse-spark-1.3-contributor（真值第 2） | ✗ muse-spark-1.3-contributor（真值第 2） |
| kimi-k2.8-preview | 未齐 0/3 | 未齐 0/3 |
| grok-4.7 | ✓ grok-4.7（真值第 1） | ✓ grok-4.7（真值第 1） |
| mimo-v2.5 | ✗ qwen3.8-max-0902（真值第 3） | ✗ mimo-v2.6-flash（真值第 6）；核验：qwen3.8-max-0902 |
| mimo-v2.5-pro | ✓ mimo-v2.5-pro（真值第 1） | ✓ mimo-v2.5-pro（真值第 1） |
| mimo-v2.6-flash | ✓ mimo-v2.6-flash（真值第 1） | ✓ mimo-v2.6-flash（真值第 1） |
| mimo-v2.6-pro | ✓ mimo-v2.6-pro（真值第 1） | ✓ mimo-v2.6-pro（真值第 1） |
| step-5-preview | ✓ step-5-preview（真值第 1） | ✓ step-5-preview（真值第 1） |
| claude-opus-5.5 | ✓ claude-opus-5.5（真值第 1） | ✓ claude-opus-5.5（真值第 1） |
| gpt-6-luna | ✓ gpt-6-luna（真值第 1） | ✓ gpt-6-luna（真值第 1） |
| glm-5.3-flashx | ✗ glm-5.3-flash（真值第 2） | ✓ glm-5.3-flashx（真值第 1） |
| glm-5.3-flash | ✗ glm-5.3-flashx（真值第 2）；核验：glm-5.3-flash | ✗ glm-5.3-flashx（真值第 2） |
| deepseek-v4.1-flash | ✓ deepseek-v4.1-flash（真值第 1） | ✓ deepseek-v4.1-flash（真值第 1） |
| deepseek-v4-flash | ✓ deepseek-v4-flash（真值第 1） | ✗ deepseek-v4-flash-0731（真值第 2） |
| deepseek-v4-pro-0813 | ✓ deepseek-v4-pro-0813（真值第 1）；核验：deepseek-v4-pro | ✗ deepseek-v4-pro（真值第 2） |
| deepseek-v4-pro | ✗ deepseek-v4-pro-0813（真值第 2）；核验：deepseek-v4-pro | ✓ deepseek-v4-pro（真值第 1） |
| deepseek-v4-flash-0731 | ✓ deepseek-v4-flash-0731（真值第 1） | ✗ deepseek-v4-flash（真值第 2） |
| deepseek-v3.2 | ✓ deepseek-v3.2（真值第 1） | ✓ deepseek-v3.2（真值第 1）；核验：kimi-k3 |
| gpt-6-sol | ✗ deepseek-v4-pro（真值第 4） | ✗ deepseek-v4-pro（真值第 9） |
| claude-sonnet-5.5 | ✓ claude-sonnet-5.5（真值第 1） | ✓ claude-sonnet-5.5（真值第 1） |
| gpt-6.1-sol | ✗ gpt-6-astra（真值第 2）；核验：gpt-6.1-sol | ✓ gpt-6.1-sol（真值第 1） |
| gpt-6-astra | ✓ gpt-6-astra（真值第 1） | ✗ gpt-6.1-sol（真值第 2） |
| gpt-5.4 | ✓ gpt-5.4（真值第 1） | ✗ deepseek-v4-pro（真值第 43） |
| gpt-5.5 | ✓ gpt-5.5（真值第 1） | ✓ gpt-5.5（真值第 1） |
| gpt-5.6-sol | ✓ gpt-5.6-sol（真值第 1） | ✓ gpt-5.6-sol（真值第 1） |
| gpt-5.6-terra | ✓ gpt-5.6-terra（真值第 1） | ✓ gpt-5.6-terra（真值第 1） |
| gpt-5.6-luna | ✓ gpt-5.6-luna（真值第 1） | ✓ gpt-5.6-luna（真值第 1） |

与上次报告不可直接比较：测试数据或评分代码不同，或尚无上次报告。

本次没有可列出的预测变动。

未获得有效回答：

- kimi-k2.8-preview group-1：HTTP 403：You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota（已记录 1 次尝试）
- kimi-k2.8-preview group-1：HTTP 403：You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota（已记录 1 次尝试）
- kimi-k2.8-preview group-1：HTTP 403：You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota（已记录 1 次尝试）
- kimi-k2.8-preview group-2：HTTP 403：You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota（已记录 1 次尝试）
- kimi-k2.8-preview group-2：HTTP 403：You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota（已记录 1 次尝试）
- kimi-k2.8-preview group-2：HTTP 403：You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota（已记录 1 次尝试）

未覆盖模型：无。疑似训练重合：0 条输出、0 条提示词。

用户授权的混用前缀修订：11 次，按实际尝试保留原始及新提示词。

采集当前输出上限：8192。历史请求上限与数量：{"4096":53,"8192":595,"32768":1}。用户更改上限前的完整回答保留；首次尝试指标使用首次已落盘记录，不包含切换配置时未完成落盘的在途请求。

每模型仅两组，结果用于观察回归，不代表稳定的真实准确率。测试集反复用于调整算法后属于回归验证集，不能继续作为一次性独立泛化评估。失败和缺失不从总计划组数中消失；条件准确率仅使用完整组。所有模型按记录的上游响应及渠道标签评估，不能据此独立认证后端身份。

报告时间：2026-09-30T17:11:11.277Z。参考数据 SHA-256：`5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4`。
