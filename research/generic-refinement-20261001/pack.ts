/** Preserve this research revision as bytes; inference needs no outer workspace. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const bundle = import.meta.dir
const flag = process.argv.indexOf('--source-root')
const root = flag >= 0 ? resolve(process.argv[flag + 1]) : resolve(bundle, '../../..')
const first = join(bundle, '../sequence-generalization-20260930')
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const files: any[] = [], compressed: any[] = []
const omitted: any[] = []
const put = async (path: string, bytes: Uint8Array) => {
  await mkdir(dirname(join(bundle, path)), {recursive: true})
  await writeFile(join(bundle, path), bytes)
}
async function preserve(source: string) {
  const bytes = await readFile(join(root, source))
  const target = 'source/' + source
  if (source.endsWith('.joblib') || bytes.length > 2_000_000) {
    const path = 'frozen/' + source + '.gz'
    const packed = Bun.gzipSync(bytes)
    await put(path, packed)
    compressed.push({path, targets: [target], sha256: sha(bytes), compressed_sha256: sha(packed),
      bytes: bytes.length, compressed_bytes: packed.length, original_source: source})
  } else {
    await put(target, bytes)
    files.push({path: target, sha256: sha(bytes), bytes: bytes.length, original_source: source})
  }
}
async function tree(folder: string) {
  for (const entry of await readdir(join(root, folder), {withFileTypes: true})) {
    const source = folder + '/' + entry.name
    if (entry.isDirectory()) {
      if (['__pycache__', 'raw-traces', 'supplemental-raw-traces'].includes(entry.name)) {
        omitted.push({source, reason: entry.name.endsWith('raw-traces') ? 'Raw completion streams remain in the original workspace.' : 'Interpreter cache.'})
      } else await tree(source)
    } else if (entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.tmp')) await preserve(source)
  }
}
await tree('research/studies/generic-refinement-20261001')
await tree('research/reports/generic-refinement-20261001')
const config = await readFile(join(first, 'source/tsconfig.json'))
await put('source/tsconfig.json', config)
files.push({path: 'source/tsconfig.json', sha256: sha(config), bytes: config.length, original_source: 'first bundle'})
const firstBytes = await readFile(join(first, 'bundle.json'))
const metadata = {schema: 'generic-refinement-research-bundle-v1', created_at: new Date().toISOString(),
  first_bundle: '../sequence-generalization-20260930', first_bundle_sha256: sha(firstBytes),
  reference_sha256: '5a86bb2409f7e132f4bb98456d54996014782fa531c6e670ce46f16d213b11d4',
  reference_labels: 53, formal_reference_answers: 1948, derived_development_answers: 240,
  scope: 'Research snapshot; no product scoring or data changed.',
  files, compressed, omitted, source_root_basename: relative(root, root) || '.',
  dependencies: 'The immutable first bundle supplies original code, reference, baseline and seen regression data.',
  raw_network_evidence: 'All JSONL attempts are preserved; completion raw-stream bytes are local only. Omission is explicit.'}
await writeFile(join(bundle, 'bundle.json'), JSON.stringify(metadata, null, 2) + '\n')
const ignorePath = join(bundle, '.gitignore')
const ignored = new Set((await readFile(ignorePath, 'utf8')).split('\n').filter(Boolean))
for (const entry of compressed) for (const target of entry.targets) ignored.add(target)
await writeFile(ignorePath, [...ignored].join('\n') + '\n')
console.log(JSON.stringify({files: files.length, compressed: compressed.length,
  stored_bytes: files.reduce((sum, file) => sum + file.bytes, 0) + compressed.reduce((sum, file) => sum + file.compressed_bytes, 0)}))
