import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { completionBody } from '../../../projects/shared/completion-request'
import { readCompletion, type CompletionResult } from '../../../projects/shared/completion'
import { traceTransport } from '../../../projects/cli/trace'

const ROOT = resolve(import.meta.dir, '../../..')
const referenceHash = '5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4'
const protocolPath = join(import.meta.dir, 'collection-protocol.json')
const prepareOnly = process.argv.includes('--prepare-only')
const resume = process.argv.includes('--resume')
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const modelMatches = (requested: string, actual: unknown) => {
  if (actual === requested) return true
  const suffix = typeof actual === 'string' && actual.startsWith(requested + '-') ? actual.slice(requested.length + 1) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix) || /^\d{8}$/.test(suffix)
}
const inside = (path: string) => {
  const absolute = resolve(ROOT, path), rel = relative(ROOT, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Paths must remain inside the research workspace.')
  return absolute
}
const localPath = (path: string) => relative(ROOT, path).split('\\').join('/')
const optionalRead = async (path: string) => readFile(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
})
const jsonLines = (bytes: Buffer | null): any[] => bytes ? bytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

const protocolBytes = await readFile(protocolPath)
const protocol = JSON.parse(protocolBytes.toString())
const profile = { format: 'responses', reasoning: { effort: 'low' }, stream: true, store: false,
  max_output_tokens: 8192, timeout_ms: 600000, concurrency: 4, max_attempts: 2 }
if (protocol.schema !== 'generic-refinement-blind-collection-v2' || protocol.purpose !== 'prospective-evaluation-v2' ||
    protocol.training_allowed !== false || !equal(protocol.models, ['gpt-6-astra', 'gpt-6.1-sol']) ||
    protocol.endpoint !== 'https://api.openai.com/v1/responses' || !equal(protocol.profile, profile) || protocol.rounds?.length !== 20) {
  throw new Error('The predeclared v2 collection protocol is invalid.')
}

// This reads hashes and metadata only; no classifier is loaded or scored.
const freezePath = inside(process.env.CANDIDATE_FREEZE_FILE ?? protocol.candidate_freeze_default)
const freezeBytes = await readFile(freezePath)
const freeze = JSON.parse(freezeBytes.toString())
if (freeze.schema !== 'generic-refinement-freeze-v1' || freeze.reference_sha256 !== referenceHash ||
    freeze.fixed_holdout_opened !== false || freeze.freeze_after_selection_before_regression !== true ||
    !freeze.hashes || !Object.keys(freeze.hashes).some(path => path.endsWith('/fitted.joblib'))) {
  throw new Error('An intact reference-selected candidate freeze is required before collection.')
}
for (const [path, expected] of Object.entries(freeze.hashes)) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || sha(await readFile(inside(path))) !== expected) {
    throw new Error(`Frozen candidate source or artifact mismatch: ${path}`)
  }
}

const historicalPrompts = new Set<string>(), historicalTexts = new Set<string>(), historicalSequences = new Set<string>()
function visit(value: any) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(visit); return }
  for (const [name, item] of Object.entries(value)) {
    if (['prompt', 'base_prompt'].includes(name) && typeof item === 'string') historicalPrompts.add(item)
    if (name === 'text' && typeof item === 'string' && item) {
      historicalTexts.add(sha(item))
      const numbers = parseNumbers(item) as number[]
      if (numbers.length >= 80) historicalSequences.add(sha(JSON.stringify(numbers)))
    }
    if (typeof item === 'object') visit(item)
  }
}
for (const [path, expected] of Object.entries(protocol.deduplication.source_hashes)) {
  const bytes = await readFile(inside(path))
  if (sha(bytes) !== expected) throw new Error(`Historical duplicate-check source changed: ${path}`)
  if (path.endsWith('.jsonl')) jsonLines(bytes).forEach(visit)
  else visit(JSON.parse(bytes.toString()))
}
const promptSet = new Set<string>(), challengeIds = new Set<string>()
for (const round of protocol.rounds) {
  if (round.challenges?.length !== 3) throw new Error('Each round must contain three frozen challenges.')
  for (const challenge of round.challenges) {
    if (!Number.isInteger(challenge.expected_count) || challenge.expected_count < 80 || typeof challenge.prompt !== 'string' ||
        !challenge.prompt.startsWith(protocol.neutral_prefix + '\n') || historicalPrompts.has(challenge.prompt) ||
        promptSet.has(challenge.prompt) || challengeIds.has(challenge.id)) throw new Error('Invalid or duplicate frozen challenge.')
    promptSet.add(challenge.prompt); challengeIds.add(challenge.id)
  }
}

const sourcePaths = [localPath(import.meta.path), localPath(protocolPath), 'projects/shared/completion-request.ts',
  'projects/shared/completion.ts', 'projects/shared/throughput.ts', 'projects/shared/fingerprint-core.js', 'projects/cli/trace.ts']
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(inside(path)))])))
const directory = inside(process.env.OUTPUT_DIR ?? 'research/reports/generic-refinement-20261001/prospective-v2')
const outputRelative = relative(join(ROOT, 'research/reports/generic-refinement-20261001'), directory)
if (outputRelative.startsWith('..') || isAbsolute(outputRelative)) throw new Error('The v2 collector must write inside its new research report directory.')
const manifestPath = join(directory, 'manifest.json'), samplesPath = join(directory, 'samples.jsonl')
await mkdir(directory, { recursive: true, mode: 0o700 })
const lockPath = join(directory, '.collect-lock'), runId = `v2-run-${randomUUID()}`
try {
  const lock = await open(lockPath, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid, run_id: runId, created_at: new Date().toISOString() }) + '\n')
  await lock.close()
} catch (error: any) {
  if (error.code !== 'EEXIST' || !resume) throw new Error('Collection is locked; inspect the existing process before using --resume.')
  const oldLock = JSON.parse((await readFile(lockPath)).toString())
  let alive = true
  try { process.kill(oldLock.pid, 0) } catch (failure: any) { if (failure.code === 'ESRCH') alive = false }
  if (alive) throw new Error('The previous collector process is still active.')
  await rename(lockPath, join(directory, `.collect-lock.stale-${runId}`))
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, run_id: runId }) + '\n', { mode: 0o600, flag: 'wx' })
}

let manifest: any, halted = false, haltReason: string | null = null, key = ''
const controllers = new Set<AbortController>()
const stop = () => { halted = true; haltReason = 'operator-interrupted'; for (const controller of controllers) controller.abort() }
const redact = (value: unknown) => {
  let message = value instanceof Error ? value.message : String(value)
  if (key) message = message.replaceAll(key, '[REDACTED]')
  return message.replace(/sk[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]')
}
const saveManifest = async () => {
  const temporary = join(directory, `.manifest-${process.pid}.tmp`)
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, manifestPath)
}
try {
  const existing = await optionalRead(manifestPath)
  const binding = { path: localPath(freezePath), sha256: sha(freezeBytes), contents: freeze }
  if (existing) {
    manifest = JSON.parse(existing.toString())
    if (manifest.id !== protocol.id || manifest.purpose !== protocol.purpose || manifest.protocol_sha256 !== sha(protocolBytes) ||
        manifest.candidate_freeze_sha256 !== binding.sha256 || !equal(manifest.frozen_candidate, binding) || !equal(manifest.source_hashes, sourceHashes)) {
      throw new Error('Resume must retain the original protocol, collector sources and candidate freeze.')
    }
    if (manifest.collection_runs?.some((run: any) => run.halt_reason) && !resume && !prepareOnly) {
      throw new Error('A paused collection requires explicit --resume; no scoring may inform its remaining retries.')
    }
  } else {
    manifest = { schema_version: 2, id: protocol.id, purpose: protocol.purpose, training_allowed: false,
      created_at: new Date().toISOString(), endpoint: protocol.endpoint, models: protocol.models, profile,
      request: { format: 'responses', reasoning: { effort: 'low' }, stream: true, store: false, max_output_tokens: 8192 },
      max_attempts: 2, selection: protocol.selection, selection_policy: 'user-authorized-expected-count-cap',
      protocol_path: localPath(protocolPath), protocol_sha256: sha(protocolBytes), frozen_candidate: binding,
      candidate_freeze_sha256: binding.sha256,
      source_hashes: sourceHashes, duplicate_check: protocol.deduplication, rounds: protocol.rounds,
      transport: process.env.COLLECTION_HOST ?? 'local', collection_runs: [] }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  }
  if (prepareOnly) {
    console.log(JSON.stringify({ prepared: true, slots: 120, protocol_sha256: sha(protocolBytes), freeze_sha256: sha(freezeBytes) }))
  } else {
    const records = jsonLines(await optionalRead(samplesPath))
    const jobs = manifest.rounds.flatMap((round: any) => round.challenges.flatMap((challenge: any, position: number) =>
      manifest.models.map((model: string) => ({ model, round, challenge, sample_id: `${manifest.id}__${model}__${round.id}__${position + 1}` }))))
    const jobById = new Map(jobs.map((job: any) => [job.sample_id, job]))
    const jobIds = new Set(jobs.map((job: any) => job.sample_id)), identities = new Set<string>()
    for (const record of records) {
      const id = `${record.sample_id}:${record.attempt}`
      if (!jobIds.has(record.sample_id) || !Number.isInteger(record.attempt) || record.attempt < 1 || record.attempt > 2 || identities.has(id)) {
        throw new Error('Existing attempt records are outside the frozen v2 plan or duplicated.')
      }
      identities.add(id)
      const job: any = jobById.get(record.sample_id)
      const expectedBody = completionBody({ model: job.model, format: 'responses', effort: 'low', stream: true }, job.challenge.prompt)
      const numbers = parseNumbers(record.text) as number[]
      if (record.model !== job.model || record.requested_model !== job.model || record.round_id !== job.round.id ||
          record.challenge_id !== job.challenge.id || record.prompt !== job.challenge.prompt || record.endpoint !== protocol.endpoint ||
          record.expected_count !== job.challenge.expected_count || record.max_numbers !== job.challenge.expected_count ||
          record.purpose !== manifest.purpose || record.training_allowed !== false || !equal(record.request, expectedBody) ||
          !equal(record.source_hashes, sourceHashes) || record.frozen_candidate_sha256 !== binding.sha256 ||
          typeof record.text !== 'string' || record.text_sha256 !== sha(record.text) || record.parsed_count !== numbers.length ||
          record.sequence_sha256 !== sha(JSON.stringify(numbers))) throw new Error('Existing attempt does not match its immutable plan or text hashes.')
      if (record.status === 'accepted' && (record.error || record.duplicate_text || record.duplicate_sequence ||
          !modelMatches(job.model, record.actual_model) || record.response_model !== record.actual_model ||
          !(record.completion === 'complete' || record.capped) || numbers.length < Math.max(80, Math.ceil(job.challenge.expected_count * .55)) ||
          (record.capped && numbers.length !== job.challenge.expected_count))) throw new Error('Existing accepted attempt fails the frozen eligibility rules.')
    }
    const seenTexts = new Set(historicalTexts), seenSequences = new Set(historicalSequences)
    const remember = (record: any) => {
      if (record.text) seenTexts.add(sha(record.text))
      const numbers = parseNumbers(record.text) as number[]
      if (numbers.length >= 80) seenSequences.add(sha(JSON.stringify(numbers)))
    }
    records.forEach(remember)
    let writes = Promise.resolve()
    const persist = async (record: any) => {
      records.push(record); remember(record)
      writes = writes.then(() => appendFile(samplesPath, JSON.stringify(record) + '\n', { mode: 0o600 }))
      await writes
      console.log(`${record.sample_id} attempt ${record.attempt}: ${record.status}, ${record.parsed_count} numbers`)
    }
    const bodyFor = (job: any) => completionBody({ model: job.model, format: 'responses', effort: 'low', stream: true }, job.challenge.prompt)
    const traceDirectory = (job: any, attempt: number) => join(directory, 'raw-traces', sha(job.sample_id).slice(0, 24), `attempt-${attempt}`)
    const baseRecord = (job: any, attempt: number, startedAt = new Date().toISOString()) => ({
      sample_id: job.sample_id, model: job.model, requested_model: job.model, actual_model: null, response_model: null,
      round_id: job.round.id, challenge_id: job.challenge.id, purpose: manifest.purpose, training_allowed: false,
      expected_count: job.challenge.expected_count, max_numbers: job.challenge.expected_count,
      selection_policy: 'user-authorized-expected-count-cap', prompt: job.challenge.prompt, request: bodyFor(job),
      endpoint: protocol.endpoint, provenance: { kind: 'direct-openai', endpoint: protocol.endpoint, channel: 'openai-api' },
      attempt, started_at: startedAt, run_id: runId, source_hashes: sourceHashes,
      frozen_candidate_sha256: binding.sha256, status: 'failed', text: '', capped: false,
      completion: 'unknown', finish_reason: null, response_id: null, usage: null, provider_reported: null,
    } as any)
    const assignCompletion = (record: any, result: CompletionResult) => Object.assign(record, {
      text: result.text, actual_model: result.responseModel ?? null, response_model: result.responseModel ?? null,
      response_id: result.responseId ?? null, usage: result.usage ?? null, provider_reported: result.providerReported ?? null,
      finish_reason: result.finishReason ?? null, completion: result.completion, capped: result.capped ?? false,
    })
    const validate = (record: any, job: any) => {
      const numbers = parseNumbers(record.text) as number[]
      record.parsed_count = numbers.length
      record.text_sha256 = sha(record.text)
      record.sequence_sha256 = sha(JSON.stringify(numbers))
      record.minimum_numbers = Math.max(80, Math.ceil(job.challenge.expected_count * .55))
      record.duplicate_text = !!record.text && seenTexts.has(record.text_sha256)
      record.duplicate_sequence = numbers.length >= 80 && seenSequences.has(record.sequence_sha256)
      if (!modelMatches(job.model, record.actual_model)) record.invalid_reason = 'response-model-mismatch-or-missing'
      else if (!(record.http_status >= 200 && record.http_status < 300)) record.invalid_reason = 'http-error'
      else if (!(record.completion === 'complete' || record.capped)) record.invalid_reason = 'incomplete-output'
      else if (numbers.length < record.minimum_numbers) record.invalid_reason = 'insufficient-numbers'
      else if (record.duplicate_text || record.duplicate_sequence) record.invalid_reason = 'historical-or-earlier-attempt-duplicate'
      else if (records.some(previous => previous.sample_id === job.sample_id && previous.status === 'accepted')) record.invalid_reason = 'slot-already-has-first-eligible-attempt'
      if (!record.invalid_reason && !record.error) record.status = 'accepted'
      else if (!record.error) record.status = 'invalid'
      record.finished_at = new Date().toISOString()
      record.elapsed_ms = Math.max(0, Date.parse(record.finished_at) - Date.parse(record.started_at))
    }
    const attachRaw = async (record: any, traceDir: string) => {
      const rawPath = join(traceDir, 'attempt-1.body.txt'), metadataPath = join(traceDir, 'attempt-1.response.json')
      const raw = await optionalRead(rawPath), metadata = await optionalRead(metadataPath)
      if (raw) record.raw_response = { path: localPath(rawPath), sha256: sha(raw), bytes: raw.length, format: 'responses' }
      if (metadata) record.raw_response_metadata = { path: localPath(metadataPath), sha256: sha(metadata), bytes: metadata.length, ...JSON.parse(metadata.toString()) }
      record.raw_trace_directory = localPath(traceDir)
      const requestBytes = await optionalRead(join(traceDir, 'attempt-1.request.json'))
      if (requestBytes) record.raw_request = { path: localPath(join(traceDir, 'attempt-1.request.json')), sha256: sha(requestBytes), bytes: requestBytes.length }
      const errorPath = join(traceDir, 'attempt-1.error.json'), errorBytes = await optionalRead(errorPath)
      if (errorBytes) record.raw_transport_error = { path: localPath(errorPath), sha256: sha(errorBytes), bytes: errorBytes.length }
      if (!requestBytes) record.transport_preflight_failure = true
    }

    const run: any = { id: runId, started_at: new Date().toISOString(), profile,
      selection_policy: 'user-authorized-expected-count-cap', protocol_sha256: sha(protocolBytes),
      frozen_candidate_sha256: binding.sha256, source_hashes: sourceHashes, resumed: resume, status: 'recovering',
      supersedes_interrupted_runs: manifest.collection_runs.filter((prior: any) => ['running', 'recovering'].includes(prior.status)).map((prior: any) => prior.id) }
    manifest.collection_runs.push(run); await saveManifest()
    // A crash may leave an original trace before its JSONL row. Replay those bytes offline.
    for (const job of jobs) for (let attempt = 1; attempt <= 2; attempt++) {
      if (records.some(record => record.sample_id === job.sample_id && record.attempt === attempt)) continue
      const traceDir = traceDirectory(job, attempt), requestBytes = await optionalRead(join(traceDir, 'attempt-1.request.json'))
      if (!requestBytes) continue
      const request = JSON.parse(requestBytes.toString())
      if (request.url !== protocol.endpoint || !equal(request.body, bodyFor(job))) throw new Error('Interrupted trace request differs from the frozen plan.')
      const record = baseRecord(job, attempt, request.started_at)
      record.recovered_interrupted_trace = true
      const raw = await optionalRead(join(traceDir, 'attempt-1.body.txt')), metadataBytes = await optionalRead(join(traceDir, 'attempt-1.response.json'))
      try {
        if (!raw || !metadataBytes) throw new Error('Interrupted attempt has no complete response trace.')
        const metadata = JSON.parse(metadataBytes.toString())
        record.http_status = metadata.status; record.request_id = metadata.request_id
        const response = new Response(raw, { status: metadata.status, headers: { 'content-type': metadata.content_type ?? '' } })
        assignCompletion(record, await readCompletion(response, 'responses', text => { record.text = text }, undefined, job.challenge.expected_count))
      } catch (error: any) {
        if (error.completionDetails) assignCompletion(record, error.completionDetails)
        record.error = redact(error)
      }
      await attachRaw(record, traceDir); validate(record, job); await persist(record)
    }

    if (!process.env.API_KEY_FILE) throw new Error('Provide API_KEY_FILE; API credentials are never accepted as a command-line argument.')
    key = (await readFile(process.env.API_KEY_FILE, 'utf8')).trim()
    if (!key) throw new Error('API_KEY_FILE is empty.')
    run.status = 'running'; await saveManifest()
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
    const collect = async (job: any) => {
      if (records.some(record => record.sample_id === job.sample_id && record.status === 'accepted')) return
      while (!halted) {
        const previous = records.filter(record => record.sample_id === job.sample_id)
        const attempt = previous.length ? Math.max(...previous.map(record => record.attempt)) + 1 : 1
        if (attempt > 2) return
        const record = baseRecord(job, attempt), traceDir = traceDirectory(job, attempt)
        const controller = new AbortController(); controllers.add(controller)
        const timer = setTimeout(() => controller.abort(), profile.timeout_ms)
        try {
          const transport = await traceTransport(traceDir, async (url, _config, body, signal) => fetch(url, {
            method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          }))
          const response = await transport(protocol.endpoint, { baseUrl: 'https://api.openai.com/v1', model: job.model, format: 'responses', effort: 'low', apiKey: key }, record.request, controller.signal)
          record.http_status = response.status; record.request_id = response.headers.get('x-request-id')
          if ([401, 402, 403].includes(response.status)) { halted = true; haltReason = `http-${response.status}` }
          assignCompletion(record, await readCompletion(response, 'responses', text => { record.text = text }, undefined, job.challenge.expected_count))
        } catch (error: any) {
          if (error.completionDetails) assignCompletion(record, error.completionDetails)
          record.error = redact(error)
        } finally { clearTimeout(timer); controller.abort(); controllers.delete(controller) }
        await attachRaw(record, traceDir); validate(record, job); await persist(record)
        if (record.status === 'accepted') return
      }
    }
    try {
      const queue = [...jobs]
      await Promise.all(Array.from({ length: profile.concurrency }, async () => {
        while (queue.length && !halted) { const job = queue.shift(); if (job) await collect(job) }
      }))
      run.status = halted ? 'paused' : 'finished'
    } catch (error) {
      run.status = 'failed'; run.error = redact(error)
      throw error
    } finally {
      run.finished_at = new Date().toISOString(); run.halt_reason = haltReason
      run.attempts = records.filter(record => record.run_id === runId).length
      run.accepted_slots = new Set(records.filter(record => record.status === 'accepted').map(record => record.sample_id)).size
      await saveManifest(); process.off('SIGINT', stop); process.off('SIGTERM', stop)
    }
    console.log(JSON.stringify({ attempts: records.length, accepted_slots: run.accepted_slots, total_slots: 120, halted, halt_reason: haltReason }))
  }
} catch (error) {
  const run = manifest?.collection_runs?.find((item: any) => item.id === runId)
  if (run && ['recovering', 'running'].includes(run.status)) {
    run.status = 'failed'; run.error = redact(error); run.finished_at = new Date().toISOString()
    await saveManifest()
  }
  console.error(redact(error)); process.exitCode = 1
} finally {
  await unlink(lockPath)
}
