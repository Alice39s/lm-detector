# 通用序列指纹研究冻结包

本包保存 2026-09-30 至 2026-10-01 的离线研究、固定验证补全记录和第一轮冻结的通用排名组合。**这是研究提交，未修改产品评分或正式产品数据。**

选定组合为 0.5 局部通用重排、0.5 位置 LDA；只用 53 模型参考库的 636 个分组选择。参考分组命中 580/636。随后补全的固定验证有 104/106 个完整组、312/318 条有效回答；第一轮冻结组合由产品基线 81/104 提高到 88/104，修复 8 组、退步 1 组。唯一缺失型号为 Kimi 的两组，原渠道额度不足。Astra/Sol 的独立信号仍不足以支持高置信身份判断。完整结果及限定见下列报告。

## 离线运行

需要 Bun 1.4.2、Git、UV 和 Python ≥ 3.11。在项目 Git 根运行：

```sh
BUNDLE=research/sequence-generalization-20260930
bun "$BUNDLE/hydrate.ts"
uv run --no-project --with-requirements "$BUNDLE/requirements.txt" \
  python "$BUNDLE/infer.py" three-replies.json
```

输入为恰好三条回答的 JSON 数组；每条可为原文本或 1..355 的整数数组，至少 80 个有效整数。推断只加载已冻结参数，不入库、不训练、不请求 API。输出概率只适用于登记的 53 标签，使用参考库开发分数校准，不是经外部认证的身份概率。

`hydrate.ts` 从固定提交 `3389a6f3979c9298dbd9da4596c53fba7cddd7ce` 读取参考库，移除 overlay 所覆盖标签的原记录，按原字节顺序追加六个替换批次。必须重现 SHA-256 `5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4`。它仅写本包的 `source/` 生成文件，正式 `data/` 不变。浅克隆或单独复制本包时，需获取该 Git 提交，或传 `--base-reference FILE` 提供其原参考文件；文件 hash 仍须匹配。

重放最终固定验证并导出三套评估数据：

```sh
bun "$BUNDLE/source/research/scripts/evaluate-holdout.ts" \
  --output research/reports/replayed-holdout
bun "$BUNDLE/export.ts"
uv run --no-project --with-requirements "$BUNDLE/requirements.txt" \
  python "$BUNDLE/evaluate_frozen.py"
```

最终命中数应为固定验证 88/104、旧同渠道配对 19/40、v1 新直连配对 21/40。`generated/frozen-fusion-replay.json` 保存逐组分数和概率，`source/research/reports/replayed-holdout/` 保存产品基线重放结果。导出使用冻结的产品 bank 和 detector，均基于相同正式参考库；不使用验证回答拟合任何参数。

## 文件与依赖

- `inputs/reference-direct-overlay.jsonl`：六个型号的 216 条直连替换回答，约 1.32 MB。两版参考均为 53 标签、1948 回答，其余 47 标签逐字不变。
- `frozen/dependencies/`：原 bank 和 detector 的 gzip。解压后字节及 hash 必须与本轮基线完全一致；这是基线评分依赖，不是新产品评分实现。
- `frozen/artifacts/`：原融合及三个组件的 gzip。即使 dense 权重为零，原 loader 仍检查其 hash，因此该组件也保留；没有修改冻结 loader。
- `source/research/studies/`、`source/projects/offline/`、`source/projects/shared/`：保留原相对树和原源码字节。包含分组切分、特征、训练、校准和推断实现，以及本轮参考审计与采集维护源码。`source/tsconfig.json` 仅提供 Bun 的包路径映射。
- `source/research/evaluation/holdout/`、旧配对和 v1 prospective 目录：完整 manifest 与全部尝试记录，包含失败、403、重试及接纳历史。`inputs/datasets.json` 将三套资料标为 `purpose: holdout`、`training_allowed: false`；原 manifest 字节保持不变。
- `bundle.json`：复制来源、原始 hash、gzip hash、重放要求、冻结组合及省略清单。`refresh.ts --source-root DIR` 仅供原工作区维护者更新快照，本包不要求外层研究目录参与日常运行。

可检查原协议和冻结记录后从镜像中的研究源码重新运行参考 CV。大型网格缓存未包含，完整重算需要时间；请在本包副本中运行，避免覆盖冻结证据。原 `evaluate.py` 保留了五个候选的评估流程，但未随包保存未胜出的 `positional_ensemble` 权重；本包的 `evaluate_frozen.py` 专门重放第一轮冻结胜者与基线。

v2 `enriched.py` 是另外记录的探索：v1 prospective 曾在其衍生协议中转为开发材料，未产生达到预设门槛的发布参数。该过程不参与本包胜者训练、选择或校准；固定全库 holdout 从未作为训练输入。

## 证据边界

`inputs/raw-response-hashes.json` 索引尝试记录中已保存的独立原始响应路径、长度和 SHA-256。**模型完成响应的 raw stream 字节没有提交到本包。** 它们继续保留在原工作区的固定验证 raw-traces 与采集证据目录。一个小文件例外是六条 provider 元数据恢复记录：`source/research/reports/reference-repair-20260930/generation-provider-recovery/` 包含 generation GET 的 JSON 原文、响应元数据、proofs、adoption 和 plan，可离线核对 provider、模型、generation ID 及记录中的 hash；这些元数据不包含模型完成响应原文。历史两套匹配配对未保存独立 raw stream 文件，不编造其 hash。

大型候选数组、nested-cache、全部原直连 collection 和退役 Codex archive 均继续保留在原工作区。这里提交的完整文本尝试记录支持离线评分与选择规则重放，不等于提交完整原始网络证据。采集源码只作流程审计；离线命令不会执行它们，继续采集需另有明确授权及环境变量凭据。

## 报告

- `source/research/reports/sequence-generalization/20260930/REPORT.md`：当前综合结论；`REPORT-v1.md` 保留第一轮原评估。
- `source/research/reports/reference-repair-20260930/expanded-fusion-results.md`：104 个完整组的冻结组合与基线对比，含 104/104 基线预测一致核查。
- `source/research/reports/reference-repair-20260930/validation-integrity.md`：固定验证完整性及剩余 Kimi 缺口。
- `source/research/reports/reference-repair-20260930/training-anomaly-audit.md`：全训练 1948 条按产品现行“非空且 min ≥ 200”规则零命中，不需要异常样本重采。

所有参数和组合选择都发生在扩大固定验证之前。后续验证不会回写参数；不应根据这轮验证结果继续选择新组合并把同一批回答称为独立测试。
