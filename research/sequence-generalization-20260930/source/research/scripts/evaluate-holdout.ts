import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseNumbers } from '../../projects/shared/fingerprint-core.js'
import { analyzeGaussianOutputs } from '../../projects/shared/gaussian-core.js'
import { analyzeSharedOutputs, supportsSharedDetector } from '../../projects/shared/shared-detector'
import type { SharedDetector } from '../../projects/shared/shared-detector'
import { root, manifestPath, samplesPath, json, hash, save, sampleId, samplePrompt } from './holdout-shared'
import type { Manifest } from './holdout-shared'
import { parseReference, referenceSamples } from '../../projects/shared/reference'

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}
const outputDirectory = join(root, option('--output', 'research/reports/holdout'))
const bankPath = join(root, option('--bank', 'projects/data/unified_bank.json'))
let manifest: Manifest
try { manifest = await json(manifestPath) }
catch (error: any) {
  if (error.code !== 'ENOENT') throw error
  console.log('Holdout not collected. Run bun run collect:holdout with OPENROUTER_API_KEY.')
  process.exit(0)
}
if (manifest.purpose !== 'holdout' || manifest.groups.length !== 2 || manifest.groups.some(g => g.challenges.length !== 3)) throw new Error('Expected a fixed two-group, three-challenge holdout manifest')
const bankBytes = await readFile(bankPath)
const referenceBytes = await readFile(join(root, 'projects/data/unified_reference.jsonl'))
const sampleBytes = await readFile(samplesPath).catch((e: any) => {if(e.code === 'ENOENT') return Buffer.from(''); throw e})
const bank = JSON.parse(bankBytes.toString())
const detectorBytes=await readFile(join(root,'projects/data/shared_detector.json'))
const detector:SharedDetector=JSON.parse(detectorBytes.toString())
const sharedEnabled=!bank.classifier && supportsSharedDetector(bank,detector)
const references = [...referenceSamples(parseReference(referenceBytes.toString()))].map(({ sample }) => sample)
const records = sampleBytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
// Keep the frozen holdout IDs intact when only the public reference label changes.
const referenceLabel = (label: string) => ({
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-5-5': 'claude-opus-5.5',
} as Record<string, string>)[label] ?? label
const scorerHash = bank.classifier ? hash(Buffer.concat(await Promise.all(['projects/shared/gaussian-core.js', 'projects/shared/number-features.js'].map(p => readFile(join(root, p)))))) : hash(Buffer.concat([await readFile(join(root,'projects/shared/fingerprint-core.js')),await readFile(join(root,'projects/shared/shared-detector.ts')),detectorBytes]))
const evaluatorHash = hash(await readFile(join(root, 'research/scripts/evaluate-holdout.ts')))
const suiteHash = hash(await readFile(manifestPath))
const datasetHash = hash(sampleBytes)
const bankHash = hash(bankBytes)
const referenceHash = hash(referenceBytes)
if (bank.reference_sha256 !== referenceHash) throw new Error('Bank and reference data differ. Rebuild before evaluating.')
const fingerprint = hash(JSON.stringify({bankHash, datasetHash, suiteHash, scorerHash, evaluatorHash}))
let previous: any
try { previous = await json(join(outputDirectory, 'latest.json')) } catch (e: any) {if(e.code !== 'ENOENT') throw e}
if (process.argv.includes('--if-changed') && previous?.fingerprint === fingerprint) {
  console.log(`Holdout unchanged: ${previous.metrics.correct_complete_groups}/${previous.metrics.planned_groups} full-group hits; ${previous.metrics.complete_groups} complete groups. research/reports/holdout/latest.md`)
  process.exit(0)
}
const byId = new Map<string, any[]>()
const knownIds = new Set(manifest.models.flatMap(m => manifest.groups.flatMap(g => g.challenges.map(c => sampleId(manifest, m, g, c)))))
const attemptIds = new Set<string>()
for (const r of records) {
  if (r.purpose !== 'holdout' || r.test_set_id !== manifest.id || !knownIds.has(r.sample_id) || r.text_sha256 !== hash(r.text || '')) throw new Error('Invalid holdout record or text hash')
  const attemptId = `${r.sample_id}:${r.attempt}`
  if (attemptIds.has(attemptId)) throw new Error(`Duplicate holdout attempt: ${attemptId}`)
  attemptIds.add(attemptId)
  byId.set(r.sample_id, [...byId.get(r.sample_id) || [], r])
}
for (const rows of byId.values()) rows.sort((a, b) => a.attempt - b.attempt)
if (references.some(r => knownIds.has(r.id))) throw new Error('Holdout contamination: test identifiers found in training reference')
const trainingTexts = new Set(references.map(r => hash(String(r.text).trim())))
const trainingPrompts = new Set(references.map(r => r.prompt).filter(Boolean))
const textOverlaps = [...new Set(records.filter(r => r.status === 'accepted' && trainingTexts.has(hash(r.text.trim()))).map(r => r.sample_id))]
const promptOverlaps = [...manifest.groups.flatMap(g => g.challenges).filter(c => trainingPrompts.has(c.prompt)).map(c => c.id), ...(manifest.prompt_revisions || []).filter(r => trainingPrompts.has(r.prompt)).map(r => r.sample_id)]
const groups: any[] = []
const ratio = (n: number, d: number) => d ? n / d : null
for (const model of bank.models) {
  const target = manifest.models.find(m => referenceLabel(m.label) === model.id)
  for (const group of manifest.groups) {
    const samples = group.challenges.map(challenge => {
      const id = sampleId(manifest, {label: target?.label ?? model.id}, group, challenge)
      const attempts = byId.get(id) || []
      const fromAttempt = manifest.resample_from_attempt?.[id] ?? 1
      for (const r of attempts) {
        if (r.model !== (target?.label ?? model.id) || r.group_id !== group.id || r.challenge_id !== challenge.id || r.expected_count !== challenge.expected_count || r.prompt !== samplePrompt(manifest, id, r.attempt, challenge.prompt)) throw new Error(`Holdout challenge mismatch: ${id}`)
        if (r.status === 'accepted' && (![target?.api_model, target?.canonical_slug].includes(r.response_model) || r.provenance?.api_model !== target?.api_model)) throw new Error(`Holdout response model mismatch: ${id}`)
        if (r.status === 'accepted' && target?.source_kind === 'original-channel') {
          if (r.provenance?.kind !== target.source_kind || r.provenance?.endpoint !== target.endpoint || r.provenance?.source_channel !== target.source_channel || r.provenance?.trust_basis !== target.trust_basis || r.request?.reasoning_effort !== target.reasoning_override?.effort || r.request?.provider !== undefined) throw new Error(`Original-channel source or reasoning mismatch: ${id}`)
        }
        if (r.status === 'accepted' && parseNumbers(r.text).length < Math.max(80, Math.ceil(challenge.expected_count * .55))) throw new Error(`Invalid accepted sample: ${id}`)
        if (manifest.resample_from_attempt?.[id] && r.attempt >= fromAttempt && r.status === 'accepted') {
          const pinned = target?.provider_override?.only?.[0]
          if (!pinned || r.request?.provider?.only?.[0] !== pinned || r.request?.provider?.allow_fallbacks !== false || r.provider_reported?.toLowerCase().replace(/[^a-z0-9]/g, '') !== pinned.split('/')[0].replace(/[^a-z0-9]/g, '')) throw new Error(`Resampled provider mismatch: ${id}`)
          const reasoning = manifest.reasoning_revisions?.findLast(revision => revision.sample_id === id && revision.from_attempt <= r.attempt)?.reasoning ?? target?.reasoning_override
          if (JSON.stringify(r.request?.reasoning) !== JSON.stringify(reasoning)) throw new Error(`Resampled reasoning mismatch: ${id}`)
        }
      }
      const current = attempts.filter(r => r.attempt >= fromAttempt)
      const selected = current.find(r => r.status === 'accepted')
      return {id, expected_count: challenge.expected_count, selected, first: attempts[0], attempts: attempts.length, current_attempts: current.length, from_attempt: fromAttempt}
    })
    function score(first: boolean) {
      const outputs = samples.map(s => {const r = first ? s.first : s.selected; return {text: r?.status === 'accepted' ? r.text : '', expected_count: s.expected_count}})
      if (!outputs.some(o => o.text)) return null
      const result = bank.classifier ? analyzeGaussianOutputs(outputs, bank) : analyzeSharedOutputs(outputs, bank, detector)
      const rank = result.results.findIndex(r => r.model === model.id) + 1
      return {prediction: result.prediction, correct: result.prediction === model.id, used_outputs: result.used_outputs,
        absolute_match: result.absolute_match, evidence: result.evidence,
        ...(bank.classifier ? { confidence: result.confidence, confirmed_prediction: result.confirmed_prediction, distance_ratio: result.distance_ratio, candidate_set: result.candidate_set } : {}),
        decision:result.decision, probability_status:result.probability_status,
        verification_top:result.verification_top ?? null,
        verification_correct:typeof result.verification_top==='string' ? result.verification_top===model.id : null,
        verification_confidence:result.verification_confidence ?? null,
        truth_rank: rank || null, truth_probability: result.results[rank - 1]?.probability ?? null, top1_probability: result.probability,
        top3: result.results.slice(0, 3).map(r => ({model: r.model, probability: r.probability,score:r.score,verification_score:r.verification_score,verification_confidence:r.verification_confidence})),
        family_correct: result.family_prediction === model.family}
    }
    const result = score(false), firstPass = score(true)
    groups.push({id: `${model.id}:${group.id}`, model: model.id, group: group.id, api_model: target?.api_model ?? null,
      complete: samples.every(s => s.selected), result, first_pass: firstPass,
      samples: samples.map(s => ({id: s.id, attempts: s.attempts, current_attempts: s.current_attempts, from_attempt: s.from_attempt, status: s.selected ? 'accepted' : s.current_attempts ? 'failed' : 'missing', selected_attempt: s.selected?.attempt ?? null, first_status: s.first?.status || 'missing'}))})
  }
}
const complete = groups.filter(g => g.complete)
const allSamples = groups.flatMap(g => g.samples)
const correct = complete.filter(g => g.result.correct).length
const verified = complete.filter(g => typeof g.result.verification_top==='string')
const verifierCorrect = verified.filter(g => g.result.verification_correct).length
const confidenceGroups = complete.filter(g=>typeof g.result.verification_confidence==='number')
const confidenceNll = confidenceGroups.length ? confidenceGroups.reduce((sum,g)=>{
  const p=Math.min(1-1e-15,Math.max(1e-15,g.result.verification_confidence))
  return sum-Math.log(g.result.correct?p:1-p)
},0)/confidenceGroups.length : null
const confidenceBrier = confidenceGroups.length ? confidenceGroups.reduce((sum,g)=>sum+(g.result.verification_confidence-Number(g.result.correct))**2,0)/confidenceGroups.length : null
const confidenceEce = confidenceGroups.length ? Array.from({length:10},(_,i)=>{
  const rows=confidenceGroups.filter(g=>g.result.verification_confidence>=i/10 && (i===9?g.result.verification_confidence<=1:g.result.verification_confidence<(i+1)/10))
  return Math.abs(rows.reduce((sum,g)=>sum+g.result.verification_confidence-Number(g.result.correct),0))/confidenceGroups.length
}).reduce((a,b)=>a+b,0) : null
const metrics = {planned_groups: groups.length, complete_groups: complete.length, correct_complete_groups: correct,
  selected_confidence_binary_nll:confidenceNll,selected_confidence_binary_brier:confidenceBrier,selected_confidence_ece:confidenceEce,
  selected_confidence_thresholds:Object.fromEntries([.5,.8,.9,.95].map(threshold=>[String(threshold),{
    correct:confidenceGroups.filter(g=>g.result.verification_confidence>=threshold && g.result.correct).length,
    wrong:confidenceGroups.filter(g=>g.result.verification_confidence>=threshold && !g.result.correct).length,
  }])),
  verifier_scored_complete_groups:verified.length,
  verifier_correct_complete_groups:verified.length ? verifierCorrect : null,
  verifier_top1_over_complete:ratio(verifierCorrect,verified.length),
  ranking_verifier_disagreements:verified.filter(g=>g.result.verification_top!==g.result.prediction).length,
  insufficient_evidence_complete_groups: complete.filter(g => g.result.evidence.insufficient).length,
  evidence_supported_complete_groups: complete.filter(g => !g.result.evidence.insufficient).length,
  supported_correct_complete_groups: complete.filter(g => g.result.correct && !g.result.evidence.insufficient).length,
  supported_wrong_complete_groups: complete.filter(g => !g.result.correct && !g.result.evidence.insufficient).length,
  outside_complete_groups: complete.filter(g => g.result.evidence.state === 'outside').length,
  ambiguous_complete_groups: complete.filter(g => g.result.evidence.state === 'ambiguous').length,
  planned_samples: allSamples.length, accepted_samples: allSamples.filter(s => s.status === 'accepted').length,
  attempted_samples: allSamples.filter(s => s.current_attempts).length, recorded_attempts: records.length,
  first_pass_accepted_samples: allSamples.filter(s => s.first_status === 'accepted').length,
  full_group_top1_over_planned: ratio(correct, groups.length), full_group_top1_over_complete: ratio(correct, complete.length),
  full_group_top3_over_complete: ratio(complete.filter(g => g.result.truth_rank <= 3).length, complete.length),
  first_pass_ui_top1_over_planned: ratio(groups.filter(g => g.first_pass?.correct).length, groups.length),
  first_pass_complete_groups: groups.filter(g => g.first_pass?.used_outputs === 3).length,
  ui_top1_over_planned: ratio(groups.filter(g => g.result?.correct).length, groups.length),
  family_accuracy_over_complete: ratio(complete.filter(g => g.result.family_correct).length, complete.length),
  mean_reciprocal_rank: ratio(complete.reduce((sum, g) => sum + 1 / g.result.truth_rank, 0), complete.length),
  mean_nll: complete.every(g=>typeof g.result.truth_probability==='number') ? ratio(complete.reduce((sum, g) => sum - Math.log(Math.max(1e-15, g.result.truth_probability)), 0), complete.length) : null}
const sameScorer=previous?.scorer_sha256 === scorerHash && previous?.evaluator_sha256 === evaluatorHash
const comparable = previous?.dataset_sha256 === datasetHash && previous?.suite_sha256 === suiteHash &&
  groups.every(g=>{const old=previous.groups.find((p:{id:string})=>p.id===g.id);return old && old.complete===g.complete && JSON.stringify(old.samples.map((s:{id:string;selected_attempt:number|null})=>[s.id,s.selected_attempt]))===JSON.stringify(g.samples.map(s=>[s.id,s.selected_attempt]))})
const changes = comparable ? groups.flatMap(g => {const old = previous.groups.find((p: any) => p.id === g.id); return old && old.result?.prediction !== g.result?.prediction ? [{group: g.id, before: old.result?.prediction ?? null, after: g.result?.prediction ?? null, before_correct: !!old.result?.correct, after_correct: !!g.result?.correct}] : []}) : []
const report = {generated_at: new Date().toISOString(), fingerprint, bank_sha256: bankHash, reference_sha256: referenceHash,
  dataset_sha256: datasetHash, evaluator_sha256: evaluatorHash, suite_sha256: suiteHash, scorer_sha256: scorerHash, test_set_id: manifest.id,
  status: textOverlaps.length || promptOverlaps.length ? 'possible-overlap' : metrics.attempted_samples < metrics.planned_samples ? 'collecting' : complete.length === groups.length ? 'complete' : 'complete-with-failures',
  collection_complete: metrics.attempted_samples === metrics.planned_samples,
  metrics, uncovered_models: bank.models.filter((m: any) => !manifest.models.some(t => referenceLabel(t.label) === m.id)).map((m: any) => m.id),
  retired_models: manifest.models.filter(m => !bank.models.some((b: any) => b.id === referenceLabel(m.label))).map(m => m.label),
  prompt_revisions: manifest.prompt_revisions || [],
  collection_profiles: {current: manifest.profile, resample_from_attempt: manifest.resample_from_attempt ?? {}, model_provider_overrides: Object.fromEntries(manifest.models.filter(m => m.provider_override).map(m => [m.label, m.provider_override])), model_reasoning_overrides: Object.fromEntries(manifest.models.filter(m => m.reasoning_override).map(m => [m.label, m.reasoning_override])), history: 'profile_history' in manifest ? manifest.profile_history : [], recorded_output_limits: Object.fromEntries([...new Set(records.map(r => r.request.max_tokens || r.request.max_output_tokens))].map(limit => [String(limit), records.filter(r => (r.request.max_tokens || r.request.max_output_tokens) === limit).length]))},
  possible_overlap: {text_sample_ids: textOverlaps, prompt_ids: promptOverlaps},
  method:sharedEnabled?'shared-detector-v1':bank.classifier?'gaussian':'custom-bank-legacy-ranking',
  probability_status:sharedEnabled?(detector.calibration?'reference_calibrated':'unavailable'):null,
  comparison: {comparable: !!comparable, same_scoring_method:sameScorer, previous_bank_sha256: previous?.bank_sha256 ?? null,
    correct_group_delta: comparable ? correct - previous.metrics.correct_complete_groups : null,
    verifier_correct_group_delta:comparable && verified.length && typeof previous.metrics.verifier_correct_complete_groups==='number' ? verifierCorrect-previous.metrics.verifier_correct_complete_groups : null,
    changes}, groups}
await mkdir(outputDirectory, {recursive: true})
await save(join(outputDirectory, `${fingerprint.slice(0, 24)}.json`), report)
await save(join(outputDirectory, 'latest.json'), report)
const pct = (x: number | null) => x === null ? '—' : `${(100 * x).toFixed(1)}%`
const table = bank.models.map((m: any) => {
  const rows = groups.filter(g => g.model === m.id)
  const cell = (g: any) => g.complete ? `${g.result.correct ? '✓' : '✗'} ${g.result.prediction}（真值第 ${g.result.truth_rank}）${g.result.verification_top && g.result.verification_top!==g.result.prediction ? `；核验：${g.result.verification_top}` : ''}` : `未齐 ${g.result?.used_outputs || 0}/3`
  return `| ${m.id} | ${cell(rows[0])} | ${cell(rows[1])} |`
}).join('\n')
const changedRows = changes.map((c: any) => `- ${c.group}：${c.before} → ${c.after}（${c.before_correct ? '正确' : '错误'} → ${c.after_correct ? '正确' : '错误'}）`).join('\n')
const failureRows = groups.flatMap(g => g.samples.filter((s: any) => s.status !== 'accepted').map((s: any) => {const attempts = byId.get(s.id) || []; const last = attempts[attempts.length - 1]; return `- ${g.model} ${g.group}：${last?.error || '尚无有效回答'}（已记录 ${s.attempts} 次尝试）`})).join('\n')
const evidenceDescription = sharedEnabled ? (detector.calibration
  ? `使用冻结的排名器 A、核验器 B 与排名温度校准层（tau ${detector.calibration.tau.toFixed(3)}，${detector.calibration.calibration_run}）。置信度是 ${detector.model_ids.length} 个参考身份上的闭集概率，按留出环境的参考预测拟合，不含库外概率项；不按固定阈值自动确认身份。`
  : `使用冻结的集成排名 A 与共享核验器 B。全部 ${detector.model_ids.length} 模型尚未独立校准，身份概率为空，不套用旧的 85% 门槛。身份未确认不等于已判定未知。`)
  : ['gaussian-tuned-v2', 'gaussian-covariance-v3'].includes(bank.classifier?.version || '')
  ? '校准置信度至少 90% 为高置信，不高于 10% 为低置信，其余为中间区间。置信度用开发模型的已知与整类留出回答校准；库内相对分数单独报告。'
  : bank.classifier ? '使用旧高斯版的统一参考距离、候选范围及唯一候选规则。'
  : '证据不足按第一候选相对分数低于 85% 判定（85% 不触发）。绝对匹配度是原始余弦相似度，不是身份概率。'
const verifierSummary = verified.length ? `核验器最高分候选命中 **${verifierCorrect}/${verified.length}**（${pct(metrics.verifier_top1_over_complete)}）；与排名器首位不同 **${metrics.ranking_verifier_disagreements}** 组。相同回答配对比较，核验命中数变化：${report.comparison.verifier_correct_group_delta ?? '无可比较基线'}。` : '当前评分器没有逐候选核验结果。'
const confidenceSummary = confidenceNll!==null && confidenceBrier!==null && confidenceEce!==null ? `第一候选置信度的二元误差：NLL ${confidenceNll.toFixed(4)}；Brier ${confidenceBrier.toFixed(4)}；ECE ${confidenceEce.toFixed(4)}。本段只评估当前库内固定测试，库外误报需另行回放。` : ''
const markdown = `# 固定测试集评估\n\n完整三样本组命中 **${correct}/${groups.length}**；已完成 **${complete.length}/${groups.length}** 组、**${metrics.accepted_samples}/${metrics.planned_samples}** 条有效回答。\n\n${verifierSummary}\n\n${confidenceSummary}\n\n证据标识：完整组中 ${metrics.insufficient_evidence_complete_groups}/${complete.length} 组标为证据不足，仍保留候选排名。${evidenceDescription}\n\n完整组条件准确率：${pct(metrics.full_group_top1_over_complete)}；Top-3：${pct(metrics.full_group_top3_over_complete)}；家族准确率：${pct(metrics.family_accuracy_over_complete)}。首次已记录尝试按当前网页评分流程计分：${pct(metrics.first_pass_ui_top1_over_planned)}。\n\n| 模型 | 第 1 组 | 第 2 组 |\n|---|---|---|\n${table}\n\n与上次报告${comparable ? `使用相同回答配对比较，完整组命中数变化 ${report.comparison.correct_group_delta}；${sameScorer ? "评分方法相同" : "评分方法有变化"}。` : '不可直接比较：测试数据或评分代码不同，或尚无上次报告。'}\n\n${changedRows || '本次没有可列出的预测变动。'}\n\n未获得有效回答：\n\n${failureRows || '无。'}\n\n未覆盖模型：${report.uncovered_models.join('、') || '无'}。疑似训练重合：${textOverlaps.length} 条输出、${promptOverlaps.length} 条提示词。\n\n用户授权的混用前缀修订：${manifest.prompt_revisions?.length || 0} 次，按实际尝试保留原始及新提示词。\n\n采集当前输出上限：${manifest.profile.output_limit}。历史请求上限与数量：${JSON.stringify(report.collection_profiles.recorded_output_limits)}。用户更改上限前的完整回答保留；首次尝试指标使用首次已落盘记录，不包含切换配置时未完成落盘的在途请求。\n\n每模型仅两组，结果用于观察回归，不代表稳定的真实准确率。测试集反复用于调整算法后属于回归验证集，不能继续作为一次性独立泛化评估。失败和缺失不从总计划组数中消失；条件准确率仅使用完整组。所有模型按记录的上游响应及渠道标签评估，不能据此独立认证后端身份。\n\n报告时间：${report.generated_at}。参考数据 SHA-256：\`${referenceHash}\`。\n`
await writeFile(join(outputDirectory, 'latest.md'), markdown)
console.log(`Holdout: ${correct}/${groups.length} full-group hits; ${complete.length} complete groups; ${metrics.accepted_samples}/${metrics.planned_samples} valid samples. See ${outputDirectory}/latest.md`)
if (textOverlaps.length || promptOverlaps.length) console.warn('Possible training/holdout overlap; inspect latest.json before interpreting reliability.')
