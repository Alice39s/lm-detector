import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { generateChallenges } from '../../../projects/shared/challenge-browser.js'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { completionBody, COMPLETION_TIMEOUT_MS } from '../../../projects/shared/completion-request'
import { readCompletion } from '../../../projects/shared/completion'

const root = resolve(import.meta.dir, '../../..')
const directory = process.env.OUTPUT_DIR ?? join(root, 'research/reports/sequence-generalization/20260930/prospective')
const key = process.env.OPENAI_API_KEY ?? (process.env.API_KEY_FILE ? (await readFile(process.env.API_KEY_FILE, 'utf8')).trim() : '')
if (!key) throw new Error('Provide OPENAI_API_KEY or API_KEY_FILE.')
const endpoint = 'https://api.openai.com/v1/responses'
const models = ['gpt-6-astra', 'gpt-6.1-sol']
const rounds = 20
const concurrency = 4
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const manifestPath = join(directory, 'manifest.json')
const samplesPath = join(directory, 'samples.jsonl')
await mkdir(directory, { recursive: true })
let manifest: any
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch (error: any) {
  if (error.code !== 'ENOENT') throw error
  manifest = { schema_version: 1, purpose: 'prospective-evaluation', id: 'sequence-generalization-direct-low-20260930', created_at: new Date().toISOString(),
    endpoint, models, request: { format: 'responses', reasoning: { effort: 'low' }, stream: true, store: false, max_output_tokens: 8192 },
    max_attempts: 2, selection: 'first accepted attempt; no classification-based retries', transport: process.env.COLLECTION_HOST ?? 'local',
    source_hashes: Object.fromEntries(await Promise.all(['projects/data/unified_reference.jsonl', 'projects/data/unified_bank.json', 'projects/data/shared_detector.json', 'projects/shared/challenge-browser.js'].map(async path => [path, sha(await readFile(join(root, path)))]))),
    rounds: Array.from({ length: rounds }, (_, i) => ({ id: `round-${String(i + 1).padStart(2, '0')}`, challenges: generateChallenges(3) })), }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
if (manifest.purpose !== 'prospective-evaluation' || manifest.endpoint !== endpoint || JSON.stringify(manifest.models) !== JSON.stringify(models)) throw new Error('Existing manifest does not match collection.')
const records: any[] = await readFile(samplesPath, 'utf8').then(x => x.split('\n').filter(Boolean).map(x => JSON.parse(x))).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return [] })
const jobs = manifest.rounds.flatMap((round: any) => round.challenges.flatMap((challenge: any, position: number) => models.map(model => ({ model, round, challenge, sample_id: `${model}__${round.id}__${position + 1}` }))))
let halted = false
async function collect(job: any) {
  if (records.some(x => x.sample_id === job.sample_id && x.status === 'accepted')) return
  while (!halted) {
    const attempt = records.filter(x => x.sample_id === job.sample_id).length + 1
    if (attempt > (manifest.retry_extensions?.[job.sample_id]?.max_attempts ?? manifest.max_attempts)) return
    const body = completionBody({ model: job.model, format: 'responses', effort: 'low', stream: true }, job.challenge.prompt)
    const controller = new AbortController(), started = Date.now()
    const timer = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS)
    const record: any = { sample_id: job.sample_id, model: job.model, round_id: job.round.id, challenge_id: job.challenge.id,
      purpose: manifest.purpose, expected_count: job.challenge.expected_count, prompt: job.challenge.prompt, request: body, endpoint,
      attempt, started_at: new Date(started).toISOString(), status: 'failed', text: '' }
    try {
      const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      record.http_status = response.status; record.request_id = response.headers.get('x-request-id')
      if ([401, 402, 403].includes(response.status)) halted = true
      const result = await readCompletion(response, 'responses', text => { record.text = text })
      Object.assign(record, { text: result.text, response_model: result.responseModel, response_id: result.responseId, usage: result.usage, completion: result.completion, finish_reason: result.finishReason })
      if (result.responseModel !== job.model && !result.responseModel?.startsWith(job.model + '-')) throw new Error(`Model mismatch: ${result.responseModel}`)
      record.parsed_count = parseNumbers(record.text).length
      record.status = result.completion === 'complete' && record.parsed_count >= Math.max(80, Math.ceil(job.challenge.expected_count * .55)) ? 'accepted' : 'invalid'
    } catch (error) { record.error = String(error instanceof Error ? error.message : error).replaceAll(key, '[REDACTED]') }
    finally { clearTimeout(timer); controller.abort() }
    record.parsed_count = parseNumbers(record.text).length; record.elapsed_ms = Date.now() - started; record.text_sha256 = sha(record.text)
    records.push(record); await appendFile(samplesPath, JSON.stringify(record) + '\n')
    console.log(`${record.sample_id} attempt ${attempt}: ${record.status}, ${record.parsed_count} numbers${record.error ? ', ' + record.error : ''}`)
    if (record.status === 'accepted' || (record.http_status >= 400 && record.http_status < 500 && record.http_status !== 429 && record.status === 'failed')) return
  }
}
await Promise.all(Array.from({ length: concurrency }, async () => { while (jobs.length && !halted) await collect(jobs.shift()) }))
console.log(JSON.stringify({ attempts: records.length, accepted: records.filter(x => x.status === 'accepted').length, halted }))
