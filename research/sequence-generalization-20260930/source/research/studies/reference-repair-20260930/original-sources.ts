import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { parseReference, referenceSamples } from '../../../projects/shared/reference'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const report = join(root, 'research/reports/reference-repair-20260930')
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const readJSON = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const baselinePath = join(report, 'baseline/unified_reference.jsonl')
const baseline = await readFile(baselinePath)
const batches = parseReference(baseline.toString())
const targets = [
  {label: 'kimi-k2.8-preview', collection: 'projects/runs/kimi-k2.8-preview-low-20260917',
    session: '/Users/ikaleio/.omp/agent/sessions/-Projects-lm-fingerpoint-detector/2026-09-17T07-24-19-560Z_01a0ae40-86e8-7133-8348-eb991b278f49.jsonl',
    line: 34, messagePath: 'message.content[0].text', kind: 'kimi'},
  {label: 'step-5-preview', collection: 'projects/data/collections/step-5-preview-20260922',
    recovery: 'projects/data/collections/step-5-preview-20260922-low-recovery',
    session: '/Users/ikaleio/.codex/sessions/2026/09/22/rollout-2026-09-22T20-41-51-01a0c923-088a-7881-a2f9-196a93997bfd.jsonl',
    line: 9, messagePath: 'payload.content[0].text, second text line', kind: 'step'},
]
const summaries = await Promise.all(targets.map(async target => {
  const selected = batches.filter(batch => batch.model.id === target.label)
  const samples = [...referenceSamples(selected)]
  const manifestBytes = await readFile(join(root, target.collection, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString())
  const result = await readJSON(join(root, target.collection, 'result.json'))
  const sessionRow = JSON.parse((await readFile(target.session, 'utf8')).split('\n')[target.line - 1])
  const text = target.kind === 'kimi' ? sessionRow.message.content[0].text : sessionRow.payload.content[0].text
  // Only a boolean leaves memory; credentials are never copied to an artifact.
  const credentialPresent = target.kind === 'kimi'
    ? /\bsk[-_][A-Za-z0-9_-]{12,}/.test(text)
    : /^[A-Za-z0-9_-]{20,}$/.test(text.split('\n')[1].trim())
  const reasoning = Object.fromEntries([...new Set(samples.map(({batch, sample}) => sample.reasoning_effort ?? batch.request.reasoning_effort))]
    .map(effort => [String(effort), samples.filter(({batch, sample}) => (sample.reasoning_effort ?? batch.request.reasoning_effort) === effort).length]))
  return {label: target.label, reference_batches: selected.map(batch => ({id: batch.id, source: batch.source, request: batch.request, imported_from: batch.imported_from})),
    training_samples: samples.length, sample_sources: [...new Set(samples.map(({batch, sample}) => sample.actual_channel ?? batch.source.channel))],
    reported_providers: [...new Set(samples.map(({sample}) => sample.provider_reported))],
    response_models: [...new Set(samples.map(({sample}) => sample.response_model))], reasoning_counts: reasoning,
    finished_at_range: samples.map(({sample}) => sample.finished_at).filter(Boolean).sort().filter((_, i, values) => i === 0 || i === values.length - 1),
    original_evidence: samples.map(({sample}) => sample.evidence_path),
    original_collection: {directory: target.collection, manifest_sha256: sha(manifestBytes), id: manifest.id,
      schema: manifest.schema, purpose: manifest.purpose, metadata: manifest.metadata, endpoint: manifest.endpoint,
      config: Object.fromEntries(['baseUrl', 'model', 'format', 'effort', 'stream', 'parallel'].map(key => [key, manifest.config[key]])),
      tasks: manifest.tasks.length, accepted: result.accepted, attempted: result.attempted,
      recovery_directory: target.recovery ?? null},
    historical_user_credential: {file: target.session, jsonl_line: target.line, message_path: target.messagePath,
      credential_present: credentialPresent, current_validity: 'not checked; no API requests in this audit'},
  }
}))
const piAuthFile = '/Users/ikaleio/.pi/agent/auth.json'
const piAuth = await readJSON(piAuthFile)
const ompModelsFile = '/Users/ikaleio/.omp/agent/models.yml'
const ompModels = Bun.YAML.parse(await readFile(ompModelsFile, 'utf8')) as {providers?: Record<string, unknown>}
const ompDbFile = '/Users/ikaleio/.omp/agent/agent.db'
const db = new Database(ompDbFile, {readonly: true})
const credentialRows = db.query('SELECT provider, credential_type FROM auth_credentials').all() as {provider: string; credential_type: string}[]
db.close()
const configured = {pi_auth: {file: piAuthFile, provider_ids: Object.keys(piAuth), matching_provider_present: Object.keys(piAuth).some(key => /kimi|moonshot|step/i.test(key))},
  omp_models: {file: ompModelsFile, provider_ids: Object.keys(ompModels.providers ?? {}), matching_provider_present: Object.keys(ompModels.providers ?? {}).some(key => /kimi|moonshot|step/i.test(key))},
  omp_auth_database: {file: ompDbFile, matching_credentials: credentialRows.filter(row => /kimi|moonshot|step/i.test(row.provider)), total_credential_records: credentialRows.length},
  environment: {matching_variable_names: Object.keys(Bun.env).filter(key => /kimi|moonshot|stepfun|step.plan/i.test(key))},
}
const sourceFiles = ['projects/shared/reference.ts', 'projects/shared/detection.ts', 'projects/shared/completion-request.ts',
  'projects/cli/sampling.ts', 'projects/cli/collection-options.ts', 'research/scripts/holdout-shared.ts', 'research/scripts/collect-holdout.ts']
const result = {audited_at: new Date().toISOString(), scope: 'Original direct-source identity and local credential presence only',
  baseline_reference_sha256: sha(baseline), targets: summaries, configured,
  source_sha256: Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, sha(await readFile(join(root, path)))]))),
  api_requests: 0, shared_data_modified: false, secret_values_recorded: false}
await writeFile(join(report, 'original-sources-audit.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({targets: summaries.map(row => ({label: row.label, historical_credential_present: row.historical_user_credential.credential_present})),
  configured_matching_credentials: configured.omp_auth_database.matching_credentials.length,
  report: 'research/reports/reference-repair-20260930/original-sources-audit.json'}))
