# Kimi 与 Step 原渠道只读审计

两项原渠道的历史用户凭据记录都仍存在。常用本地配置没有这两个渠道的凭据；历史凭据是否仍有效尚未验证。本审计没有发起 API 请求、修改参考库或固定验证集，也没有输出或保存凭据内容。

基线参考库 SHA-256 为 `5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4`，对应 `baseline/unified_reference.jsonl`。完整来源、逐条原始证据路径、配置检查和源码 hash 在同目录 `original-sources-audit.json`。

| 参考标签 | 原渠道 | 完整请求端点 | 请求及返回模型 | 训练回答 | reasoning |
|---|---|---|---|---:|---|
| kimi-k2.8-preview | kimi-code-subscription | https://api.kimi.com/coding/v1/chat/completions | kimi-for-coding | 36 | 36 low |
| step-5-preview | stepfun-api | https://api.stepfun.com/step_plan/v1/chat/completions | step-5-preview | 36 | 34 default、2 low |

两项都使用 Chat Completions、stream 和 max_tokens 8192。其样本的 `provider_reported` 均为空；旧清单的 Moonshot AI / StepFun provider 属于已记录的声明来源。Kimi 的参考标签由原用户指定，响应名仅为 `kimi-for-coding`，不能单靠该别名确认当前后端版本仍为 k2.8。补采应保存本次实际返回的模型和渠道证据。

## 原采集与凭据存在状态

Kimi 原批次仍在 `projects/runs/kimi-k2.8-preview-low-20260917/`，批次 ID `bdb4d5fb-3380-46fe-8bdc-af7bafce70b2`。36 道挑战、36 次尝试、36 条接纳；manifest SHA-256 为 `051ff9aaa5a7509065d7dd1f68ea25d8381edf755f48c58e5ccc858246e53b8a`。

其历史用户消息位于 `/Users/ikaleio/.omp/agent/sessions/-Projects-lm-fingerpoint-detector/2026-09-17T07-24-19-560Z_01a0ae40-86e8-7133-8348-eb991b278f49.jsonl` 第 34 行 `message.content[0].text`，存在原用户给的入口和凭据。第 46 行明确要求 k2.8 low，入库标签 `kimi-k2.8-preview`。本报告仅记录存在状态。

Step 原批次在 `projects/data/collections/step-5-preview-20260922/`，批次 ID `5711a935-3ead-4bcd-9662-afd23f90c36a`。主批次接纳 34 条、54 次尝试，另在 `projects/data/collections/step-5-preview-20260922-low-recovery/` 保留两道 low 重试。主 manifest SHA-256 为 `d3ffcb4497f5b7987446b61458881cbeb9418754858368c254db9a3be2cd8b62`。

其历史用户消息位于 `/Users/ikaleio/.codex/sessions/2026/09/22/rollout-2026-09-22T20-41-51-01a0c923-088a-7881-a2f9-196a93997bfd.jsonl` 第 9 行 `payload.content[0].text`，存在原用户给的入口、凭据和模型。凭据是该消息第二文本行；本报告仅记录存在状态。

检查的常用配置包括 `projects/.env`、`/Users/ikaleio/.pi/agent/auth.json`、`/Users/ikaleio/.omp/agent/models.yml`、`config.yml`、`.env` 和 `agent.db`。项目环境文件仅配置 OpenRouter，Pi auth 为空，OMP 自定义 provider 为 Monoize，OMP auth_credentials 表为零条；没有 Kimi / Step 的现配凭据，也没有相关当前环境变量。PATH 中未发现 kimi / step / stepfun 专用 CLI。

## 当前 CLI 与固定验证集

当前参考采集 CLI 已支持这些非 OpenRouter 渠道：`projects/shared/reference.ts` 接受 `kimi-code-subscription` 和 `stepfun-api`；`projects/cli/sampling.ts` 仅向真正的 OpenRouter 路由注入 provider 固定设置。其他端点沿普通直接 HTTP 传输，使用实际请求模型和 reasoning。`--subscription` 标记本身不提供 Kimi 登录传输，Kimi 仍需显式的 API 凭据。

新参考批次使用 `schema_version: 1`、`purpose: reference`；model.id 与 request.model 分开记录。旧 Kimi 和两项 Step 批次都是 `fingerpoint-collection-v2` / `reference-collection`，当前 loadManifest 不直接支持续采旧格式。应创建新批次并保留旧目录。参考采集参数可以分别使用：

```sh
# API_KEY 由原凭据安全加载到进程环境；命令和 manifest 不含凭据值。
bun projects/cli/fpd.ts sample -b https://api.kimi.com/coding/v1 \
  -m kimi-for-coding -a cc -e low --label kimi-k2.8-preview \
  --family kimi --family-name Kimi --channel kimi-code-subscription \
  --subscription --response-model kimi-for-coding --output-dir runs/kimi-new

bun projects/cli/fpd.ts sample -b https://api.stepfun.com/step_plan/v1 \
  -m step-5-preview -a cc -e default --label step-5-preview \
  --family step --family-name Step --channel stepfun-api \
  --response-model step-5-preview --output-dir runs/step-new
```

这些命令用于参考采集说明，不用于固定验证集；本审计没有执行它们。固定验证集必须继续使用原 manifest 的两组三道挑战，不能换成参考 CLI 的 36 道训练挑战，也不能 enroll 验证回答。

当前 `research/scripts/holdout-shared.ts` 的 Target 和 `collect-holdout.ts` 仍固定 OpenRouter 的 endpoint、key、catalog 与 provenance。兼容原渠道的最小扩展是为 target 增加 endpoint、source_channel、response_models 和实际 reasoning 参数，并按端点选择凭据；OpenRouter catalogue / provider_only 只用于 OpenRouter targets。直接 Chat Completions 的 low 应写 `reasoning_effort: low`，不要沿用 OpenRouter `reasoning: {effort: low}`。

每次直接验证尝试需记录 `purpose: holdout`、原 test_set_id / sample_id、原 challenge、真实 endpoint、source_channel、api_model、实际返回模型、请求体、原始 trace hash 和 collection_run_id。非 OpenRouter targets 不应填写伪造的 OpenRouter canonical_slug、provider_route 或 trust_basis；原历史及失败尝试继续保留。不能用 K2.7 Code 或 Step 3.7 替换这些参考标签。

运行 `bun research/studies/reference-repair-20260930/original-sources.ts` 可重新生成 JSON；脚本只让凭据存在布尔值离开内存。当前有效性由获授权的主采集流程验证。
