/** Verify collection integrity offline. Never load classifiers or API credentials. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { completionBody } from '../../../projects/shared/completion-request'
import { readCompletion, type CompletionResult } from '../../../projects/shared/completion'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'

const ROOT = resolve(import.meta.dir, '../../..')
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return process.argv[index + 1]
}
const inside = (path: string) => {
  const absolute = resolve(ROOT, path), rel = relative(ROOT, absolute)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence must stay inside the research workspace.')
  return absolute
}
const localPath = (path: string) => relative(ROOT, path).split('\\').join('/')
const optionalRead = async (path: string): Promise<Buffer | null> => readFile(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
})
const jsonLines = (bytes: Buffer): any[] => bytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
const modelMatches = (requested: string, actual: unknown) => {
  if (actual === requested) return true
  const suffix = typeof actual === 'string' && actual.startsWith(requested + '-') ? actual.slice(requested.length + 1) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix) || /^\d{8}$/.test(suffix)
}
const protocolPath = join(import.meta.dir, 'collection-protocol.json')
const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes.toString())
const directory = inside(argument('--directory', process.env.OUTPUT_DIR ?? 'research/reports/generic-refinement-20261001/prospective-v2'))
const freezePath = inside(argument('--freeze', process.env.CANDIDATE_FREEZE_FILE ?? protocol.candidate_freeze_default))
const outputPath = inside(argument('--output', join(directory, 'integrity.json')))
const outputRelative = relative(join(ROOT, 'research/reports/generic-refinement-20261001'), outputPath)
if (outputRelative.startsWith('..') || isAbsolute(outputRelative) || !/(?:^|-)integrity\.json$/.test(basename(outputPath)) ||
    !relative(join(directory, 'raw-traces'), outputPath).startsWith('..')) throw new Error('Verifier output must be an integrity report outside original traces and inside this study report directory.')
const manifestPath = join(directory, 'manifest.json'), samplesPath = join(directory, 'samples.jsonl')
const manifestBytes = await optionalRead(manifestPath), sampleBytes = await optionalRead(samplesPath), freezeBytes = await optionalRead(freezePath)
const errors: string[] = [], incomplete: string[] = [], notes: string[] = []
const check = (condition: unknown, message: string) => { if (!condition) errors.push(message) }
const report: any = { schema: 'generic-refinement-prospective-integrity-v1', status: 'incomplete', errors,
  checked_at: new Date().toISOString(), manifest_sha256: manifestBytes ? sha(manifestBytes) : null,
  samples_sha256: sampleBytes ? sha(sampleBytes) : null, candidate_freeze_sha256: freezeBytes ? sha(freezeBytes) : null,
  verifier_sha256: sha(await readFile(import.meta.path)), collector_sha256: sha(await readFile(join(import.meta.dir, 'collect.ts'))),
  protocol_sha256: sha(protocolBytes), current_source_hashes_match: false,
  paths: { manifest: localPath(manifestPath), samples: localPath(samplesPath), freeze: localPath(freezePath),
    verifier: localPath(import.meta.path), collector: localPath(join(import.meta.dir, 'collect.ts')), protocol: localPath(protocolPath) },
  classifier_loaded: false, model_api_calls: 0, scoring_performed: false, incomplete_reasons: incomplete, notes }

try {
  if (!manifestBytes || !sampleBytes || !freezeBytes) {
    incomplete.push('Manifest, samples and candidate freeze must all exist before blind analysis.')
  } else {
    const manifest = JSON.parse(manifestBytes.toString()), freeze = JSON.parse(freezeBytes.toString())
    const profile = { format: 'responses', reasoning: { effort: 'low' }, stream: true, store: false,
      max_output_tokens: 8192, timeout_ms: 600000, concurrency: 4, max_attempts: 2 }
    check(protocol.schema === 'generic-refinement-blind-collection-v2' && protocol.purpose === 'prospective-evaluation-v2' &&
      protocol.training_allowed === false && equal(protocol.profile, profile) && equal(protocol.models, ['gpt-6-astra', 'gpt-6.1-sol']) &&
      protocol.rounds?.length === 20 && protocol.endpoint === 'https://api.openai.com/v1/responses', 'Invalid predeclared collection protocol.')
    check(freeze.schema === 'generic-refinement-freeze-v1' && freeze.fixed_holdout_opened === false &&
      freeze.freeze_after_selection_before_regression === true && freeze.reference_sha256 ===
      '5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4', 'Invalid candidate freeze identity or selection policy.')
    for (const [path, expected] of Object.entries(freeze.hashes ?? {})) {
      check(sha(await readFile(inside(path))) === expected, `Frozen candidate hash mismatch: ${path}`)
    }
    check(Object.keys(freeze.hashes ?? {}).some(path => path.endsWith('/fitted.joblib')), 'Candidate freeze does not bind a fitted artifact.')
    check(manifest.schema_version === 2 && manifest.id === protocol.id && manifest.purpose === protocol.purpose &&
      manifest.training_allowed === false && manifest.protocol_sha256 === sha(protocolBytes) &&
      equal(manifest.rounds, protocol.rounds) && equal(manifest.models, protocol.models) && equal(manifest.profile, profile) &&
      manifest.endpoint === protocol.endpoint && manifest.max_attempts === 2 && equal(manifest.selection, protocol.selection) &&
      equal(manifest.duplicate_check, protocol.deduplication), 'Manifest differs from the predeclared protocol.')
    check(manifest.candidate_freeze_sha256 === sha(freezeBytes) && manifest.frozen_candidate?.sha256 === sha(freezeBytes) &&
      manifest.frozen_candidate?.path === localPath(freezePath) && equal(manifest.frozen_candidate?.contents, freeze), 'Manifest candidate freeze binding mismatch.')
    check(!(await optionalRead(join(directory, '.collect-lock'))), 'Collection has an active or unreconciled lock.')
    const sourcePaths = [localPath(join(import.meta.dir, 'collect.ts')), localPath(protocolPath), 'projects/shared/completion-request.ts',
      'projects/shared/completion.ts', 'projects/shared/throughput.ts', 'projects/shared/fingerprint-core.js', 'projects/cli/trace.ts']
    const expectedSources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(inside(path)))])))
    report.current_source_hashes_match = equal(manifest.source_hashes, expectedSources)
    check(report.current_source_hashes_match, 'Collector or parser source hashes changed since manifest creation.')
    report.current_source_hashes = expectedSources
    const historicalPrompts = new Set<string>(), seenTexts = new Set<string>(), seenSequences = new Set<string>()
    const remember = (text: string) => {
      if (text) seenTexts.add(sha(text))
      const numbers = parseNumbers(text) as number[]
      if (numbers.length >= 80) seenSequences.add(sha(JSON.stringify(numbers)))
    }
    const visit = (value: any) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(visit); return }
      for (const [name, item] of Object.entries(value)) {
        if (['prompt', 'base_prompt'].includes(name) && typeof item === 'string') historicalPrompts.add(item)
        if (name === 'text' && typeof item === 'string') remember(item)
        if (typeof item === 'object') visit(item)
      }
    }
    for (const [path, expected] of Object.entries(protocol.deduplication.source_hashes)) {
      const bytes = await readFile(inside(path))
      check(sha(bytes) === expected, `Historical duplicate-check source changed: ${path}`)
      if (path.endsWith('.jsonl')) jsonLines(bytes).forEach(visit)
      else visit(JSON.parse(bytes.toString()))
    }
    const jobs = new Map<string, any>(), prompts = new Set<string>(), challengeIds = new Set<string>()
    for (const round of protocol.rounds) {
      check(round.challenges?.length === 3, `Round ${round.id} does not have three common challenges.`)
      for (const [position, challenge] of round.challenges.entries()) {
        check(!historicalPrompts.has(challenge.prompt) && !prompts.has(challenge.prompt) && !challengeIds.has(challenge.id) &&
          challenge.prompt.startsWith(protocol.neutral_prefix + '\n') && Number.isInteger(challenge.expected_count) && challenge.expected_count >= 80,
          `Invalid or repeated challenge: ${challenge.id}`)
        prompts.add(challenge.prompt); challengeIds.add(challenge.id)
        for (const model of protocol.models) {
          const sampleId = `${protocol.id}__${model}__${round.id}__${position + 1}`
          check(!jobs.has(sampleId), `Repeated planned slot: ${sampleId}`)
          jobs.set(sampleId, { sample_id: sampleId, model, round, challenge,
            body: completionBody({ model, format: 'responses', effort: 'low', stream: true }, challenge.prompt) })
        }
      }
    }
    check(jobs.size === 120 && prompts.size === 60, 'Protocol does not declare 120 unique common-prompt slots.')
    const runs = manifest.collection_runs ?? [], runIds = new Set(runs.map((run: any) => run.id))
    check(runIds.size === runs.length, 'Collection run IDs repeat.')
    const latest = runs.at(-1)
    if (!latest || latest.status !== 'finished' || latest.halt_reason || !latest.finished_at) incomplete.push('Last collection run has not finished without a halt.')
    const closedByResume = new Set(runs.flatMap((run: any) => run.status === 'finished' ? run.supersedes_interrupted_runs ?? [] : []))
    for (const [index, run] of runs.entries()) {
      check(equal(run.source_hashes, manifest.source_hashes) && equal(run.profile, profile) && run.protocol_sha256 === sha(protocolBytes) &&
        run.frozen_candidate_sha256 === sha(freezeBytes) && run.selection_policy === 'user-authorized-expected-count-cap', `Collection run binding mismatch: ${run.id}`)
      for (const oldId of run.supersedes_interrupted_runs ?? []) {
        check(runs.slice(0, index).some((old: any) => old.id === oldId && ['running', 'recovering'].includes(old.status)), `Run supersedes an unknown or already terminal run: ${run.id}`)
      }
      if (['running', 'recovering'].includes(run.status) && !closedByResume.has(run.id)) incomplete.push(`Unclosed collection run: ${run.id}`)
    }
    report.prior_interrupted_runs = runs.filter((run: any) => run !== latest && run.status !== 'finished').map((run: any) => ({ id: run.id, status: run.status, halt_reason: run.halt_reason ?? null, superseded: closedByResume.has(run.id) }))
    const records = jsonLines(sampleBytes), physicalIds = new Set<string>(), accepted = new Map<string, any>()
    const perSlot = new Map<string, any[]>(), requestPaths = new Set<string>(), evidencePaths = new Set<string>()
    let replayed = 0, transportFailures = 0
    const proof = async (evidence: any, expectedPath: string, label: string) => {
      const bytes = await optionalRead(expectedPath)
      if (!bytes) { check(!evidence, `${label}: evidence points to a missing file.`); return null }
      evidencePaths.add(localPath(expectedPath))
      check(evidence?.path === localPath(expectedPath) && evidence?.sha256 === sha(bytes) && evidence?.bytes === bytes.length, `${label}: path, SHA256 or byte count mismatch.`)
      return bytes
    }
    for (const record of records) {
      const label = `${record.sample_id}:attempt-${record.attempt}`, job = jobs.get(record.sample_id)
      check(!!job, `${label}: unplanned slot.`)
      if (!job) continue
      check(Number.isInteger(record.attempt) && record.attempt >= 1 && record.attempt <= 2 && !physicalIds.has(label), `${label}: invalid or repeated physical attempt.`)
      physicalIds.add(label)
      const previous = perSlot.get(record.sample_id) ?? []
      check(record.attempt === previous.length + 1, `${label}: attempts are missing or out of order.`)
      check(!accepted.has(record.sample_id), `${label}: a physical attempt follows an already accepted slot.`)
      previous.push(record); perSlot.set(record.sample_id, previous)
      check(record.model === job.model && record.requested_model === job.model && record.round_id === job.round.id &&
        record.challenge_id === job.challenge.id && record.prompt === job.challenge.prompt && record.expected_count === job.challenge.expected_count &&
        record.max_numbers === job.challenge.expected_count && equal(record.request, job.body) && record.endpoint === protocol.endpoint &&
        record.purpose === protocol.purpose && record.training_allowed === false && record.selection_policy === 'user-authorized-expected-count-cap' &&
        record.frozen_candidate_sha256 === sha(freezeBytes) && equal(record.source_hashes, manifest.source_hashes) && runIds.has(record.run_id), `${label}: request or provenance binding mismatch.`)
      check(equal(record.provenance, { kind: 'direct-openai', endpoint: protocol.endpoint, channel: 'openai-api' }), `${label}: source channel mismatch.`)
      check(typeof record.text === 'string' && record.response_model === record.actual_model, `${label}: text or actual-model schema mismatch.`)
      if (record.actual_model !== null) check(modelMatches(job.model, record.actual_model), `${label}: actual API model is outside the requested model or its dated snapshots.`)
      const numbers = parseNumbers(record.text) as number[], textHash = sha(record.text), sequenceHash = sha(JSON.stringify(numbers))
      check(record.text_sha256 === textHash && record.sequence_sha256 === sequenceHash && record.parsed_count === numbers.length &&
        record.minimum_numbers === Math.max(80, Math.ceil(job.challenge.expected_count * .55)), `${label}: parsed text or sequence hash mismatch.`)
      const duplicateText = !!record.text && seenTexts.has(textHash), duplicateSequence = numbers.length >= 80 && seenSequences.has(sequenceHash)
      check(record.duplicate_text === duplicateText && record.duplicate_sequence === duplicateSequence, `${label}: duplicate decision differs from predeclared chronological rule.`)
      check(['accepted', 'invalid', 'failed'].includes(record.status), `${label}: unknown attempt status.`)
      if (record.status === 'failed') check(typeof record.error === 'string' && !!record.error, `${label}: failed attempt lacks its original error.`)
      if (record.status === 'invalid') check(!record.error && typeof record.invalid_reason === 'string' && !!record.invalid_reason, `${label}: invalid attempt lacks its predeclared rejection reason.`)
      const traceDir = join(directory, 'raw-traces', sha(record.sample_id).slice(0, 24), `attempt-${record.attempt}`)
      check(record.raw_trace_directory === localPath(traceDir), `${label}: original trace directory mismatch.`)
      const requestPath = join(traceDir, 'attempt-1.request.json'), requestBytes = await proof(record.raw_request, requestPath, label + ': request')
      const rawPath = join(traceDir, 'attempt-1.body.txt'), raw = await proof(record.raw_response, rawPath, label + ': body')
      const metadataPath = join(traceDir, 'attempt-1.response.json'), metadataBytes = await proof(record.raw_response_metadata, metadataPath, label + ': response metadata')
      const transportError = await proof(record.raw_transport_error, join(traceDir, 'attempt-1.error.json'), label + ': transport error')
      if (requestBytes) {
        requestPaths.add(localPath(requestPath))
        const request = JSON.parse(requestBytes.toString())
        check(equal(Object.keys(request).sort(), ['body', 'started_at', 'url']) && request.url === protocol.endpoint && equal(request.body, job.body), `${label}: original request body or endpoint mismatch.`)
        check(!/"(?:authorization|api[_-]?key|x-api-key)"\s*:/i.test(requestBytes.toString()), `${label}: forbidden authentication metadata in trace.`)
      } else check(record.transport_preflight_failure === true && record.status === 'failed' && !!record.error && !raw && !metadataBytes, `${label}: request trace is silently omitted.`)
      for (const bytes of [requestBytes, raw, metadataBytes, transportError]) {
        if (bytes) check(!/sk[-_][A-Za-z0-9_-]{16,}/.test(bytes.toString()), `${label}: credential-shaped string in evidence.`)
      }
      let replay: CompletionResult | undefined, replayFailed = false
      if (raw && metadataBytes) {
        const metadata = JSON.parse(metadataBytes.toString())
        check(equal(Object.keys(metadata).sort(), ['content_type', 'request_id', 'status']) && metadata.status === record.http_status &&
          metadata.request_id === (record.request_id ?? null) && metadata.status === record.raw_response_metadata.status &&
          metadata.content_type === record.raw_response_metadata.content_type && metadata.request_id === record.raw_response_metadata.request_id &&
          record.raw_response.format === 'responses', `${label}: safe response metadata mismatch.`)
        try {
          replay = await readCompletion(new Response(raw, { status: metadata.status, headers: { 'content-type': metadata.content_type ?? '' } }), 'responses', undefined, undefined, job.challenge.expected_count)
        } catch (error: any) { replayFailed = true; replay = error.completionDetails }
        if (replay) {
          replayed++
          check(replay.text === record.text && (replay.responseModel ?? null) === record.actual_model &&
            (replay.responseId ?? null) === record.response_id && (replay.providerReported ?? null) === record.provider_reported &&
            equal(replay.usage ?? null, record.usage) && (replay.finishReason ?? null) === record.finish_reason &&
            replay.completion === record.completion && (replay.capped ?? false) === record.capped &&
            equal(parseNumbers(replay.text), numbers), `${label}: original response replay differs from stored completion.`)
          if (replayFailed) check(record.status === 'failed' && typeof record.error === 'string' && !!record.error, `${label}: replay failure is not retained as a failed attempt.`)
          else if (record.status === 'failed') notes.push(`${label}: replay succeeds; original transport/timeout error remains preserved, never adopted based on classification.`)
        } else check(record.status === 'failed' && !!record.error, `${label}: unreplayable response is not explicitly failed.`)
      } else {
        transportFailures++
        check(record.status === 'failed' && !!record.error && (!record.http_status || record.transport_preflight_failure), `${label}: missing response body or metadata without an explicit transport failure.`)
        if (transportError) check(typeof JSON.parse(transportError.toString()).message === 'string', `${label}: missing transport-error message.`)
      }
      const eligible = !record.error && !replayFailed && modelMatches(job.model, record.actual_model) &&
        record.http_status >= 200 && record.http_status < 300 && (record.completion === 'complete' || record.capped) &&
        numbers.length >= record.minimum_numbers && !duplicateText && !duplicateSequence
      check((record.status === 'accepted') === eligible, `${label}: status differs from first-eligible policy.`)
      if (record.status === 'accepted') {
        check(!!requestBytes && !!raw && !!metadataBytes && !!replay && (!record.capped || numbers.length === job.challenge.expected_count), `${label}: accepted attempt lacks complete cap evidence.`)
        accepted.set(record.sample_id, record)
      }
      remember(record.text)
    }
    const walk = async (path: string): Promise<string[]> => {
      let entries
      try { entries = await readdir(path, { withFileTypes: true }) } catch (error: any) { if (error.code === 'ENOENT') return []; throw error }
      const found: string[] = []
      for (const entry of entries) {
        const file = join(path, entry.name)
        if (entry.isDirectory()) found.push(...await walk(file))
        else if (entry.isFile()) found.push(localPath(file))
        else errors.push('Unexpected symbolic link or special file in original traces.')
      }
      return found
    }
    const allEvidence = await walk(join(directory, 'raw-traces')), allRequests = allEvidence.filter(path => path.endsWith('/attempt-1.request.json'))
    check(allRequests.length === requestPaths.size && allRequests.every(path => requestPaths.has(path)), 'Unrecorded or unplanned physical request traces remain.')
    check(allEvidence.length === evidencePaths.size && allEvidence.every(path => evidencePaths.has(path)), 'Unrecorded original response, metadata or transport-error evidence remains.')
    const missing = [...jobs.keys()].filter(id => !accepted.has(id))
    if (missing.length) incomplete.push(`${missing.length} planned slots lack their first eligible accepted attempt.`)
    report.planned_slots = jobs.size; report.accepted_slots = accepted.size; report.attempts = records.length
    report.physical_request_traces = requestPaths.size; report.raw_replayed_attempts = replayed; report.transport_failed_attempts = transportFailures
    report.missing_slots = missing; report.accepted_attempts = [...jobs.keys()].filter(id => accepted.has(id)).map(id => {
      const record = accepted.get(id)
      return { sample_id: id, attempt: record.attempt, text_sha256: record.text_sha256, sequence_sha256: record.sequence_sha256,
        parsed_count: record.parsed_count, requested_model: record.requested_model, actual_model: record.actual_model }
    })
    if (!errors.length && !incomplete.length && accepted.size === 120) report.status = 'complete'
  }
} catch (error) {
  // Never include response text, request secrets or a token in diagnostics.
  errors.push(error instanceof Error ? error.message.replace(/sk[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]') : 'Evidence parsing failed.')
}
if (errors.length) report.status = 'invalid'
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ status: report.status, errors: errors.length, accepted_slots: report.accepted_slots ?? 0, output: localPath(outputPath) }))
if (report.status !== 'complete') process.exitCode = 1
