import { Box, Text, render, useWindowSize } from 'ink'
import { TOKENIZER_MODEL } from '@fingerpoint/shared/tokenizer-posterior'
import { StarNote } from './detect-help'
import { MAX_PARALLEL_PROBES } from './tokenizer-options'

const sections = [
  { title: 'CONNECTION', options: [
    ['-b, --baseurl URL', 'Base URL or complete endpoint. Env: BASE_URL.'],
    ['-m, --model MODEL', 'Model to request. Env: MODEL. Also used to check the claimed tokenizer.'],
    ['-k, --apikey KEY', 'API key. Env: API_KEY.'],
    ['-a, --api TYPE', 'responses (default), chatcompletion, or message; any prefix or cc.'],
    ['-e, --effort LEVEL', 'Reasoning effort for Chat Completions and Responses. Omitted by default.'],
    ['-ns, --no-stream', 'Use JSON instead of SSE.'],
    ['--timeout SECONDS', 'Deadline of each request. Default: 90.'],
  ] },
  { title: 'PROBING', options: [
    ['-p, --parallel NUMBER', `Requests in flight: 1–${MAX_PARALLEL_PROBES}. Default: 4. Use 1 for the fewest requests.`],
    ['--max-probes NUMBER', `Probe budget, at least ${TOKENIZER_MODEL.minimumProbes}. Default: ${TOKENIZER_MODEL.maximumProbes}. Two baselines are sent in addition.`],
    ['--bank FILE', 'Use a custom tokenizer bank.'],
  ] },
  { title: 'OUTPUT', options: [
    ['--input FILE', 'Recompute a saved result offline. No API requests.'],
    ['--output FILE', 'Save requests, counts, and the result as JSON. Credentials are excluded.'],
    ['--json', 'Write JSON to stdout instead of the TUI.'],
    ['-h, --help', 'Show this help.'],
  ] },
] as const

function Help() {
  const { columns } = useWindowSize()
  const width = Math.max(32, Math.min(columns || 80, 100))
  const narrow = width < 65
  return <Box flexDirection="column" width={width} paddingX={1}>
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text><Text bold color="cyan">FPD</Text> / TOKENIZER PROBE</Text>
      <Text dimColor>Identify the tokenizer behind an API from its reported input token counts.</Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">USAGE</Text>
      <Text>npx lmfpd@latest tokenizer -b URL -k KEY -m MODEL [options]</Text>
    </Box>
    {sections.map(section => <Box key={section.title} flexDirection="column" marginTop={1}>
      <Text bold color="cyan">{section.title}</Text>
      {section.options.map(([flag, description]) => <Box key={flag} flexDirection={narrow ? 'column' : 'row'} marginBottom={narrow ? 1 : 0}>
        <Box width={narrow ? undefined : 25} flexShrink={0}><Text bold>{flag}</Text></Box>
        <Box flexGrow={1} flexBasis={narrow ? undefined : 0} paddingLeft={narrow ? 2 : 0}><Text>{description}</Text></Box>
      </Box>)}
    </Box>)}
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">HOW IT WORKS</Text>
      <Text>Each request sends one short probe text inside a fixed wrapper and reads the input tokens from usage. A baseline request with only the wrapper removes the hidden template overhead.</Text>
      <Text>Probes are chosen one batch at a time to separate the remaining candidates. Probing stops once one tokenizer, or an unlisted one, reaches {TOKENIZER_MODEL.stopAt * 100}% posterior probability.</Text>
      <Text dimColor>Messages requests ask for at most 16 output tokens. Other protocols omit the output limit, like detection requests.</Text>
    </Box>
    <Box marginTop={1}><StarNote /></Box>
  </Box>
}

export async function printTokenizerHelp() {
  const view = render(<Help />, { interactive: false, patchConsole: false })
  await view.waitUntilRenderFlush()
  view.unmount()
}
