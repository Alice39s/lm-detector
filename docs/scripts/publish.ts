import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { docsBase } from '../site.config.ts'

/**
 * Copies the pre-rendered docs into the detector's output: `docs/build/client<DOCS_BASE>` becomes `web/dist/docs`,
 * so one static deployment serves both (`DOCS_BASE` always ends in `/docs`). The docs home's data file sits next to
 * that folder (`docs.data`), where client-side navigation fetches it. The SPA fallback, which renders the docs'
 * not-found page, becomes the folder's `404.html`.
 */
const docsDir = resolve(import.meta.dirname, '..')
const built = join(docsDir, 'build/client', docsBase)
const target = resolve(docsDir, '../web/dist/docs')

if (!(await stat(built)).isDirectory()) throw new Error(`No pre-rendered docs in ${built}; run the docs build first.`)
// The detector must be built first: publishing into an empty web/dist would deploy the docs alone.
await stat(resolve(docsDir, '../web/dist/index.html'))
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(built, target, { recursive: true })
await cp(`${built}.data`, `${target}.data`)
await cp(join(docsDir, 'build/client/__spa-fallback.html'), join(target, '404.html'))
console.log(`Docs published to ${target}`)
