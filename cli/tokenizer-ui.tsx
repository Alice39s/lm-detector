import { useEffect, useState } from 'react'
import { Box, Text, render, useInput, useWindowSize } from 'ink'
import terminalLink from 'terminal-link'
import type { TokenizerBank } from '@fingerpoint/shared/tokenizer-bank'
import type { ProbeStep, TokenizerRun } from '@fingerpoint/shared/tokenizer-probe'
import type { TokenizerVerdict } from '@fingerpoint/shared/tokenizer-posterior'
import { cleanText } from './detect-request'
import type { TokenizerOptions } from './tokenizer-options'

const percentage = (value: number) => `${(value * 100).toFixed(1)}%`
const seconds = (milliseconds: number) => `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`

export interface TokenizerState { run: TokenizerRun; startedAt: number; finishedAt?: number; cancelled: boolean }

export function stepLabel(bank: TokenizerBank, step: ProbeStep) {
  if (step.probe === null) return 'baseline'
  return `${bank.probes.find(probe => probe.id === step.probe)?.category ?? '?'} · ${step.probe}`
}

export function verdictLine(bank: TokenizerBank, verdict: TokenizerVerdict) {
  const item = bank.classes.find(entry => entry.id === verdict.top.id)
  const name = item ? `${item.series} (${item.lab_name})` : verdict.top.id
  if (verdict.kind === 'exact') return `Exact tokenizer match: ${name} · ${percentage(verdict.confidence)}`
  if (verdict.kind === 'related') return `Unlisted tokenizer closest to ${name} · ${percentage(verdict.confidence)}`
  return `Unlisted tokenizer · ${percentage(verdict.confidence)} · closest listed: ${name}`
}

export function claimLine(bank: TokenizerBank, verdict: TokenizerVerdict, model: string) {
  const claim = verdict.claim
  if (!claim) return `No tokenizer is registered for "${model}".`
  const expected = claim.expected.length
    ? claim.expected.map(id => bank.classes.find(item => item.id === id)?.series ?? id).join(' / ')
    : `an unpublished ${claim.vendor} tokenizer`
  const status = claim.status === 'consistent' ? 'consistent' : claim.status === 'inconsistent' ? 'INCONSISTENT' : 'uncertain'
  return `Claimed "${model}" expects ${expected}: ${status} (${percentage(claim.probability)})`
}

/** o200k_base and cl100k_base also result when a relay estimates usage with tiktoken instead of reporting the upstream count. */
export const estimatedUsageClasses = new Set(['o200k', 'cl100k'])

function Dashboard({ state, options, bank, cancel, saved, fatal }: {
  state: TokenizerState; options: TokenizerOptions; bank: TokenizerBank; cancel: () => void; saved?: string; fatal?: string
}) {
  const [now, setNow] = useState(Date.now())
  const { columns } = useWindowSize()
  useEffect(() => {
    if (state.finishedAt) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [state.finishedAt])
  useInput((input, key) => { if (input === 'q' || (key.ctrl && input === 'c')) cancel() }, {
    isActive: !!process.stdin.isTTY && !state.finishedAt,
  })
  const safe = (value: string) => cleanText(options.config.apiKey ? value.replaceAll(options.config.apiKey, '[REDACTED]') : value)
  const { run } = state
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(now / 100) % 10]
  const phase = state.cancelled ? 'Cancelled' : run.error ? 'Stopped' : state.finishedAt ? 'Finished' : 'Probing'
  const answered = run.steps.filter(step => step.state === 'done').length
  const models = [...new Set(run.observations.map(observation => observation.responseModel).filter(Boolean))]
  const verdict = run.verdict
  const top = verdict && bank.classes.find(item => item.id === verdict.top.id)
  return <Box flexDirection="column" width={Math.max(30, Math.min(columns || 80, 100))} paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text><Text bold color="cyan">FPD</Text><Text dimColor> / TOKENIZER PROBE (</Text><Text color="cyan">{terminalLink('lm.ikale.io', 'https://lm.ikale.io', { fallback: false })}</Text><Text dimColor>)</Text></Text>
      <Text wrap="truncate-end" bold>{options.input ? `Offline · ${safe(options.input)}` : safe(options.config.model)}</Text>
      {!options.input && <Text dimColor wrap="truncate-middle">{safe(options.config.baseUrl)}</Text>}
      <Text dimColor>{options.input ? 'Saved observations' : `${options.api} · ${options.config.stream ? 'SSE' : 'JSON'} · parallel ${options.parallel} · up to ${options.maxProbes} probes`} · {bank.classes.length} tokenizer classes</Text>
    </Box>
    <Box justifyContent="space-between">
      <Text bold>{state.finishedAt ? '●' : spinner} {phase} · {answered} answered</Text>
      <Text dimColor>{seconds((state.finishedAt ?? now) - state.startedAt)}</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {run.steps.slice(-10).map((step, index) => <Box key={`${index}:${step.probe}`}>
        <Box width={3}><Text color={step.state === 'failed' ? 'red' : step.state === 'done' ? 'green' : 'yellow'}>{step.state === 'done' ? '✓' : step.state === 'failed' ? '×' : spinner}</Text></Box>
        <Box flexGrow={1} flexBasis={0}><Text wrap="truncate-end">{stepLabel(bank, step)}</Text></Box>
        <Box width={10} justifyContent="flex-end"><Text dimColor>{step.tokens === undefined ? '—' : `${step.tokens} tok`}</Text></Box>
      </Box>)}
      {run.steps.length > 10 && <Text dimColor>Showing the last 10 of {run.steps.length} requests.</Text>}
    </Box>
    {run.posterior && <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">LEADING TOKENIZERS</Text>
      <Box>
        <Box width={4}><Text dimColor>#</Text></Box>
        <Box flexGrow={1}><Text dimColor>Tokenizer</Text></Box>
        <Box width={10} justifyContent="flex-end"><Text dimColor>Exact</Text></Box>
        <Box width={10} justifyContent="flex-end"><Text dimColor>Related</Text></Box>
      </Box>
      {run.posterior.classes.slice(0, 5).map((score, index) => {
        const item = bank.classes.find(entry => entry.id === score.id)
        return <Box key={score.id}>
          <Box width={4}><Text color={index === 0 ? 'cyan' : undefined}>{index + 1}</Text></Box>
          <Box flexGrow={1} flexBasis={0}><Text wrap="truncate-end" bold={index === 0}>{item ? `${item.series} · ${item.lab_name}` : score.id}</Text></Box>
          <Box width={10} justifyContent="flex-end"><Text color={index === 0 ? 'cyan' : undefined}>{percentage(score.exact)}</Text></Box>
          <Box width={10} justifyContent="flex-end"><Text dimColor>{percentage(score.related)}</Text></Box>
        </Box>
      })}
      <Text dimColor>Unlisted tokenizer: {percentage(run.posterior.unknown)} · matched {run.posterior.classes[0].matched}/{run.posterior.classes[0].compared} probes of the leader</Text>
    </Box>}
    {verdict && <Box flexDirection="column" marginTop={1}>
      <Text bold>{verdictLine(bank, verdict)}</Text>
      {top && verdict.kind !== 'unknown' && <Text dimColor wrap="truncate-end">Shared by {top.members.length} open tokenizers, e.g. {top.members.slice(0, 3).join(', ')}</Text>}
      {!options.input && <Text color={verdict.claim?.status === 'inconsistent' ? 'red' : verdict.claim?.status === 'consistent' ? 'green' : 'yellow'}>{claimLine(bank, verdict, options.config.model)}</Text>}
      {verdict.kind === 'exact' && estimatedUsageClasses.has(verdict.top.id) && verdict.claim?.status !== 'consistent' && <Text color="yellow">Relays that estimate usage locally with tiktoken report the same counts.</Text>}
      {models.length > 0 && <Text dimColor wrap="truncate-end">Returned model: {models.map(model => safe(model as string)).join(', ')}</Text>}
    </Box>}
    {run.baselineDrift && <Text color="yellow">The two baselines differ: the upstream adds a varying amount of hidden input.</Text>}
    <Box marginTop={1} flexDirection="column">
      {(fatal || run.error) && <Text color="red">{safe(fatal ?? run.error?.message ?? '')}</Text>}
      {saved && <Text color="green">Saved {safe(saved)}</Text>}
      <Text dimColor>{state.finishedAt ? 'Counts come from the upstream usage report. A match shows the tokenizer, not the model weights.' : 'q / Ctrl+C to cancel'}</Text>
    </Box>
  </Box>
}

export interface TokenizerDisplay {
  update(state: TokenizerState): void
  finish(saved?: string, fatal?: string): Promise<void>
}

export function createTokenizerDisplay(options: TokenizerOptions, bank: TokenizerBank, initial: TokenizerState, cancel: () => void): TokenizerDisplay {
  let state = initial
  const terminal = !!process.stdout.isTTY && !process.env.CI && process.env.TERM !== 'dumb'
  const view = render(<Dashboard state={state} options={options} bank={bank} cancel={cancel} />, {
    exitOnCtrlC: false, patchConsole: false, maxFps: 10, interactive: terminal,
  })
  let reported = 0
  return {
    update(next: TokenizerState) {
      state = next
      if (!terminal) {
        for (const step of state.run.steps.slice(reported)) {
          if (step.state === 'requesting') break
          reported++
          const error = cleanText(options.config.apiKey ? (step.error ?? '').replaceAll(options.config.apiKey, '[REDACTED]') : step.error ?? '')
          process.stderr.write(`${stepLabel(bank, step)}: ${step.state === 'done' ? `${step.tokens} tokens` : `failed · ${error}`}\n`)
        }
      }
      view.rerender(<Dashboard state={state} options={options} bank={bank} cancel={cancel} />)
    },
    async finish(saved?: string, fatal?: string) {
      state = { ...state, finishedAt: state.finishedAt ?? Date.now() }
      view.rerender(<Dashboard state={state} options={options} bank={bank} cancel={cancel} saved={saved} fatal={fatal} />)
      await view.waitUntilRenderFlush()
      view.unmount()
    },
  }
}
