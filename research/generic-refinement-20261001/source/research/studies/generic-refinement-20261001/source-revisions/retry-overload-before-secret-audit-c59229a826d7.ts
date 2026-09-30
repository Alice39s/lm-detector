/** Operational continuation only: no classifier imports or score-based retries. */
import { appendFile, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { readCompletion, type CompletionResult } from '../../../projects/shared/completion'
import { traceTransport } from '../../../projects/cli/trace'

export const ROOT = resolve(import.meta.dir, '../../..')
export const STUDY = import.meta.dir
export const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
export const localPath = (path: string) => relative(ROOT, path).split('\\').join('/')
export const inside = (path: string) => {
  const absolute = resolve(ROOT, path), rel = relative(ROOT, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence paths must remain inside the workspace.')
  return absolute
}
export const optionalRead = async (path: string): Promise<Buffer | null> => readFile(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
})
export const rows = (bytes: Buffer | null): any[] => bytes ? bytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
export const modelMatches = (requested: string, actual: unknown) => {
  if (requested === actual) return true
  const suffix = typeof actual === 'string' && actual.startsWith(requested + '-') ? actual.slice(requested.length + 1) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix) || /^\d{8}$/.test(suffix)
}
export const protocolPath = join(STUDY, 'retry-overload-protocol.json')
export const sourcePaths = [localPath(join(STUDY, 'retry-overload.ts')), localPath(join(STUDY, 'verify-overload.ts')),
  localPath(protocolPath), 'projects/shared/completion.ts', 'projects/shared/completion-request.ts',
  'projects/shared/throughput.ts', 'projects/shared/fingerprint-core.js', 'projects/cli/trace.ts']
export const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(inside(path)))])))
export const traceDirectory = (directory: string, sampleId: string, attempt: number) =>
  join(directory, 'supplemental-raw-traces', sha(sampleId).slice(0, 24), `attempt-${attempt}`)

export async function loadOriginal(directory: string, freezePath: string, auditName: string) {
  if (await optionalRead(join(directory, '.collect-lock'))) throw new Error('Original collector is still locked.')
  const manifestPath = join(directory, 'manifest.json'), samplesPath = join(directory, 'samples.jsonl')
  const manifestBytes = await readFile(manifestPath), sampleBytes = await readFile(samplesPath), freezeBytes = await readFile(freezePath)
  const manifest = JSON.parse(manifestBytes.toString()), freeze = JSON.parse(freezeBytes.toString()), records = rows(sampleBytes)
  const latest = manifest.collection_runs?.at(-1)
  if (!latest || latest.status !== 'finished' || latest.halt_reason || !latest.finished_at) throw new Error('The original run must finish without a halt before continuation.')
  if (manifest.candidate_freeze_sha256 !== sha(freezeBytes) || manifest.frozen_candidate?.path !== localPath(freezePath)) throw new Error('Original candidate freeze differs.')
  const auditPath = join(directory, auditName)
  const process = Bun.spawn([Bun.which('bun') ?? 'bun', join(STUDY, 'verify-prospective.ts'), '--directory', directory,
    '--freeze', freezePath, '--output', auditPath], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(process.stdout).text(), stderr = await new Response(process.stderr).text()
  await process.exited
  const auditBytes = await readFile(auditPath), audit = JSON.parse(auditBytes.toString())
  if (!['complete', 'incomplete'].includes(audit.status) || audit.errors?.length || audit.current_source_hashes_match !== true ||
      audit.manifest_sha256 !== sha(manifestBytes) || audit.samples_sha256 !== sha(sampleBytes) || audit.candidate_freeze_sha256 !== sha(freezeBytes)) {
    throw new Error(`Original collection verification failed; inspect ${localPath(auditPath)} (${stdout.trim() ? 'report produced' : 'no report'}${stderr ? ', verifier stderr retained' : ''}).`)
  }
  const jobs = manifest.rounds.flatMap((round: any) => round.challenges.flatMap((challenge: any, position: number) =>
    manifest.models.map((model: string) => ({ sample_id: `${manifest.id}__${model}__${round.id}__${position + 1}`,
      model, round_id: round.id, challenge_id: challenge.id, prompt: challenge.prompt, expected_count: challenge.expected_count }))))
  const selected = new Map<string, any>()
  for (const record of records) if (record.status === 'accepted' && !selected.has(record.sample_id)) selected.set(record.sample_id, record)
  const missing = jobs.filter((job: any) => !selected.has(job.sample_id)).map((job: any) => {
    const attempts = records.filter(record => record.sample_id === job.sample_id)
    if (attempts.length !== 2 || !equal(attempts.map(record => record.attempt), [1, 2])) throw new Error('Missing original slots must have two exhausted retained attempts.')
    return { ...job, request: attempts[1].request, original_attempts: attempts.map(record => ({ attempt: record.attempt,
      record_sha256: sha(JSON.stringify(record)), text_sha256: record.text_sha256, sequence_sha256: record.sequence_sha256,
      status: record.status, error: record.error ?? null, invalid_reason: record.invalid_reason ?? null })) }
  })
  const bindings: Record<string, string> = { ...freeze.hashes, ...manifest.source_hashes,
    [localPath(manifestPath)]: sha(manifestBytes), [localPath(samplesPath)]: sha(sampleBytes), [localPath(freezePath)]: sha(freezeBytes),
    [localPath(join(STUDY, 'verify-prospective.ts'))]: sha(await readFile(join(STUDY, 'verify-prospective.ts'))) }
  for (const record of records) for (const evidence of [record.raw_request, record.raw_response, record.raw_response_metadata, record.raw_transport_error]) {
    if (evidence) bindings[evidence.path] = evidence.sha256
  }
  return { directory, manifest, records, jobs, selected, missing, bindings, auditPath, auditBytes, audit,
    manifest_sha256: sha(manifestBytes), samples_sha256: sha(sampleBytes), freeze_sha256: sha(freezeBytes), freezePath }
}

export async function loadPlan(directory: string, original: any) {
  const path = join(directory, 'supplemental-manifest.json'), bytes = await readFile(path), manifest = JSON.parse(bytes.toString())
  const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes.toString())
  const current = await sourceHashes(), plan = manifest.plan
  if (manifest.schema !== 'generic-refinement-missing-continuation-manifest-v1' || manifest.id !== protocol.id ||
      manifest.plan_sha256 !== sha(JSON.stringify(plan)) || plan.candidate_freeze_sha256 !== original.freeze_sha256 ||
      plan.original_manifest_sha256 !== original.manifest_sha256 || plan.original_samples_sha256 !== original.samples_sha256 ||
      !equal(plan.jobs, original.missing) || !equal(plan.original_bindings, original.bindings) ||
      !equal(plan.source_hashes, current) || !equal(plan.operational_profile, protocol.operational_profile) ||
      !equal(plan.original_profile, original.manifest.profile) || plan.protocol_sha256 !== sha(protocolBytes)) {
    throw new Error('Continuation plan, original bytes or continuation source hashes changed.')
  }
  const preparation = await readFile(inside(plan.original_preparation_audit.path))
  if (sha(preparation) !== plan.original_preparation_audit.sha256) throw new Error('Preparation audit changed.')
  return { manifest, bytes, path, protocol, source_hashes: current }
}

export async function duplicateSets(original: any) {
  const texts = new Set<string>(), sequences = new Set<string>()
  const remember = (text: string) => {
    if (text) texts.add(sha(text))
    const numbers = parseNumbers(text) as number[]
    if (numbers.length >= 80) sequences.add(sha(JSON.stringify(numbers)))
  }
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    for (const [name, item] of Object.entries(value)) {
      if (name === 'text' && typeof item === 'string') remember(item)
      if (typeof item === 'object') visit(item)
    }
  }
  for (const [path, expected] of Object.entries(original.manifest.duplicate_check.source_hashes)) {
    const bytes = await readFile(inside(path))
    if (sha(bytes) !== expected) throw new Error('Historical duplicate-check source changed.')
    if (path.endsWith('.jsonl')) rows(bytes).forEach(visit)
    else visit(JSON.parse(bytes.toString()))
  }
  original.records.forEach((record: any) => remember(record.text))
  return { texts, sequences, remember }
}

export function assignCompletion(record: any, result: CompletionResult) {
  Object.assign(record, { text: result.text, actual_model: result.responseModel ?? null, response_model: result.responseModel ?? null,
    response_id: result.responseId ?? null, usage: result.usage ?? null, provider_reported: result.providerReported ?? null,
    finish_reason: result.finishReason ?? null, completion: result.completion, capped: result.capped ?? false })
}
export async function attachRaw(record: any, traceDir: string) {
  record.raw_trace_directory = localPath(traceDir)
  for (const [key, suffix] of [['raw_request', 'request.json'], ['raw_response', 'body.txt'],
    ['raw_response_metadata', 'response.json'], ['raw_transport_error', 'error.json']]) {
    const path = join(traceDir, 'attempt-1.' + suffix), bytes = await optionalRead(path)
    if (bytes) {
      record[key] = { path: localPath(path), sha256: sha(bytes), bytes: bytes.length }
      if (key === 'raw_response') record[key].format = 'responses'
      if (key === 'raw_response_metadata') Object.assign(record[key], JSON.parse(bytes.toString()))
    }
  }
  if (!record.raw_request) record.transport_preflight_failure = true
}
export function finalize(record: any, job: any, seen: any) {
  const numbers = parseNumbers(record.text) as number[]
  record.parsed_count = numbers.length; record.text_sha256 = sha(record.text); record.sequence_sha256 = sha(JSON.stringify(numbers))
  record.minimum_numbers = Math.max(80, Math.ceil(job.expected_count * .55))
  record.duplicate_text = !!record.text && seen.texts.has(record.text_sha256)
  record.duplicate_sequence = numbers.length >= 80 && seen.sequences.has(record.sequence_sha256)
  if (!modelMatches(job.model, record.actual_model)) record.invalid_reason = 'response-model-mismatch-or-missing'
  else if (!(record.http_status >= 200 && record.http_status < 300)) record.invalid_reason = 'http-error'
  else if (!(record.completion === 'complete' || record.capped)) record.invalid_reason = 'incomplete-output'
  else if (numbers.length < record.minimum_numbers) record.invalid_reason = 'insufficient-numbers'
  else if (record.duplicate_text || record.duplicate_sequence) record.invalid_reason = 'historical-or-earlier-attempt-duplicate'
  if (!record.error && !record.invalid_reason) record.status = 'accepted'
  else if (!record.error) record.status = 'invalid'
  record.finished_at = new Date().toISOString(); record.elapsed_ms = Math.max(0, Date.parse(record.finished_at) - Date.parse(record.started_at))
}

export async function auditSupplemental(directory: string, original: any, planData: any, allowPlannedOrphans = false) {
  const errors: string[] = [], incomplete: string[] = [], notes: string[] = [], bindings: Record<string, string> = { ...original.bindings, ...planData.source_hashes }
  const check = (ok: unknown, message: string) => { if (!ok) errors.push(message) }
  const samplePath = join(directory, 'supplemental-samples.jsonl'), bytes = await optionalRead(samplePath), records = rows(bytes)
  const selected = new Map<string, any>([...original.selected].map(([id, record]: any) => [id, { record, record_source: 'original' }]))
  const jobs = new Map(planData.manifest.plan.jobs.map((job: any) => [job.sample_id, job])), seen = await duplicateSets(original)
  const attempts = new Map<string, number>(), physical = new Set<string>(), evidencePaths = new Set<string>()
  const runs = planData.manifest.collection_runs ?? [], runIds = new Set(runs.map((run: any) => run.id)), latest = runs.at(-1)
  check(runIds.size === runs.length, 'Supplemental run IDs repeat.')
  const superseded = new Set(runs.flatMap((run: any) => run.status === 'finished' ? run.supersedes_interrupted_runs ?? [] : []))
  for (const [index, run] of runs.entries()) {
    check(run.plan_sha256 === planData.manifest.plan_sha256 && equal(run.source_hashes, planData.source_hashes) &&
      equal(run.operational_profile, planData.protocol.operational_profile), `Supplemental run binding differs: ${run.id}`)
    for (const oldId of run.supersedes_interrupted_runs ?? []) check(runs.slice(0, index).some((old: any) => old.id === oldId && ['running', 'recovering'].includes(old.status)), 'Invalid supplemental interrupted-run closure.')
    if (['running', 'recovering'].includes(run.status) && !superseded.has(run.id)) incomplete.push(`Supplemental run is unclosed: ${run.id}`)
  }
  if (!latest || latest.status !== 'finished' || latest.halt_reason || !latest.finished_at) incomplete.push('Last supplemental run has not finished without a halt.')
  if (await optionalRead(join(directory, '.supplemental-collect-lock'))) incomplete.push('Supplemental collector is still locked.')
  const proof = async (evidence: any, path: string, label: string) => {
    const value = await optionalRead(path)
    if (!value) { check(!evidence, `${label}: missing original proof file.`); return null }
    const relative = localPath(path); evidencePaths.add(relative); bindings[relative] = sha(value)
    check(evidence?.path === relative && evidence?.sha256 === sha(value) && evidence?.bytes === value.length, `${label}: original proof path/hash/length differs.`)
    check(!/sk[-_][A-Za-z0-9_-]{16,}/.test(value.toString()), `${label}: credential-shaped string in original proof.`)
    return value
  }
  let replayed = 0
  for (const record of records) {
    const label = `${record.sample_id}:attempt-${record.attempt}`, job: any = jobs.get(record.sample_id)
    check(!!job, `${label}: unplanned continuation slot.`); if (!job) continue
    check(record.attempt === 3 + (attempts.get(record.sample_id) ?? 0) && record.attempt <= 5 && !physical.has(label), `${label}: missing, repeated or excessive physical attempt.`)
    physical.add(label); attempts.set(record.sample_id, (attempts.get(record.sample_id) ?? 0) + 1)
    check(!selected.has(record.sample_id), `${label}: attempt follows an already eligible answer.`)
    check(record.model === job.model && record.requested_model === job.model && record.round_id === job.round_id &&
      record.challenge_id === job.challenge_id && record.prompt === job.prompt && equal(record.request, job.request) &&
      record.endpoint === original.manifest.endpoint && record.expected_count === job.expected_count && record.max_numbers === job.expected_count &&
      record.purpose === original.manifest.purpose && record.training_allowed === false && record.collection_kind === 'missing-continuation' &&
      record.plan_sha256 === planData.manifest.plan_sha256 && record.candidate_freeze_sha256 === original.freeze_sha256 &&
      record.original_manifest_sha256 === original.manifest_sha256 && record.original_samples_sha256 === original.samples_sha256 &&
      equal(record.source_hashes, planData.source_hashes) && equal(record.original_profile, original.manifest.profile) &&
      equal(record.operational_profile, planData.protocol.operational_profile) && runIds.has(record.run_id) &&
      record.selection_policy === 'user-authorized-expected-count-cap', `${label}: frozen request or source binding differs.`)
    check(equal(record.provenance, { kind: 'direct-openai', endpoint: original.manifest.endpoint, channel: 'openai-api' }), `${label}: source channel differs.`)
    const numbers = parseNumbers(record.text) as number[], textHash = sha(record.text), sequenceHash = sha(JSON.stringify(numbers))
    const dupText = !!record.text && seen.texts.has(textHash), dupSequence = numbers.length >= 80 && seen.sequences.has(sequenceHash)
    check(record.response_model === record.actual_model && record.text_sha256 === textHash && record.sequence_sha256 === sequenceHash && record.parsed_count === numbers.length &&
      record.minimum_numbers === Math.max(80, Math.ceil(job.expected_count * .55)) && record.duplicate_text === dupText && record.duplicate_sequence === dupSequence,
      `${label}: text, sequence or chronological duplicate decision differs.`)
    if (record.actual_model !== null) check(modelMatches(job.model, record.actual_model), `${label}: response model bypasses the requested model.`)
    const traceDir = traceDirectory(directory, record.sample_id, record.attempt)
    check(record.raw_trace_directory === localPath(traceDir), `${label}: original trace directory differs.`)
    const request = await proof(record.raw_request, join(traceDir, 'attempt-1.request.json'), label + ': request')
    const raw = await proof(record.raw_response, join(traceDir, 'attempt-1.body.txt'), label + ': body')
    const metadataBytes = await proof(record.raw_response_metadata, join(traceDir, 'attempt-1.response.json'), label + ': metadata')
    const transportError = await proof(record.raw_transport_error, join(traceDir, 'attempt-1.error.json'), label + ': transport error')
    if (request) {
      const submitted = JSON.parse(request.toString())
      check(equal(Object.keys(submitted).sort(), ['body', 'started_at', 'url']) && submitted.url === original.manifest.endpoint && equal(submitted.body, job.request), `${label}: submitted request differs.`)
    } else check(record.transport_preflight_failure === true && record.status === 'failed' && !!record.error && !raw && !metadataBytes, `${label}: missing request trace is not an explicit preflight failure.`)
    let replay: CompletionResult | undefined, replayFailed = false
    if (raw && metadataBytes) {
      const metadata = JSON.parse(metadataBytes.toString())
      check(equal(Object.keys(metadata).sort(), ['content_type', 'request_id', 'status']) && metadata.status === record.http_status && metadata.request_id === (record.request_id ?? null) &&
        metadata.status === record.raw_response_metadata.status && metadata.content_type === record.raw_response_metadata.content_type && metadata.request_id === record.raw_response_metadata.request_id && record.raw_response.format === 'responses', `${label}: response metadata differs.`)
      try { replay = await readCompletion(new Response(raw, { status: metadata.status, headers: { 'content-type': metadata.content_type ?? '' } }), 'responses', undefined, undefined, job.expected_count) }
      catch (error: any) { replayFailed = true; replay = error.completionDetails }
      if (replay) {
        replayed++
        check(replay.text === record.text && (replay.responseModel ?? null) === record.actual_model && (replay.responseId ?? null) === record.response_id &&
          (replay.providerReported ?? null) === record.provider_reported && equal(replay.usage ?? null, record.usage) && (replay.finishReason ?? null) === record.finish_reason &&
          replay.completion === record.completion && (replay.capped ?? false) === record.capped && equal(parseNumbers(replay.text), numbers), `${label}: response replay differs.`)
        if (replayFailed) check(record.status === 'failed' && !!record.error, `${label}: original replay failure was not retained.`)
        else if (record.status === 'failed') notes.push(`${label}: original transport/timeout error retained although offline replay now succeeds.`)
      } else check(record.status === 'failed' && !!record.error, `${label}: unreplayable failure is not retained.`)
    } else {
      check(record.status === 'failed' && !!record.error && (!record.http_status || record.transport_preflight_failure), `${label}: response proof omitted without a transport failure.`)
      if (transportError) check(typeof JSON.parse(transportError.toString()).message === 'string', `${label}: transport-error message missing.`)
    }
    const eligible = !record.error && !replayFailed && modelMatches(job.model, record.actual_model) && record.http_status >= 200 && record.http_status < 300 &&
      (record.completion === 'complete' || record.capped) && numbers.length >= record.minimum_numbers && !dupText && !dupSequence
    check((record.status === 'accepted') === eligible, `${label}: first-eligible status differs.`)
    check(['accepted', 'invalid', 'failed'].includes(record.status), `${label}: unknown status.`)
    if (record.status === 'failed') check(typeof record.error === 'string' && !!record.error, `${label}: failed attempt lacks its original error.`)
    if (record.status === 'invalid') check(!record.error && typeof record.invalid_reason === 'string' && !!record.invalid_reason, `${label}: invalid attempt lacks a rejection reason.`)
    if (record.status === 'accepted') {
      check(!!request && !!raw && !!metadataBytes && !!replay && (!record.capped || numbers.length === job.expected_count), `${label}: accepted cap evidence is incomplete.`)
      selected.set(record.sample_id, { record, record_source: 'supplemental' })
    }
    seen.remember(record.text)
  }
  const walk = async (directory: string): Promise<string[]> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error: any) { if (error.code === 'ENOENT') return []; throw error }
    const found: string[] = []
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) found.push(...await walk(path))
      else if (entry.isFile()) found.push(localPath(path))
      else errors.push('Unexpected symbolic link or special file in supplemental traces.')
    }
    return found
  }
  const allEvidence = await walk(join(directory, 'supplemental-raw-traces'))
  const unrecorded = allEvidence.filter(path => !evidencePaths.has(path)), recoverablePaths = new Set<string>()
  if (allowPlannedOrphans) for (const job of planData.manifest.plan.jobs) {
    if (selected.has(job.sample_id)) continue
    for (let attempt = 3 + (attempts.get(job.sample_id) ?? 0); attempt <= 5; attempt++) {
      const traceDir = traceDirectory(directory, job.sample_id, attempt), requestPath = join(traceDir, 'attempt-1.request.json')
      const bytes = await optionalRead(requestPath); if (!bytes) break
      const submitted = JSON.parse(bytes.toString())
      check(equal(Object.keys(submitted).sort(), ['body', 'started_at', 'url']) && submitted.url === original.manifest.endpoint && equal(submitted.body, job.request), 'Unrecorded recovery request differs from the exact fixed slot.')
      for (const suffix of ['request.json', 'body.txt', 'response.json', 'error.json']) {
        const path = join(traceDir, 'attempt-1.' + suffix)
        if (await optionalRead(path)) recoverablePaths.add(localPath(path))
      }
    }
  }
  check(unrecorded.every(path => allowPlannedOrphans && recoverablePaths.has(path)), 'Unrecorded or unplanned supplemental physical request/response evidence remains.')
  if (unrecorded.length && allowPlannedOrphans) notes.push('Known consecutive planned orphan traces require offline recovery before any new request.')
  const missing = original.jobs.filter((job: any) => !selected.has(job.sample_id))
  if (missing.length) incomplete.push(`${missing.length} original planned slots still lack an eligible answer.`)
  bindings[localPath(planData.path)] = sha(planData.bytes)
  if (bytes) bindings[localPath(samplePath)] = sha(bytes)
  return { errors, incomplete, notes, selected, records, bytes, samplePath, bindings, replayed, missing }
}

async function main() {
  const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes.toString())
  if (protocol.schema !== 'generic-refinement-missing-continuation-protocol-v1' || protocol.training_allowed !== false ||
      !equal(protocol.operational_profile, { concurrency: 1, additional_attempts: 3, attempt_numbers: [3, 4, 5], backoff_before_attempt_ms: [5000, 15000, 30000], timeout_ms: 600000, pause_http_statuses: [401, 402, 403] })) throw new Error('Invalid continuation protocol.')
  const directory = inside(process.env.OUTPUT_DIR ?? protocol.original_directory_default)
  if (relative(join(ROOT, 'research/reports/generic-refinement-20261001'), directory).startsWith('..')) throw new Error('Continuation output must stay inside this study report directory.')
  const freezePath = inside(process.env.CANDIDATE_FREEZE_FILE ?? protocol.candidate_freeze_default)
  const preparing = process.argv.includes('--prepare-only'), original = await loadOriginal(directory, freezePath,
    preparing ? 'overload-preparation-original-integrity.json' : 'overload-current-original-integrity.json')
  const manifestPath = join(directory, 'supplemental-manifest.json'), samplePath = join(directory, 'supplemental-samples.jsonl')
  if (preparing) {
    if (!original.missing.length) throw new Error('All original slots are already accepted; no continuation is needed.')
    const plan = { created_at: new Date().toISOString(), original_manifest_sha256: original.manifest_sha256,
      original_samples_sha256: original.samples_sha256, candidate_freeze_sha256: original.freeze_sha256,
      original_bindings: original.bindings, original_preparation_audit: { path: localPath(original.auditPath), sha256: sha(original.auditBytes) },
      original_profile: original.manifest.profile, operational_profile: protocol.operational_profile,
      protocol_sha256: sha(protocolBytes), source_hashes: await sourceHashes(), jobs: original.missing }
    await writeFile(manifestPath, JSON.stringify({ schema: 'generic-refinement-missing-continuation-manifest-v1', id: protocol.id,
      purpose: protocol.purpose, training_allowed: false, plan, plan_sha256: sha(JSON.stringify(plan)), collection_runs: [] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await writeFile(samplePath, '', { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ prepared: true, missing_slots: original.missing.map((job: any) => job.sample_id), plan_sha256: sha(JSON.stringify(plan)), network_calls: 0 }))
    return
  }
  const planData = await loadPlan(directory, original), audited = await auditSupplemental(directory, original, planData, true)
  if (audited.errors.length) throw new Error('Supplemental records fail offline verification; inspect with verify-overload.ts before continuing.')
  if (!process.argv.includes('--resume') && planData.manifest.collection_runs.length) throw new Error('Use explicit --resume after inspecting an interrupted continuation.')
  const lockPath = join(directory, '.supplemental-collect-lock'), runId = `continuation-run-${randomUUID()}`
  try { const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, run_id: runId }) + '\n'); await lock.close() }
  catch (error: any) {
    if (error.code !== 'EEXIST' || !process.argv.includes('--resume')) throw new Error('Supplemental collector is locked.')
    const old = JSON.parse((await readFile(lockPath)).toString()); let alive = true
    try { process.kill(old.pid, 0) } catch (failure: any) { if (failure.code === 'ESRCH') alive = false }
    if (alive) throw new Error('Previous supplemental collector is still active.')
    await rename(lockPath, join(directory, `.supplemental-collect-lock.stale-${runId}`)); await writeFile(lockPath, JSON.stringify({ pid: process.pid, run_id: runId }) + '\n', { flag: 'wx', mode: 0o600 })
  }
  const manifest = planData.manifest, records = audited.records, seen = await duplicateSets(original)
  records.forEach(record => seen.remember(record.text))
  let key = '', halted = false, haltReason: string | null = null, active: AbortController | undefined
  const redact = (error: unknown) => { let message = error instanceof Error ? error.message : String(error); if (key) message = message.replaceAll(key, '[REDACTED]'); return message.replace(/sk[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]') }
  const stop = () => { halted = true; haltReason = 'operator-interrupted'; active?.abort() }
  const saveManifest = async () => { const temporary = join(directory, `.supplemental-manifest-${process.pid}.tmp`); await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, manifestPath) }
  const run: any = { id: runId, started_at: new Date().toISOString(), status: 'recovering', plan_sha256: manifest.plan_sha256,
    source_hashes: planData.source_hashes, operational_profile: protocol.operational_profile,
    supersedes_interrupted_runs: manifest.collection_runs.filter((run: any) => ['running', 'recovering'].includes(run.status)).map((run: any) => run.id) }
  manifest.collection_runs.push(run)
  const baseRecord = (job: any, attempt: number, startedAt = new Date().toISOString()) => ({ sample_id: job.sample_id, model: job.model, requested_model: job.model,
    actual_model: null, response_model: null, response_id: null, usage: null, provider_reported: null, finish_reason: null, completion: 'unknown', capped: false,
    round_id: job.round_id, challenge_id: job.challenge_id, prompt: job.prompt, expected_count: job.expected_count, max_numbers: job.expected_count,
    request: job.request, endpoint: original.manifest.endpoint, provenance: { kind: 'direct-openai', endpoint: original.manifest.endpoint, channel: 'openai-api' },
    purpose: original.manifest.purpose, training_allowed: false, collection_kind: 'missing-continuation', attempt, run_id: runId, started_at: startedAt,
    original_manifest_sha256: original.manifest_sha256, original_samples_sha256: original.samples_sha256, candidate_freeze_sha256: original.freeze_sha256,
    plan_sha256: manifest.plan_sha256, source_hashes: planData.source_hashes, original_profile: original.manifest.profile,
    operational_profile: protocol.operational_profile, selection_policy: 'user-authorized-expected-count-cap', text: '', status: 'failed' } as any)
  const persist = async (record: any) => { records.push(record); seen.remember(record.text); await appendFile(samplePath, JSON.stringify(record) + '\n', { mode: 0o600 }); console.log(`${record.sample_id} attempt ${record.attempt}: ${record.status}, ${record.parsed_count} numbers`) }
  try {
    await saveManifest()
    for (const job of manifest.plan.jobs) for (let attempt = 3; attempt <= 5; attempt++) {
      if (records.some(record => record.sample_id === job.sample_id && record.attempt === attempt)) continue
      const traceDir = traceDirectory(directory, job.sample_id, attempt), submitted = await optionalRead(join(traceDir, 'attempt-1.request.json'))
      if (!submitted) continue
      const request = JSON.parse(submitted.toString())
      if (request.url !== original.manifest.endpoint || !equal(request.body, job.request)) throw new Error('Interrupted supplemental request differs from its fixed plan.')
      const record = baseRecord(job, attempt, request.started_at); record.recovered_interrupted_trace = true
      try {
        const raw = await readFile(join(traceDir, 'attempt-1.body.txt')), metadata = JSON.parse(await readFile(join(traceDir, 'attempt-1.response.json'), 'utf8'))
        record.http_status = metadata.status; record.request_id = metadata.request_id
        if (protocol.operational_profile.pause_http_statuses.includes(metadata.status)) { halted = true; haltReason = `http-${metadata.status}` }
        assignCompletion(record, await readCompletion(new Response(raw, { status: metadata.status, headers: { 'content-type': metadata.content_type ?? '' } }), 'responses', text => { record.text = text }, undefined, job.expected_count))
      } catch (error: any) { if (error.completionDetails) assignCompletion(record, error.completionDetails); record.error = redact(error); record.error_code = error.code ?? null }
      await attachRaw(record, traceDir); finalize(record, job, seen); await persist(record)
    }
    planData.bytes = await readFile(manifestPath)
    const recoveredAudit = await auditSupplemental(directory, original, planData)
    if (recoveredAudit.errors.length) throw new Error('Recovered supplemental evidence fails strict verification; no model request will be made.')
    if (!process.env.API_KEY_FILE) throw new Error('Provide API_KEY_FILE; no key arguments or fallback credentials are accepted.')
    key = (await readFile(process.env.API_KEY_FILE, 'utf8')).trim(); if (!key) throw new Error('API_KEY_FILE is empty.')
    run.status = 'running'; await saveManifest(); process.on('SIGINT', stop); process.on('SIGTERM', stop)
    for (const job of manifest.plan.jobs) {
      if (records.some(record => record.sample_id === job.sample_id && record.status === 'accepted')) continue
      while (!halted) {
        const previous = records.filter(record => record.sample_id === job.sample_id), attempt = previous.length ? Math.max(...previous.map(record => record.attempt)) + 1 : 3
        if (attempt > 5) break
        await new Promise(resolve => setTimeout(resolve, protocol.operational_profile.backoff_before_attempt_ms[attempt - 3]))
        if (halted) break
        if (await optionalRead(join(directory, '.collect-lock')) || sha(await readFile(join(directory, 'manifest.json'))) !== original.manifest_sha256 ||
            sha(await readFile(join(directory, 'samples.jsonl'))) !== original.samples_sha256) throw new Error('Original collection reopened or changed during continuation.')
        const record = baseRecord(job, attempt), traceDir = traceDirectory(directory, job.sample_id, attempt), controller = new AbortController()
        active = controller; const timer = setTimeout(() => controller.abort(), protocol.operational_profile.timeout_ms)
        try {
          const transport = await traceTransport(traceDir, async (url, _config, body, signal) => fetch(url, { method: 'POST', signal, redirect: 'error',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
          const response = await transport(original.manifest.endpoint, { baseUrl: 'https://api.openai.com/v1', apiKey: key, model: job.model, format: 'responses', effort: 'low' }, job.request, controller.signal)
          record.http_status = response.status; record.request_id = response.headers.get('x-request-id')
          if (protocol.operational_profile.pause_http_statuses.includes(response.status)) { halted = true; haltReason = `http-${response.status}` }
          assignCompletion(record, await readCompletion(response, 'responses', text => { record.text = text }, undefined, job.expected_count))
        } catch (error: any) { if (error.completionDetails) assignCompletion(record, error.completionDetails); record.error = redact(error); record.error_code = error.code ?? null }
        finally { clearTimeout(timer); controller.abort(); active = undefined }
        await attachRaw(record, traceDir); finalize(record, job, seen); await persist(record)
        if (record.status === 'accepted') break
      }
      if (halted) break
    }
    run.status = halted ? 'paused' : 'finished'
  } catch (error) { run.status = 'failed'; run.error = redact(error); throw new Error(redact(error)) }
  finally {
    run.finished_at = new Date().toISOString(); run.halt_reason = haltReason; run.attempts = records.filter(record => record.run_id === runId).length
    await saveManifest(); process.off('SIGINT', stop); process.off('SIGTERM', stop); await unlink(lockPath)
  }
}

if (import.meta.main) await main().catch(error => { console.error(error instanceof Error ? error.message : 'Continuation failed.'); process.exitCode = 1 })
