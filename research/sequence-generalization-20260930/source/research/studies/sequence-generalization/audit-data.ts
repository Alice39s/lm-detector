import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { parseReference } from '../../../projects/shared/reference.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = join(root, 'research/reports/sequence-generalization/20260930')
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const paths = {
  reference: 'projects/data/unified_reference.jsonl',
  bank: 'projects/data/unified_bank.json',
  detector: 'projects/data/shared_detector.json',
  holdoutManifest: 'research/evaluation/holdout/manifest.json',
  holdoutSamples: 'research/evaluation/holdout/samples.jsonl',
  pairedManifest: 'research/reports/astra-sol-separation/paired-low-01/manifest.json',
  pairedSamples: 'research/reports/astra-sol-separation/paired-low-01/samples.jsonl',
  trapSamples: 'research/reports/astra-sol-separation/trap-pilot-01/samples.jsonl',
  parser: 'projects/shared/fingerprint-core.js',
}
const buffers = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(join(root, path))])))
const hashes = Object.fromEntries(Object.entries(buffers).map(([key, value]) => [paths[key as keyof typeof paths], sha(value)]))
const jsonl = (b: Buffer) => b.toString().split('\n').filter(s => s.trim()).map(s => JSON.parse(s))
const count = (xs: unknown[]) => Object.fromEntries([...new Set(xs.map(x => JSON.stringify(x)))].sort().map(k => [JSON.parse(k), xs.filter(x => JSON.stringify(x) === k).length]))
const batches = parseReference(buffers.reference.toString())
const reference = batches.flatMap(b => b.samples.map(s => {
  const n = parseNumbers(s.text) as number[]
  const old = (s.text.match(/\d+/g) ?? []).map(Number).filter(v => v >= 1 && v <= 355)
  return {dataset: 'reference', id: s.id, model: b.model.id, batch: b.id, channel: s.actual_channel ?? b.source.channel,
    endpoint: b.source.endpoint, format: b.request.format, reasoning: s.reasoning_effort ?? b.request.reasoning_effort,
    provider: s.provider_reported, response_model: s.response_model, condition: s.condition, challenge: s.challenge_id,
    expected: s.expected_count, valid_count: n.length, accepted: n.length >= Math.max(80, Math.ceil(s.expected_count * .55)),
    completion: s.completion, started: s.started_at, finished: s.finished_at, evidence: s.evidence_path,
    text_sha: sha(s.text.trim()), sequence_sha: sha(JSON.stringify(n)), prompt_sha: sha(s.prompt),
    prompt_system_sha: sha(JSON.stringify([s.system_prompt, s.prompt])), parser_diff: JSON.stringify(n) !== JSON.stringify(old)}
}))
const manifest = JSON.parse(buffers.holdoutManifest.toString())
const referenceLabel = (label: string) => ({'claude-haiku-4-5-20251001': 'claude-haiku-4.5', 'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-opus-4-6': 'claude-opus-4.6', 'claude-opus-4-7': 'claude-opus-4.7', 'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-5-5': 'claude-opus-5.5'} as Record<string, string>)[label] ?? label
const allHoldout = jsonl(buffers.holdoutSamples)
const effectiveHoldout = allHoldout.filter(r => r.status === 'accepted' && r.attempt >= (manifest.resample_from_attempt?.[r.sample_id] ?? 1))
  .sort((a, b) => a.attempt - b.attempt)
const firstById = (rows: any[], field: string) => [...new Map(rows.toReversed().map(r => [r[field], r])).values()]
const holdout = firstById(effectiveHoldout, 'sample_id').map(r => ({dataset: 'holdout', id: r.sample_id, model: referenceLabel(r.model),
  group: r.group_id, challenge: r.challenge_id, attempt: r.attempt, valid_count: parseNumbers(r.text).length,
  text_sha: sha(r.text.trim()), sequence_sha: sha(JSON.stringify(parseNumbers(r.text))), prompt_sha: sha(r.prompt),
  prompt_system_sha: sha(JSON.stringify([r.system_prompt ?? '', r.prompt]))}))
const allPair = jsonl(buffers.pairedSamples)
const paired = firstById(allPair.filter(r => r.status === 'accepted'), 'sample_id').map(r => ({dataset: 'paired', id: r.sample_id,
  model: r.model, group: r.round_id, challenge: r.challenge_id, attempt: r.attempt,
  valid_count: parseNumbers(r.text).length, text_sha: sha(r.text.trim()), sequence_sha: sha(JSON.stringify(parseNumbers(r.text))),
  prompt_sha: sha(r.prompt), prompt_system_sha: sha(JSON.stringify(['', r.prompt])), endpoint: r.endpoint,
  provider: r.provider_reported, reasoning: r.request?.reasoning_effort, request_provider: r.request?.provider,
  started: r.started_at, finished: r.finished_at ?? r.collected_at, expected: r.expected_count}))
const allTrap = jsonl(buffers.trapSamples)
const trap = allTrap.filter(r => r.status === 'completed').map(r => ({dataset: 'trap', id: `${r.model}:${r.attempt}`,
  model: r.model.replace(/^openai\//, ''), group: r.round_id, valid_count: parseNumbers(r.text).length,
  text_sha: sha(r.text.trim()), sequence_sha: sha(JSON.stringify(parseNumbers(r.text))), prompt_sha: sha(r.prompt)}))
const duplicates = (rows: any[], key: string) => {
  const map = new Map<string, any[]>()
  for (const row of rows) map.set(row[key], [...map.get(row[key]) ?? [], {dataset: row.dataset, id: row.id, model: row.model}])
  return [...map].filter(([, xs]) => xs.length > 1).map(([hash, members]) => ({hash, members}))
}
const referenceDuplicateSequence = duplicates(reference, 'sequence_sha')
const allDuplicateSequence = duplicates([...reference, ...holdout, ...paired, ...trap], 'sequence_sha')
const crossDatasetSequences = allDuplicateSequence.filter(g => new Set(g.members.map(m => m.dataset)).size > 1)
const overlaps = (a: any[], b: any[], key: string) => b.filter(r => new Set(a.map(r => r[key])).has(r[key])).map(r => ({dataset: r.dataset, id: r.id, model: r.model, hash: r[key]}))
const byModel = [...new Set(reference.map(r => r.model))].sort().map(model => {
  const rows = reference.filter(r => r.model === model)
  const groupCounts = count(rows.map(r => r.condition))
  const baseGroups = count(rows.filter(r => r.condition.startsWith('environment-')).map(r => r.condition.slice(0, 14)))
  const stableChallenges = new Set(rows.filter(r => /^query-\d\d$/.test(r.challenge)).map(r => r.challenge))
  return {model, batches: new Set(rows.map(r => r.batch)).size, samples: rows.length, valid: rows.filter(r => r.accepted).length,
    groups: Object.keys(groupCounts).length, group_sizes: count(Object.values(groupCounts)), valid_numbers: rows.reduce((n, r) => n + r.valid_count, 0),
    base_environments: Object.keys(baseGroups).length, base_environment_sizes: count(Object.values(baseGroups)), stable_challenges: stableChallenges.size,
    channels: count(rows.map(r => r.channel)), formats: count(rows.map(r => r.format)), reasoning: count(rows.map(r => r.reasoning)),
    providers: count(rows.map(r => r.provider)), dates: count(rows.map(r => (r.finished ?? r.started ?? '').slice(0, 10) || 'unknown')),
    completions: count(rows.map(r => r.completion)), effective_holdout: holdout.filter(r => r.model === model).length,
    source_strata: new Set(rows.map(r => JSON.stringify([r.channel, r.endpoint, r.format, r.reasoning]))).size}
})
const pairLabels = ['gpt-6-astra', 'gpt-6.1-sol']
const summary = {
  hashes, reference: {batches: batches.length, samples: reference.length, valid_samples: reference.filter(r => r.accepted).length,
    models: byModel.length, valid_numbers: reference.reduce((n, r) => n + r.valid_count, 0), conditions: count(reference.map(r => r.condition)),
    parser_differences: reference.filter(r => r.parser_diff), duplicate_sequences: referenceDuplicateSequence,
    duplicate_texts: duplicates(reference, 'text_sha'), by_model: byModel},
  holdout: {attempts: allHoldout.length, statuses: count(allHoldout.map(r => r.status)), effective: holdout.length,
    models_effective: new Set(holdout.map(r => r.model)).size, manifest_models: manifest.models.length,
    manifest_planned_groups: manifest.models.length * manifest.groups.length, bank_planned_groups: byModel.length * manifest.groups.length,
    pair: pairLabels.map(model => ({model, accepted: holdout.filter(r => r.model === model).length})),
    reference_sequence_overlap: overlaps(reference, holdout, 'sequence_sha'), reference_prompt_overlap: overlaps(reference, holdout, 'prompt_sha')},
  paired: {attempts: allPair.length, statuses: count(allPair.map(r => r.status)), effective: paired.length,
    by_model: pairLabels.map(model => ({model, samples: paired.filter(r => r.model === model).length, rounds: new Set(paired.filter(r => r.model === model).map(r => r.group)).size})),
    endpoints: count(paired.map(r => r.endpoint)), reasoning: count(paired.map(r => r.reasoning)), providers: count(paired.map(r => r.provider)),
    reference_sequence_overlap: overlaps(reference, paired, 'sequence_sha'), reference_prompt_overlap: overlaps(reference, paired, 'prompt_sha'),
    own_duplicate_sequences: duplicates(paired, 'sequence_sha')},
  trap: {attempts: allTrap.length, statuses: count(allTrap.map(r => r.status)), completed: trap.length,
    valid: trap.filter(r => r.valid_count >= Math.max(80, Math.ceil(323 * .55))).length},
  cross_dataset_duplicate_sequences: crossDatasetSequences,
  rows: {reference, holdout, paired, trap},
}
await writeFile(join(out, 'data-audit.json'), JSON.stringify(summary, null, 2) + '\n')
const table = byModel.map(r => `| ${r.model} | ${r.valid}/${r.samples} | ${r.batches} | ${Object.entries(r.channels).map(([k, v]) => `${k} (${v})`).join(', ')} | ${r.source_strata} | ${r.effective_holdout} |`).join('\n')
const hashTable = Object.entries(hashes).map(([p, hash]) => `| \`${p}\` | \`${hash}\` |`).join('\n')
await writeFile(join(out, 'data-audit.md'), `# 数据审计：序列泛化研究（2026-09-30）

当前正式参考库有 53 个标签、159 个批次、1,948 条回答。全部通过产品解析器的有效数字门槛，共 648,471 个有效数字。每个标签都有完整的 query-01 至 query-36；各取一条固定挑战回答可组成 636 个三样本组。额外 40 条由 21 条固定挑战变体和 19 条历史补充探针组成。

## 可复现范围

在仓库父目录运行 \`bun research/studies/sequence-generalization/audit-data.ts\`。脚本读取现有文件，只写本目录的审计 JSON 与 Markdown。使用 \`projects/shared/fingerprint-core.js\` 的 \`parseNumbers\`，按最长连续数字段解析；有效门槛为 \`max(80, ceil(expected_count * 0.55))\`。完整逐条元数据、哈希和分层计数保存在 \`data-audit.json\`。采集日期按原始 UTC 时间记录。

## 重复与解析

- 正式参考库内，完全相同的有效数字序列为 0 组；原文去首尾空白后完全相同为 0 组。没有跨标签或跨环境的完全相同序列。
- 正式参考库与当前生效固定 holdout、paired-low-01、trap-pilot-01 的序列重复为 0。固定 holdout 和 paired-low-01 与参考库的精确提示词重复均为 0。
- 旧研究脚本的简单正则解析与产品解析器在 26 条参考回答上不同。字母会分隔数字段。新研究须使用产品解析，不能直接复用旧 general.py 的 parse。
- 19 条 \`condition=holdout-clean\` 是旧补充参考：claude-fable-5.1 为 11 条，claude-opus-5 为 8 条。来源为 2026-09-10 的 openrouter-claude-validation / openrouter-opus-original-fresh，schema-cutover 原行 558–576。现有 train-embedding.py 和 train-probability-classifier.py 明确把它们作为仅训练的历史补充行。它们与当前冻结 holdout 没有精确提示词、原文或序列重合；名称本身不能判定污染。

## Astra / Sol 的采集边界

| 集合 | gpt-6-astra | gpt-6.1-sol | 可隔离的因素 |
|---|---|---|---|
| 正式参考 | 36 条，1 批，OpenAI 直连 Responses，low，2026-09-30 UTC | 36 条，1 批，OpenRouter/OpenAI Chat Completions，low，2026-09-29 UTC | 两者 36 道挑战和系统提示逐条一致；渠道、接口、批次和时间与模型标签混杂 |
| paired-low-01 | 60 条，20 轮 | 60 条，20 轮 | 两者参数相同、OpenRouter 固定 OpenAI 且不回退；同轮同提示配对 |
| 当前固定 holdout | 6 条，2 个完整组三样本 | 0 条 | 不能评估两者的成对识别或 Sol 置信度 |
| trap-pilot-01 | 6 条 | 6 条 | 单一中文提示、相同接口和 low 参数；仅适合作为题型观察 |

paired-low-01 共 122 次尝试：120 accepted、1 failed、1 invalid。按样本 ID 取首个 accepted 后仍为 120 条；序列没有内部重复。固定 holdout 共 377 次记录：252 accepted、121 failed、4 invalid。按 manifest 的生效尝试编号取首个有效记录后为 216 条、36 个模型、72 个完整组。manifest 只含原始 36 标签；当前库展示口径为 106 计划组，所以覆盖率为 72/106 组、216/318 条，另 17 个当前标签没有固定 holdout 回答。

正式参考的留环境验证只隔离提示条件。Astra 与 Sol 各只有一个采集批次，也各只有一种渠道、接口和时间层。因此无法从正式参考构造两个标签都存在的留渠道或留会话验证。保留 12 个 prompt environment 的名字，不要把它们解释成 12 个独立采集会话。旧研究曾把跨渠道差异误当作模型差异；本轮仍需同参数外部配对集核验迁移。

参考元数据还存在 328 条接口格式缺失、1,281 条实际 provider 缺失和 4 条采集时间缺失。47 个标签只有一种已记录 source / endpoint / format / reasoning 组合；其余 6 个标签有两种。这些缺失限制会话或供应商隔离，不能用 batch ID 数量代替独立来源数。

## 评估划分建议

1. 全库算法选择使用 12 个留一固定环境外折。每折训练排除全部 held challenge ID、环境前缀变体、精确原文和产品解析序列重复。基准面板每标签每挑战取稳定的第一条参考，报告 636 组三样本结果。额外参考仅训练，不能充当额外评估组。
2. 特征标准化、位置投影、监督选择、模型中心和置信度校准都只拟合外折训练行。若选择参数后报告同一外折分数，明确标为开发交叉验证；独立泛化必须用选择后冻结的外部集合。
3. paired-low-01 用作全库模型的跨采集迁移回放，不加入正式参考或产品校准。若在其中做方法研究，按 round_id 同时留出两个标签的三条回答，避免同提示的配对答案落在训练和验证两侧。该数据已被多次研究，不能再称为未触碰测试集。
4. 冻结 holdout 只作回归验证。报告覆盖与识别结果；当前没有 Sol 回答，不能据此声称成对高置信度识别已获验证。当前报告是 60/72 完整组命中，60/106 全计划组命中。
5. 用户新授权的同参数直连前瞻配对采集，只在候选和置信度阈值冻结后打开评分。3 / 6 / 9 / 15 回答的确认指标使用不重叠轮次；重采样合并另列为探索估计。置信度报告同时给出覆盖、错误和按匹配轮聚类的不确定区间。

## 所有标签的当前样本与来源

“来源层”按已记录 channel / endpoint / format / reasoning 组合计数。holdout 列按产品标签别名归一后计数。

| 标签 | 有效 / 总数 | 批次数 | 渠道及样本数 | 来源层 | 生效 holdout |
|---|---:|---:|---|---:|---:|
${table}

## 输入 SHA-256

| 文件 | SHA-256 |
|---|---|
${hashTable}
`)
console.log(JSON.stringify({reference: {...summary.reference, by_model: undefined, conditions: undefined, duplicate_texts: undefined, parser_differences: summary.reference.parser_differences.length},
  pair_reference: byModel.filter(r => pairLabels.includes(r.model)), holdout: summary.holdout, paired: summary.paired,
  trap: summary.trap, cross_dataset_duplicate_sequences: crossDatasetSequences, hashes}, null, 2))
