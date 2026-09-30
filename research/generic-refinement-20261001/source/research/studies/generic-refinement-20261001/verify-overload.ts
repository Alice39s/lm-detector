/** Verify merged original/continuation evidence offline; never classify answers. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, STUDY, sha, equal, inside, localPath, protocolPath, optionalRead,
  loadOriginal, loadPlan, auditSupplemental } from './retry-overload'

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return process.argv[index + 1]
}
const protocolBytes = await readFile(protocolPath), protocol = JSON.parse(protocolBytes.toString())
const directory = inside(argument('--directory', process.env.OUTPUT_DIR ?? protocol.original_directory_default))
const freezePath = inside(argument('--freeze', process.env.CANDIDATE_FREEZE_FILE ?? protocol.candidate_freeze_default))
const outputPath = join(directory, 'combined-integrity.json'), adoptionPath = join(directory, 'adoption.json')
const errors: string[] = [], report: any = { schema: 'generic-refinement-combined-prospective-integrity-v1',
  status: 'incomplete', errors, checked_at: new Date().toISOString(), accepted_slots: 0, complete_groups: 0,
  classifier_loaded: false, scoring_performed: false, model_api_calls: 0,
  verifier_sha256: sha(await readFile(import.meta.path)), continuation_collector_sha256: sha(await readFile(join(STUDY, 'retry-overload.ts'))),
  continuation_protocol_sha256: sha(protocolBytes), paths: { original_directory: localPath(directory), freeze: localPath(freezePath),
    supplemental_manifest: localPath(join(directory, 'supplemental-manifest.json')), supplemental_samples: localPath(join(directory, 'supplemental-samples.jsonl')),
    adoption: localPath(adoptionPath), combined_integrity: localPath(outputPath) }, bindings: {} }
try {
  const original = await loadOriginal(directory, freezePath, 'overload-verification-original-integrity.json')
  const planData = await loadPlan(directory, original), supplemental = await auditSupplemental(directory, original, planData)
  report.errors.push(...supplemental.errors)
  Object.assign(report, { candidate_freeze_sha256: original.freeze_sha256,
    original_manifest_sha256: original.manifest_sha256, original_samples_sha256: original.samples_sha256,
    supplemental_manifest_sha256: sha(planData.bytes), supplemental_samples_sha256: supplemental.bytes ? sha(supplemental.bytes) : null,
    original_integrity: { status: original.audit.status, path: localPath(original.auditPath), sha256: sha(original.auditBytes),
      errors: original.audit.errors, incomplete_reasons: original.audit.incomplete_reasons ?? [], accepted_slots: original.audit.accepted_slots },
    original_parsed_credential_audit: original.credentialAudit,
    supplemental_parsed_credential_audit: { encrypted_content_exceptions: supplemental.ciphertextExceptions },
    original_attempts_preserved: true, original_attempts: original.records.length, supplemental_attempts: supplemental.records.length,
    raw_replayed_supplemental_attempts: supplemental.replayed, accepted_slots: supplemental.selected.size,
    incomplete_reasons: supplemental.incomplete, notes: supplemental.notes,
    missing_slots: supplemental.missing.map((job: any) => job.sample_id),
    operational_amendment: 'Only retry budget 2→5, serial scheduling and fixed backoff changed. Original candidate, requests, challenge grid and eligibility remain frozen; no model refit or classification-based selection.' })
  const groupCounts = new Map<string, number>(), common = new Map<string, Map<string, string>>()
  for (const job of original.jobs) {
    const entry = supplemental.selected.get(job.sample_id)
    if (!entry) continue
    const record = entry.record, groupId = `${record.model}:${record.round_id}`, challengeId = `${record.round_id}:${record.challenge_id}`
    groupCounts.set(groupId, (groupCounts.get(groupId) ?? 0) + 1)
    const models = common.get(challengeId) ?? new Map<string, string>()
    if (models.has(record.model)) errors.push('Merged adoption repeats a model/challenge slot.')
    models.set(record.model, record.prompt); common.set(challengeId, models)
  }
  report.complete_groups = [...groupCounts.values()].filter(count => count === 3).length
  for (const models of common.values()) if (models.size === 2 && new Set(models.values()).size !== 1) errors.push('Merged model answers did not use the same frozen common challenge.')
  const bindings: Record<string, string> = { ...supplemental.bindings,
    [localPath(original.auditPath)]: sha(original.auditBytes),
    [planData.manifest.plan.original_preparation_audit.path]: planData.manifest.plan.original_preparation_audit.sha256 }
  // Bind the later blind-only evaluator and its actual fixed metrics helper too.
  for (const path of ['research/studies/generic-refinement-20261001/evaluate-blind.py',
    'projects/research/sequence-generalization-20260930/source/research/studies/sequence-generalization/evaluate.py']) {
    const bytes = await optionalRead(inside(path))
    if (!bytes) errors.push(`Blind evaluation dependency is missing: ${path}`)
    else bindings[path] = sha(bytes)
  }
  if (!errors.length && !supplemental.incomplete.length && supplemental.selected.size === 120 && report.complete_groups === 40 && common.size === 60 && [...common.values()].every(models => models.size === 2)) {
    const adoption = original.jobs.map((job: any) => {
      const entry = supplemental.selected.get(job.sample_id), record = entry.record
      return { sample_id: record.sample_id, attempt: record.attempt, record_source: entry.record_source,
        model: record.model, round_id: record.round_id, challenge_id: record.challenge_id,
        text_sha256: record.text_sha256, sequence_sha256: record.sequence_sha256 }
    })
    const adoptionBytes = JSON.stringify(adoption, null, 2) + '\n'
    await writeFile(adoptionPath, adoptionBytes, { mode: 0o600 })
    bindings[localPath(adoptionPath)] = sha(adoptionBytes); report.adoption_sha256 = sha(adoptionBytes)
    report.status = 'complete'
  } else if (!errors.length) report.status = 'incomplete'
  // Recheck every binding after raw replay and adoption writes, before handing off.
  for (const [path, digest] of Object.entries(bindings)) if (sha(await readFile(inside(path))) !== digest) errors.push(`Input changed during combined verification: ${path}`)
  report.bindings = bindings
  report.current_source_hashes_match = errors.length === 0
  if (!equal(original.manifest.models, ['gpt-6-astra', 'gpt-6.1-sol'])) errors.push('Original model gallery for blind collection changed.')
} catch (error) {
  errors.push(error instanceof Error ? error.message.replace(/sk[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]') : 'Combined evidence verification failed.')
}
if (errors.length) { report.status = 'invalid'; report.current_source_hashes_match = false }
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ status: report.status, errors: errors.length, accepted_slots: report.accepted_slots, complete_groups: report.complete_groups,
  output: localPath(outputPath), classifier_loaded: false, model_api_calls: 0 }))
if (report.status !== 'complete') process.exitCode = 1
