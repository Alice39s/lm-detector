import { createHash } from 'node:crypto'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Challenge } from '../../projects/shared/types'
import type { Format } from '../../projects/shared/completion'
export const root = fileURLToPath(new URL('../../', import.meta.url))
export const directory = join(root, 'research/evaluation/holdout')
export const manifestPath = join(directory, 'manifest.json')
export const samplesPath = join(directory, 'samples.jsonl')
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
export async function jsonl(path: string): Promise<any[]> {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error }
}
export async function save(path: string, value: unknown) {
  await mkdir(join(path, '..'), {recursive: true})
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n')
  await rename(path + '.tmp', path)
}
export type Target = {
  label: string; api_model: string; canonical_slug: string | null; format: Format; family: string;
  provider_override?: {order?: string[]; only?: string[]; allow_fallbacks: boolean};
  reasoning_override?: {enabled?: boolean; effort?: string};
  endpoint?: string; source_kind?: 'original-channel'; source_channel?: string; trust_basis?: string;
}
export type Manifest = {
  purpose: 'holdout'; id: string; created_at: string; endpoint: string;
  groups: {id: string; challenges: Challenge[]}[]; models: Target[];
  profile: {effort: string; stream: boolean; parallel: boolean; output_limit: number; timeout_ms: number};
  source_hashes: Record<string, string>;
  prompt_revisions?: {sample_id: string; from_attempt: number; prompt: string; changed_at: string; reason: string}[];
  reasoning_revisions?: {sample_id: string; from_attempt: number; reasoning: {effort: string}; changed_at: string; reason: string}[];
  resample_from_attempt?: Record<string, number>;
  resample_source_hashes?: Record<string, string>;
}
export const sampleId = (manifest: Manifest, target: Pick<Target, 'label'>, group: Manifest['groups'][number], c: Challenge) =>
  `${manifest.id}:${target.label}:${group.id}:${c.id}`
export async function sourceHashes() {
  const files = ['projects/shared/challenge-browser.js', 'projects/shared/completion-request.ts', 'projects/shared/completion.ts']
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
}

export function samplePrompt(manifest: Manifest, id: string, attempt: number, original: string) {
  return (manifest.prompt_revisions || []).filter(r => r.sample_id === id && r.from_attempt <= attempt).sort((a, b) => b.from_attempt - a.from_attempt)[0]?.prompt || original
}
