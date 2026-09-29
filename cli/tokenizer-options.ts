import { parseArgs } from 'node:util'
import type { ApiConfig } from '@fingerpoint/shared/types'
import { TOKENIZER_MODEL } from '@fingerpoint/shared/tokenizer-posterior'
import { positiveInteger } from './detect-options'

export interface TokenizerOptions {
  config: ApiConfig
  api: 'responses' | 'chatcompletion' | 'message'
  parallel: number
  maxProbes: number
  timeoutMs: number
  bank?: string
  input?: string
  output?: string
  json: boolean
}

export const MAX_PARALLEL_PROBES = 8

export function parseTokenizerOptions(args: string[], env = process.env): TokenizerOptions | undefined {
  const { values } = parseArgs({ args: args.map(arg => arg === '-ns' ? '--no-stream' : arg), options: {
    model: { type: 'string', short: 'm' }, apikey: { type: 'string', short: 'k' }, baseurl: { type: 'string', short: 'b' },
    'base-url': { type: 'string' }, 'api-key': { type: 'string' }, api: { type: 'string', short: 'a' },
    effort: { type: 'string', short: 'e' }, 'no-stream': { type: 'boolean' }, parallel: { type: 'string', short: 'p' },
    'max-probes': { type: 'string' }, timeout: { type: 'string' }, bank: { type: 'string' },
    input: { type: 'string' }, output: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  }, strict: true, allowPositionals: false })
  if (values.help) return undefined
  const apiInput = (values.api ?? 'responses').toLowerCase()
  const api = apiInput === 'cc' ? 'chatcompletion'
    : (['responses', 'chatcompletion', 'message'] as const).find(name => name.startsWith(apiInput))
  if (!apiInput || !api) throw new Error('--api must be a prefix of responses, chatcompletion, or message (or cc).')
  const timeout = Number(values.timeout ?? '90')
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) throw new Error('--timeout must be between 1 and 600 seconds.')
  const config: ApiConfig = {
    model: (values.model ?? env.MODEL ?? '').trim(),
    apiKey: (values.apikey ?? values['api-key'] ?? env.API_KEY ?? '').trim(),
    baseUrl: (values.baseurl ?? values['base-url'] ?? env.BASE_URL ?? '').trim(),
    format: api === 'message' ? 'anthropic' : api === 'chatcompletion' ? 'openai' : 'responses',
    stream: !values['no-stream'], effort: values.effort ?? '',
  }
  if (!values.input) {
    for (const [name, value, variable] of [
      ['model', config.model, 'MODEL'], ['apikey', config.apiKey, 'API_KEY'], ['baseurl', config.baseUrl, 'BASE_URL'],
    ]) {
      if (!value) throw new Error(`Set --${name} or the ${variable} environment variable.`)
    }
  }
  const maxProbes = positiveInteger(values['max-probes'] ?? String(TOKENIZER_MODEL.maximumProbes), '--max-probes', 60)
  if (maxProbes < TOKENIZER_MODEL.minimumProbes) throw new Error(`--max-probes must be at least ${TOKENIZER_MODEL.minimumProbes}.`)
  return {
    config, api, maxProbes, timeoutMs: Math.round(timeout * 1000), json: !!values.json,
    parallel: positiveInteger(values.parallel ?? '4', '--parallel', MAX_PARALLEL_PROBES),
    bank: values.bank, input: values.input, output: values.output,
  }
}
