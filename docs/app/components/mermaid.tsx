import { use, useId, useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'

/** Rendered in the browser only; the pre-rendered page keeps the diagram source until Mermaid loads. */
export function Mermaid({ chart }: { chart: string }) {
  const hydrated = useSyncExternalStore(() => () => {}, () => true, () => false)
  if (!hydrated) return <pre className="fd-mermaid-source">{chart}</pre>
  return <MermaidContent chart={chart} />
}

const cache = new Map<string, Promise<unknown>>()
function cached<T>(key: string, create: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit) return hit as Promise<T>
  const promise = create()
  cache.set(key, promise)
  return promise
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId()
  const { resolvedTheme } = useTheme()
  const { default: mermaid } = use(cached('mermaid', () => import('mermaid')))
  const theme = resolvedTheme === 'dark' ? 'dark' : 'neutral'
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', fontFamily: 'inherit', theme })
  // Mermaid uses the id in CSS selectors, so it keeps only word characters of React's id.
  const { svg } = use(cached(`${theme}:${chart}`, () => mermaid.render(`mermaid-${id.replace(/[^\w-]/g, '')}`, chart)))
  return <div className="fd-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}
