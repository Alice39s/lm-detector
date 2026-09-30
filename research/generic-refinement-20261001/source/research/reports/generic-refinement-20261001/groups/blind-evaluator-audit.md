# v2 技术补采盲测评估审计

当前 evaluator、retry 协议/worker、combined verifier 的定版源码和补采准备元数据审计通过。原 Responses encrypted_content 的六条旧正则误报已通过限定路径/原SHA的解析式审计重新分类，原报告和冻结未改。补采正在进行；结束后仍需默认 strict combined-integrity=complete、120slots/40groups才能评分。未执行盲测评分，没有读取新回答的分类结果，也没有调用 API、修改候选或原冻结。

## 原冻结与题集

原 portfolio/freeze.json SHA-256 为 `63365f1b27657bb3d42137e44931a95320fedcad8c1330d104300f31f4fd5b4d`。其 62 个文件哈希全部与当前字节一致；v2 manifest 的 candidate_freeze_sha256 和完整嵌入 freeze 内容也一致。排名 artifact 与开发温度仍受原冻结约束。

manifest 和 collection-protocol 的 rounds/models 逐结构相同：gpt-6-astra、gpt-6.1-sol 两模型共享 20 个轮次，每轮三个挑战，共 60 个唯一 prompt、120 个计划回答和40个三回答组。技术补采必须继续同一缺失 slot，不改变挑战、prompt、requested_model、low reasoning、8192输出上限或 expected-count cap。

## evaluate-blind.py 源码

评分前先要求 combined-integrity schema 正确、status=complete、errors为空、120个accepted slots和40个完整组，并逐一核查审计 bindings、原 freeze SHA 和全部原冻结文件哈希。随后读取显式 adoption，每个 slot 只允许一个 accepted attempt；检查所有来源中是否存在更早 accepted attempt，再核对每个计划回答的 model/round/challenge/prompt 及 Python 整数解析 SHA。只有全部门禁通过后才加载排名器和执行评分。

候选和第一冻结融合必须使用相同全库标签顺序/参考 SHA。开发温度还要求其 artifact_sha256 与实际候选一致。候选推理仍通过 portfolio 全53标签，不使用两标签子集作为主排名；旧 metrics 的 pair_binary_accuracy 只是诊断。

current_product 没有温度。代码为共用 metrics 临时计算 softmax，但在输出前移除 selected、NLL、Brier、ECE，以及每条预测的 top/truth probability 和 probability vector。accuracy、Top3、rank、原分数和匹配轮次的 accuracy bootstrap 不依赖该临时概率。因此不会将产品原始分数宣称为已校准身份概率。

## 15回答聚合与补充建议

旧 disjoint_accumulation 按 manifest 顺序，对每模型每五个三回答组平均分数。20轮产生每模型4块、两模型合计8条判断，但双方使用相同四个轮次块，只有4个matched paired clusters。每个原始轮次只进入一块；聚合只输出accuracy，没有重新拟合温度或输出聚合高置信概率。3回答结果的40条判断同样只有20个matched clusters。

根代理已在新评估输出显式标记 paired_clusters=4（15回答）和20（3回答），避免将total=8当作8个独立观测；新增53个唯一 gallery IDs和每种分数的40×53 finite断言也已只读核对。

实际 metrics/disjoint_accumulation 来自第一 bundle 的 `source/research/studies/sequence-generalization/evaluate.py`：source_robust 在 import 时把该目录置于 sys.path 前端。verify-overload 已将实际 helper及新 evaluate-blind.py 加入 bindings；原冻结保持不改。combined verifier 同时绑定原/supplemental manifest、samples、adoption、协议、源版本和所有原/补采 raw 文件，在 raw 重放及 adoption 落盘后再次逐hash检查；原和补采活动锁均阻止完整状态。

## retry/combined 源码核查

retry-overload-protocol 声明只对原固定题集中未accepted、两次原attempt均保留的缺失slot增加尝试3/4/5。准备阶段先运行原冻结verifier，绑定原manifest/samples/freeze/raw字节和精确missing jobs，再写独立supplemental plan；不更改原记录。请求body和endpoint逐结构复制原attempt，原concurrency=4/max_attempts=2仍作为原profile保留，新操作profile另记concurrency=1、总预算5、退避5/15/30秒、timeout600秒。身份、cap、最低数量和历史/先前attempt去重规则保持原定义，没有分类器导入或按识别分数重试。

审计发现初始worker strict audit曾先拒绝未登记的中断raw，导致后续离线recovery不可达。负责人已修复：仅worker恢复入口允许未accepted的计划slot、从next连续3..5编号、与原固定request完全相同的四种既定trace文件；恢复append后、读取API key之前重新strict audit。未知路径或accepted之后的新trace仍拒绝。verify-overload 始终使用默认strict audit，不允许未登记raw通过最终门禁。

combined verifier 对各supplemental attempt重放原response bytes和content-type，核对请求/模型/来源/文本/整数/hash/cap/usage/finish等字段，重算eligibility及跨原/补采的chronological duplicates。不允许accepted之后再请求。adoption按原120jobs顺序，只保存来源、attempt、truth身份和文本/整数SHA，不含预测。完整状态要求120slots、40组三回答、60 common challenges且每题两个模型prompt相同，所有源/raw绑定再次验证后才写complete。

## 定版凭据修订与准备状态

loadOriginal 仍执行原冻结verifier，并保留其六条告警和原失败报告。新auditOriginalCredentials要求legacy errors恰好等于协议的六条literal错误，且保存报告的manifest/samples/freeze/verifier SHA与当前原审计相同；任何其他原错误仍然致命。例外还必须对应指定sample/attempt/raw_response SHA，以及root独立实际密钥比对的同一proof；不会以字符串包含encrypted_content就宽泛忽略检查。

JSON/SSE扫描只在response body、字段名encrypted_content、parent.type=reasoning且整值匹配gAAAA前缀base64包络时允许credential-shaped子串；六个原例外还要求解析路径精确为item.encrypted_content。plaintext、auth字段、无法解析的含sk片段以及SSE非data行中的含sk文本仍拒绝。解析只改变审计判断，不改变原bytes或完成状态。

只读扫描原392个proof文件（382个request/response/metadata及10个transport-error文件），其SHA/byte count全部匹配，parsed credential issues为空。六个typed ciphertext proof逐项属于固定allowlist；root原382文件审计与新增10个transport审计的proof/计数均吻合，实际密钥泄露为0是root比对声明，审计没有读取密钥值。原62个冻结文件再次逐hash通过。

supplemental prepare已固定四个缺失slot，plan SHA为`b4529947ab9df4dcb65ef406676a4bcbdf24b282d0b260e0f94a8154c76ff0a8`，审计复算一致。原profile的8192输出上限、concurrency=4和max_attempts=2保持；额外操作attempts=[3,4,5]另记。三个定版源的当前SHA与plan.source_hashes一致：

- retry-overload.ts：`132abf5ba23fc404fcee8c558cb7330269b2eac0d52599af70373392dbec589e`。
- verify-overload.ts：`f740f4957ed100946ff8de5484b5c84c3bb4ace99a2923badc95b1fbe1d302d2`。
- retry-overload-protocol.json：`5200063023b1c5c7e96f0a413642b4514a4b1c04f1d83d1799523d97050427b8`。
- evaluate-blind.py：`ece2b9d93f149e820c288d8d1bdaa771fb0441a5440f14aa762512c7bd64db55`。

## 综合报告基础部分

REPORT的30+30+11+35+13+13等于132个网格条目；portfolio的37条目来自已有11+13+13，没有重复当作新实验。完整716×53数组逐字节去重得到35个不同分数配置，三次相同基线形成两条重复记录；报告已明确37条目/35配置。

宏Top1增量乘100为0.0137578616352个百分点，报告的0.01376正确。旧240条匹配资料进入新来源头训练及开发选择，因此35/40、38/40的全量拟合回代不能支持泛化；报告已排除这种解释。固定104回归覆盖52个truth标签而gallery仍53，Kimi缺失、20/4匹配clusters和开发温度身份解释边界均明确。旧metrics的逐组二项精度下界尚未校正同题双模型相关性，只能作探索诊断；15回答聚合不输出其概率或高置信下界。本次未读取新blind分类结果。
