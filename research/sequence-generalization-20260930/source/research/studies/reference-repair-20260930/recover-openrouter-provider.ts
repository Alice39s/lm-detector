import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readCompletion, type Format } from '../../../projects/shared/completion'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { directory, hash, json, manifestPath, root, sampleId, samplesPath, save, sourceHashes, type Manifest } from '../../scripts/holdout-shared'

type Row = Record<string, any>
type RecoveryManifest = Manifest & {collection_runs?: Row[]; profile_history?: Row[]}
const script = 'research/studies/reference-repair-20260930/recover-openrouter-provider.ts'
const output = join(root, 'research/reports/reference-repair-20260930/generation-provider-recovery')
const planPath = join(output, 'plan.json')
const adopt = process.argv.includes('--adopt')
const endpoint = 'https://openrouter.ai/api/v1/generation'
const identity = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const require = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const local = (path: string) => {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  require(!relative(root, absolute).startsWith('..'), 'Evidence path is outside the workspace')
  return absolute
}
const readRows = async () => (await readFile(samplesPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) as Row[]

async function validateSource(row: Row, target: Manifest['models'][number], expected: number) {
  require(row.status === 'failed' && row.error === 'Provider mismatch: expected openai, received (missing)', 'Source failure has another cause')
  require(row.http_status === 200 && !row.provider_reported, 'Source already has provider metadata or failed HTTP')
  require(row.request.provider?.only?.length === 1 && row.request.provider.only[0] === 'openai' && row.request.provider.allow_fallbacks === false, 'Source did not pin OpenAI without fallback')
  require(row.request.model === target.api_model && [target.api_model, target.canonical_slug].includes(row.response_model), 'Source model identity does not match target')
  require(row.response_id?.startsWith('gen-') && row.response_id === row.generation_id, 'Source response ID does not match HTTP generation ID')
  require(parseNumbers(row.text).length === expected && row.parsed_count === expected, 'Source is not an exact expected-count answer')
  require(row.text_sha256 === hash(row.text), 'Source text hash does not match')
  require(row.selection_policy === 'user-authorized-expected-count-cap' && row.max_numbers === expected, 'Source cap policy does not match the fixed challenge')
  const raw = await readFile(local(row.raw_response.path))
  require(hash(raw) === row.raw_response.sha256 && raw.length === row.raw_response.bytes, 'Source raw response hash/bytes do not match')
  const metadata = await json(local(row.raw_response_metadata.path))
  require(metadata.status === row.http_status && metadata.content_type === row.raw_response_metadata.content_type, 'Source raw response metadata does not match')
  const request = await json(join(local(row.raw_response.path), '..', 'attempt-1.request.json'))
  require(JSON.stringify(request.body) === JSON.stringify(row.request) && request.url === row.provenance.endpoint + '/responses', 'Source trace does not match the recorded request')
  require(!request.headers && !request.apiKey, 'Source trace contains credentials')
  const completion = await readCompletion(new Response(raw, {status: row.http_status, headers: {'content-type': metadata.content_type}}), row.format as Format, undefined, undefined, expected)
  require(completion.text === row.text && completion.responseId === row.response_id && completion.responseModel === row.response_model, 'Source raw response does not replay its text and identity')
  require((completion.providerReported ?? null) === null, 'Source raw stream unexpectedly reports a provider')
  require(completion.completion === row.completion && Boolean(completion.capped) === row.capped && JSON.stringify(completion.usage) === JSON.stringify(row.usage), 'Source replay completion profile differs')
  require(completion.completion === 'complete' || completion.capped === true, 'Source response neither completed nor reached the authorized cap')
}

const manifest: RecoveryManifest = await json(manifestPath)
const rows = await readRows()
const target = manifest.models.find(model => model.label === 'gpt-6-sol')!
require(target?.api_model === 'openai/gpt-6-sol' && target.format === 'responses', 'Unexpected recovery target')
const selected: Row[] = []
for (const group of manifest.groups) for (const challenge of group.challenges) {
  const id = sampleId(manifest, target, group, challenge)
  const floor = manifest.resample_from_attempt?.[id] ?? 1
  const cohort = rows.filter(row => row.sample_id === id && row.attempt >= floor).sort((a, b) => a.attempt - b.attempt)
  const eligible = cohort.find(row => row.status === 'failed' && row.http_status === 200 && row.error === 'Provider mismatch: expected openai, received (missing)' && parseNumbers(row.text).length === challenge.expected_count)
  require(eligible, 'A fixed challenge has no eligible provider-only failure')
  await validateSource(eligible!, target, challenge.expected_count)
  selected.push(eligible!)
}
require(selected.length === 6 && new Set(selected.map(row => row.response_id)).size === 6, 'Recovery requires exactly six distinct original generations')
const candidatePlan = {
  test_set_id: manifest.id, fixed_groups_sha256: hash(JSON.stringify(manifest.groups)), model: target.label,
  policy: 'Earliest failed HTTP-200 answer per fixed slot with exact expected_count and only missing pinned-provider metadata; no classifier results are read.',
  metadata_endpoint: endpoint, source_rows: selected.map(row => ({sample_id: row.sample_id, source_attempt: row.attempt,
    source_record_sha256: hash(JSON.stringify(row)), generation_id: row.response_id, raw_response_sha256: row.raw_response.sha256})),
}
await mkdir(output, {recursive: true})
if (await Bun.file(planPath).exists()) require(JSON.stringify(await json(planPath)) === JSON.stringify(candidatePlan), 'Frozen recovery cohort differs from current sources')
else await writeFile(planPath, JSON.stringify(candidatePlan, null, 2) + '\n', {flag: 'wx', mode: 0o600})

const keyPath = process.env.OPENROUTER_KEY_FILE ?? '/tmp/lmfpd-repair-20260930/openrouter-key'
let key: string | undefined
const proofs: Row[] = []
for (const row of selected) {
  const generationId = row.response_id as string
  const proofDirectory = join(output, hash(row.sample_id), `source-attempt-${row.attempt}`)
  const bodyPath = join(proofDirectory, 'generation.body.json'), metadataPath = join(proofDirectory, 'generation.response.json')
  const url = endpoint + '?id=' + encodeURIComponent(generationId)
  let body: Buffer, metadata: Row
  if (await Bun.file(bodyPath).exists()) {
    body = await readFile(bodyPath); metadata = await json(metadataPath)
  } else {
    key ??= (await readFile(keyPath, 'utf8')).trim()
    require(key.length > 0, 'OpenRouter metadata credential is unavailable')
    const response = await fetch(url, {method: 'GET', headers: {Authorization: 'Bearer ' + key, 'User-Agent': 'ModelTrace/1.0'}, signal: AbortSignal.timeout(30_000)})
    body = Buffer.from(await response.arrayBuffer())
    require(response.ok, `Generation metadata lookup failed with HTTP ${response.status}`)
    require(!body.toString().includes(key) && !/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(body.toString()), 'Metadata body contains a credential')
    metadata = {method: 'GET', endpoint: url, status: response.status, content_type: response.headers.get('content-type'),
      request_id: response.headers.get('x-request-id'), fetched_at: new Date().toISOString()}
    await mkdir(proofDirectory, {recursive: true})
    await writeFile(bodyPath, body, {flag: 'wx', mode: 0o600})
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx', mode: 0o600})
  }
  const data = JSON.parse(body.toString()).data
  require(metadata.method === 'GET' && metadata.endpoint === url && metadata.status >= 200 && metadata.status < 300, 'Saved metadata request does not match this generation')
  require(data?.id === generationId && [target.api_model, target.canonical_slug].includes(data.model), 'Generation metadata model or ID differs from the raw response')
  require(identity(data.provider_name) === 'openai', 'Generation metadata does not confirm OpenAI')
  const proof = {kind: 'openrouter-generation-api', method: 'GET', endpoint: url, generation_id: data.id,
    provider_name: data.provider_name, model: data.model, fetched_at: metadata.fetched_at,
    response: {path: relative(root, bodyPath), sha256: hash(body), bytes: body.length, format: 'json'},
    response_metadata: {path: relative(root, metadataPath), status: metadata.status, content_type: metadata.content_type, request_id: metadata.request_id},
    source_sample_id: row.sample_id, source_attempt: row.attempt, source_record_sha256: hash(JSON.stringify(row)), raw_response_sha256: row.raw_response.sha256}
  proofs.push(proof)
  console.log(JSON.stringify({sample_id: row.sample_id, source_attempt: row.attempt, generation_id: data.id, provider: data.provider_name, model: data.model, status: metadata.status}))
}
await save(join(output, 'proofs.json'), {test_set_id: manifest.id, fixed_groups_sha256: candidatePlan.fixed_groups_sha256,
  policy: candidatePlan.policy, metadata_requests: proofs.length, model_generation_requests: 0, proofs})

if (adopt) {
  const lock = join(directory, '.collect-lock')
  await mkdir(lock).catch(() => { throw new Error('A holdout collector is running; wait before adopting metadata recovery.') })
  try {
    const current: RecoveryManifest = await json(manifestPath), currentRows = await readRows()
    require(current.id === manifest.id && hash(JSON.stringify(current.groups)) === candidatePlan.fixed_groups_sha256, 'Fixed suite changed before recovery adoption')
    const sources = {...await sourceHashes(), ...Object.fromEntries(await Promise.all([script, 'projects/shared/fingerprint-core.js'].map(async path => [path, hash(await readFile(join(root, path)))])))}
    const runId = crypto.randomUUID(), startedAt = new Date().toISOString()
    const profile = {kind: 'metadata-recovery', model_generation_requests: 0, metadata_endpoint: endpoint,
      max_numbers_policy: 'challenge.expected_count', selection_policy: 'user-authorized-expected-count-cap', cohort_policy: candidatePlan.policy,
      provider_reported_source: 'openrouter-generation-api', preserves_original_request_profiles: true}
    const run: Row = {id: runId, started_at: startedAt, models: [target.label], source_hashes: sources,
      fixed_groups_sha256: candidatePlan.fixed_groups_sha256, profile, metadata_requests: proofs.length,
      reason: 'Recover provider-only failures using metadata for the original raw generation IDs; no new completion requests.', accepted_this_run: 0}
    current.collection_runs ??= []; current.collection_runs.push(run)
    current.profile_history ??= []; current.profile_history.push({changed_at: startedAt, collection_run_id: runId, source_hashes: sources, profile, reason: run.reason})
    await save(manifestPath, current)
    for (const [index, original] of selected.entries()) {
      const proof = proofs[index]!, previous = currentRows.filter(row => row.sample_id === original.sample_id).sort((a, b) => a.attempt - b.attempt)
      const source = previous.find(row => row.attempt === original.attempt)
      require(source && hash(JSON.stringify(source)) === proof.source_record_sha256, 'Original source row changed before adoption')
      if (previous.some(row => row.status === 'accepted' && row.attempt >= (current.resample_from_attempt?.[original.sample_id] ?? 1))) continue
      const recovered: Row = {...original, attempt: Math.max(...previous.map(row => row.attempt)) + 1, status: 'accepted',
        source_attempt: original.attempt, billed_request: false, record_kind: 'metadata-recovery', source_collection_run_id: original.collection_run_id,
        source_generation_hashes: original.source_hashes, collection_run_id: runId, source_hashes: sources,
        provider_stream_reported: original.provider_reported ?? null, provider_reported: proof.provider_name,
        provider_reported_source: proof.kind, provider_evidence: proof, recovered_at: new Date().toISOString()}
      delete recovered.error
      await appendFile(samplesPath, JSON.stringify(recovered) + '\n')
      currentRows.push(recovered); run.accepted_this_run++
    }
    run.completed_at = new Date().toISOString()
    await save(manifestPath, current)
    await save(join(output, 'adoption.json'), {test_set_id: current.id, collection_run_id: runId, accepted_this_run: run.accepted_this_run,
      metadata_requests: proofs.length, model_generation_requests: 0, plan_sha256: hash(await readFile(planPath)), completed_at: run.completed_at})
    console.log(JSON.stringify({accepted_this_run: run.accepted_this_run, metadata_requests: proofs.length, model_generation_requests: 0, collection_run_id: runId}))
  } finally {await rm(lock, {recursive: true, force: true})}
}
