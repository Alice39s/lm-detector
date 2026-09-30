import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseNumbers } from '../../../projects/shared/fingerprint-core.js'
import { root, hash } from '../../scripts/holdout-shared'

const directory = join(root, 'research/reports/reference-repair-20260930')
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const datasetPath = join(root, 'research/evaluation/holdout/samples.jsonl')
const manifestPath = join(root, 'research/evaluation/holdout/manifest.json')
const [dataset, manifest] = await Promise.all([readFile(datasetPath), readFile(manifestPath)])
const report = await readJson(join(root, 'research/reports/holdout/latest.json'))
if (report.dataset_sha256 !== hash(dataset) || report.suite_sha256 !== hash(manifest)) throw new Error('Run the current fixed-holdout evaluator first')
if (report.metrics.planned_groups !== 106 || report.groups.length !== 106) throw new Error('Expected all 106 planned fixed groups')
const before = await readJson(join(directory, 'baseline/holdout-before.json'))
const oldIds = new Set(before.groups.filter((group: any) => group.complete).map((group: any) => group.id))
if (oldIds.size !== 72) throw new Error('Expected the preserved 72 baseline groups')
const records = dataset.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
const lookup = new Map(records.map(row => [`${row.sample_id}:${row.attempt}`, row]))
const groups = report.groups.filter((group: any) => group.complete).map((group: any) => {
  const rows = group.samples.map((sample: any) => lookup.get(`${sample.id}:${sample.selected_attempt}`))
  if (rows.length !== 3 || !rows.every((row: any) => row?.status === 'accepted' && row.text_sha256 === hash(row.text))) throw new Error(`Invalid selected group: ${group.id}`)
  return {id: group.id, model: group.model, cluster: group.group, cohort: oldIds.has(group.id) ? 'old_72' : 'added_34',
    formal_product_prediction: group.result.prediction,
    sample_ids: rows.map((row: any) => row.sample_id), attempts: rows.map((row: any) => row.attempt),
    text_sha256: rows.map((row: any) => row.text_sha256), numbers: rows.map((row: any) => parseNumbers(row.text))}
})
const hashes = {samples_sha256: hash(dataset), manifest_sha256: hash(manifest),
  reference_sha256: hash(await readFile(join(root, 'projects/data/unified_reference.jsonl'))),
  bank_sha256: hash(await readFile(join(root, 'projects/data/unified_bank.json'))),
  shared_detector_sha256: hash(await readFile(join(root, 'projects/data/shared_detector.json'))),
  formal_product_scorer_sha256: report.scorer_sha256,
  evaluator_report_sha256: hash(await readFile(join(root, 'research/reports/holdout/latest.json'))),
  candidate_freeze_sha256: hash(await readFile(join(root, 'research/reports/sequence-generalization/20260930/candidate-freeze.json')))}
if (report.reference_sha256 !== hashes.reference_sha256 || report.bank_sha256 !== hashes.bank_sha256) throw new Error('The formal evaluator reference/bank hashes are stale')
const coverage = {planned_groups: 106, complete_groups: groups.length, planned_samples: 318, selected_samples: report.groups.reduce((count: number, group: any) => count + group.samples.filter((sample: any) => sample.selected_attempt !== null).length, 0),
  observed_truth_labels: new Set(groups.map((group: any) => group.model)).size,
  incomplete_groups: report.groups.filter((group: any) => !group.complete).map((group: any) => ({id: group.id, model: group.model, missing_samples: group.samples.filter((sample: any) => sample.selected_attempt === null).map((sample: any) => sample.id)}))}
await mkdir(directory, {recursive: true})
await writeFile(join(directory, 'expanded-fusion-input.json'), JSON.stringify({created_at: new Date().toISOString(), hashes, coverage, groups}) + '\n')
console.log(JSON.stringify({groups: groups.length, old: groups.filter((group: any) => group.cohort === 'old_72').length,
  added: groups.filter((group: any) => group.cohort === 'added_34').length, coverage, hashes}))
