# 通用序列指纹研究

所有分类方法均对整个 53 标签模型库训练和评分。研究文件不修改产品参考库或评分器。

- [协议](PROTOCOL.md)
- [完整报告](../../reports/sequence-generalization/20260930/REPORT.md)
- [第一轮报告](../../reports/sequence-generalization/20260930/REPORT-v1.md)
- [补充训练复查](../../reports/sequence-generalization/20260930/enriched/report.md)
- [数据审计](../../reports/sequence-generalization/20260930/data-audit.md)
- [逐组冻结验证](../../reports/sequence-generalization/20260930/evaluation-results.json)

从仓库父目录运行：

```sh
bun research/studies/sequence-generalization/audit-data.ts
bun research/studies/sequence-generalization/verify-collection.ts
uv run --no-project --with numpy==2.5.3 --with scipy==1.17.1 --with scikit-learn==1.9.1 --with joblib --with threadpoolctl python research/studies/sequence-generalization/positional.py
uv run research/studies/sequence-generalization/classifiers.py
uv run research/studies/sequence-generalization/rerank.py
uv run research/studies/sequence-generalization/fusion.py
```

既有运行已冻结。上述训练命令重写对应分支的输出；审查第一轮时，直接读取现有 artifact 和报告。外部评分会拒绝与封存哈希不同的实现或 artifact。

对 JSON 文件中的三条回答文本或三个整数数组运行研究模型：

```sh
uv run --no-project --with numpy==2.5.3 --with scipy==1.17.1 --with scikit-learn==1.9.1 --with joblib --with threadpoolctl python research/studies/sequence-generalization/infer.py replies.json
```

输出的概率在库内 53 类之间归一化，不能用于认证上游身份或证明库外拒识。新渠道和新提示需要独立验证。
