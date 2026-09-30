补采作为操作修订单独记录，候选和识别参数没有改变。原采集结束后有 134 个保留尝试、116 个合格位置和 4 个缺失位置；补采计划只能在原 run 完成且 lock 释放后，依据固定接纳规则确定缺失位置，不能读取分类分数。此次修订将总物理尝试预算由 2 增至 5，另设串行调度及尝试 3／4／5 前的固定 5／15／30 秒退避。

原 manifest、samples、collector、verifier、挑战协议和 62 项候选 freeze 的字节全部保留。新增文件为 `retry-overload.ts`、`retry-overload-protocol.json`、`verify-overload.ts`；实际补采另写 `supplemental-manifest.json`、`supplemental-samples.jsonl` 和 `supplemental-raw-traces/`，避免影响冻结的原 verifier。旧 attempt 1／2 与所有新 attempt 3…5 均保留；原 request body、prompt、model、endpoint、low、8192、600 秒超时和 expected-count cap 不变。原并发 4／预算 2 的 profile 原样记录，额外并发 1／预算 3 单独记录为 operational profile。

| 新文件 | 定版 SHA256 |
|---|---|
| `retry-overload.ts` | `132abf5ba23fc404fcee8c558cb7330269b2eac0d52599af70373392dbec589e` |
| `verify-overload.ts` | `f740f4957ed100946ff8de5484b5c84c3bb4ace99a2923badc95b1fbe1d302d2` |
| `retry-overload-protocol.json` | `5200063023b1c5c7e96f0a413642b4514a4b1c04f1d83d1799523d97050427b8` |

`--prepare-only` 不读取 key、不调用模型；它重放原 verifier，并把 exact missing IDs、原输入字节 SHA、原请求和新源码／协议 SHA 固定进 supplemental manifest。实际生成必须另行执行，没有 manifest 不能开始。身份错配不得绕过原门禁或更换 model。按原 min count、completion、cap、exact／dated response model 及历史和先前尝试的正文／整数序列去重规则接纳第一合格回答；没有 classifier 依赖或分数重试分支。

原 verifier 因宽泛 `sk[-_]` 正则在 Responses `item.encrypted_content` 中产生六个误报。原失败报告保存于 `original-integrity-before-secret-reclassification.json`，不改写。新协议固定六个 sample ID／attempt／原 body SHA／literal error。独立解析审计要求匹配字符串位于 `encrypted_content`、父对象 `type: reasoning`，整个值符合 `gAAAA` 前缀 base64 envelope；原例外还只接受 `item.encrypted_content` 这个路径。JSON 以外的含凭据形状片段、SSE 的非 data 事件／注释行、普通正文和认证字段仍导致失败，原报告其他错误不允许重新分类。

root 的 `secret-shape-audit.json` 记录 382 个 request／body／metadata proof、六个密文误报，以及四把实际授权 key 的比对泄露数 0；`transport-secret-audit.json` 另记录十个 transport-error proof 和实际 key 比对泄露数 0。新审计分别核对 382／10 的计数、每个 proof 的路径和 SHA，并严格扫描全部 392 个 evidence。三份 root 说明均进入新 binding。此子代理没有读取、保存或显示实际 key；实际 key 比对来自 root 保存的证据说明。原失败状态和六个错误继续完整展示在 combined report 的 original-integrity 元数据中。

静态审计发现并修复了崩溃恢复的门禁冲突：初始 worker 审查只允许尚未接纳的固定位置、下一连续 attempt 3…5、完全相同原请求的四种已知 orphan trace 文件。恢复为独立记录后，在读取 key 前重新执行严格审查。最终 verifier 从不允许未登记 trace，也拒绝合格位置之后的新物理请求。原 API 401／402／403 与补采中断会暂停新请求，保留 run 和 raw，只能显式 resume。

最终 `verify-overload.ts` 先重放原审查，再逐条严格重放补采 request／response／metadata／transport error，核对所有原字节、实际型号、正文、序列、完成状态、cap、usage、先后去重和 attempt 唯一性。合并后必须闭合原 120 个位置、40 个三回答组、60 个双方共同挑战。只有完整时才生成按原计划顺序排列、没有预测字段的 `adoption.json`，并输出 `combined-integrity.json`。其 bindings 包含全部原 freeze、四个原／补记录文件、原／新 collector 和 verifier、两份协议、解析依赖、所有 raw proof、三份 root 审计说明、blind-only evaluator、真实固定 metrics helper 和 adoption。

两个新增 Bun 入口构建通过，独立审阅确认恢复门禁和精确密文审计的限定。源码修订前后快照在 `source-revisions/`。本子代理没有执行实际补采、模型 API、分类识别、Git 或测试；完整合并审查仍须由 root 在补采结束后运行。这一操作修订不会被称为模型重拟合或基于盲测结果选参。
