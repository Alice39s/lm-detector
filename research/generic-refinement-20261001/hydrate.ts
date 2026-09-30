/** Verify frozen bytes and prepare local links to the unchanged first bundle. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const root = import.meta.dir
const source = join(root, 'source')
const first = resolve(root, '../sequence-generalization-20260930')
const metadata = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'))
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function bundlePath(path: string): string {
  if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..'))
    throw new Error(`Invalid bundle path: ${path}`)
  const target = resolve(root, path)
  if (!target.startsWith(root + sep)) throw new Error(`Path escapes bundle: ${path}`)
  return target
}

async function prepareParent(target: string) {
  let ancestor = dirname(target)
  while (true) {
    try {
      const actual = await realpath(ancestor)
      if (actual !== root && actual !== source && !actual.startsWith(source + sep))
        throw new Error(`Refusing to create a path through an external symlink: ${target}`)
      break
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error
      ancestor = dirname(ancestor)
    }
  }
  await mkdir(dirname(target), {recursive: true})
}

if (!/^[a-f0-9]{64}$/.test(metadata.first_bundle_sha256)
    || sha(await readFile(join(first, 'bundle.json'))) !== metadata.first_bundle_sha256)
  throw new Error('Adjacent first bundle does not match its frozen dependency hash')
const baseFlag = process.argv.indexOf('--base-reference')
const forwarded = baseFlag === -1 ? [] : ['--base-reference', resolve(process.argv[baseFlag + 1])]
const hydration = Bun.spawn([process.execPath, join(first, 'hydrate.ts'), ...forwarded],
  {cwd: first, stdout: 'inherit', stderr: 'inherit'})
if (await hydration.exited) throw new Error('First bundle verification/hydration failed')

const links: [string, string][] = [
  ['source/projects/research/sequence-generalization-20260930', first],
  ...['data', 'offline', 'cli', 'shared'].map(name =>
    [`source/projects/${name}`, join(first, 'source/projects', name)] as [string, string]),
  ['source/research/studies/sequence-generalization', join(first, 'source/research/studies/sequence-generalization')],
  ['source/research/reports/sequence-generalization/20260930', join(first, 'source/research/reports/sequence-generalization/20260930')],
]
for (const [path, dependency] of links) {
  const destination = bundlePath(path)
  await prepareParent(destination)
  let existing
  try { existing = await lstat(destination) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace existing non-symlink: ${path}`)
    if (await realpath(destination) !== await realpath(dependency))
      throw new Error(`Existing dependency link points elsewhere: ${path}`)
  } else {
    // Directory links remain relative when the two adjacent bundles are moved.
    await symlink(relative(dirname(destination), dependency), destination,
      'dir')
  }
}

async function put(path: string, bytes: Uint8Array) {
  if (!path.startsWith('source/')) throw new Error(`Hydration target must remain in source/: ${path}`)
  const target = bundlePath(path)
  await prepareParent(target)
  const parent = await realpath(dirname(target))
  if (parent !== source && !parent.startsWith(source + sep))
    throw new Error(`Refusing to write through a dependency symlink: ${path}`)
  let existing
  try { existing = await lstat(target) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace a hydration-target symlink: ${path}`)
  await writeFile(target, bytes)
}

for (const entry of metadata.files) {
  if (sha(await readFile(bundlePath(entry.path))) !== entry.sha256)
    throw new Error(`Frozen source/report changed: ${entry.path}`)
}
for (const entry of metadata.compressed) {
  const packed = await readFile(bundlePath(entry.path))
  if (sha(packed) !== entry.compressed_sha256) throw new Error(`Compressed artifact changed: ${entry.path}`)
  const bytes = Bun.gunzipSync(packed)
  if (sha(bytes) !== entry.sha256) throw new Error(`Hydrated artifact hash mismatch: ${entry.path}`)
  for (const target of entry.targets) await put(target, bytes)
}
console.log(JSON.stringify({first_bundle_sha256: metadata.first_bundle_sha256,
  verified_files: metadata.files.length, hydrated: metadata.compressed.length,
  dependency_links: links.length, training_performed: false, api_requests: 0}))
