import { readFile, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apiFormat, parseReference } from '../../../projects/shared/reference'
import { json, save, root, manifestPath, hash } from '../../scripts/holdout-shared'

const reportDir = join(root, 'research/reports/reference-repair-20260930')
const cataloguePath = process.env.HOLDOUT_CATALOGUE ?? '/tmp/lmfpd-repair-20260930/catalog.json'
const catalogue = (await json(cataloguePath)).data
const manifest = await json(manifestPath)
const referenceBytes = await readFile(join(root, 'projects/data/unified_reference.jsonl'), 'utf8')
const references = parseReference(referenceBytes)
const bank = await json(join(root, 'projects/data/unified_bank.json'))
const referenceLabel = (label: string) => ({'claude-haiku-4-5-20251001': 'claude-haiku-4.5', 'claude-sonnet-4-6': 'claude-sonnet-4.6', 'claude-opus-4-6': 'claude-opus-4.6', 'claude-opus-4-7': 'claude-opus-4.7', 'claude-opus-4-8': 'claude-opus-4.8'} as Record<string, string>)[label] ?? label
const existing = new Set(manifest.models.map((m: any) => referenceLabel(m.label)))
const evidence = []
await mkdir(join(reportDir, 'catalogue'), {recursive: true})
await copyFile(cataloguePath, join(reportDir, 'catalogue/models.json'))
for (const model of bank.models) {
  if (existing.has(model.id)) continue
  const batches = references.filter(b => b.model.id === model.id)
  const batch = [...batches].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')).at(-1)!
  const requestModel = batch.request.model!
  const apiModel = batch.source.channel === 'openai/direct' ? 'openai/' + requestModel : requestModel
  const found = catalogue.find((c: any) => c.id === apiModel)
  if (!found) { evidence.push({label: model.id, status: 'requires-original-channel', source: batch.source, request: batch.request}); continue }
  let provider = batch.source.channel.startsWith('openrouter/') ? batch.source.channel.slice('openrouter/'.length) : 'openai'
  let providerBasis = 'Reference batch channel; precision route retained.'
  if (provider === 'unknown') {
    const snapshotPath = '/tmp/lmfpd-repair-20260930/' + model.id + '-endpoints.json'
    const snapshot = await json(snapshotPath)
    const endpoints = snapshot.data.endpoints
    if (endpoints.length !== 1 || !endpoints[0].tag) throw new Error(`Cannot select one evidenced provider: ${model.id}`)
    provider = endpoints[0].tag
    providerBasis = 'Current endpoint snapshot has one provider; historical provider remains unresolved.'
    await copyFile(snapshotPath, join(reportDir, 'catalogue/' + model.id + '-endpoints.json'))
  }
  const effort = batch.request.reasoning_effort
  const target = {label: model.id, api_model: apiModel, canonical_slug: found.canonical_slug, family: model.family,
    format: apiFormat(batch.request.format!), provider_override: {only: [provider], allow_fallbacks: false},
    ...(!effort || effort === 'default' ? {} : {reasoning_override: effort === 'none' ? {enabled: false} : {effort}})}
  manifest.models.push(target)
  evidence.push({label: model.id, status: 'prepared', target, reference_batch: batch.id, reference_source: batch.source,
    reference_request: batch.request, effort_choice: 'Latest reference batch by created_at; no effort change.', provider_basis: providerBasis,
    channel_change: batch.source.channel === 'openai/direct' ? 'OpenAI direct reference; fixed holdout via OpenRouter/OpenAI.' : null})
}
await save(manifestPath, manifest)
await save(join(reportDir, 'target-preparation.json'), {created_at: new Date().toISOString(), reference_sha256: hash(referenceBytes), catalogue_sha256: hash(await readFile(cataloguePath)), fixed_groups_sha256: hash(JSON.stringify(manifest.groups)), evidence})
console.log(JSON.stringify({prepared: evidence.filter(e => e.status === 'prepared').map(e => e.label), original_channels: evidence.filter(e => e.status !== 'prepared').map(e => e.label), manifest_models: manifest.models.length}))
