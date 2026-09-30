import { docsLlms } from '@/lib/source'

/** `llms-full.txt`: every page of both languages as Markdown. */
export async function loader() {
  return new Response(`${await docsLlms.full('zh')}\n\n${await docsLlms.full('en')}`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
