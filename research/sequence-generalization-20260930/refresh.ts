/** Snapshot only this study's sources, attempt records and selected evidence. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const bundle = import.meta.dir
const sourceFlag = process.argv.indexOf('--source-root')
const sourceRoot = resolve(sourceFlag === -1 ? join(bundle, '../../..') : process.argv[sourceFlag + 1])
const baseline = 'research/reports/reference-repair-20260930/baseline'
const run = 'research/reports/sequence-generalization/20260930'
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const fileEntries: any[] = [], compressed: any[] = []
async function put(path: string, bytes: Uint8Array | string) {
  const target = join(bundle, path)
  await mkdir(join(target, '..'), {recursive: true})
  await writeFile(target, bytes)
}
async function copy(path: string) {
  const bytes = await readFile(join(sourceRoot, path))
  const target = 'source/' + path
  await put(target, bytes)
  fileEntries.push({path: target, origin: path, sha256: sha(bytes), bytes: bytes.length})
}
async function optional(path: string) {
  try { await copy(path) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
}
async function sourceDirectory(path: string, extensions: string[]) {
  for (const name of (await readdir(join(sourceRoot, path))).sort()) {
    if (extensions.some(extension => name.endsWith(extension))) await copy(join(path, name))
  }
}
async function directoryTree(path: string) {
  for (const entry of (await readdir(join(sourceRoot, path), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await directoryTree(child)
    else if (entry.isFile()) await copy(child)
  }
}
async function gzip(origin: string, archive: string, targets: string[]) {
  const bytes = await readFile(join(sourceRoot, origin))
  const packed = Bun.gzipSync(bytes, {level: 9})
  await put(archive, packed)
  compressed.push({path: archive, origin, sha256: sha(bytes), bytes: bytes.length,
    compressed_sha256: sha(packed), compressed_bytes: packed.length, targets})
}
const baselineReference = await readFile(join(sourceRoot, baseline, 'unified_reference.jsonl'))
const baseCommit = '3389a6f3979c9298dbd9da4596c53fba7cddd7ce'
const git = Bun.spawn(['git', 'show', `${baseCommit}:data/unified_reference.jsonl`],
  {cwd: join(sourceRoot, 'projects'), stdout: 'pipe', stderr: 'pipe'})
const committed = await new Response(git.stdout).text()
if (await git.exited) throw new Error('Cannot read the pinned reference commit')
const byLabel = (lines: string[]) => {
  const result = new Map<string, string[]>()
  for (const line of lines) {
    const id = JSON.parse(line).model.id
    result.set(id, [...result.get(id) || [], line])
  }
  return result
}
const headLines = committed.trimEnd().split('\n')
const baselineLines = baselineReference.toString().trimEnd().split('\n')
const oldGroups = byLabel(headLines), currentGroups = byLabel(baselineLines)
const changedLabels = [...currentGroups.keys()].filter(label => JSON.stringify(oldGroups.get(label)) !== JSON.stringify(currentGroups.get(label)))
const overlay = baselineLines.filter(line => changedLabels.includes(JSON.parse(line).model.id)).join('\n') + '\n'
const replay = [...headLines.filter(line => !changedLabels.includes(JSON.parse(line).model.id)), ...overlay.trimEnd().split('\n')].join('\n') + '\n'
if (replay !== baselineReference.toString()) throw new Error('Overlay does not reproduce the exact baseline bytes')
await put('inputs/reference-direct-overlay.jsonl', overlay)

await sourceDirectory('research/studies/sequence-generalization', ['.py', '.ts', '.md'])
await sourceDirectory('research/studies/reference-repair-20260930', ['.py', '.ts', '.md'])
await sourceDirectory('projects/offline', ['.py'])
await sourceDirectory('projects/shared', ['.ts', '.js', '.json', '.md'])
await sourceDirectory('projects/cli', ['.ts', '.tsx'])
for (const name of ['holdout-shared.ts', 'collect-holdout.ts', 'evaluate-holdout.ts']) await copy('research/scripts/' + name)
for (const name of ['bank_builder.py', 'rebuild_unified_bank.py', 'README.md', 'package.json', 'requirements.txt']) await optional('research/' + name)
await put('source/tsconfig.json', JSON.stringify({compilerOptions: {
  moduleResolution: 'Bundler', allowImportingTsExtensions: true, allowJs: true,
  paths: {'@fingerpoint/shared/*': ['./projects/shared/*']},
}}, null, 2) + '\n')

const datasets = [
  {name: 'holdout', path: 'research/evaluation/holdout'},
  {name: 'previous_pair', path: 'research/reports/astra-sol-separation/paired-low-01'},
  {name: 'prospective_v1', path: run + '/prospective'},
]
const datasetEntries = [], rawIndex = []
for (const dataset of datasets) {
  await copy(dataset.path + '/manifest.json')
  await copy(dataset.path + '/samples.jsonl')
  const records = (await readFile(join(sourceRoot, dataset.path, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const manifestBytes = await readFile(join(sourceRoot, dataset.path, 'manifest.json'))
  const sourceManifest = JSON.parse(manifestBytes.toString())
  datasetEntries.push({name: dataset.name, purpose: 'holdout', training_allowed: false,
    original_manifest_purpose: sourceManifest.purpose ?? null, manifest: 'source/' + dataset.path + '/manifest.json',
    manifest_sha256: sha(manifestBytes), samples: 'source/' + dataset.path + '/samples.jsonl',
    attempts: records.length, accepted_records: records.filter(record => record.status === 'accepted').length,
    independent_raw_record_count: records.filter(record => record.raw_response).length})
  for (const record of records) {
    if (!record.raw_response) continue
    const raw = record.raw_response
    let actual: string | null = null
    try { actual = sha(await readFile(join(sourceRoot, raw.path))) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    rawIndex.push({dataset: dataset.name, sample_id: record.sample_id, attempt: record.attempt,
      path: raw.path, sha256: raw.sha256, bytes: raw.bytes, local_sha256: actual,
      local_hash_matches: actual === raw.sha256, raw_bytes_in_bundle: false})
  }
}
await put('inputs/datasets.json', JSON.stringify(datasetEntries, null, 2) + '\n')
await put('inputs/raw-response-hashes.json', JSON.stringify({
  raw_bytes_in_bundle: false,
  scope: 'Independent raw_response entries recorded in included attempt records. Historical matched cohorts did not record separate raw stream files.',
  provider_metadata_recovery: 'Six generation GET metadata bodies, response metadata, proofs, adoption and plan are included under source/research/reports/reference-repair-20260930/generation-provider-recovery. Completion raw streams remain omitted.',
  entries: rawIndex,
}, null, 2) + '\n')

for (const filename of ['candidate-freeze.json', 'REPORT.md', 'REPORT-v1.md', 'data-audit.md',
  'runtime-comparison.json', 'collection-integrity.json', 'evaluation-results.json', 'frozen-fusion-expanded.json', 'frozen-fusion-expanded.md']) await optional(run + '/' + filename)
for (const [folder, names] of Object.entries({
  fusion: ['selection.json', 'report.md', 'reference-oof.npz', 'candidates.npz'],
  classifiers: ['summary.json', 'plan.json', 'folds.json', 'report.md', 'reference-oof.npz'],
  rerank: ['selection.json', 'freeze.json', 'report.md', 'oof.json', 'group-details.json'],
  positional: ['summary.json', 'panel.json', 'protocol.json', 'configs.json', 'results.json', 'confidence.json', 'calibrators.json', 'report.md', 'reference-oof.npz'],
  'positional/ensemble-fusion': ['summary.json', 'frozen-selection.json', 'confidence.json', 'calibrators.json', 'report.md'],
  enriched: ['plan.json', 'results.json', 'report.md', 'interpretation.md', 'previous-plan-with-primary-reference.json', 'previous-results-with-primary-reference.json', 'groups.json', 'transfer-folds.json'],
})) for (const name of names) await optional(run + '/' + folder + '/' + name)
await gzip(run + '/evaluation-data.json', 'frozen/evaluation-data.json.gz', ['source/' + run + '/evaluation-data.json'])
await gzip(run + '/fusion/fitted.joblib', 'frozen/artifacts/fusion.joblib.gz', ['source/' + run + '/fusion/fitted.joblib'])
for (const [origin, archive] of [
  ['rerank/frozen.joblib', 'rerank.joblib.gz'], ['positional/fitted.joblib', 'positional.joblib.gz'],
  ['classifiers/fitted-winner.joblib', 'dense.joblib.gz'],
]) await gzip(run + '/' + origin, 'frozen/artifacts/' + archive, ['source/' + run + '/' + origin])
for (const filename of ['unified_bank.json', 'shared_detector.json']) await gzip(baseline + '/' + filename,
  'frozen/dependencies/' + filename + '.gz', ['source/projects/data/' + filename, 'source/' + baseline + '/' + filename])
for (const filename of ['holdout-manifest.json', 'holdout-samples.jsonl']) await gzip(baseline + '/' + filename,
  'frozen/baseline/' + filename + '.gz', ['source/' + baseline + '/' + filename])
for (const name of ['holdout-before.json', 'holdout-before.md']) await optional(baseline + '/' + name)
for (const name of ['latest.json', 'latest.md']) await optional('research/reports/holdout/' + name)
for (const name of ['training-anomaly-audit.json', 'training-anomaly-audit.md', 'holdout-inventory.json', 'holdout-inventory.md',
  'validation-integrity.json', 'validation-integrity.md', 'original-sources-audit.json', 'original-sources-audit.md', 'target-preparation.json',
  'expanded-fusion-results.json', 'expanded-fusion-results.md'])
  await optional('research/reports/reference-repair-20260930/' + name)
await directoryTree('research/reports/reference-repair-20260930/generation-provider-recovery')
const freezeBytes = await readFile(join(sourceRoot, run, 'candidate-freeze.json'))
const fusionArtifact = await readFile(join(sourceRoot, run, 'fusion/fitted.joblib'))
await put('bundle.json', JSON.stringify({schema: 'sequence-generalization-research-bundle-v1',
  created_at: new Date().toISOString(), status: 'Offline research; no product scoring change',
  reference: {base_commit: baseCommit, base_path: 'data/unified_reference.jsonl', base_sha256: sha(committed),
    overlay: 'inputs/reference-direct-overlay.jsonl', overlay_sha256: sha(overlay), replacement_labels: changedLabels,
    reference_sha256: sha(baselineReference), source: baseline + '/unified_reference.jsonl',
    samples: 1948, labels: 53, targets: ['source/projects/data/unified_reference.jsonl', 'source/' + baseline + '/unified_reference.jsonl']},
  winner: {id: 'generic_fusion', selection: 'First reference-only frozen fusion, before expanded holdout; no holdout retuning',
    artifact: 'source/' + run + '/fusion/fitted.joblib', artifact_sha256: sha(fusionArtifact),
    original_candidate_freeze_sha256: sha(freezeBytes), inactive_dense_component_retained_for_original_loader_hash_check: true},
  files: fileEntries, compressed, datasets: datasetEntries,
  omissions: ['Independent raw response bytes; preserved at original local evidence paths and indexed by recorded hashes',
    'Nonwinning positional_ensemble model weights; its reports and original freeze are included',
    'Large candidate-grid arrays and nested fitting caches outside the selected fusion OOF evidence',
    'Full six original-channel collection directories and old Codex archive; remain unchanged locally'],
  raw_bytes_in_bundle: false, provider_generation_metadata_in_bundle: true,
  api_requests_during_packaging: 0, product_files_modified: false,
}, null, 2) + '\n')
console.log(JSON.stringify({bundle, copied_files: fileEntries.length, compressed_files: compressed.length,
  compressed_bytes: compressed.reduce((sum, entry) => sum + entry.compressed_bytes, 0),
  attempts: datasetEntries.map(dataset => ({name: dataset.name, attempts: dataset.attempts})),
  reference_sha256: sha(baselineReference)}))
