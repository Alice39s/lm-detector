/** Recreate exact reference-only inputs and frozen model bytes inside this bundle. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = import.meta.dir
const metadata = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'))
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function put(path: string, bytes: string | Uint8Array) {
  if (!path.startsWith('source/')) throw new Error('Hydration target must stay inside source/')
  const target = join(root, path)
  await mkdir(join(target, '..'), {recursive: true})
  await writeFile(target, bytes)
}
let committed: string
const baseFlag = process.argv.indexOf('--base-reference')
if (baseFlag !== -1) committed = await readFile(resolve(process.argv[baseFlag + 1]), 'utf8')
else {
  const git = Bun.spawn(['git', 'show', `${metadata.reference.base_commit}:${metadata.reference.base_path}`],
    {cwd: resolve(root, '../..'), stdout: 'pipe', stderr: 'pipe'})
  committed = await new Response(git.stdout).text()
  if (await git.exited) throw new Error('Pinned Git reference unavailable; pass --base-reference FILE with the committed reference bytes')
}
if (sha(committed) !== metadata.reference.base_sha256) throw new Error('Committed reference hash mismatch')
const overlayBytes = await readFile(join(root, metadata.reference.overlay))
if (sha(overlayBytes) !== metadata.reference.overlay_sha256) throw new Error('Overlay hash mismatch')
const overlay = overlayBytes.toString().trimEnd().split('\n')
const replacement = new Set(overlay.map(line => JSON.parse(line).model.id))
const reference = [...committed.trimEnd().split('\n').filter(line => !replacement.has(JSON.parse(line).model.id)), ...overlay].join('\n') + '\n'
if (sha(reference) !== metadata.reference.reference_sha256) throw new Error('Reconstructed reference hash mismatch')
for (const target of metadata.reference.targets) await put(target, reference)
for (const entry of metadata.compressed) {
  const packed = await readFile(join(root, entry.path))
  if (sha(packed) !== entry.compressed_sha256) throw new Error(`Compressed input hash mismatch: ${entry.path}`)
  const bytes = Bun.gunzipSync(packed)
  if (sha(bytes) !== entry.sha256) throw new Error(`Hydrated input hash mismatch: ${entry.path}`)
  for (const target of entry.targets) await put(target, bytes)
}
for (const entry of metadata.files) if (sha(await readFile(join(root, entry.path))) !== entry.sha256)
  throw new Error(`Frozen source/input changed: ${entry.path}`)
const fixed = JSON.parse(await readFile(join(root, 'source/research/evaluation/holdout/manifest.json'), 'utf8'))
if (fixed.purpose !== 'holdout' || metadata.datasets.some((dataset: any) => dataset.training_allowed !== false))
  throw new Error('Evaluation data must remain holdout-only')
console.log(JSON.stringify({reference_sha256: sha(reference), hydrated: metadata.compressed.length,
  samples: metadata.reference.samples, labels: metadata.reference.labels, training_input: 'Formal reference only',
  evaluation_inputs: 'holdout-only; never included in model or calibration fitting'}))
