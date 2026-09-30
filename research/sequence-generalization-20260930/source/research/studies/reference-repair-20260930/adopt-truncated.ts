import { appendFile, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { readCompletion, type CompletionResult } from '../../../projects/shared/completion'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { root, directory, manifestPath, samplesPath, json, jsonl, save, hash, sourceHashes, sampleId, samplePrompt, type Manifest } from '../../scripts/holdout-shared'

// Run only after the uncapped collector exits, while its lock remains held.
const manifest: Manifest & {collection_runs: any[]; profile_history: any[]} = await json(manifestPath)
const rows = await jsonl(samplesPath)
const native = process.argv.includes('--native')
const baseline = await jsonl(join(root, 'research/reports/reference-repair-20260930/baseline/holdout-samples.jsonl'))
const baselineKeys = new Set(baseline.map(row => `${row.sample_id}:${row.attempt}`))
const slots = manifest.models.flatMap(target => manifest.groups.flatMap(group => group.challenges.map(challenge => ({
  target, group, challenge, id: sampleId(manifest, target, group, challenge),
}))))
const byId = new Map<string, any[]>()
for (const row of rows) byId.set(row.sample_id, [...byId.get(row.sample_id) ?? [], row])
const stoppedRun = manifest.collection_runs.findLast(run => native ? run.profile.source_kind === 'original-channel' : run.models.some((label: string) => label === 'mimo-v2.6-pro'))
const time = new Date().toISOString()
const recovered: string[] = [], adopted: any[] = []

// Preserve paid in-flight requests whose raw trace existed before termination.
for (const slot of slots) {
  if (native !== (slot.target.source_kind === 'original-channel')) continue
  const base = join(directory, 'raw-traces', hash(slot.id))
  const directories = await readdir(base).catch(() => [])
  for (const name of directories.sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))) {
    if (!/^attempt-\d+$/.test(name)) continue
    const attempt = Number(name.split('-')[1]), history = byId.get(slot.id) ?? []
    if (history.some(row => row.attempt === attempt)) continue
    if (attempt !== history.length + 1) throw new Error(`Missing attempt before interrupted trace: ${slot.id}`)
    const trace = join(base, name)
    const request = await json(join(trace, 'attempt-1.request.json'))
    const prompt = samplePrompt(manifest, slot.id, attempt, slot.challenge.prompt)
    if (request.body.model !== slot.target.api_model || request.body.messages?.at(-1)?.content !== prompt) throw new Error('Interrupted trace request identity differs')
    const metadata = await json(join(trace, 'attempt-1.response.json')).catch(() => null)
    const rawPath = join(trace, 'attempt-1.body.txt'), raw = await readFile(rawPath).catch(() => null)
    let text = '', snapshot: CompletionResult | undefined
    if (raw && metadata) {
      try { snapshot = await readCompletion(new Response(raw, {status: metadata.status, headers: {'content-type': metadata.content_type ?? ''}}), slot.target.format, value => { text = value }, value => { snapshot = value }) }
      catch (error) { snapshot = (error as any).completionDetails ?? snapshot }
    }
    const row: any = {purpose: 'holdout', test_set_id: manifest.id, sample_id: slot.id, model: slot.target.label,
      group_id: slot.group.id, challenge_id: slot.challenge.id, expected_count: slot.challenge.expected_count,
      prompt, request: request.body, format: slot.target.format, attempt, started_at: request.started_at,
      collected_at: time, text, text_sha256: hash(text), parsed_count: parseNumbers(text).length, status: 'failed',
      error: 'Collector interrupted to apply user-authorized integer-prefix truncation; original trace retained.',
      collection_run_id: stoppedRun.id, source_hashes: stoppedRun.source_hashes, recovery: 'raw-trace-after-termination',
      provenance: {kind: slot.target.source_kind ?? 'openrouter', endpoint: slot.target.endpoint ?? manifest.endpoint, api_model: slot.target.api_model,
        canonical_slug: slot.target.canonical_slug, source_channel: slot.target.source_channel,
        provider_route: slot.target.provider_override?.only?.[0] ?? null, trust_basis: slot.target.trust_basis ?? 'direct-openrouter'},
      ...(snapshot ? {response_model: snapshot.responseModel, response_id: snapshot.responseId, provider_reported: snapshot.providerReported,
        usage: snapshot.usage, completion: snapshot.completion, finish_reason: snapshot.finishReason} : {}),
      ...(metadata ? {http_status: metadata.status, raw_response_metadata: {path: relative(root, join(trace, 'attempt-1.response.json')), ...metadata}} : {}),
      ...(raw ? {raw_response: {path: relative(root, rawPath), sha256: hash(raw), bytes: raw.length, format: slot.target.format}} : {})}
    await appendFile(samplesPath, JSON.stringify(row) + '\n')
    history.push(row); byId.set(slot.id, history); recovered.push(`${slot.id}:${attempt}`)
  }
}
Object.assign(stoppedRun, {completed_at: time, interrupted: true, interruption_reason: 'User requested direct truncation.'})
const sources = {...await sourceHashes(), 'research/studies/reference-repair-20260930/adopt-truncated.ts': hash(await readFile(import.meta.filename)),
  'projects/shared/fingerprint-core.js': hash(await readFile(join(root, 'projects/shared/fingerprint-core.js')))}
const run = {id: crypto.randomUUID(), started_at: time, completed_at: time, models: [] as string[], source_hashes: sources,
  fixed_groups_sha256: hash(JSON.stringify(manifest.groups)), profile: {...manifest.profile, selection_policy: 'user-authorized-expected-count-cap', max_numbers_policy: 'challenge.expected_count'},
  kind: 'derive-from-preserved-raw-response', authorization: 'User: 直接截断啊', reason: 'Use the earliest eligible new raw response prefix; preserve all old attempts and raw bytes.'}
manifest.collection_runs.push(run)
manifest.profile_history.push({changed_at: time, profile: run.profile, source_hashes: sources, collection_run_id: run.id, reason: run.reason})
manifest.resample_from_attempt ??= {}
for (const slot of slots) {
  const history = byId.get(slot.id) ?? []
  const floor = manifest.resample_from_attempt[slot.id] ?? 1
  const selected = history.find(row => row.attempt >= floor && row.status === 'accepted')
  if (selected && (baselineKeys.has(`${slot.id}:${selected.attempt}`) || parseNumbers(selected.text).length <= slot.challenge.expected_count)) continue
  for (const source of history) {
    if (baselineKeys.has(`${slot.id}:${source.attempt}`) || source.attempt < floor || source.http_status !== 200 || !source.raw_response) continue
    const raw = await readFile(join(root, source.raw_response.path))
    if (hash(raw) !== source.raw_response.sha256) throw new Error('Original response hash changed')
    let completion: CompletionResult
    try { completion = await readCompletion(new Response(raw, {status: 200, headers: {'content-type': source.raw_response_metadata.content_type}}), slot.target.format, undefined, undefined, slot.challenge.expected_count) }
    catch { continue }
    if (!completion.capped || parseNumbers(completion.text).length !== slot.challenge.expected_count || ![slot.target.api_model, slot.target.canonical_slug].includes(completion.responseModel ?? '')) continue
    const pinned = slot.target.provider_override?.only?.[0]
    const provider = (value: string) => value.split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, '')
    if (pinned && (!completion.providerReported || provider(pinned) !== provider(completion.providerReported))) continue
    const attempt = Math.max(0, ...history.map(row => row.attempt)) + 1
    const row = {...source, attempt, status: 'accepted', error: undefined, completion_details: undefined,
      text: completion.text, text_sha256: hash(completion.text), parsed_count: slot.challenge.expected_count,
      response_model: completion.responseModel, response_id: completion.responseId, provider_reported: completion.providerReported,
      usage: completion.usage, completion: completion.completion, finish_reason: completion.finishReason, capped: completion.capped,
      max_numbers: slot.challenge.expected_count, selection_policy: 'user-authorized-expected-count-cap', source_attempt: source.attempt,
      source_usage: source.usage, billed_request: false, collected_at: time, elapsed_ms: 0, source_elapsed_ms: source.elapsed_ms,
      collection_run_id: run.id, source_hashes: sources, recovery: undefined}
    await appendFile(samplesPath, JSON.stringify(row) + '\n')
    history.push(row); manifest.resample_from_attempt[slot.id] = attempt
    if (!run.models.includes(slot.target.label)) run.models.push(slot.target.label)
    adopted.push({sample_id: slot.id, source_attempt: source.attempt, active_attempt: attempt, count: slot.challenge.expected_count})
    break
  }
}
await save(manifestPath, manifest)
await save(join(root, `research/reports/reference-repair-20260930/${native ? 'native-recovery' : 'truncation-adoption'}.json`), {created_at: time, recovered, adopted, policy: run.profile})
console.log(JSON.stringify({recovered: recovered.length,adopted: adopted.length,models:run.models}))
