import type { Analysis } from './types'
import type { TokenizerBank } from './tokenizer-bank'
import { expectedClasses, TOKENIZER_MODEL, type TokenizerPosterior, type TokenizerVerdict } from './tokenizer-posterior'

/**
 * The tokenizer evidence enters the fingerprint ranking by Bayes' rule. Number choices and token counts are treated as
 * independent given the model, so the calibrated closed-set posterior of each candidate m is multiplied by
 *   (1 - ε) · BF(m) + ε,   BF(m) = P(H_m | counts) / P(H_m),
 * and renormalized. H_m are the tokenizer hypotheses compatible with m, and BF(m) is their Bayes factor against the
 * marginal of the counts. ε is a Huber ε-contamination share for runs whose reported usage does not come from the
 * served model's tokenizer, such as relays that estimate usage locally; it bounds how far the counts alone move the
 * ranking.
 */
export const TOKENIZER_FUSION = {
  decoupling: 0.1,
  /** Chance that an unmapped model keeps the tokenizer of the mapped models in its family rather than an unlisted one. */
  inheritance: 0.8,
  /** Compatibility thresholds, the same as the claim check. */
  consistent: 0.9,
  inconsistent: 0.1,
} as const

/** class: the model id maps to listed classes; unpublished: its vendor has not published the tokenizer;
 * family: unmapped, so it inherits from mapped models of the same family; unmapped: no evidence applies. */
export type TokenizerLink = 'class' | 'unpublished' | 'family' | 'unmapped'
export interface TokenizerFit {
  link: TokenizerLink
  /** Listed classes the model is served with; empty for an unpublished tokenizer or an unmapped model. */
  classes: string[]
  /** Posterior probability that the observed tokenizer is compatible with the model; for an inherited tokenizer, that
   * it is the family's. Null when unmapped. */
  probability: number | null
  /** Likelihood of the counts under the model relative to their marginal, after contamination. 1 carries no evidence. */
  factor: number
  status: 'consistent' | 'inconsistent' | 'uncertain' | 'unmapped'
}
export interface TokenizerEvidence {
  method: 'tokenizer-bayes-factor-v1'
  /** False when the ranking has no calibrated probabilities to combine with, such as a partial ranking. */
  fused: boolean
  decoupling: number
  answered: number
  verdict: TokenizerVerdict | null
  /** Leading candidate of the number fingerprint alone. */
  fingerprint_top: string
}

interface Mass { posterior: number; prior: number }
const bayesFactor = (mass: Mass) => mass.posterior / mass.prior

function classMass(bank: TokenizerBank, posterior: TokenizerPosterior, classes: string[]): Mass {
  const set = new Set(classes)
  const { known, relative } = TOKENIZER_MODEL.prior
  return {
    posterior: posterior.classes.filter(score => set.has(score.id)).reduce((sum, score) => sum + score.exact + score.related, 0),
    prior: set.size * (known + relative) / bank.classes.length,
  }
}
const unlistedMass = (posterior: TokenizerPosterior): Mass => ({
  posterior: posterior.unknown, prior: TOKENIZER_MODEL.prior.relative + TOKENIZER_MODEL.prior.alien,
})

function fit(link: TokenizerLink, classes: string[], probability: number | null, bayes: number): TokenizerFit {
  const status = probability === null ? 'unmapped' : probability >= TOKENIZER_FUSION.consistent ? 'consistent'
    : probability <= TOKENIZER_FUSION.inconsistent ? 'inconsistent' : 'uncertain'
  return { link, classes, probability, factor: (1 - TOKENIZER_FUSION.decoupling) * bayes + TOKENIZER_FUSION.decoupling, status }
}

/** Fits every candidate model to the counts. Unmapped models borrow the hypotheses of mapped models in their family. */
export function tokenizerFits(bank: TokenizerBank, posterior: TokenizerPosterior, models: { model: string; family: string }[]) {
  const mapped = new Map(models.map(({ model }) => [model, expectedClasses(bank, model)]))
  // Families with only unpublished tokenizers keep an empty class set and inherit the unlisted hypothesis.
  const families = new Map<string, Set<string>>()
  for (const { model, family } of models) {
    const expected = mapped.get(model)
    if (!expected) continue
    const classes = families.get(family) ?? new Set<string>()
    for (const id of expected.expected) classes.add(id)
    families.set(family, classes)
  }
  const unlisted = unlistedMass(posterior)
  return new Map(models.map(({ model, family }): [string, TokenizerFit] => {
    const expected = mapped.get(model)
    if (expected?.expected.length) {
      const mass = classMass(bank, posterior, expected.expected)
      return [model, fit('class', expected.expected, mass.posterior, bayesFactor(mass))]
    }
    if (expected) return [model, fit('unpublished', [], unlisted.posterior, bayesFactor(unlisted))]
    const relatives = families.get(family)
    if (!relatives) return [model, fit('unmapped', [], null, 1)]
    const classes = [...relatives]
    const inherited = classes.length ? classMass(bank, posterior, classes) : unlisted
    const weight = TOKENIZER_FUSION.inheritance
    // The status names the inherited tokenizer; the factor keeps the chance of an unlisted one.
    return [model, fit('family', classes, inherited.posterior, weight * bayesFactor(inherited) + (1 - weight) * bayesFactor(unlisted))]
  }))
}

/**
 * Attaches the tokenizer evidence to an analysis and, when its probabilities are calibrated, reorders the candidates
 * by the combined posterior. Partial and uncalibrated rankings keep their order and only carry the fits. A run with a
 * baseline but no answered probe carries no evidence, so the analysis is returned unchanged.
 */
export function fuseTokenizerEvidence(analysis: Analysis, bank: TokenizerBank, posterior: TokenizerPosterior, verdict: TokenizerVerdict | null): Analysis {
  if (!analysis.results.length || !posterior.answered) return analysis
  const fits = tokenizerFits(bank, posterior, analysis.results)
  const fused = analysis.probability_status === 'reference_calibrated'
    && analysis.results.every(row => typeof row.verification_confidence === 'number' && Number.isFinite(row.verification_confidence))
  const tokenizer: TokenizerEvidence = {
    method: 'tokenizer-bayes-factor-v1', fused, decoupling: TOKENIZER_FUSION.decoupling,
    answered: posterior.answered, verdict, fingerprint_top: analysis.prediction,
  }
  const rows = analysis.results.map(row => ({ ...row, tokenizer: fits.get(row.model) as TokenizerFit }))
  if (!fused) return { ...analysis, results: rows, tokenizer }
  const weights = rows.map(row => (row.verification_confidence as number) * row.tokenizer.factor)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const results = rows.map((row, i) => {
    const value = weights[i] / total
    return { ...row, fingerprint_confidence: row.verification_confidence, verification_confidence: value, probability: value, identity_probability: value }
  }).map((row, i) => ({ row, i })).sort((a, b) => b.row.verification_confidence - a.row.verification_confidence || a.i - b.i).map(({ row }) => row)
  const top = results[0]
  return {
    ...analysis, results, tokenizer,
    prediction: top.model, prediction_name: top.display_name, family_prediction: top.family, family_prediction_name: top.family_name,
    probability: top.verification_confidence, probability_top: top.model, verification_confidence: top.verification_confidence,
    ranking_score: top.score, verification_score: top.verification_score ?? undefined,
  }
}
