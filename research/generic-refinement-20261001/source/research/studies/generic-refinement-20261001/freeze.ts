/** Bind the selected ranker and its development temperature before external scoring. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const run = 'research/reports/generic-refinement-20261001'
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hashes: Record<string, string> = {}
const read = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'))
async function add(path: string, expected?: string) {
  const bytes = await readFile(join(root, path))
  const actual = sha(bytes)
  if (expected && actual !== expected) throw new Error(`Source changed before final freeze: ${path}`)
  if (hashes[path] && hashes[path] !== actual) throw new Error(`Conflicting dependency hashes: ${path}`)
  hashes[path] = actual
}
for (const path of [`${run}/portfolio/freeze-inputs.json`, `${run}/domain-groups/freeze.json`]) {
  const input = await read(path)
  for (const [name, digest] of Object.entries({...input.hashes, ...input.files})) await add(name, digest as string)
  await add(path)
}
const source = await read(`${run}/source-robust/freeze.json`)
for (const [path, digest] of Object.entries(source.hashes)) await add(path, digest as string)
const local = await read(`${run}/source-local/freeze.json`)
for (const [path, digest] of Object.entries(local.hashes)) await add(path, digest as string)
const protocol = await read('research/studies/generic-refinement-20261001/collection-protocol.json')
for (const [path, digest] of Object.entries(protocol.deduplication.source_hashes)) await add(path, digest as string)
for (const name of ['freeze.ts', 'calibrate.py', 'evaluate.py', 'CALIBRATION_PROTOCOL.md',
  'collect.ts', 'verify-prospective.ts', 'collection-protocol.json']) await add(`research/studies/generic-refinement-20261001/${name}`)
for (const path of ['projects/shared/completion-request.ts', 'projects/shared/completion.ts',
  'projects/shared/throughput.ts', 'projects/shared/fingerprint-core.js', 'projects/cli/trace.ts',
  'projects/research/sequence-generalization-20260930/bundle.json',
  `${run}/portfolio/calibration.json`, `${run}/portfolio/calibration-plan.json`]) await add(path)
const metadata = {schema: 'generic-refinement-freeze-v1', created_at: new Date().toISOString(),
  reference_sha256: '5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4',
  selected_artifact: `${run}/portfolio/fitted.joblib`, selected_module: 'portfolio',
  calibration: `${run}/portfolio/calibration.json`,
  selection: '37 predeclared full-gallery label/source-balanced development candidates; no external score selection.',
  fixed_holdout_opened: false, freeze_after_selection_before_regression: true,
  candidate_changed_after_evaluation: false, hashes}
const target = `${run}/portfolio/freeze.json`
await writeFile(join(root, target), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({path: target, inputs: Object.keys(hashes).length, freeze_sha256: sha(await readFile(join(root, target)))}))
