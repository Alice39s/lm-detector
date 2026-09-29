import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { directTransport } from '@fingerpoint/shared/detection'
import { assertTokenizerBank, type TokenizerBank } from '@fingerpoint/shared/tokenizer-bank'
import { probeTokenizer, serializeTokenizerReport, tokenizerReport, type TokenizerRun } from '@fingerpoint/shared/tokenizer-probe'
import { tokenizerPosterior, tokenizerVerdict, type TokenizerObservation } from '@fingerpoint/shared/tokenizer-posterior'
import { requestEndpoint } from './detect-options'
import { errorMessage } from './detect-request'
import { readJson } from './detect-run'
import { printTokenizerHelp } from './tokenizer-help'
import { parseTokenizerOptions, type TokenizerOptions } from './tokenizer-options'
import { createTokenizerDisplay, type TokenizerDisplay, type TokenizerState } from './tokenizer-ui'

const emptyRun = (): TokenizerRun => ({ steps: [], observations: [], posterior: null, verdict: null, baselineDrift: false })

interface Saved { run: TokenizerRun; request?: Record<string, unknown> }

/** Recomputes a saved run against the current bank without sending requests. `-m` overrides the saved model. */
async function analyzeSaved(path: string, bank: TokenizerBank, model: string): Promise<Saved> {
  const data = await readJson(path) as { schema?: string; observations?: TokenizerObservation[]; request?: Record<string, unknown> }
  const observations = data?.observations
  if (data?.schema !== 'fpd-tokenizer-v1' || !Array.isArray(observations) || !observations.every(item =>
    item && (item.probe === null || typeof item.probe === 'string') && Number.isSafeInteger(item.tokens))) {
    throw new Error('The input must be a saved fpd tokenizer result with an observations array.')
  }
  const posterior = tokenizerPosterior(bank, observations)
  if (!posterior) throw new Error('The saved observations contain no baseline.')
  const baselines = observations.filter(item => item.probe === null).map(item => item.tokens)
  const request = model ? { ...data.request, model } : data.request
  const claimed = typeof request?.model === 'string' ? request.model : ''
  return {
    request,
    run: {
      steps: observations.map(item => ({ probe: item.probe, state: 'done', tokens: item.tokens, responseModel: item.responseModel })),
      observations, posterior, baselineDrift: new Set(baselines).size > 1,
      // Like a live run, a verdict needs at least one answered probe.
      verdict: posterior.answered > 0 ? tokenizerVerdict(bank, posterior, claimed) : null,
    },
  }
}

function serialize(state: TokenizerState, options: TokenizerOptions, bank: TokenizerBank, savedRequest?: Record<string, unknown>) {
  const { apiKey, ...config } = options.config
  const request = options.input ? savedRequest
    : { ...config, api: options.api, parallel: options.parallel, max_probes: options.maxProbes, timeout_seconds: options.timeoutMs / 1000 }
  return serializeTokenizerReport(tokenizerReport(state.run, bank, { createdAt: state.startedAt, cancelled: state.cancelled, request }), apiKey)
}

export async function runTokenizerCommand(args: string[]) {
  let key = ''
  let display: TokenizerDisplay | undefined
  const abort = new AbortController()
  const cancel = () => abort.abort()
  try {
    const options = parseTokenizerOptions(args)
    if (!options) { await printTokenizerHelp(); return }
    key = options.config.apiKey
    const url = options.input ? '' : requestEndpoint(options.config)
    const bank = await readJson(options.bank ?? fileURLToPath(new URL('../data/tokenizer_bank.json', import.meta.url)))
    assertTokenizerBank(bank)
    const state: TokenizerState = { run: emptyRun(), startedAt: Date.now(), cancelled: false }
    process.on('SIGINT', cancel)
    process.on('SIGTERM', cancel)
    if (!options.json) display = createTokenizerDisplay(options, bank, state, cancel)
    let savedRequest: Record<string, unknown> | undefined
    if (options.input) {
      const saved = await analyzeSaved(options.input, bank, options.config.model)
      state.run = saved.run
      savedRequest = saved.request
    } else {
      state.run = await probeTokenizer(options.config, bank, {
        url, transport: directTransport, signal: abort.signal, concurrency: options.parallel,
        maximumProbes: options.maxProbes, timeoutMs: options.timeoutMs,
        onUpdate: run => { state.run = run; display?.update({ ...state }) },
      })
    }
    state.cancelled = abort.signal.aborted
    state.finishedAt = Date.now()
    display?.update({ ...state })
    const serialized = serialize(state, options, bank, savedRequest)
    if (options.output) await writeFile(options.output, serialized, { mode: 0o600 })
    if (options.json) process.stdout.write(serialized)
    await display?.finish(options.output)
    display = undefined
    if (state.cancelled) process.exitCode = 130
    else if (state.run.error || !state.run.verdict) process.exitCode = 1
  } catch (error) {
    const message = errorMessage(error, key)
    if (display) await display.finish(undefined, message)
    else process.stderr.write(`Error: ${message}\nUse fpd tokenizer --help for usage.\n`)
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
