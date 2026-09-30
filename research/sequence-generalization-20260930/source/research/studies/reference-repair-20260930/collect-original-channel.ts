import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { completionBody, COMPLETION_TIMEOUT_MS } from '../../../projects/shared/completion-request'
import { readCompletion } from '../../../projects/shared/completion'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { traceTransport } from '../../../projects/cli/trace'
import { directory, root, manifestPath, samplesPath, json, jsonl, save, sourceHashes, sampleId, samplePrompt, hash, type Manifest, type Target } from '../../scripts/holdout-shared'

type OriginalTarget = Target & {
  endpoint: string
  source_kind: 'original-channel'
  source_channel: string
  trust_basis: string
  effort_choice: string
}
type CollectionManifest = Manifest & {collection_runs?: any[]; profile_history?: any[]}
const definitions = [
  {label: 'kimi-k2.8-preview', model: 'kimi-for-coding', family: 'kimi', keyName: 'KIMI_API_KEY',
    endpoint: 'https://api.kimi.com/coding/v1/chat/completions', channel: 'kimi-code-subscription',
    trustBasis: 'direct-kimi-code',
    effortChoice: 'Use low from the original Kimi Coding reference requests.'},
  {label: 'step-5-preview', model: 'step-5-preview', family: 'step', keyName: 'STEP_API_KEY',
    endpoint: 'https://api.stepfun.com/step_plan/v1/chat/completions', channel: 'stepfun-api',
    trustBasis: 'direct-stepfun',
    effortChoice: 'Reference includes default and low; use low from the original-channel recovery requests.'},
] as const
const retryFailed = process.argv.includes('--retry-failed')
const maxAttempts = Number(process.env.HOLDOUT_MAX_ATTEMPTS || 3)
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('HOLDOUT_MAX_ATTEMPTS must be 1–3 for original channels.')
const outputLimit = Number(process.env.HOLDOUT_OUTPUT_LIMIT || 8192)
if (!Number.isInteger(outputLimit) || outputLimit < 8192 || outputLimit > 65536) throw new Error('HOLDOUT_OUTPUT_LIMIT must be 8192–65536.')
const timeoutMs = Number(process.env.HOLDOUT_TIMEOUT_MS || COMPLETION_TIMEOUT_MS)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('HOLDOUT_TIMEOUT_MS must be 1000–600000.')
const only = process.env.HOLDOUT_MODEL?.split(',')
if (only?.some(label => !definitions.some(target => target.label === label))) throw new Error('Original-channel collector supports only the two original reference identities.')
const selected = definitions.filter(target => !only || only.includes(target.label))
const secretValues = selected.map(target => process.env[target.keyName]).filter(Boolean) as string[]
function safeError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of secretValues) message = message.replaceAll(value, '[REDACTED]')
  return message.replace(/\bsk-[\w-]+/g, '[REDACTED]')
}
const lock = join(directory, '.collect-lock')
await mkdir(directory, {recursive: true})
await mkdir(lock).catch(() => { throw new Error('A holdout collector is already running; wait for it to finish before collecting original channels.') })
try {
  const manifest: CollectionManifest = await json(manifestPath)
  if (manifest.purpose !== 'holdout' || manifest.groups.length !== 2 || manifest.groups.some(group => group.challenges.length !== 3)) throw new Error('Expected the saved two-group, three-challenge fixed suite.')
  const bank = await json(join(root, 'projects/data/unified_bank.json'))
  const targets: OriginalTarget[] = selected.map(definition => {
    if (!bank.models.some((model: any) => model.id === definition.label)) throw new Error(`Unregistered original reference identity: ${definition.label}`)
    const target: OriginalTarget = {label: definition.label, api_model: definition.model, canonical_slug: null,
      family: definition.family, format: 'openai', reasoning_override: {effort: 'low'}, endpoint: definition.endpoint,
      source_kind: 'original-channel', source_channel: definition.channel, trust_basis: definition.trustBasis,
      effort_choice: definition.effortChoice}
    const existing = manifest.models.find(model => model.label === definition.label) as OriginalTarget | undefined
    if (existing) {
      if (existing.api_model !== target.api_model || existing.endpoint !== target.endpoint || existing.format !== 'openai'
        || existing.source_kind !== target.source_kind || existing.source_channel !== target.source_channel
        || existing.trust_basis !== target.trust_basis || JSON.stringify(existing.reasoning_override) !== JSON.stringify(target.reasoning_override)
        || existing.provider_override) throw new Error(`Original-channel target configuration differs: ${target.label}`)
      return existing
    }
    manifest.models.push(target)
    return target
  })
  const sources = {...await sourceHashes(), ...Object.fromEntries(await Promise.all([
    'research/studies/reference-repair-20260930/collect-original-channel.ts',
    'projects/shared/fingerprint-core.js', 'projects/cli/trace.ts',
  ].map(async path => [path, hash(await readFile(join(root, path)))])))}
  const profile = {...manifest.profile, effort: 'low', stream: true, parallel: false,
    output_limit: outputLimit, timeout_ms: timeoutMs, reasoning_field: 'reasoning_effort', source_kind: 'original-channel',
    max_numbers_policy: 'challenge.expected_count', selection_policy: 'user-authorized-expected-count-cap'}
  const run: any = {id: crypto.randomUUID(), started_at: new Date().toISOString(), models: targets.map(target => target.label),
    source_hashes: sources, fixed_groups_sha256: hash(JSON.stringify(manifest.groups)), profile,
    targets: targets.map(target => ({label: target.label, api_model: target.api_model, endpoint: target.endpoint,
      source_channel: target.source_channel, trust_basis: target.trust_basis, effort_choice: target.effort_choice})),
    reason: 'Complete the saved six challenges through their original reference channels; no OpenRouter fallback.',
    blocked_sources: [], halted_sources: []}
  manifest.collection_runs ??= []; manifest.collection_runs.push(run)
  manifest.profile_history ??= []; manifest.profile_history.push({changed_at: run.started_at, profile,
    source_hashes: sources, collection_run_id: run.id, reason: run.reason})
  await save(manifestPath, manifest)
  const previous = new Map<string, any[]>()
  for (const row of await jsonl(samplesPath)) previous.set(row.sample_id, [...previous.get(row.sample_id) || [], row])
  const tally = {accepted_this_run: 0, failed_attempts_this_run: 0}

  async function collect(target: OriginalTarget) {
    const definition = selected.find(value => value.label === target.label)!
    const apiKey = process.env[definition.keyName]
    if (!apiKey) {
      run.blocked_sources.push({label: target.label, reason: 'missing_original_channel_credential', variable: definition.keyName})
      console.log(`${target.label}: missing ${definition.keyName}; planned slots remain missing.`)
      return
    }
    let halted = false
    for (const group of manifest.groups) for (const challenge of group.challenges) {
      if (halted) return
      const id = sampleId(manifest, target, group, challenge)
      const attempts = previous.get(id) || []
      const floor = manifest.resample_from_attempt?.[id] ?? 1
      if (attempts.some(row => row.attempt >= floor && row.status === 'accepted')) continue
      if (attempts.some(row => row.attempt >= floor) && !retryFailed) continue
      for (let retry = 0; retry < maxAttempts && !halted; retry++) {
        const attempt = Math.max(0, ...attempts.map(row => row.attempt)) + 1
        const prompt = samplePrompt(manifest, id, attempt, challenge.prompt)
        const body = completionBody({model: target.api_model, format: 'openai', effort: 'low', stream: true}, prompt)
        body.max_tokens = outputLimit
        const headers = {'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, 'User-Agent': 'ModelTrace/1.0'}
        const started = Date.now(), controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const traceDirectory = join(directory, 'raw-traces', hash(id), `attempt-${attempt}`)
        const record: any = {purpose: 'holdout', test_set_id: manifest.id, sample_id: id, model: target.label,
          group_id: group.id, challenge_id: challenge.id, expected_count: challenge.expected_count, prompt,
          request: body, format: 'openai', attempt, started_at: new Date(started).toISOString(),
          collection_run_id: run.id, source_hashes: sources, max_numbers: challenge.expected_count,
          selection_policy: 'user-authorized-expected-count-cap', completion: 'unknown', finish_reason: null, capped: false,
          provenance: {kind: target.source_kind, endpoint: target.endpoint, api_model: target.api_model,
            canonical_slug: target.canonical_slug, source_channel: target.source_channel, provider_route: null,
            trust_basis: target.trust_basis}}
        let text = '', retryable = false
        try {
          const transport = await traceTransport(traceDirectory, async (url, _config, request, signal) =>
            fetch(url, {method: 'POST', headers, body: JSON.stringify(request), signal}))
          const response = await transport(target.endpoint, {baseUrl: target.endpoint.replace(/\/chat\/completions$/, ''),
            apiKey, model: target.api_model, format: 'openai', effort: 'low', stream: true}, body, controller.signal)
          record.http_status = response.status
          retryable = response.status === 429 || response.status >= 500
          record.generation_id = response.headers.get('x-generation-id')
          const completion = await readCompletion(response, 'openai', partial => { text = partial }, undefined, challenge.expected_count)
          Object.assign(record, {text: completion.text, response_model: completion.responseModel, response_id: completion.responseId,
            provider_reported: completion.providerReported ?? null, usage: completion.usage,
            completion: completion.completion, finish_reason: completion.finishReason ?? null, capped: Boolean(completion.capped)})
          if (completion.responseModel !== target.api_model) throw new Error(`Response model mismatch: expected ${target.api_model}, received ${completion.responseModel ?? '(missing)'}`)
          record.parsed_count = parseNumbers(completion.text).length
          record.status = record.parsed_count >= Math.max(80, Math.ceil(challenge.expected_count * .55)) ? 'accepted' : 'invalid'
          if (record.status === 'invalid') { record.error = 'Insufficient valid numbers'; retryable = true }
        } catch (error) {
          const message = safeError(error)
          Object.assign(record, {status: 'failed', text, parsed_count: parseNumbers(text).length, error: message})
          if ((error as any)?.completionDetails) {
            const details = (error as any).completionDetails
            Object.assign(record, {completion_details: details, usage: details.usage, completion: details.completion,
              finish_reason: details.finishReason ?? details.finish ?? null, capped: Boolean(details.capped)})
          }
          retryable ||= controller.signal.aborted || /timeout|timed out|fetch failed|connection|socket|ECONN/i.test(message)
          retryable ||= retryFailed && record.http_status === 200 && !message.includes('Response model mismatch')
          if (record.http_status === 401 || record.http_status === 402 || /Payment Required|available credits|insufficient credits/i.test(message)) {
            halted = true
            run.halted_sources.push({label: target.label, reason: 'authentication_or_credit_failure', http_status: record.http_status ?? null})
          }
          if (message.includes('Response model mismatch')) retryable = false
        } finally { clearTimeout(timer); controller.abort() }
        try {
          const path = join(traceDirectory, 'attempt-1.body.txt'), bytes = await readFile(path)
          record.raw_response = {path: relative(root, path), sha256: hash(bytes), bytes: bytes.length, format: 'openai'}
          record.raw_response_metadata = {path: relative(root, join(traceDirectory, 'attempt-1.response.json')),
            ...await json(join(traceDirectory, 'attempt-1.response.json'))}
        } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        record.elapsed_ms = Date.now() - started
        record.collected_at = new Date().toISOString()
        record.text_sha256 = hash(record.text || '')
        await appendFile(samplesPath, JSON.stringify(record) + '\n')
        attempts.push(record); previous.set(id, attempts)
        if (record.status === 'accepted') tally.accepted_this_run++
        else tally.failed_attempts_this_run++
        console.log(`${target.label} ${group.id} ${challenge.id.split('-').slice(0, 2).join('-')}: ${record.status}, ${record.parsed_count} numbers${record.error ? ', ' + record.error.slice(0, 180) : ''}`)
        if (!retryable || record.status === 'accepted' || halted || retry + 1 === maxAttempts) break
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }
  }
  await Promise.all(targets.map(collect))
  Object.assign(run, {completed_at: new Date().toISOString(), ...tally})
  await save(manifestPath, manifest)
  console.log(JSON.stringify({...tally, planned_samples: targets.length * 6, blocked_sources: run.blocked_sources, halted_sources: run.halted_sources}))
  if (run.blocked_sources.length || run.halted_sources.length) process.exitCode = 2
} finally { await rm(lock, {recursive: true, force: true}) }
