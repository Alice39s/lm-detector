import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { parseReference } from '../../../projects/shared/reference'
import { completionBody } from '../../../projects/shared/completion-request'

const root = resolve(import.meta.dir, '../../..')
const run = join(root, 'research/reports/sequence-generalization/20260930')
const jsonl = (text: string): any[] => text.split('\n').filter(Boolean).map(line => JSON.parse(line))
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const manifest = JSON.parse(await readFile(join(run, 'prospective/manifest.json'), 'utf8'))
const sampleBytes = await readFile(join(run, 'prospective/samples.jsonl'))
const records = jsonl(sampleBytes.toString())
const freeze = JSON.parse(await readFile(join(run, 'candidate-freeze.json'), 'utf8'))
const audit = JSON.parse(await readFile(join(run, 'data-audit.json'), 'utf8'))
for (const path of ['projects/data/unified_reference.jsonl', 'projects/data/unified_bank.json', 'projects/data/shared_detector.json', 'research/evaluation/holdout/manifest.json', 'research/evaluation/holdout/samples.jsonl']) {
  if (sha(await readFile(join(root, path))) !== audit.hashes[path]) throw new Error('Input changed: ' + path)
}
if (sha(sampleBytes) !== freeze.prospective_dataset_sha256) throw new Error('Prospective samples changed after freeze.')
const accepted: any[] = [], seen = new Set<string>()
for (const round of manifest.rounds) for (const model of manifest.models) for (let i = 0; i < round.challenges.length; i++) {
  const sampleId = `${model}__${round.id}__${i + 1}`, challenge = round.challenges[i]
  const attempts = records.filter(row => row.sample_id === sampleId).sort((a, b) => a.attempt - b.attempt)
  for (const [index, row] of attempts.entries()) {
    const identity = `${sampleId}:${row.attempt}`
    const body = completionBody({ model, format: 'responses', effort: 'low', stream: true }, challenge.prompt)
    if (seen.has(identity) || row.attempt !== index + 1 || row.attempt > (manifest.retry_extensions?.[sampleId]?.max_attempts ?? manifest.max_attempts) ||
        row.prompt !== challenge.prompt || row.expected_count !== challenge.expected_count || sha(row.text) !== row.text_sha256 ||
        row.parsed_count !== parseNumbers(row.text).length || JSON.stringify(row.request) !== JSON.stringify(body)) throw new Error('Attempt integrity failure: ' + identity)
    if (/sk-proj-[A-Za-z0-9_-]{20,}/.test(JSON.stringify(row))) throw new Error('Credential pattern found in saved sample.')
    seen.add(identity)
    if (row.status === 'accepted' && (row.completion !== 'complete' || row.parsed_count < Math.max(80, Math.ceil(challenge.expected_count * .55)) ||
      (row.response_model !== model && !row.response_model?.startsWith(model + '-')))) throw new Error('Invalid accepted response: ' + identity)
  }
  const chosen = attempts.find(row => row.status === 'accepted')
  if (!chosen) throw new Error('Incomplete planned position: ' + sampleId)
  accepted.push(chosen)
}
if (seen.size !== records.length) throw new Error('Unplanned attempt records.')
const sequences = (rows: any[]) => new Set(rows.map(row => sha(JSON.stringify(parseNumbers(row.text)))))
const reference = parseReference(await readFile(join(root, 'projects/data/unified_reference.jsonl'), 'utf8')).flatMap(batch => batch.samples)
const oldPair = jsonl(await readFile(join(root, 'research/reports/astra-sol-separation/paired-low-01/samples.jsonl'), 'utf8')).filter(row => row.status === 'accepted')
const holdout = jsonl(await readFile(join(root, 'research/evaluation/holdout/samples.jsonl'), 'utf8')).filter(row => row.status === 'accepted')
const fresh = sequences(accepted)
const overlap = (rows: any[]) => [...sequences(rows)].filter(hash => fresh.has(hash)).length
const promptOverlap = (rows: any[]) => {
  const previous = new Set(rows.map(row => row.prompt))
  return new Set(accepted.filter(row => previous.has(row.prompt)).map(row => row.prompt)).size
}
const result = { attempts: records.length, selected: accepted.length, planned: manifest.rounds.length * manifest.models.length * 3,
  complete_matched_rounds: manifest.rounds.length, statuses: Object.fromEntries(['accepted', 'failed', 'invalid'].map(status => [status, records.filter(row => row.status === status).length])),
  selected_by_model: Object.fromEntries(manifest.models.map((model: string) => [model, accepted.filter(row => row.model === model).length])),
  sequence_duplicate_records: accepted.length - fresh.size,
  sequence_overlap: { reference: overlap(reference), old_pair: overlap(oldPair), holdout: overlap(holdout) },
  exact_prompt_overlap: { reference: promptOverlap(reference), old_pair: promptOverlap(oldPair), holdout: promptOverlap(holdout) },
  all_original_inputs_unchanged: true, attempts_requests_hashes_and_response_labels_valid: true,
  samples_sha256: sha(sampleBytes), manifest_sha256: sha(await readFile(join(run, 'prospective/manifest.json'))) }
await writeFile(join(run, 'collection-integrity.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
