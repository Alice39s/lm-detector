# 通用检测器第二轮研究

本包保存通用序列特征、来源平衡和分组分类器的继续研究。目标仍是完整的 53 模型库，并重点检查 gpt-6.1-sol 与 gpt-6-astra。**本提交提供冻结研究参数和可复核证据；产品评分和正式参考库未更新。**

完整方法、数据角色、识别结果和限制见 `source/research/reports/generic-refinement-20261001/REPORT.md`。第一轮研究包 `../sequence-generalization-20260930/` 是固定依赖，必须一起保留。

## 离线推断

从项目 Git 根运行，需 Bun、UV 和 Python ≥ 3.12（锁定的 NumPy 版本要求）：

```sh
FIRST=research/sequence-generalization-20260930
BUNDLE=research/generic-refinement-20261001
bun "$BUNDLE/hydrate.ts"
uv run --no-project --with-requirements "$FIRST/requirements.txt" \
  python "$BUNDLE/infer.py" three-replies.json
```

输入为恰好三条回答的 JSON 数组；每条是原文本或 1..355 的整数数组，至少 80 个有效整数。推断核查冻结 hash，加载全 53 标签排名器，不训练、不采集。输出的 development_probability 是开发材料上的封闭标签概率，不能当作经过认证的模型身份置信度。

`hydrate.ts` 核查相邻第一包的固定 hash，再还原本包压缩文件，建立七个相对目录链接。它只写两个研究包内的生成文件。Gitless 复制或浅克隆可传 `--base-reference FILE`；该文件必须通过第一包声明的原参考 SHA 核查。

## 重放已见资料

hydrate 会还原第一包早期的导出文件。因此重放最终 104 组固定验证前，必须先运行第一包的导出：

```sh
bun "$FIRST/export.ts"
uv run --no-project --with-requirements "$FIRST/requirements.txt" \
  python "$BUNDLE/source/research/studies/generic-refinement-20261001/evaluate.py" \
  --freeze "$BUNDLE/source/research/reports/generic-refinement-20261001/portfolio/freeze.json" \
  --artifact "$BUNDLE/source/research/reports/generic-refinement-20261001/portfolio/fitted.joblib" \
  --module portfolio \
  --calibration "$BUNDLE/source/research/reports/generic-refinement-20261001/portfolio/calibration.json" \
  --output "$BUNDLE/generated/seen-regression-replay.json"
```

固定验证回答始终只用于回归评估。旧 OpenRouter 配对和 v1 直连配对的 240 条回答，在本轮明确转为衍生开发材料：原 manifest 不变，新角色由 derived-development-manifest 和协议记录。新候选在这两套资料全量拟合后的命中是训练回代，不能称为独立验证。第一轮的参数没有使用这 240 条回答。

## 文件和证据边界

- `source/research/studies/generic-refinement-20261001/`：全部原研究源码、预先声明的网格、选择/校准协议和采集修订。候选、温度和原 62 个冻结输入在 v2 采集前锁定。
- `source/research/reports/generic-refinement-20261001/`：分组 OOF、候选数组、选择记录、全部原采集和补采尝试、冻结记录、完整性报告及结果。较大文件存于 `frozen/`，hydrate 后字节必须匹配 `bundle.json`。
- v2 共 20 个匹配轮次、60 条不同题目，两模型各回答三题，共 120 槽。先完成采集和完整性审计，再评分。采集器和验证器均不加载分类器。
- 补采修订只处理无有效回答的原槽，保持原题、型号、low reasoning 和请求 body；保留原尝试，采用第一个有效回答。原候选、原采集协议和原 verifier 字节不改。
- 原 verifier 的六个凭据形状误报来自 `item.encrypted_content` 随机密文。保留原失败报告和新解析式审计，其他完整性错误仍拒绝通过。
- **原始模型响应流未提交。** 原 `raw-traces` 和补采 `supplemental-raw-traces` 保留在原工作区；包内明确列出省略目录，并保留各次请求/响应的 hash、长度及完整文本尝试记录。包支持离线评分和记录核查，不能在缺少原响应流的副本中宣称完成网络原文重放。

`evaluate-blind.py` 需要原工作区中全部响应流的 combined-integrity 绑定才能执行。副本可检查已保存的结果、冻结 hash 和全部文本尝试；它不会自动放宽该门禁。`pack.ts` 只供维护者从原工作区重新制作快照，离线推断无需外层研究目录。
