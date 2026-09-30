import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const run = 'research/reports/sequence-generalization/20260930'
const sha = async (path: string) => createHash('sha256').update(await readFile(join(root, path))).digest('hex')
const entries = [
  ['positional', 'positional', 'positional/fitted.joblib'],
  ['positional_ensemble', 'positional', 'positional/ensemble-fusion/fitted.joblib'],
  ['svm_ensemble', 'classifiers', 'classifiers/fitted-winner.joblib'],
  ['local_rerank', 'rerank', 'rerank/frozen.joblib'],
  ['generic_fusion', 'fusion', 'fusion/fitted.joblib'],
]
const sources = ['positional.py', 'classifiers.py', 'rerank.py', 'fusion.py', 'evaluate.py', 'export-evaluation.ts', 'PROTOCOL.md']
  .map(file => `research/studies/sequence-generalization/${file}`)
const auxiliary = [`${run}/rerank/freeze.json`]
const frozen = { schema: 'generic-candidate-freeze-v1', created_at: new Date().toISOString(),
  reference_sha256: await sha('projects/data/unified_reference.jsonl'),
  selection_scope: 'All 53 registered models, 636 reference groups; no external evaluation scores used',
  prospective_dataset_sha256: await sha(`${run}/prospective/samples.jsonl`),
  source_hashes: Object.fromEntries(await Promise.all([...sources, ...auxiliary].map(async path => [path, await sha(path)]))),
  candidates: await Promise.all(entries.map(async ([id, module, file]) => ({ id, module, artifact: `${run}/${file}`, artifact_sha256: await sha(`${run}/${file}`) }))), }
await writeFile(join(root, run, 'candidate-freeze.json'), JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx' })
console.log('Frozen ' + frozen.candidates.length + ' generic candidates before external scoring.')
