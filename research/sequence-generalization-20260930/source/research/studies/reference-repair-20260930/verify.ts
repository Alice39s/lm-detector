import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { parseReference, referenceSamples } from '../../../projects/shared/reference'
import { readCompletion, type Format } from '../../../projects/shared/completion'
import { root, hash, sampleId, samplePrompt, type Manifest } from '../../scripts/holdout-shared'

type RecordRow = Record<string, any>
const output = join(root, 'research/reports/reference-repair-20260930')
const baseline = join(output, 'baseline')
const final = process.argv.includes('--final')
const reportOption = process.argv.indexOf('--after-report')
const afterPath = reportOption === -1 ? join(root, 'research/reports/holdout/latest.json') : resolve(root, process.argv[reportOption + 1]!)
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const canonicalLabel = (label: string) => ({
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5', 'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-opus-4-6': 'claude-opus-4.6', 'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8', 'claude-opus-5-5': 'claude-opus-5.5',
} as Record<string, string>)[label] ?? label
const key = (row: RecordRow) => `${row.sample_id}:${row.attempt}`
const normalizedProvider = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const sequenceHash = (text: string) => hash(JSON.stringify(parseNumbers(text)))
const errors: {check: string; id?: string}[] = []
const check = (valid: unknown, name: string, id?: string) => { if (!valid) errors.push({check: name, ...(id ? {id} : {})}) }
const counts = (values: unknown[]) => Object.fromEntries([...new Set(values)].map(value => [String(value), values.filter(item => item === value).length]))

function records(bytes: Buffer) {
  return bytes.toString().split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) as RecordRow[]
}

function userPrompts(request: RecordRow): string[] {
  const messages = Array.isArray(request?.input) ? request.input : request?.messages
  if (typeof request?.input === 'string') return [request.input]
  return (Array.isArray(messages) ? messages : []).filter(row => row.role === 'user').map(row =>
    typeof row.content === 'string' ? row.content : (Array.isArray(row.content) ? row.content : []).map((part: any) => part.text ?? '').join(''))
}

function costs(rows: RecordRow[]) {
  const billed = rows.filter(row => row.billed_request !== false && row.source_attempt === undefined)
  const reported = billed.filter(row => typeof row.usage?.cost === 'number' && Number.isFinite(row.usage.cost))
  const sum = (field: string, alternatives: string[] = []) => billed.reduce((total, row) => {
    const value = [field, ...alternatives].map(name => row.usage?.[name]).find(value => typeof value === 'number' && Number.isFinite(value))
    return total + (value ?? 0)
  }, 0)
  return {attempts: rows.length, api_attempts: billed.length, derived_attempts: rows.length - billed.length,
    with_reported_cost: reported.length, without_reported_cost: billed.length - reported.length,
    reported_cost_usd: reported.reduce((total, row) => total + row.usage.cost, 0),
    input_tokens: sum('input_tokens', ['prompt_tokens']), output_tokens: sum('output_tokens', ['completion_tokens']), total_tokens: sum('total_tokens'),
    policy: 'Sum top-level usage.cost once per billed physical request. Derivatives and source_usage never add another charge. Missing physical-request cost remains unknown.'}
}

const paths = {
  manifest: join(root, 'research/evaluation/holdout/manifest.json'), samples: join(root, 'research/evaluation/holdout/samples.jsonl'),
  reference: join(root, 'projects/data/unified_reference.jsonl'), bank: join(root, 'projects/data/unified_bank.json'),
  detector: join(root, 'projects/data/shared_detector.json'),
}
const bytes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path)]))) as Record<keyof typeof paths, Buffer>
const oldBytes = await readFile(join(baseline, 'holdout-samples.jsonl'))
const oldRows = records(oldBytes), rows = records(bytes.samples)
const oldManifest: Manifest = await readJson(join(baseline, 'holdout-manifest.json'))
const manifest: Manifest = JSON.parse(bytes.manifest.toString())
const bank = JSON.parse(bytes.bank.toString()), detector = JSON.parse(bytes.detector.toString())
const before = await readJson(join(baseline, 'holdout-before.json'))
const sourceHashes = Object.fromEntries(Object.entries(bytes).map(([name, content]) => [name, hash(content)]))
check(bytes.samples.length >= oldBytes.length && bytes.samples.subarray(0, oldBytes.length).equals(oldBytes), 'old_jsonl_bytes_preserved_as_exact_prefix')
const currentByAttempt = new Map(rows.map(row => [key(row), row]))
check(currentByAttempt.size === rows.length, 'unique_attempt_ids')
for (const row of oldRows) check(JSON.stringify(currentByAttempt.get(key(row))) === JSON.stringify(row), 'old_attempt_preserved', key(row))
check(manifest.id === oldManifest.id && manifest.purpose === 'holdout', 'fixed_suite_id_preserved')
check(JSON.stringify(manifest.groups) === JSON.stringify(oldManifest.groups), 'fixed_challenge_ids_prompts_counts_preserved')
check(manifest.groups.length === 2 && manifest.groups.every(group => group.challenges.length === 3), 'two_groups_three_challenges')
check(bank.models.length === 53, 'expected_53_bank_labels')
check(bank.reference_sha256 === sourceHashes.reference, 'bank_matches_current_reference')
check((detector.source_reference_sha256 ?? detector.reference_sha256) === sourceHashes.reference, 'detector_matches_current_reference')
const bankIds = bank.models.map((model: any) => model.id) as string[]
const modelIds = manifest.models.map(model => canonicalLabel(model.label))
check(new Set(modelIds).size === modelIds.length, 'unique_manifest_labels')
const uncovered = bankIds.filter(label => !modelIds.includes(label)), retired = modelIds.filter(label => !bankIds.includes(label))
check(!retired.length, 'manifest_has_no_retired_bank_labels')
const baselineKeys = new Set(oldRows.map(key)), appended = rows.filter(row => !baselineKeys.has(key(row)))
const slots = new Map<string, {model: Manifest['models'][number]; group: Manifest['groups'][number]; challenge: Manifest['groups'][number]['challenges'][number]}>()
for (const model of manifest.models) for (const group of manifest.groups) for (const challenge of group.challenges) slots.set(sampleId(manifest, model, group, challenge), {model, group, challenge})
const bySample = new Map<string, RecordRow[]>()
let rawVerified = 0, replayVerified = 0, providerRecoveryVerified = 0
const missingRaw: string[] = [], missingProvider: string[] = []
const sourceFiles = ['projects/shared/challenge-browser.js', 'projects/shared/completion-request.ts', 'projects/shared/completion.ts']
const currentCodeHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(root, path)))])))

for (const row of rows) {
  const id = key(row), slot = slots.get(row.sample_id), isNew = !baselineKeys.has(id)
  check(!!slot, 'record_slot_in_fixed_suite', id)
  check(row.purpose === 'holdout' && row.test_set_id === manifest.id, 'record_holdout_purpose_suite', id)
  check(Number.isInteger(row.attempt) && row.attempt >= 1, 'positive_attempt_number', id)
  check(typeof row.text === 'string' && row.text_sha256 === hash(row.text ?? ''), 'output_text_sha256', id)
  check(['accepted', 'failed', 'invalid'].includes(row.status), 'known_attempt_status', id)
  if (!slot) continue
  const {model, group, challenge} = slot
  const metadataRecovery = row.record_kind === 'metadata-recovery'
  const capPolicy = row.selection_policy === 'user-authorized-expected-count-cap'
  const declaredCap = row.capped === true || row.max_numbers !== undefined || capPolicy
  if (declaredCap) {
    check(capPolicy && row.max_numbers === challenge.expected_count, 'authorized_expected_count_cap_policy', id)
    if (row.status === 'accepted') check(parseNumbers(row.text).length <= challenge.expected_count, 'capped_answer_does_not_exceed_expected_count', id)
  }
  check(row.model === model.label && row.group_id === group.id && row.challenge_id === challenge.id && row.expected_count === challenge.expected_count, 'record_challenge_identity', id)
  check(row.prompt === samplePrompt(manifest, row.sample_id, row.attempt, challenge.prompt), 'record_effective_fixed_prompt', id)
  check(row.request?.model === model.api_model && userPrompts(row.request).includes(row.prompt), 'request_model_and_prompt', id)
  check(row.provenance?.api_model === model.api_model && typeof row.provenance?.endpoint === 'string', 'record_source_api_model_endpoint', id)
  if (row.status === 'accepted') {
    const allowedResponseModels = [model.api_model, model.canonical_slug].filter(Boolean)
    check(allowedResponseModels.includes(row.response_model), 'accepted_response_model_api_or_exact_canonical', id)
    check(row.http_status >= 200 && row.http_status < 300, 'accepted_http_status', id)
    const parsed = parseNumbers(row.text).length
    check(parsed >= Math.max(80, Math.ceil(challenge.expected_count * .55)), 'accepted_minimum_parsed_count', id)
    check(row.parsed_count === parsed, 'recorded_parse_count', id)
    const pinned = model.provider_override?.only?.[0]
    const fromAttempt = manifest.resample_from_attempt?.[row.sample_id] ?? 1
    if (pinned && row.attempt >= fromAttempt) check(row.request?.provider?.only?.length === 1 && row.request.provider.only[0] === pinned && row.request.provider.allow_fallbacks === false && normalizedProvider(row.provider_reported) === normalizedProvider(pinned.split('/')[0]), 'pinned_provider_request_response', id)
    if (!row.provider_reported) missingProvider.push(id)
  }
  if (isNew) {
    if (row.source_attempt !== undefined) {
      const source = currentByAttempt.get(`${row.sample_id}:${row.source_attempt}`)
      check((capPolicy || metadataRecovery) && Number.isInteger(row.source_attempt) && row.source_attempt < row.attempt && source && ['accepted', 'failed'].includes(source.status) && source.http_status >= 200 && source.http_status < 300, 'derived_uses_previous_valid_http_attempt', id)
      check(source && !baselineKeys.has(key(source)), 'derived_does_not_reference_baseline_attempt', id)
      check(row.billed_request === false, 'derived_is_not_a_new_billed_request', id)
      check(source && JSON.stringify(source.raw_response) === JSON.stringify(row.raw_response) && JSON.stringify(source.raw_response_metadata) === JSON.stringify(row.raw_response_metadata), 'derived_preserves_source_raw_evidence', id)
      check(source && JSON.stringify(source.request) === JSON.stringify(row.request), 'derived_preserves_source_request', id)
      if (metadataRecovery) {
        const pinned = model.provider_override?.only?.[0]?.split('/')[0]
        check(source?.status === 'failed' && source.error === `Provider mismatch: expected ${normalizedProvider(pinned)}, received (missing)` && !source.provider_reported, 'provider_recovery_source_failed_only_for_missing_provider', id)
        check(source && row.text === source.text && row.text_sha256 === source.text_sha256 && parseNumbers(source.text).length === challenge.expected_count, 'provider_recovery_preserves_exact_original_output', id)
        check(source && ['usage', 'completion', 'finish_reason', 'capped', 'selection_policy', 'max_numbers'].every(field => JSON.stringify(source[field]) === JSON.stringify(row[field])), 'provider_recovery_preserves_original_completion_profile', id)
        check(source && row.source_collection_run_id === source.collection_run_id && JSON.stringify(row.source_generation_hashes) === JSON.stringify(source.source_hashes), 'provider_recovery_retains_original_source_versions', id)
      } else if (source && row.capped === true) check(row.text === parseNumbers(source.text).slice(0, challenge.expected_count).join(', '), 'derived_cap_is_original_numeric_prefix', id)
    }
    const run = (manifest as any).collection_runs?.find((run: any) => run.id === row.collection_run_id)
    check(run && JSON.stringify(run.source_hashes) === JSON.stringify(row.source_hashes), 'new_attempt_matches_collection_run_sources', id)
    for (const path of sourceFiles) check(/^[0-9a-f]{64}$/.test(row.source_hashes?.[path] ?? ''), 'new_request_parser_source_hash_recorded', id)
    check(run?.fixed_groups_sha256 === hash(JSON.stringify(manifest.groups)), 'new_run_uses_fixed_group_hash', id)
    const target = model as typeof model & {endpoint?: string; source_kind?: string; source_channel?: string; trust_basis?: string}
    check(row.provenance?.endpoint === (target.endpoint ?? manifest.endpoint), 'new_source_endpoint_matches_declared_target', id)
    check(row.provenance?.canonical_slug === model.canonical_slug, 'new_source_canonical_slug_matches_target', id)
    if (target.source_kind === 'original-channel') {
      check(row.provenance.kind === target.source_kind && row.provenance.source_channel === target.source_channel && row.provenance.trust_basis === target.trust_basis, 'new_original_channel_provenance_matches_target', id)
      check(row.request.reasoning_effort === 'low', 'new_original_channel_native_reasoning_low', id)
    } else {
      const reasoning = manifest.reasoning_revisions?.findLast(revision => revision.sample_id === row.sample_id && revision.from_attempt <= row.attempt)?.reasoning ?? model.reasoning_override
      if (reasoning) check(JSON.stringify(row.request.reasoning) === JSON.stringify(reasoning), 'new_reasoning_request_matches_declared_override', id)
    }
    if (row.provider_reported_source === 'openrouter-generation-api' || metadataRecovery) {
      const proof = row.provider_evidence, source = currentByAttempt.get(`${row.sample_id}:${row.source_attempt}`)
      const beforeErrors = errors.length
      check(metadataRecovery && row.provider_reported_source === 'openrouter-generation-api' && proof?.kind === 'openrouter-generation-api' && proof.method === 'GET', 'provider_recovery_has_explicit_metadata_source', id)
      check(proof && source && proof.source_sample_id === row.sample_id && proof.source_attempt === row.source_attempt && proof.source_record_sha256 === hash(JSON.stringify(source)) && proof.raw_response_sha256 === row.raw_response?.sha256, 'provider_evidence_binds_original_record_and_raw', id)
      check(proof && proof.generation_id === row.response_id && proof.generation_id === source?.response_id && proof.generation_id === source?.generation_id && proof.model && [model.api_model, model.canonical_slug].includes(proof.model), 'provider_evidence_matches_original_generation_identity', id)
      check(proof && proof.endpoint === row.provenance.endpoint + '/generation?id=' + encodeURIComponent(row.response_id) && row.provider_stream_reported === null && proof.provider_name === row.provider_reported, 'provider_evidence_exact_endpoint_and_reported_source', id)
      try {
        const bodyPath = resolve(root, proof.response.path), metadataPath = resolve(root, proof.response_metadata.path)
        check([bodyPath, metadataPath].every(path => {const local = relative(root, path); return local !== '..' && !local.startsWith('../')}), 'provider_evidence_paths_inside_workspace', id)
        const body = await readFile(bodyPath), metadata = await readJson(metadataPath), data = JSON.parse(body.toString()).data
        check(proof.response.format === 'json' && hash(body) === proof.response.sha256 && body.length === proof.response.bytes, 'provider_metadata_raw_sha256_bytes', id)
        check(!/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(body.toString()) && !metadata.headers && !metadata.apiKey, 'provider_metadata_excludes_credentials', id)
        check(metadata.method === 'GET' && metadata.endpoint === proof.endpoint && metadata.fetched_at === proof.fetched_at && metadata.status >= 200 && metadata.status < 300 && ['status', 'content_type', 'request_id'].every(field => metadata[field] === proof.response_metadata[field]), 'provider_metadata_http_request_and_response_matches_evidence', id)
        const pinned = model.provider_override?.only?.[0]?.split('/')[0]
        check(data?.id === proof.generation_id && data.model === proof.model && data.provider_name === proof.provider_name && normalizedProvider(data.provider_name) === normalizedProvider(pinned), 'provider_metadata_body_confirms_exact_generation_model_supplier', id)
      } catch {check(false, 'provider_metadata_evidence_read_failed', id)}
      if (beforeErrors === errors.length) providerRecoveryVerified++
    } else check(!row.provider_evidence && row.provider_stream_reported === undefined, 'ordinary_attempt_has_no_unverified_provider_override', id)
    const evidence = row.raw_response ?? row.raw_evidence
    if (!evidence?.path) {
      missingRaw.push(id)
      check(row.http_status === undefined, 'new_http_response_has_raw_evidence', id)
    } else {
      const evidencePath = isAbsolute(evidence.path) ? evidence.path : resolve(root, evidence.path)
      const relativePath = relative(root, evidencePath)
      check(relativePath !== '..' && !relativePath.startsWith('../'), 'raw_evidence_path_inside_workspace', id)
      try {
        const raw = await readFile(evidencePath)
        const correctRawHash = hash(raw) === evidence.sha256
        check(correctRawHash, 'raw_response_sha256', id)
        if (typeof evidence.bytes === 'number') check(raw.length === evidence.bytes, 'raw_response_byte_count', id)
        const metadataPath = row.raw_response_metadata?.path
        const metadata = metadataPath ? await readJson(resolve(root, metadataPath)) : row.raw_response_metadata
        if (metadata) check(metadata.status === row.http_status && metadata.status === row.raw_response_metadata.status && metadata.content_type === row.raw_response_metadata.content_type && metadata.request_id === row.raw_response_metadata.request_id, 'raw_response_metadata_matches_record', id)
        const headers = evidence.headers ?? row.response_headers ?? (metadata?.content_type ? {'content-type': metadata.content_type} : {})
        check(!Object.keys(headers).some(name => /authorization|api-key/i.test(name)), 'raw_headers_exclude_credentials', id)
        check(!/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(raw.toString()), 'raw_body_excludes_api_key', id)
        const traceRequest = await readJson(join(evidencePath, '..', 'attempt-1.request.json'))
        check(JSON.stringify(traceRequest.body) === JSON.stringify(row.request), 'raw_trace_request_body_matches_record', id)
        const suffix = {anthropic: '/messages', responses: '/responses', openai: '/chat/completions'}[row.format as Format]
        const requestEndpoint = target.source_kind === 'original-channel' ? row.provenance.endpoint : row.provenance.endpoint + suffix
        check(traceRequest.url === requestEndpoint, 'raw_trace_request_endpoint_matches_record', id)
        check(!traceRequest.headers && !traceRequest.apiKey, 'raw_trace_request_excludes_credentials', id)
        if (correctRawHash && (evidence.bytes === undefined || raw.length === evidence.bytes)) rawVerified++
        if (row.status === 'accepted') {
          const completion = await readCompletion(new Response(raw, {status: row.http_status, headers}), row.format as Format, undefined, undefined, capPolicy ? challenge.expected_count : undefined)
          const identical = completion.text === row.text && completion.responseModel === row.response_model && completion.responseId === row.response_id
          check(identical, 'raw_completion_replays_record_identity_text', id)
          const legitimateCap = capPolicy && row.capped === true && completion.capped === true && completion.completion === 'truncated'
          const legitimateComplete = completion.completion === 'complete' && !completion.capped && row.capped !== true
          check(legitimateCap || legitimateComplete, 'raw_completion_complete_or_authorized_cap', id)
          if (capPolicy) check((completion.capped ?? false) === (row.capped ?? false), 'raw_completion_replays_cap_flag', id)
          const streamProvider = metadataRecovery ? row.provider_stream_reported : row.provider_reported
          check((completion.providerReported ?? null) === (streamProvider ?? null), 'raw_completion_replays_provider', id)
          check(JSON.stringify(completion.usage) === JSON.stringify(row.usage), 'raw_completion_replays_usage', id)
          if (identical && (legitimateCap || legitimateComplete)) replayVerified++
        }
      } catch {
        check(false, 'raw_evidence_read_or_replay_failed', id)
      }
    }
  }
  bySample.set(row.sample_id, [...bySample.get(row.sample_id) ?? [], row])
}
for (const [id, attempts] of bySample) {
  attempts.sort((first, second) => first.attempt - second.attempt)
  check(attempts.every((row, index) => row.attempt === index + 1), 'attempt_sequence_has_no_gaps', id)
}

const referenceRows = [...referenceSamples(parseReference(bytes.reference.toString()))]
const referenceIds = new Set(referenceRows.map(({sample}) => sample.id))
const referenceTexts = new Set(referenceRows.map(({sample}) => hash(sample.text.trim())))
const referenceSequences = new Set(referenceRows.map(({sample}) => sequenceHash(sample.text)))
const referencePrompts = new Set(referenceRows.map(({sample}) => sample.prompt))
const accepted = rows.filter(row => row.status === 'accepted')
const overlaps = {
  identifiers: rows.filter(row => referenceIds.has(row.sample_id)).map(row => key(row)),
  exact_text: accepted.filter(row => referenceTexts.has(hash(row.text.trim()))).map(row => key(row)),
  parsed_sequence: accepted.filter(row => referenceSequences.has(sequenceHash(row.text))).map(row => key(row)),
  prompts: rows.filter(row => referencePrompts.has(row.prompt)).map(row => key(row)),
}
for (const [name, collisions] of Object.entries(overlaps)) check(!collisions.length, `no_reference_overlap_${name}`)
const selected: RecordRow[] = [], groups: RecordRow[] = []
for (const model of manifest.models) for (const group of manifest.groups) {
  const samples = group.challenges.map(challenge => {
    const id = sampleId(manifest, model, group, challenge), from = manifest.resample_from_attempt?.[id] ?? 1
    const chosen = bySample.get(id)?.find(row => row.attempt >= from && row.status === 'accepted')
    if (chosen) selected.push(chosen)
    return {id, selected_attempt: chosen?.attempt ?? null, text_sha256: chosen?.text_sha256 ?? null}
  })
  groups.push({id: `${canonicalLabel(model.label)}:${group.id}`, model: canonicalLabel(model.label), complete: samples.every(sample => sample.selected_attempt !== null), samples})
}
const completeGroups = groups.filter(group => group.complete)
const fullCoverage = !uncovered.length && modelIds.length === 53 && completeGroups.length === 106 && selected.length === 318
const beforeComplete = before.groups.filter((group: any) => group.complete)
check(beforeComplete.length === 72, 'baseline_has_72_old_complete_groups')
for (const old of beforeComplete) {
  const current = groups.find(group => group.id === old.id)
  check(current?.complete && JSON.stringify(current.samples.map((sample: any) => [sample.id, sample.selected_attempt])) === JSON.stringify(old.samples.map((sample: any) => [sample.id, sample.selected_attempt])), 'old_complete_group_keeps_selected_attempts', old.id)
}
let after: any = null
try { after = await readJson(afterPath) } catch {}
const evaluatorHash = hash(await readFile(join(root, 'research/scripts/evaluate-holdout.ts')))
const scorerHash = hash(Buffer.concat(bank.classifier
  ? await Promise.all(['projects/shared/gaussian-core.js', 'projects/shared/number-features.js'].map(path => readFile(join(root, path))))
  : [await readFile(join(root, 'projects/shared/fingerprint-core.js')), await readFile(join(root, 'projects/shared/shared-detector.ts')), bytes.detector]))
const currentEvaluation = after?.dataset_sha256 === sourceHashes.samples && after?.suite_sha256 === sourceHashes.manifest && after?.reference_sha256 === sourceHashes.reference && after?.bank_sha256 === sourceHashes.bank && after?.evaluator_sha256 === evaluatorHash && after?.scorer_sha256 === scorerHash
if (final) check(currentEvaluation, 'current_evaluator_report_matches_all_input_hashes')
const oldGroupIds = new Set(beforeComplete.map((group: any) => group.id))
const newComplete = completeGroups.filter(group => !oldGroupIds.has(group.id))
function scoreSummary(evaluated: any[]) {
  const complete = evaluated.filter(group => group.complete && group.result)
  return {complete_groups: complete.length, top1_correct: complete.filter(group => group.result.correct).length,
    top3_correct: complete.filter(group => group.result.truth_rank <= 3).length,
    top1: complete.length ? complete.filter(group => group.result.correct).length / complete.length : null}
}
const oldAfter = currentEvaluation ? after.groups.filter((group: any) => oldGroupIds.has(group.id)) : []
const newAfter = currentEvaluation ? after.groups.filter((group: any) => !oldGroupIds.has(group.id)) : []
const changes = currentEvaluation ? oldAfter.flatMap((group: any) => {
  const old = beforeComplete.find((candidate: any) => candidate.id === group.id)
  return old?.result?.prediction === group.result?.prediction ? [] : [{id: group.id, truth: group.model, before: old?.result?.prediction, after: group.result?.prediction, before_correct: old?.result?.correct, after_correct: group.result?.correct}]
}) : []
const versionPaths = [...new Set(appended.flatMap(row => Object.keys(row.source_hashes ?? {})))]
for (const path of versionPaths) {
  if (currentCodeHashes[path] || path.includes('..') || isAbsolute(path)) continue
  try { currentCodeHashes[path] = hash(await readFile(join(root, path))) } catch {}
}
const sourceVersionMatrix = Object.fromEntries(versionPaths.map(path => [path, {
  current_workspace_sha256: currentCodeHashes[path] ?? null,
  recorded_versions: [...new Set(appended.map(row => row.source_hashes?.[path]).filter(Boolean))].map(sha256 => {
    const members = appended.filter(row => row.source_hashes?.[path] === sha256)
    return {sha256, attempts: members.length, collection_run_ids: [...new Set(members.map(row => row.collection_run_id))],
      matches_current_workspace: currentCodeHashes[path] ? sha256 === currentCodeHashes[path] : null}
  }),
}]))
const result = {
  generated_at: new Date().toISOString(), stage: final ? 'final' : 'interim', status: errors.length ? 'integrity-errors' : final ? fullCoverage ? 'complete' : 'incomplete' : 'collecting',
  input_hashes: sourceHashes, verification_script_sha256: hash(await readFile(import.meta.path)),
  baseline: {recorded_attempts: oldRows.length, bytes: oldBytes.length, samples_sha256: hash(oldBytes), before: scoreSummary(beforeComplete)},
  preservation: {old_attempts: oldRows.length, new_attempts: appended.length, exact_prefix: bytes.samples.subarray(0, oldBytes.length).equals(oldBytes), old_complete_groups: beforeComplete.length},
  coverage: {bank_labels: bankIds.length, manifest_labels: modelIds.length, uncovered_labels: uncovered, retired_labels: retired,
    planned_groups: 106, complete_groups: completeGroups.length, planned_samples: 318, selected_samples: selected.length,
    old_complete_groups: beforeComplete.length, newly_complete_groups: newComplete.length,
    pending_groups: [...groups.filter(group => !group.complete).map(group => ({id: group.id, missing: group.samples.filter((sample: any) => sample.selected_attempt === null).map((sample: any) => sample.id)})),
      ...uncovered.flatMap(label => manifest.groups.map(group => ({id: `${label}:${group.id}`, missing: group.challenges.map(challenge => sampleId(manifest, {label}, group, challenge))}))) ]},
  evidence: {new_attempts: appended.length, new_http_raw_verified: rawVerified, new_accepted_replayed: replayVerified,
    provider_metadata_recoveries_verified: providerRecoveryVerified,
    derived_cap_attempts: appended.filter(row => row.source_attempt !== undefined && row.record_kind !== 'metadata-recovery').length,
    provider_metadata_recovery_attempts: appended.filter(row => row.record_kind === 'metadata-recovery').length,
    new_missing_raw: missingRaw, accepted_missing_reported_provider: missingProvider.length,
    historical_raw_evidence_required: false, historical_limit: 'Old attempts remain byte-identical; missing historical raw/provider/terminal metadata cannot be reconstructed or asserted.'},
  no_train_overlap: overlaps, attempt_statuses: counts(rows.map(row => row.status)), new_attempt_statuses: counts(appended.map(row => row.status)),
  source_versions: {matrix: sourceVersionMatrix, policy: 'Each row must match its recorded collection-run sources and frozen group hash. Current workspace source changes do not invalidate old attempts; accepted responses must replay with the current parser.'},
  blockers: {uncovered_manifest_labels: uncovered,
    collection_runs: (manifest as any).collection_runs?.flatMap((run: any) => run.blocked_missing_catalog ?? []) ?? [],
    latest_failed_slots: [...bySample.entries()].filter(([id, attempts]) => !attempts.some(row => row.attempt >= (manifest.resample_from_attempt?.[id] ?? 1) && row.status === 'accepted')).map(([id, attempts]) => {
      const last = attempts[attempts.length - 1]!
      return {id, model: canonicalLabel(last.model), attempt: last.attempt, status: last.status, http_status: last.http_status ?? null, reason: String(last.error ?? '').slice(0, 400)}
    })},
  comparison: {report_path: relative(root, afterPath), current_evaluation: !!currentEvaluation,
    paired_old_72: {before: scoreSummary(beforeComplete), after: currentEvaluation ? scoreSummary(oldAfter) : null, changes},
    newly_complete_34: {planned_groups: 34, complete_groups: newComplete.length, result: currentEvaluation ? scoreSummary(newAfter) : null},
    all_106: currentEvaluation ? scoreSummary(after.groups) : null},
  cost: {all_attempts: costs(rows), old_attempts: costs(oldRows), new_attempts: costs(appended), selected_answers: costs(selected)},
  errors,
}
await mkdir(output, {recursive: true})
await writeFile(join(output, 'validation-integrity.json'), JSON.stringify(result, null, 2) + '\n')
const paired = result.comparison.paired_old_72
const markdown = `# 固定测试集补全完整性\n\n状态：${result.stage}，${result.status}。覆盖 ${completeGroups.length}/106 组三回答、${selected.length}/318 条有效回答。\n\n旧 ${oldRows.length} 次尝试按原始 JSONL 字节前缀保留：${result.preservation.exact_prefix ? '通过' : '失败'}。新增 ${appended.length} 次尝试；${rawVerified} 次 HTTP 原始响应哈希已核对，${replayVerified} 条新增有效回答可从原始响应复现。固定六题的 ID、提示词和要求数量保持原样。${providerRecoveryVerified} 条提供商元数据恢复记录已与原始 generation ID、原记录哈希及 API 响应字节严格绑定。\n\n旧 72 组固定回答：${paired.before.top1_correct}/${paired.before.complete_groups} → ${paired.after ? `${paired.after.top1_correct}/${paired.after.complete_groups}` : '等待当前评估报告'}。新增组单独报告：${newComplete.length}/34 已完整；${result.comparison.newly_complete_34.result ? `命中 ${result.comparison.newly_complete_34.result.top1_correct}/${result.comparison.newly_complete_34.result.complete_groups}` : '等待当前评估报告'}。两部分不混用准确率分母。\n\n训练重合：ID ${overlaps.identifiers.length}、原始输出 ${overlaps.exact_text.length}、产品解析数字序列 ${overlaps.parsed_sequence.length}、实际提示词 ${overlaps.prompts.length}。\n\n新增尝试记录费用 ${result.cost.new_attempts.reported_cost_usd.toFixed(6)} USD，${result.cost.new_attempts.with_reported_cost}/${result.cost.new_attempts.api_attempts} 次物理调用有费用字段。${result.cost.new_attempts.derived_attempts} 条派生记录不重复计费。缺少费用的调用不按零费用解释。费用仅累加顶层 usage.cost，不重复累加其分项。\n\n源版本按每条记录与采集 run 的哈希匹配核查；当前工作区版本变更单列在 JSON 版本矩阵中，不使旧记录失效。有效回答均用当前解析器重放。历史尝试未保存的原始响应、提供商或终止信息无法补证。原始数据保持完整，报告不把标签或请求型号解释为独立后端身份认证。\n\n完整性错误 ${errors.length} 项，详情见 validation-integrity.json。${final ? '' : '采集尚未结束，本报告属于中间快照。'}\n`
await writeFile(join(output, 'validation-integrity.md'), markdown)
console.log(JSON.stringify({stage: result.stage, status: result.status, errors: errors.length,
  coverage: {complete_groups: completeGroups.length, planned_groups: 106, selected_samples: selected.length, planned_samples: 318, uncovered_labels: uncovered},
  raw_verified: rawVerified, replay_verified: replayVerified, current_evaluation: !!currentEvaluation, cost: result.cost.new_attempts}))
if (errors.length) process.exitCode = 1
