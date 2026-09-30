/** One probe string. The request sends `wrapper.prefix + text + wrapper.suffix` as the only user message. */
export interface TokenizerProbe { id: string; category: string; text: string }

/**
 * One tokenizer class: open tokenizers of one lineage whose counts agree on the probes.
 * `counts[j]` is `count(prefix + probes[j].text + suffix) - count(prefix + suffix)`.
 * `alternatives[j]` lists every value members disagree on for probe j.
 */
export interface TokenizerClass {
  id: string
  lab: string
  lab_name: string
  series: string
  series_zh: string
  members: string[]
  aliases: string[]
  counts: number[]
  alternatives?: Record<string, number[]>
  note?: string
}

/** A first-party API model id pattern. `class` is null when the vendor has not published its tokenizer. */
export interface TokenizerApiModel { pattern: string; vendor: string; class: string | null }

export interface TokenizerBank {
  schema: 'tokenizer-bank-v1'
  generated_at: string
  /** `excluded` lists archived repositories left out because their files do not reflect the model's tokenizer. */
  source: { tool: string; archive_manifest_sha256: string; tokenizers: number; candidates: number; excluded?: { key: string; reason: string }[] }
  wrapper: { prefix: string; suffix: string }
  probes: TokenizerProbe[]
  classes: TokenizerClass[]
  api_models: TokenizerApiModel[]
}

/** Throws unless the bank has the expected shape, so a stale or truncated file fails before any request is sent. */
export function assertTokenizerBank(value: unknown): asserts value is TokenizerBank {
  const bank = value as TokenizerBank
  if (bank?.schema !== 'tokenizer-bank-v1') throw new Error('The tokenizer bank has an unsupported schema.')
  if (!Array.isArray(bank.probes) || !bank.probes.length || !Array.isArray(bank.classes) || bank.classes.length < 2) {
    throw new Error('The tokenizer bank must contain probes and at least two classes.')
  }
  if (typeof bank.wrapper?.prefix !== 'string' || typeof bank.wrapper?.suffix !== 'string') {
    throw new Error('The tokenizer bank has no probe wrapper.')
  }
  const ids = new Set<string>()
  for (const item of bank.classes) {
    if (ids.has(item.id)) throw new Error(`The tokenizer bank repeats class ${item.id}.`)
    ids.add(item.id)
    if (item.counts.length !== bank.probes.length || !item.counts.every(Number.isSafeInteger)) {
      throw new Error(`Tokenizer class ${item.id} does not have one integer count per probe.`)
    }
  }
  if (!Array.isArray(bank.api_models)) throw new Error('The tokenizer bank has no api_models array.')
  for (const model of bank.api_models) {
    if (model.class !== null && !ids.has(model.class)) throw new Error(`API model ${model.pattern} refers to unknown class ${model.class}.`)
  }
  // Compile the patterns now so a broken bank fails before any request is sent and billed.
  const patterns = [...bank.api_models.map(model => model.pattern), ...bank.classes.flatMap(item => Array.isArray(item.aliases) ? item.aliases : [null])]
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') throw new Error('The tokenizer bank has a class without an aliases array.')
    try { new RegExp(pattern, 'i') } catch (error) { throw new Error(`The tokenizer bank has an invalid pattern ${pattern}: ${(error as Error).message}`) }
  }
}

export const wrapProbe = (bank: TokenizerBank, text: string) => bank.wrapper.prefix + text + bank.wrapper.suffix
