静态协议审计通过。修复后的评估器要求独立完整性报告通过并重新核对文件 SHA，才读取 v2 回答进行识别。盲采尚未完成，本审计不声称已经验证其完整性、命中率或模型身份置信度。审计过程中没有模型 API 请求、Git 操作、测试文件或盲测识别分数读取。

审阅范围为 `PORTFOLIO_PROTOCOL.md`、`CALIBRATION_PROTOCOL.md`、`evaluate.py`、`calibrate.py`、`collect.ts`、`collection-protocol.json` 和 `verify-prospective.ts`。历史参考、固定 holdout 和两批旧配对文本只用于预声明的 prompt／正文／整数序列去重，没有读取它们的识别结果来修改挑战或选择候选。

| 文件 | 审计时 SHA256 |
|---|---|
| `PORTFOLIO_PROTOCOL.md` | `33191e4abb3c7a067e77e4bf412a557a77aaa6813cebd7888e28a8a16fee51e2` |
| `CALIBRATION_PROTOCOL.md` | `282253087eaf7339fc537883b2622f13a299d789e458c406d7285711dd9d4772` |
| `evaluate.py` | `4595201ec6fb86cb80f069d4c722a09345eb19d0c381fcdfd22bd00c5f3abce2` |
| `calibrate.py` | `af23c277dd96f22d07bb3a6e2b1abb0e69c275d6482b559065b1e5a8b1032708` |
| `collect.ts` | `eeae98572adc006b867a5faf6def2b3e44a61c4149b7b971d1f4227d3fb17ad4` |
| `verify-prospective.ts` | `b3f313b48e35bee831dd443547b9066dd9b47e54fc8e3109ccb583c0072d94f9` |
| `collection-protocol.json` | `4ad53fad0eb1cdd1eb62a83c64ffd0042486a1865f456de5eea291270d97494f` |

候选协议预先限定三个分支最多 37 项，按全部 53 标签等权、标签内部实际来源等权的 Macro Top-1 选择；同样加权的 MRR 和固定配置顺序用于打破平局。旧配对资料明确转为开发资料，固定 holdout 没有参与拟合或温度校准。该协议不会把仅影响两个标签的额外来源题数当作全库命中提升。此项审计核对协议和代码的接口，不复核候选排序数值；分支去重和均衡由另一独立审计负责。

校准器拟合单一全库 beta，对标签 (m)、其实际来源 (d) 的每条 OOF 组赋权 `1 / (53 × 该标签来源数 × 该来源组数)`，最小化 `logsumexp(beta * scores) - beta * truth_score` 的加权平均。权重总和检查为 1。输入要求 716×53 有限分数、716 个唯一 OOF group ID、整数 truth 0…52，并核对每组标签及普通字典 artifact 的模型顺序和固定参考 SHA。代码没有目标两标签专属温度或按外评置信阈值选择参数。开发温度不等于经过外部验证的身份概率。

本次发现并已核对修复的评估流程问题如下：

- collector 的候选绑定原先只存在于 `frozen_candidate.sha256`，而 evaluator 读取顶层 `candidate_freeze_sha256`；collector 已同时记录两者，verifier 验证其相同。
- 原 evaluator 可以跳过未闭合轮次直接评分。现在必须有 `status: complete`、无错误、120 个计划位置、40 个完整三回答组、无活动 lock、最后 run 完成且无 halt 的独立完整性报告。
- evaluator 重新核对 manifest、samples、freeze、verifier、collector、protocol 及当前采集依赖 SHA；Python 从原文重新解析整数，并与采集器的 compact JSON sequence SHA 核对。
- 未校准的产品分数曾被临时 softmax 后保留 NLL／Brier／ECE。现在删除这些概率指标及对应预测概率，只保留识别指标。
- v2 聚合原先继承 1／2／3／5 轮。现在仅报告预声明的每轮 3 回答，以及固定连续 5 轮的 15 回答组。路径参数在使用 `relative_to(ROOT)` 前已 resolve。

v2 的 60 个挑战已一次性固定为 20 轮、每轮 3 个，共同用于两个请求模型。所有挑战使用相同新增中性前缀；审计修复没有改动任何 prompt、长度或 grid。请求为直接 OpenAI Responses、low、stream、`store: false`、8192 输出额度，4 并发、600 秒超时、每位置最多 2 次尝试。允许响应型号为 exact requested ID 或同型号日期后缀，保留 `requested_model` 与真实 `actual_model`，不采用跨型号别名。

采集器在读取 `API_KEY_FILE` 前核对候选 freeze 的全部 hash。manifest 首次绑定完整 freeze、采集源码及协议 SHA；resume 不允许切换候选或代码。没有命令行明文 key 或环境 key fallback，网络重定向按 error 处理。trace 只保存 URL、request body、status、content type、request ID 和实际收到的响应字节，不保存认证头。错误中的 key 会被遮盖，verifier 不读取任何凭据，也不请求网络。

用户授权的 cap 使用既有 `readCompletion(..., expected_count)`：只保留前 expected_count 个完整解析整数；原始 request 仍为 8192，正文、completion、finish_reason、capped、max_numbers 和选择政策均记录。自然完整的短回答沿用预声明的 `max(80, ceil(0.55 × expected_count))` 门槛。第一合格尝试按这些规则接纳，历史或任何更早本轮尝试的同正文／同整数序列重复会记 invalid 并保留；不会根据分类分数重试或挑选输出。

每次尝试都保存原始 request、response metadata、body 和可用的 transport-error proof。未写入 JSONL 的崩溃 trace 在 resume 前离线重放，仍按同一规则决定是否合格。401／402／403 暂停新请求，显式 `--resume` 才继续剩余额度。历史 paused／failed run 不覆写；历史 crashed running run 由后续 finished run 的 `supersedes_interrupted_runs` 明确闭合。verifier 检查所有物理尝试的唯一身份、请求参数、源码和冻结绑定，逐条重放原字节，核对正文／整数序列／型号／完成状态／usage，并拒绝未登记的 raw 证据。

collector 修复前 SHA 为 `bd277abd86b0821d62b04590c07a04013b0d11cb8511466120e72fe74beb93e4`。原版本和两个最终源码快照保存在 `research/studies/generic-refinement-20261001/source-revisions/`。最终两个 Bun 入口构建通过，两个 Python 文件通过 AST 语法检查。对刻意没有 manifest／samples 的目录运行只读 verifier，结果为 `incomplete`、errors 0、识别和 API 调用 0；该 preflight 只证明缺数据时关闭评分入口，完整 raw 重放仍须在实际采集完成后执行。

最终 `integrity.json` 必须由固定版本 verifier 生成，状态完整且所有 SHA 仍一致，才允许评估。20 个共同轮次是主要匹配单位；15 回答聚合只有 4 个配对块、8 个模型组，不应把 8 个组当作独立题来宣称身份置信下界。继承评估器中的概率阈值下界是二项观察统计，跨模型共同 prompt 的依赖需要与轮次聚类区间一起解释。三回答组的开发温度没有为 15 回答重新校准。
