import { appendFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { generateChallenges } from '../../projects/shared/challenge-browser.js'
import { parseNumbers } from '../../projects/shared/fingerprint-core.js'
import { completionBody, COMPLETION_TIMEOUT_MS } from '../../projects/shared/completion-request'
import { readCompletion } from '../../projects/shared/completion'
import { traceTransport } from '../../projects/cli/trace'
import { directory, root, manifestPath, samplesPath, json, jsonl, save, sourceHashes, sampleId, hash, samplePrompt, type Manifest, type Target } from './holdout-shared'

const key = process.env.OPENROUTER_API_KEY
if (!key) throw new Error('Set OPENROUTER_API_KEY before collecting. Evaluation does not need a key.')
const endpoint = 'https://openrouter.ai/api/v1'
const concurrency = Number(process.env.HOLDOUT_CONCURRENCY || 3)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('HOLDOUT_CONCURRENCY must be 1–12')
const onlyModel = process.env.HOLDOUT_MODEL
const retryFailed = process.argv.includes('--retry-failed')
const resample = process.argv.includes('--resample')
const maxAttempts = Number(process.env.HOLDOUT_MAX_ATTEMPTS || 3)
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('HOLDOUT_MAX_ATTEMPTS must be 1–5')
if (resample && retryFailed) throw new Error('Use --resample to start or resume the pinned cohort; use --retry-failed separately afterward.')
type CollectionManifest = Manifest & {profile_history?: any[]; collection_runs?: any[]}
const referenceLabel = (label: string) => label.startsWith('claude-')
  ? label.replace(/-(\d)-(\d)(?:-\d{8})?$/, '-$1.$2') : label
const providerIdentity = (value: string) => value.split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, '')
await mkdir(directory, {recursive: true})
const lock = join(directory, '.collect-lock')
await mkdir(lock).catch(() => { throw new Error('A holdout collector is already running; inspect research/evaluation/holdout/.collect-lock before retrying.') })
try {
  let manifest: CollectionManifest | undefined
  try { manifest = await json(manifestPath) }
  catch (error: any) { if (error.code !== 'ENOENT') throw error }
  const catalogueResponse = await fetch(endpoint + '/models', {headers: {Authorization: 'Bearer ' + key, 'User-Agent': 'ModelTrace/1.0'}, signal: AbortSignal.timeout(30000)})
  if (!catalogueResponse.ok) throw new Error(`Model catalogue HTTP ${catalogueResponse.status}`)
  const catalogue = (await catalogueResponse.json() as any).data
  const bank = await json(join(root, 'projects/data/unified_bank.json'))
  const reference = await jsonl(join(root, 'projects/data/unified_reference.jsonl'))
  const requested = onlyModel?.split(',')
  if (requested?.some(label => !bank.models.some((model: any) => model.id === referenceLabel(label)))) throw new Error('HOLDOUT_MODEL contains an unregistered model label.')
  const targets: Target[] = bank.models.filter((m: {id: string}) => !requested || requested.includes(m.id)).map((m: {id: string; family: string}) => {
    const existing = manifest?.models.find(target => referenceLabel(target.label) === m.id)
    if (existing) {
      if (!catalogue.some((entry: any) => entry.id === existing.api_model)) throw new Error(`Existing target unavailable in current OpenRouter catalogue: ${existing.label}, ${existing.api_model}`)
      return existing
    }
    const batches = reference.filter(batch => batch.model?.id === m.id)
    const requestedModels = [...new Set<string>(batches.map(batch => batch.request?.model).filter(Boolean))]
    const apiModels = requestedModels.map(model => model.includes('/') ? model :
      batches.every(batch => batch.source?.channel === 'openai/direct') ? `openai/${model}` : model)
    if (apiModels.length !== 1) throw new Error(`Reference request model is missing or ambiguous for ${m.id}; add an explicit proven manifest target.`)
    const api_model = apiModels[0]
    const found = catalogue.find((x: any) => x.id === api_model)
    if (!found) throw new Error(`No exact OpenRouter model mapping for ${m.id}: ${api_model}`)
    const latest = batches.flatMap(batch => batch.samples.map((sample: any) => ({batch, sample})))
      .sort((a, b) => String(a.sample.finished_at ?? a.batch.created_at).localeCompare(String(b.sample.finished_at ?? b.batch.created_at))).at(-1)
    const format = {chat_completions: 'openai', responses: 'responses', messages: 'anthropic'}[latest?.batch.request.format as string]
    if (!format) throw new Error(`Reference request format is missing for ${m.id}; add an explicit manifest target.`)
    const target: Target = {label: m.id, api_model, canonical_slug: found.canonical_slug, family: m.family, format}
    const effort = latest?.sample.reasoning_effort ?? latest?.batch.request.reasoning_effort
    if (effort === 'none') target.reasoning_override = {enabled: false}
    else if (effort && effort !== 'default') target.reasoning_override = {effort}
    const channels = [...new Set<string>(batches.map(batch => batch.source.channel))]
    const route = channels.length === 1 ? channels[0].replace(/^openrouter\//, '') : undefined
    if (route && channels[0].startsWith('openrouter/') && route !== 'unknown') target.provider_override = {only: [route], allow_fallbacks: false}
    else if (channels.length === 1 && channels[0] === 'openai/direct') target.provider_override = {only: ['openai'], allow_fallbacks: false}
    return target
  })
  if (!manifest) {
    manifest = {purpose: 'holdout', id: 'holdout-' + crypto.randomUUID(), created_at: new Date().toISOString(), endpoint,
      groups: [1, 2].map(i => ({id: `group-${i}`, challenges: generateChallenges(3)})), models: targets,
      profile: {effort: '', stream: true, parallel: false, output_limit: 8192, timeout_ms: COMPLETION_TIMEOUT_MS}, source_hashes: await sourceHashes()}
    if (manifest.groups.flatMap(g => g.challenges).some(c => reference.some(batch => batch.samples.some((sample: any) => sample.prompt === c.prompt)))) throw new Error('New holdout prompt overlaps training data')
    await save(manifestPath, manifest)
  }
  const currentHashes = await sourceHashes()
  if (manifest.endpoint !== endpoint) throw new Error('Collection endpoint changed; create a separate suite.')
  if (manifest.purpose !== 'holdout' || manifest.groups.length !== 2 || manifest.groups.some(group => group.challenges.length !== 3)) throw new Error('Expected the fixed two-group, three-challenge holdout suite.')
  // The saved challenge text defines an existing suite. A changed generator is
  // not executed during continuation; new request/parser versions are recorded.
  const collectionSourceHashes = {...currentHashes, ...Object.fromEntries(await Promise.all([
    'research/scripts/collect-holdout.ts', 'projects/shared/fingerprint-core.js', 'projects/cli/trace.ts',
  ].map(async path => [path, hash(await readFile(join(root, path)))])))}
  const newTargets = targets.filter(t => !manifest.models.some(m => m.label === t.label))
  if (newTargets.length) {manifest.models.push(...newTargets); await save(manifestPath, manifest)}
  const blockedMissingCatalogue = bank.models.filter((model: any) => {
    const existing = manifest.models.find(target => referenceLabel(target.label) === model.id)
    if (existing && catalogue.some((entry: any) => entry.id === existing.api_model)) return false
    const batches = reference.filter(batch => batch.model?.id === model.id)
    const models = [...new Set<string>(batches.map(batch => batch.request?.model).filter(Boolean))]
    return models.length === 1 && !catalogue.some((entry: any) => entry.id === models[0] ||
      (batches.every(batch => batch.source?.channel === 'openai/direct') && entry.id === `openai/${models[0]}`))
  }).map((model: any) => ({label: model.id, request_models: [...new Set(reference.filter(batch => batch.model?.id === model.id).map(batch => batch.request?.model))], reason: 'blocked_missing_catalog'}))
  const run = {id: crypto.randomUUID(), started_at: new Date().toISOString(), models: targets.map(target => target.label),
    source_hashes: collectionSourceHashes, fixed_groups_sha256: hash(JSON.stringify(manifest.groups)),
    profile: {...manifest.profile, max_numbers_policy: 'challenge.expected_count',
      selection_policy: 'user-authorized-expected-count-cap'}, blocked_missing_catalog: blockedMissingCatalogue,
    reason: 'Continue saved fixed challenges; preserve historical attempts, profiles and source hashes.'}
  manifest.collection_runs ??= []; manifest.collection_runs.push(run)
  manifest.profile_history ??= []; manifest.profile_history.push({changed_at: run.started_at, profile: run.profile,
    source_hashes: collectionSourceHashes, collection_run_id: run.id, reason: run.reason})
  await save(manifestPath, manifest)
  const records = await jsonl(samplesPath)
  const attempts = new Map<string, any[]>()
  for (const r of records) attempts.set(r.sample_id, [...attempts.get(r.sample_id) || [], r])
  if (resample) {
    if (!onlyModel) throw new Error('--resample requires HOLDOUT_MODEL to name the models being refreshed.')
    manifest.resample_from_attempt ??= {}
    for (const target of manifest.models.filter(t => onlyModel.split(',').includes(t.label))) {
      if (target.provider_override?.only?.length !== 1 || target.provider_override.allow_fallbacks !== false) throw new Error(`Pin exactly one provider without fallback before resampling ${target.label}.`)
      for (const group of manifest.groups) for (const challenge of group.challenges) {
        const id = sampleId(manifest, target, group, challenge)
        manifest.resample_from_attempt[id] ??= (attempts.get(id)?.length ?? 0) + 1
      }
    }
    await save(manifestPath, manifest)
  }
  let halted = false, accepted = 0, failed = 0
  const selectedLabels = new Set(targets.map(target => target.label))
  const groupJobs = manifest.models.filter(target => selectedLabels.has(target.label)).flatMap(target => manifest.groups.map(group => ({target, group})))
  const jobs = retryFailed ? groupJobs.flatMap(({target, group}) => group.challenges.map(challenge => ({target, group: {...group, challenges: [challenge]}}))) : groupJobs
  async function collectGroup({target, group}: typeof jobs[number]) {
    for (const challenge of group.challenges) {
      if (halted) return
      const id = sampleId(manifest, target, group, challenge), previous = attempts.get(id) || []
      const fromAttempt = manifest.resample_from_attempt?.[id] ?? 1
      if (previous.some(r => r.attempt >= fromAttempt && r.status === 'accepted') || (fromAttempt === 1 && previous.length && !retryFailed && !resample)) continue
      for (let retry = 0; retry < maxAttempts && !halted; retry++) {
        const prompt = samplePrompt(manifest, id, previous.length + 1, challenge.prompt)
        const body = completionBody({model: target.api_model, format: target.format, effort: manifest.profile.effort, stream: true}, prompt)
        const reasoningRevision = manifest.reasoning_revisions?.findLast(r => r.sample_id === id && r.from_attempt <= previous.length + 1)
        if (reasoningRevision) body.reasoning = reasoningRevision.reasoning
        else if (target.reasoning_override) body.reasoning = target.reasoning_override
        if (target.provider_override) body.provider = target.provider_override
        const headers: Record<string, string> = {'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'User-Agent': 'ModelTrace/1.0'}
        if (target.format === 'anthropic') {headers['x-api-key'] = key!; headers['anthropic-version'] = '2023-06-01'}
        const suffix = {anthropic: '/messages', responses: '/responses', openai: '/chat/completions'}[target.format]
        const started = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS)
        let text = '', retryable = false
        const record: any = {purpose: 'holdout', test_set_id: manifest.id, sample_id: id, model: target.label, group_id: group.id,
          challenge_id: challenge.id, expected_count: challenge.expected_count, prompt, request: body,
          format: target.format, provenance: {kind: 'openrouter', endpoint, api_model: target.api_model, canonical_slug: target.canonical_slug, provider_route: target.provider_override?.only?.[0] ?? null, trust_basis: 'direct-openrouter'},
          attempt: previous.length + 1, started_at: new Date(started).toISOString(), collection_run_id: run.id,
          source_hashes: collectionSourceHashes, max_numbers: challenge.expected_count,
          selection_policy: 'user-authorized-expected-count-cap', completion: 'unknown', finish_reason: null, capped: false}
        const traceDirectory = join(directory, 'raw-traces', hash(id), `attempt-${record.attempt}`)
        try {
          const transport = await traceTransport(traceDirectory, async (url, _config, request, signal) =>
            fetch(url, {method: 'POST', headers, body: JSON.stringify(request), signal}))
          const response = await transport(endpoint + suffix, {baseUrl: endpoint, apiKey: key!, model: target.api_model,
            format: target.format, effort: manifest.profile.effort, stream: true}, body, controller.signal)
          record.http_status = response.status
          retryable = response.status === 429 || response.status >= 500
          record.generation_id = response.headers.get('x-generation-id')
          const completion = await readCompletion(response, target.format, part => {text = part}, undefined, challenge.expected_count)
          Object.assign(record, {text: completion.text, response_model: completion.responseModel, response_id: completion.responseId,
            provider_reported: completion.providerReported, usage: completion.usage, completion: completion.completion,
            finish_reason: completion.finishReason ?? null, capped: Boolean(completion.capped)})
          if (![target.api_model, target.canonical_slug].includes(completion.responseModel ?? '')) throw new Error(`Response model mismatch: expected ${target.api_model} or ${target.canonical_slug}, received ${completion.responseModel}`)
          const pinned = target.provider_override?.only?.[0]
          if (pinned && (!completion.providerReported || providerIdentity(completion.providerReported) !== providerIdentity(pinned))) throw new Error(`Provider mismatch: expected ${pinned}, received ${completion.providerReported ?? '(missing)'}`)
          record.parsed_count = parseNumbers(completion.text).length
          record.status = record.parsed_count >= Math.max(80, Math.ceil(challenge.expected_count * .55)) ? 'accepted' : 'invalid'
          if (record.status === 'invalid') record.error = 'Insufficient valid numbers'
        } catch (error) {
          const message = String(error instanceof Error ? error.message : error).replaceAll(key!, '[REDACTED]').replace(/\bsk-[\w-]+/g, '[REDACTED]')
          Object.assign(record, {status: 'failed', text, parsed_count: parseNumbers(text).length, error: message})
          if ((error as any)?.completionDetails) {
            const details = (error as any).completionDetails
            Object.assign(record, {completion_details: details, usage: details.usage, completion: details.completion,
              finish_reason: details.finishReason ?? details.finish ?? null, capped: Boolean(details.capped)})
          }
          retryable ||= controller.signal.aborted || /timeout|timed out|fetch failed|connection|socket|ECONN/i.test(message)
          if (record.http_status === 401 || record.http_status === 402 || /Payment Required|available credits|insufficient credits/i.test(message)) halted = true
        } finally {clearTimeout(timer); controller.abort()}
        try {
          const path = join(traceDirectory, 'attempt-1.body.txt'), bytes = await readFile(path)
          record.raw_response = {path: relative(root, path), sha256: hash(bytes), bytes: bytes.length, format: target.format}
          record.raw_response_metadata = {path: relative(root, join(traceDirectory, 'attempt-1.response.json')),
            ...await json(join(traceDirectory, 'attempt-1.response.json'))}
        } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        record.elapsed_ms = Date.now() - started
        record.collected_at = new Date().toISOString()
        record.text_sha256 = hash(record.text || '')
        await appendFile(samplesPath, JSON.stringify(record) + '\n')
        previous.push(record); attempts.set(id, previous)
        if (record.status === 'accepted') accepted++; else failed++
        console.log(`${target.label} ${group.id} ${challenge.id.split('-').slice(0, 2).join('-')}: ${record.status}, ${record.parsed_count} numbers${record.error ? ', ' + record.error.slice(0, 180) : ''}`)
        if (retryFailed && record.status !== 'accepted' && record.http_status === 200 && !String(record.error || '').includes('Response model mismatch')) retryable = true
        if (!retryable || record.status === 'accepted' || halted) break
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }
  }
  const workers = Array.from({length: concurrency}, async () => {while (jobs.length && !halted) await collectGroup(jobs.shift()!)})
  await Promise.all(workers)
  Object.assign(run, {completed_at: new Date().toISOString(), accepted_this_run: accepted, failed_attempts_this_run: failed, halted})
  await save(manifestPath, manifest)
  console.log(JSON.stringify({accepted_this_run: accepted, failed_attempts_this_run: failed, halted, planned_samples: manifest.models.length * 6}))
  if (halted) process.exitCode = 2
} finally {await rm(lock, {recursive: true, force: true})}
