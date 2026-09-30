import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { analyzeSharedOutputs, type SharedDetector } from '../../../projects/shared/shared-detector'

const root = resolve(import.meta.dir, '../../..')
const run = join(root, 'research/reports/sequence-generalization/20260930')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const jsonl = async (path: string): Promise<any[]> => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(x => JSON.parse(x))
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const bank = await json(join(root, 'projects/data/unified_bank.json'))
const detector: SharedDetector = await json(join(root, 'projects/data/shared_detector.json'))
const ids: string[] = detector.model_ids
const freeze = await json(join(run, 'candidate-freeze.json'))
if (freeze.reference_sha256 !== sha(await readFile(join(root, 'projects/data/unified_reference.jsonl')))) throw new Error('Reference changed after candidate selection.')

function score(id: string, model: string, rows: any[]) {
  const result = analyzeSharedOutputs(rows.map(row => ({ text: row.text, expected_count: row.expected_count })), bank, detector)
  const byId = new Map(result.results.map(row => [row.model, row]))
  return { id, model, sample_ids: rows.map(row => row.sample_id), numbers: rows.map(row => parseNumbers(row.text)),
    expected_counts: rows.map(row => row.expected_count), baseline_scores: ids.map(id => byId.get(id)?.score),
    baseline_probabilities: ids.map(id => byId.get(id)?.probability), baseline_prediction: result.prediction,
    baseline_confidence: result.probability, baseline_decision: result.decision }
}

async function paired(directory: string) {
  const manifest = await json(join(directory, 'manifest.json'))
  const records = await jsonl(join(directory, 'samples.jsonl'))
  const groups = []
  for (const round of manifest.rounds) for (const modelEntry of manifest.models) {
    const model = typeof modelEntry === 'string' ? modelEntry : modelEntry.label
    const rows = round.challenges.map((_: any, i: number) => records.filter(row => row.sample_id === `${model}__${round.id}__${i + 1}` && row.status === 'accepted').sort((a, b) => a.attempt - b.attempt)[0])
    if (rows.every(Boolean)) groups.push({ ...score(`${model}:${round.id}`, model, rows), cluster: round.id })
  }
  return { planned_groups: manifest.rounds.length * manifest.models.length, groups, attempts: records.length,
    accepted_samples: new Set(records.filter(row => row.status === 'accepted').map(row => row.sample_id)).size,
    manifest_sha256: sha(await readFile(join(directory, 'manifest.json'))), samples_sha256: sha(await readFile(join(directory, 'samples.jsonl'))) }
}

const holdoutBaseline = await json(join(root, 'research/reports/holdout/latest.json'))
const holdoutRecords = await jsonl(join(root, 'research/evaluation/holdout/samples.jsonl'))
const lookup = new Map(holdoutRecords.map(row => [`${row.sample_id}:${row.attempt}`, row]))
const holdoutGroups = holdoutBaseline.groups.filter((group: any) => group.complete).map((group: any) => {
  const rows = group.samples.map((sample: any) => lookup.get(`${sample.id}:${sample.selected_attempt}`))
  if (!rows.every(row => row?.status === 'accepted' && sha(row.text) === row.text_sha256)) throw new Error('Invalid frozen holdout selection.')
  return { ...score(group.id, group.model, rows), cluster: group.group }
})
const result = { created_at: new Date().toISOString(), candidate_freeze_sha256: sha(await readFile(join(run, 'candidate-freeze.json'))), model_ids: ids,
  datasets: { holdout: { planned_groups: holdoutBaseline.metrics.planned_groups, groups: holdoutGroups },
    previous_pair: await paired(join(root, 'research/reports/astra-sol-separation/paired-low-01')),
    prospective: await paired(join(run, 'prospective')) } }
await writeFile(join(run, 'evaluation-data.json'), JSON.stringify(result) + '\n')
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.datasets).map(([name, data]) => [name, { groups: data.groups.length, planned_groups: data.planned_groups }]))))
