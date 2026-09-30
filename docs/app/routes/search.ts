import { createFromSource } from 'fumadocs-core/search/server'
import { source } from '@/lib/source'

// The default multilingual tokenizer segments Chinese and English text into one index.
const server = createFromSource(source)

/** Pre-rendered into a static index file; `staticClient` downloads it. */
export async function loader() {
  return server.staticGET()
}
