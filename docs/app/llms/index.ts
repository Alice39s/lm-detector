import { docsLlms } from '@/lib/source'

/** `llms.txt`: an index of both languages, pre-rendered as a static file. */
export async function loader() {
  return new Response(`${await docsLlms.index('zh')}\n\n${await docsLlms.index('en')}`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
