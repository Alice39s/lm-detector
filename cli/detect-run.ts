import { readFile } from 'node:fs/promises'
import { generateChallenges } from '@fingerpoint/shared/challenge-browser.js'
import { directTransport } from '@fingerpoint/shared/detection'
import { parseNumbers } from '@fingerpoint/shared/fingerprint-core.js'
import { analyzeSharedOutputs, type SharedDetector } from '@fingerpoint/shared/shared-detector'
import type { TokenizerBank } from '@fingerpoint/shared/tokenizer-bank'
import { fuseTokenizerEvidence } from '@fingerpoint/shared/tokenizer-fusion'
import { tokenizerPosterior, tokenizerVerdict, type TokenizerObservation } from '@fingerpoint/shared/tokenizer-posterior'
import { probeTokenizer, tokenizerReport, type TokenizerRun } from '@fingerpoint/shared/tokenizer-probe'
import type { Analysis, Bank, Challenge, Output } from '@fingerpoint/shared/types'
import { requestEndpoint, type DetectOptions } from './detect-options'
import { acceptedSample, minimumNumbers, requestSample, type Sample } from './detect-request'

export interface Round {
  index: number
  challenges: Challenge[]
  samples: Sample[]
  outputs: Output[]
  startedAt: number
  finishedAt?: number
  analysis?: Analysis
  error?: string
}
export interface DetectionState {
  rounds: Round[]
  total: number
  startedAt: number
  finishedAt?: number
  cancelled: boolean
  /** The tokenizer probe shared by every round; absent with --no-tokenizer or a saved file without probe data. */
  tokenizer?: TokenizerRun
  /** False while the probe is still running. */
  tokenizerSettled?: boolean
  /** The claimed model the verdict was checked against. */
  tokenizerModel?: string
}

export async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch {
    throw new Error(`Cannot read valid JSON from ${path}.`)
  }
}

export async function loadChallenges(path?: string, count = 3): Promise<Challenge[] | undefined> {
  if (!path) return undefined
  const data = await readJson(path)
  if (!Array.isArray(data) || data.length !== count || !data.every(item => item &&
    typeof item.id === 'string' && typeof item.prompt === 'string' && item.prompt.trim() &&
    Number.isSafeInteger(item.expected_count) && item.expected_count > 0)) {
    throw new Error(`The challenge file must contain ${count} challenge object${count === 1 ? '' : 's'} matching --count, each with id, prompt, and a positive integer expected_count.`)
  }
  return data as Challenge[]
}

function englishAnalysis(analysis: Analysis): Analysis {
  let label: string, reason: string
  if (analysis.decision === 'unscorable') {
    label = 'Not enough valid samples'
    reason = `Received ${analysis.used_outputs}/3 valid samples. Three valid samples are required.`
  } else if (analysis.decision === 'partial') {
    label = 'Partial sample ranking'
    reason = `Ranked ${analysis.used_outputs} valid sample${analysis.used_outputs === 1 ? '' : 's'}. Confidence requires three valid samples.`
  } else if (analysis.method === 'custom-bank-legacy-ranking') {
    label = 'Custom bank ranking'
    reason = 'The verifier does not match this bank. Confidence is unavailable.'
  } else {
    // A fused analysis keeps the ranker's own leader for this comparison.
    const fused = analysis.tokenizer?.fused
    const agrees = analysis.verification_top === (analysis.tokenizer?.fingerprint_top ?? analysis.prediction)
    const order = fused ? 'Candidate order follows the confidence with the tokenizer result included.' : 'Candidate order follows the ranker.'
    label = agrees ? 'Ranker and verifier agree' : 'Ranker and verifier disagree'
    reason = agrees ? `Both methods selected the same leading candidate.${fused ? ` ${order}` : ''}`
      : `The verifier preferred ${analysis.results.find(row => row.model === analysis.verification_top)?.display_name ?? analysis.verification_top}. ${order}`
  }
  return {
    ...analysis, prediction_name: analysis.decision === 'unscorable' ? 'Not scored' : analysis.prediction_name,
    evidence: { ...analysis.evidence, label, reason },
  }
}

interface Probe { bank: TokenizerBank; run: TokenizerRun }

function scoreRound(round: Round, options: DetectOptions, bank: Bank, detector: SharedDetector, probe?: Probe) {
  round.outputs = round.samples.map(sample => ({
    text: acceptedSample(sample) ? sample.text : '', expected_count: sample.expectedCount,
  }))
  const accepted = round.samples.filter(acceptedSample).length
  if (!accepted || (options.strict && accepted !== 3)) {
    round.error = options.strict ? `Strict mode requires 3/3 successful samples; received ${accepted}/3.`
      : 'No valid samples. This round cannot be scored.'
    return
  }
  try {
    const analysis = analyzeSharedOutputs(round.outputs, bank, detector, { allowPartial: !options.strict })
    round.analysis = englishAnalysis(probe?.run.posterior ? fuseTokenizerEvidence(analysis, probe.bank, probe.run.posterior, probe.run.verdict) : analysis)
    if (!round.analysis.results.length) round.error = round.analysis.evidence.reason
  } catch {
    round.error = 'Scoring failed. Check that the reference bank and detector files are valid.'
  }
}

export async function runDetection(
  options: DetectOptions, bank: Bank, detector: SharedDetector,
  onUpdate: (state: DetectionState) => void, signal: AbortSignal, fixedChallenges?: Challenge[], tokenizerBank?: TokenizerBank,
): Promise<DetectionState> {
  const state: DetectionState = { rounds: [], total: options.repeat, startedAt: Date.now(), cancelled: false }
  const report = () => onUpdate({ ...state, rounds: state.rounds.map(round => ({ ...round, samples: [...round.samples] })) })
  // One probe measures the upstream for every round. It runs beside the first round, with four probes in flight
  // when samples run in parallel and one otherwise.
  const probing = tokenizerBank && probeTokenizer(options.config, tokenizerBank, {
    url: requestEndpoint(options.config), transport: directTransport, signal, maximumProbes: options.maxProbes,
    concurrency: options.parallel > 1 ? 4 : 1,
    onUpdate: run => { state.tokenizer = run; report() },
  }).then(run => {
    state.tokenizer = run
    state.tokenizerSettled = true
    report()
    return { bank: tokenizerBank, run }
  })
  if (probing) {
    state.tokenizerSettled = false
    state.tokenizerModel = options.config.model
  }
  report()
  for (let index = 0; index < options.repeat; index++) {
    if (signal.aborted) break
    const challenges: Challenge[] = fixedChallenges ?? generateChallenges(options.count)
    const round: Round = {
      index: index + 1, challenges, outputs: [], startedAt: Date.now(),
      samples: challenges.map(challenge => ({
        state: 'queued', text: '', rawText: '', count: 0, expectedCount: challenge.expected_count,
      })),
    }
    state.rounds.push(round)
    report()
    let next = 0
    const worker = async () => {
      while (!signal.aborted && next < challenges.length) {
        const sampleIndex = next++
        round.samples[sampleIndex] = await requestSample(options, challenges[sampleIndex], signal, sample => {
          round.samples[sampleIndex] = sample
          report()
        })
      }
    }
    // The barrier includes failed requests and cancelled streams before any next round.
    await Promise.all(Array.from({ length: options.parallel }, worker))
    if (signal.aborted) {
      for (const sample of round.samples) {
        if (sample.state === 'queued') { sample.state = 'cancelled'; sample.error = 'Cancelled before dispatch.' }
      }
      round.outputs = round.samples.map(sample => ({ text: acceptedSample(sample) ? sample.text : '', expected_count: sample.expectedCount }))
      round.error = 'Cancelled. This round was not scored.'
    } else scoreRound(round, options, bank, detector, probing ? await probing : undefined)
    round.finishedAt = Date.now()
    report()
  }
  // A cancelled run still waits for the aborted probe, so its partial requests are saved with the rounds.
  if (probing) await probing
  state.cancelled = signal.aborted
  state.finishedAt = Date.now()
  report()
  return state
}

/** Recomputes a saved probe against the current bank. `-m` or `MODEL` overrides the saved model for the claim check. */
function savedProbe(source: Record<string, unknown> | undefined, tokenizerBank: TokenizerBank, model: string): Probe & { model: string } | undefined {
  const saved = source?.tokenizer as { observations?: TokenizerObservation[]; model?: unknown } | undefined
  if (!saved) return undefined
  const observations = saved.observations
  if (!Array.isArray(observations) || !observations.every(item =>
    item && (item.probe === null || typeof item.probe === 'string') && Number.isSafeInteger(item.tokens))) {
    throw new Error('The saved tokenizer probe must have an observations array.')
  }
  const posterior = tokenizerPosterior(tokenizerBank, observations)
  const baselines = observations.filter(item => item.probe === null).map(item => item.tokens)
  const request = source?.request as { model?: unknown } | undefined
  const claimed = model || (typeof saved.model === 'string' ? saved.model : typeof request?.model === 'string' ? request.model : '')
  return {
    bank: tokenizerBank, model: claimed,
    run: {
      steps: observations.map(item => ({ probe: item.probe, state: 'done', tokens: item.tokens, responseModel: item.responseModel })),
      observations, posterior, baselineDrift: new Set(baselines).size > 1,
      // Like a live run, a verdict needs at least one answered probe.
      verdict: posterior && posterior.answered > 0 ? tokenizerVerdict(tokenizerBank, posterior, claimed) : null,
    },
  }
}

export async function analyzeInput(options: DetectOptions, bank: Bank, detector: SharedDetector, tokenizerBank?: TokenizerBank): Promise<DetectionState> {
  const data = await readJson(options.input!)
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined
  const probe = tokenizerBank ? savedProbe(source, tokenizerBank, options.config.model) : undefined
  let entries = Array.isArray(source?.rounds) ? source.rounds : [data]
  if (source?.schema_version === 1 && source.purpose === 'reference' && Array.isArray(source.samples)) {
    const groups = new Map<string, typeof source.samples>()
    for (const sample of source.samples) {
      if (!sample || typeof sample.condition !== 'string' || !['complete', 'truncated', 'unknown'].includes(sample.completion)) {
        throw new Error('Collection samples must record their condition and completion status.')
      }
      const group = groups.get(sample.condition) ?? []
      group.push(sample)
      groups.set(sample.condition, group)
    }
    entries = []
    for (const group of groups.values()) {
      for (let index = 0; index < group.length; index += 3) {
        const samples = group.slice(index, index + 3)
        entries.push({ outputs: samples, samples })
      }
    }
  }
  if (!entries.length) throw new Error('The input file contains no rounds.')
  const state: DetectionState = {
    rounds: [], total: entries.length, startedAt: Date.now(), cancelled: false,
    tokenizer: probe?.run, tokenizerSettled: probe ? true : undefined, tokenizerModel: probe?.model,
  }
  for (const entry of entries) {
    const outputs = Array.isArray(entry) ? entry : entry?.outputs
    if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 3 || !outputs.every(item => item &&
      typeof item.text === 'string' && Number.isSafeInteger(item.expected_count) && item.expected_count > 0)) {
      throw new Error('Each input round must contain one to three outputs with text and a positive integer expected_count.')
    }
    const round: Round = {
      index: state.rounds.length + 1, challenges: [], outputs: [], startedAt: Date.now(),
      samples: outputs.map((output: Output, index: number) => {
        const numbers = parseNumbers(output.text) as number[]
        const savedSample = Array.isArray(entry?.samples) ? entry.samples[index] : undefined
        const wasTruncated = savedSample?.state === 'truncated' || savedSample?.completion === 'truncated'
        const strictRejection = options.strict && (wasTruncated || (savedSample?.completion !== undefined && savedSample.completion !== 'complete'))
        const truncated = !options.strict && numbers.length > output.expected_count
        return {
          state: strictRejection || numbers.length < minimumNumbers(output.expected_count) ? 'failed'
            : truncated || wasTruncated ? 'truncated' : 'complete',
          text: truncated ? numbers.slice(0, output.expected_count).join(', ') : output.text,
          rawText: typeof savedSample?.rawText === 'string' ? savedSample.rawText : output.text,
          count: truncated ? output.expected_count : numbers.length, expectedCount: output.expected_count,
          error: strictRejection ? 'This saved sample has no confirmed complete response. Strict mode requires completion evidence.'
            : numbers.length < minimumNumbers(output.expected_count) ? 'Too few valid numbers.' : undefined,
        }
      }),
    }
    scoreRound(round, options, bank, detector, probe)
    round.finishedAt = Date.now()
    state.rounds.push(round)
  }
  state.finishedAt = Date.now()
  return state
}

export function serializeResult(state: DetectionState, options: DetectOptions, bank: Bank, tokenizerBank?: TokenizerBank) {
  const { apiKey, ...config } = options.config
  const only = state.rounds.length === 1 ? state.rounds[0] : undefined
  const result = {
    schema: 'fpd-detection-v1', created_at: new Date(state.startedAt).toISOString(),
    request: options.input ? undefined : { ...config, api: options.api, count: options.count, parallel: options.parallel, repeat: options.repeat,
      strict: options.strict, timeout_seconds: options.timeoutMs / 1000, tokenizer: options.tokenizer,
      max_probes: options.tokenizer ? options.maxProbes : undefined },
    bank: { reference_sha256: bank.reference_sha256, models: bank.models.length },
    cancelled: state.cancelled, requested_rounds: state.total,
    completed_rounds: state.rounds.filter(round => round.finishedAt).length,
    scored_rounds: state.rounds.filter(round => round.analysis?.results.length).length,
    // `observations` alone lets --input recompute the probe against a newer tokenizer bank.
    tokenizer: state.tokenizer && tokenizerBank ? tokenizerReport(state.tokenizer, tokenizerBank, { createdAt: state.startedAt, model: state.tokenizerModel ?? '' }) : undefined,
    rounds: state.rounds,
    // Preserve the single-round shape consumed by existing offline research commands.
    challenges: only?.challenges, outputs: only?.outputs, analysis: only?.analysis,
  }
  return JSON.stringify(result, (_name, value) => typeof value === 'string' && apiKey
    ? value.replaceAll(apiKey, '[REDACTED]') : value, 2) + '\n'
}
