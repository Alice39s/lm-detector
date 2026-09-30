import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { anomalousSamples, ANOMALOUS_MINIMUM } from '../../../projects/shared/sample-distribution'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { parseReference, referenceSamples } from '../../../projects/shared/reference'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const report = join(root, 'research/reports/reference-repair-20260930')
const baseline = join(report, 'baseline')
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const sources = ['unified_reference.jsonl', 'unified_bank.json', 'shared_detector.json', 'holdout-manifest.json', 'holdout-samples.jsonl']
const snapshot = Object.fromEntries(await Promise.all(sources.map(async name => [name, await readFile(join(baseline, name))])))
const batches = parseReference(snapshot['unified_reference.jsonl'].toString())
const flattened = [...referenceSamples(batches)]
const flaggedIndexes = anomalousSamples(flattened.map(({ sample }) => sample.text))
const validCount = flattened.filter(({ sample }) => parseNumbers(sample.text).length >= Math.max(80, Math.ceil(sample.expected_count * .55))).length
const stripCredentials = (endpoint: string | null) => {
  if (!endpoint) return endpoint
  const url = new URL(endpoint)
  url.username = ''; url.password = ''; url.search = ''; url.hash = ''
  return url.toString()
}
const flagged = flaggedIndexes.map(index => {
  const { batch, sample } = flattened[index]
  const numbers = parseNumbers(sample.text) as number[]
  return {label: batch.model.id, batch_id: batch.id, sample_id: sample.id, query_id: sample.challenge_id,
    condition: sample.condition, count: numbers.length, min: Math.min(...numbers), max: Math.max(...numbers),
    expected_count: sample.expected_count, source_channel: batch.source.channel, actual_channel: sample.actual_channel,
    effective_channel: sample.actual_channel ?? batch.source.channel, endpoint: stripCredentials(batch.source.endpoint),
    provider_reported: sample.provider_reported, requested_model: batch.request.model, response_model: sample.response_model,
    request_format: batch.request.format, reasoning_effort: sample.reasoning_effort ?? batch.request.reasoning_effort,
    prompt: sample.prompt, base_prompt: sample.base_prompt ?? null, user_prefix: sample.user_prefix ?? null,
    system_prompt: sample.system_prompt, attempt: sample.attempt, completion: sample.completion,
    started_at: sample.started_at, finished_at: sample.finished_at, original_evidence_path: sample.evidence_path,
    imported_from: batch.imported_from ?? null, text_sha256: sha(sample.text)}
})
const perModel = [...new Set(batches.map(batch => batch.model.id))].sort().map(label => {
  const sequences = flattened.filter(({batch}) => batch.model.id === label).map(({sample}) => parseNumbers(sample.text) as number[])
  const nonempty = sequences.filter(numbers => numbers.length)
  const minima = nonempty.map(numbers => Math.min(...numbers))
  const maxima = nonempty.map(numbers => Math.max(...numbers))
  const total = sequences.reduce((sum, numbers) => sum + numbers.length, 0)
  const below = sequences.reduce((sum, numbers) => sum + numbers.filter(number => number < ANOMALOUS_MINIMUM).length, 0)
  return {label, samples: sequences.length, flagged: flagged.filter(sample => sample.label === label).length,
    parsed_numbers: total, below_200_count: below, below_200_fraction: total ? below / total : null,
    min: minima.length ? Math.min(...minima) : null, max: maxima.length ? Math.max(...maxima) : null,
    sample_min_range: minima.length ? [Math.min(...minima), Math.max(...minima)] : null,
    sample_max_range: maxima.length ? [Math.min(...maxima), Math.max(...maxima)] : null}
})
const liveReference = await readFile(join(root, 'projects/data/unified_reference.jsonl'))
const sourceHashes = Object.fromEntries(await Promise.all([
  'projects/shared/sample-distribution.ts', 'projects/shared/fingerprint-core.js',
  'projects/web/src/routes/detect.tsx', 'projects/cli/detect-ui.tsx', 'projects/cli/detect-run.ts',
  'projects/cli/sampling.ts', 'projects/cli/enrollment.ts',
].map(async file => [file, sha(await readFile(join(root, file)))])))
const result = {scope: 'Formal reference training samples in the frozen baseline; no evaluation samples included',
  rule: {function: 'anomalousSamples', parser: 'parseNumbers', nonempty_required: true, minimum_inclusive: ANOMALOUS_MINIMUM},
  input_snapshot: Object.fromEntries(sources.map(name => [`research/reports/reference-repair-20260930/baseline/${name}`, sha(snapshot[name])])),
  live_reference_sha256: sha(liveReference), baseline_matches_live_reference: sha(snapshot['unified_reference.jsonl']) === sha(liveReference),
  source_sha256: sourceHashes, batches: batches.length, models: perModel.length, training_samples: flattened.length,
  scorable_training_samples: validCount, flagged_count: flagged.length, flagged, per_model: perModel,
  flagged_fields: ['label', 'batch_id', 'sample_id', 'query_id', 'condition', 'count', 'min', 'max', 'expected_count',
    'source_channel', 'actual_channel', 'effective_channel', 'endpoint', 'provider_reported', 'requested_model',
    'response_model', 'request_format', 'reasoning_effort', 'prompt', 'base_prompt', 'user_prefix', 'system_prompt',
    'attempt', 'completion', 'started_at', 'finished_at', 'original_evidence_path', 'imported_from', 'text_sha256'],
  new_api_calls: 0, shared_data_modified: false}
await mkdir(report, {recursive: true})
await writeFile(join(report, 'training-anomaly-audit.json'), JSON.stringify(result, null, 2) + '\n')
const hashes = Object.entries(result.input_snapshot).map(([file, hash]) => `| \`${file}\` | \`${hash}\` |`).join('\n')
const table = perModel.map(row => `| ${row.label} | ${row.samples} | ${row.flagged} |`).join('\n')
const deepSeekTable = perModel.filter(row => row.label.startsWith('deepseek-v4-pro')).map(row =>
  `| ${row.label} | ${row.samples} | ${row.flagged} | ${row.parsed_numbers} | ${row.below_200_count} | ${((row.below_200_fraction ?? 0) * 100).toFixed(4)}% | ${row.sample_min_range?.join('–')} |`).join('\n')
const details = flagged.length
  ? flagged.map(row => `### ${row.label}: ${row.query_id}\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\``).join('\n\n')
  : '无命中样本。逐条详情集合为 `[]`，不需要改提示词重采或替换训练样本。'
await writeFile(join(report, 'training-anomaly-audit.md'), `# 训练样本频率异常审计（2026-09-30）

全训练库 **${flattened.length} 条回答、${perModel.length} 个模型、${batches.length} 个批次，按当前产品规则命中 ${flagged.length} 条**。全部 ${validCount} 条满足产品评分的有效数字数量门槛。${result.baseline_matches_live_reference ? '冻结快照与审计时的正式参考库 SHA-256 一致。' : '正式参考库已不同于冻结快照；本报告仅针对所列快照。'}

本报告直接调用 \`projects/shared/sample-distribution.ts\` 的 \`anomalousSamples\`，其内部调用产品 \`parseNumbers\`。唯一判定条件为：解析后的有效数字序列非空，且最小值 **≥ ${ANOMALOUS_MINIMUM}**。扫描包含全训练库，不根据分类结果或模型标签筛选。没有扩大到其他异常规则。

## 命中样本

${details}

JSON 报告为命中样本预留标签、批次、query、condition、有效数字 count/min/max、实际及记录来源、provider、请求及返回 model、reasoning、原始提示和证据路径等字段；本次集合为空。没有读取或输出任何凭据。

## Web 与 CLI 的实际调用

- Web：\`projects/web/src/routes/detect.tsx:25\` 导入同一个 \`anomalousSamples\`；\`:265\` 在显示结果时仅传入 diagnostics.accepted 的回答文本，其他文本传空串。
- CLI：\`projects/cli/detect-ui.tsx:4\` 导入同一个函数；\`:76\` 对已有分析结果的 outputs 调用。\`projects/cli/detect-run.ts:68\` 与 \`:119\` 已将未接纳回答的输出文本置为空串。
- 两端没有各自实现阈值或数字解析。两端使用同一 ≥ 200、非空规则。

## DeepSeek v4 Pro 的数值覆盖

以下是相同解析结果的描述统计，不构成新异常规则。两版参考样本都包含大量小于 200 的数字，因此按当前规则无命中。JSON 另为每个模型保存同样的总数、低于 200 的计数及比例、整体 min/max 和逐条 min/max 范围。

| 标签 | 训练回答 | 命中 | 有效数字总数 | 小于 200 | 比例 | 每条最小值范围 |
|---|---:|---:|---:|---:|---:|---:|
${deepSeekTable}

## 未来定点替换的最小约束

本次无命中，所以不执行替换。若未来同一规则出现命中，保留原批次、所有原始及失败尝试；先将正式参考和派生数据归档，并按 sample ID 定点替换。新的回答使用新的批次 ID，保持公开标签、query ID、expected_count 和实际 provider / request model / response model / reasoning 的记录。只改受影响提示；保留原提示、修订理由和实际生效尝试编号。

当前 CLI 的 \`schema_version: 1\` / \`purpose: reference\` 批次包含 model、source、request、plan 和 samples。采集目录保存不可随意修改的 manifest fingerprint、\`attempts/query-XX/NNNN.json\`、\`trace/query-XX/NNNN\`、\`attempts.jsonl\` 和 \`result.json\`。已选中的挑战不能在原批次上 refine，源码要求创建新批次。enroll 会追加并去重，不会删除旧参考；直接 enroll 新回答不会完成坏样本替换。完成定点替换后必须重建 bank、重训匹配的评分及校准参数，并运行固定 holdout 离线评估。

## 各模型覆盖

| 标签 | 训练回答 | 命中 |
|---|---:|---:|
${table}

## 冻结快照 SHA-256

| 文件 | SHA-256 |
|---|---|
${hashes}

运行：\`bun research/studies/reference-repair-20260930/audit.ts\`。脚本只读取正式数据和 baseline 快照，只写本报告目录的审计 JSON / Markdown。不调用模型 API，不改共享数据，也不运行或新增测试。
`)
console.log(JSON.stringify({training_samples: result.training_samples, models: result.models,
  flagged: result.flagged_count, scorable: result.scorable_training_samples,
  baseline_matches_live_reference: result.baseline_matches_live_reference,
  reference_sha256: result.live_reference_sha256,
  report: 'research/reports/reference-repair-20260930/training-anomaly-audit.md'}))
