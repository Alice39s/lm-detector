import type { ApiConfig, CodedError, ErrorCode } from './types'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

export interface ProbeUsage {
  /** Input tokens the upstream billed for the request, including cached prompt tokens. */
  inputTokens: number
  responseModel?: string
}

const coded = (message: string, code: ErrorCode, extra?: Partial<CodedError>): CodedError => Object.assign(new Error(message), { code }, extra)
const object = (value: Json | undefined): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const count = (value: Json | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const text = (value: Json | undefined) => typeof value === 'string' ? value : ''

/**
 * Chat Completions reports `prompt_tokens`, which already includes cached tokens. Responses reports
 * `input_tokens` the same way. Messages reports cache writes and cache reads outside `input_tokens`.
 */
export function inputTokens(usage: Json | undefined, format: ApiConfig['format']): number | undefined {
  const value = object(usage)
  if (format === 'openai') return count(value.prompt_tokens)
  const base = count(value.input_tokens)
  if (format === 'responses' || base === undefined) return base
  return base + (count(value.cache_creation_input_tokens) ?? 0) + (count(value.cache_read_input_tokens) ?? 0)
}

function parse(payload: string): JsonObject {
  try { return object(JSON.parse(payload) as Json) } catch { throw coded('The upstream returned invalid JSON.', 'bad_stream_json') }
}

/** The HTTP status is the error; a body that is not JSON is kept as plain text instead of masking the status. */
function errorDetail(body: string) {
  const trimmed = body.trim()
  let data: JsonObject = {}
  if (trimmed.startsWith('{')) {
    try { data = object(JSON.parse(trimmed) as Json) } catch { data = {} }
  }
  return text(object(data.error).message) || text(data.message) || trimmed.slice(0, 300)
}

/** Reads the usage report of a JSON or SSE response. The generated text is ignored. */
export async function readUsage(response: Response, format: ApiConfig['format']): Promise<ProbeUsage> {
  if (!response.ok) {
    const detail = errorDetail(await response.text())
    throw coded(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`, 'http', { httpStatus: response.status })
  }
  let usage: JsonObject = {}, responseModel: string | undefined
  const merge = (value: Json | undefined) => { usage = { ...usage, ...object(value) } }
  const accept = (data: JsonObject) => {
    if (data.error || data.type === 'error') throw coded(text(object(data.error).message) || text(data.message) || 'The upstream stream failed.', 'upstream_stream_error')
    const response = object(data.response), message = object(data.message)
    // Responses reports a failed generation inside the response object, usually with null usage.
    if (format === 'responses' && (data.type === 'response.failed' || response.status === 'failed')) {
      throw coded(text(object(response.error).message) || 'The upstream response failed.', 'upstream_stream_error')
    }
    responseModel = text(data.model) || text(response.model) || text(message.model) || responseModel
    if (format === 'anthropic') { merge(message.usage); if (data.type !== 'message_start') merge(data.usage) }
    else if (format === 'responses') merge(data.usage ?? response.usage)
    else if (data.usage) merge(data.usage)
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) accept(parse(await response.text()))
  else {
    if (!response.body) throw coded('The upstream returned no stream body.', 'no_stream_body')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    const frame = (value: string) => {
      const payload = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (payload && payload.trim() !== '[DONE]') accept(parse(payload))
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        let match: RegExpExecArray | null
        while ((match = /\r?\n\r?\n/.exec(buffer))) { frame(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length) }
        if (done) { if (buffer.trim()) frame(buffer); break }
      }
    } finally { reader.releaseLock() }
  }
  const tokens = inputTokens(usage, format)
  if (tokens === undefined) throw coded('The upstream did not report input tokens.', 'no_usage')
  return { inputTokens: tokens, responseModel }
}
