# 研究资料

产品 monorepo 位于 [`../projects/`](../projects/README.md)。本目录保存研究代码、固定评估集、实验产物和历史报告。

本次审查从 [REVIEW.md](REVIEW.md) 开始。最新计划见 [PLAN.md](../PLAN.md)，支持域与置信度实验见 [studies/support-conditioned/](studies/support-conditioned/README.md)。组级校准后续流程见 [studies/group-calibration/](studies/group-calibration/README.md)。新实验源码统一放在 `studies/`，结果放在 `reports/<主题>/<运行>/`。

- `scripts/`：采集、训练、固定集评估和诊断脚本。
- `evaluation/`：固定测试集、旧尝试和未知模型回答。
- `reports/`：指标、冻结产物、历史部署和回退证据。
- `docs/`、`designs/`：方法说明和设计记录。
- `number-generation/`：数字生成机制研究。
- `archive/`：历史参考样本。
- 根目录 Python 文件：研究用指纹与建库实现。

## 运行

先从 `../projects/` 安装 Bun 依赖。以下命令从本目录运行：

```sh
bun run evaluate:holdout
bun run rebuild-bank
```

也可以从外层仓库根目录直接运行：

```sh
bun research/scripts/evaluate-holdout.ts
uv run --with-requirements research/requirements.txt python research/bank_builder.py --help
```

研究命令在本目录的 `package.json` 中。产品构建不执行研究脚本。修改 `../projects/data/unified_reference.jsonl` 后运行 `bun run rebuild-bank`，修改评分代码后运行 `bun run evaluate:holdout`，查看 `reports/holdout/latest.md`。

正式参考 JSONL 每行是一个批次，公共元数据与 `samples` 分开。Python 命令通过 `reference_data.py` 读取，TypeScript 使用共享 `parseReference`；旧参考行不再兼容。格式迁移也会改变文件哈希。只有证明有序评分输入和派生数值完全相同，才可在保留原训练记录及迁移证据后重新绑定冻结参数，不能直接跳过哈希校验。

评估只读取固定回答，不请求模型 API。只有明确要求采集时才运行 `bun run collect:holdout`。`evaluation/holdout/` 不能参与参考库、模型中心或校准。保留失败记录和旧尝试，不根据评分结果挑选回答。

重新采样已有固定集时，先在 `evaluation/holdout/manifest.json` 为目标型号设置 `provider_override.only`（单一供应商）与 `allow_fallbacks: false`，再设 `HOLDOUT_MODEL` 为逗号分隔的型号标签运行 `collect-holdout.ts --resample`；续采失败题使用 `--retry-failed`。`resample_from_attempt` 为每题记录本轮起始尝试，评估只选本轮首条合格回答；原尝试、旧源码哈希和提示词修订不覆盖。若采集代码迁移，`resample_source_hashes` 单独绑定新请求与解析实现，固定挑战生成器的哈希必须与旧集一致。仅修改个别题的推理档位时，在 `reasoning_revisions` 写入样本 ID 和生效尝试编号，每条请求保存实际路由、推理参数与返回供应商。

## 产品参数重训

维护入口已迁至 `../projects/`。入库并重建参考库后，从该目录运行 `bun run retrain --data-dir ./data`；独立 CLI 使用 `fpd retrain --data-dir DIR`。产品侧的 `offline/` 数值代码只读取目标目录的正式参考记录、指纹库和已有参数，不读取研究评估集。运行需要 `uv` 和 Python；CLI 本身使用 Bun/TypeScript。

每个模型按参考文件顺序选取 `query-01` 至 `query-36` 的首条回答。第 1–8 组建立核验参考，第 9–10 组拟合核验参数，第 11–12 组用于内部审查。产品排序器使用全部参考回答。校准按 12 个环境逐个留出，并用 66 个双环境留出完成嵌套验收；共重拟合排序器 78 次。首候选二元 NLL 必须低于同准确率常数，正确/错误 AUC 必须高于 0.75。

训练证据保存在目标目录 `.training/`。校准未通过、参考输入变化或来源哈希不匹配时，命令不会替换 `shared_detector.json`。成功后运行本目录的 `bun run evaluate:holdout`，查看 `reports/holdout/latest.md` 的覆盖率、识别结果和前后变化。随后从 `../projects/` 运行 `bun run build`。这些命令均不请求模型 API。

置信度仅为参考身份上的闭集概率，不包含库外概率，也不是接受阈值或身份认证。校准层绑定排序器、核验器、参考库和模型列表。核验器不匹配时，只保留基础排名。历史研究报告中的旧命令和冻结源码保留原样，供复现当时结果。

## 历史记录

历史 JSON、JSONL、冻结源码和报告保留原内容。它们记录的旧路径和源码哈希是当时的证据。当前产品代码和数据分别位于 `../projects/web/`、`../projects/cli/`、`../projects/shared/` 和 `../projects/data/`。

带冻结源码校验的历史实验可能需要重新生成实验快照。不要改写历史哈希来绕过检查。日常固定集评估直接读取当前正式库与固定回答。
