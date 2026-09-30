import { compressToEncodedURIComponent } from 'lz-string'
import workerConfig from '../../../worker/wrangler.json'

const REPOSITORY = 'https://github.com/Ikaleio/lm-detector'
/** The Worker on the default branch, which the Playground import reads. GitHub serves raw files with open CORS. */
export const WORKER_SOURCE_URL = 'https://raw.githubusercontent.com/Ikaleio/lm-detector/main/worker/main.js'
/** Deploy to Cloudflare copies `worker/` into a new repository of the user and deploys it with Workers Builds. */
export const DEPLOY_BUTTON_URL = `https://deploy.workers.cloudflare.com/?url=${REPOSITORY}/tree/main/worker`
const PLAYGROUND_URL = 'https://workers.cloudflare.com/playground'

/**
 * A Workers Playground link that opens `source` as `main.js` with the runtime settings of `worker/wrangler.json`.
 * The Playground reads the fragment as `contentType:multipartBody` compressed with lz-string, the format of its own
 * share links; its Deploy button then creates the Worker in the user's account.
 */
export async function playgroundUrl(source: string) {
  const form = new FormData()
  form.set(workerConfig.main, new Blob([source], { type: 'application/javascript+module' }), workerConfig.main)
  const metadata = { main_module: workerConfig.main, compatibility_date: workerConfig.compatibility_date, compatibility_flags: workerConfig.compatibility_flags }
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  const body = new Response(form)
  const contentType = body.headers.get('content-type')
  if (!contentType) throw new Error('The browser did not serialize the Worker upload.')
  return `${PLAYGROUND_URL}#${compressToEncodedURIComponent(`${contentType}:${await body.text()}`)}`
}

/**
 * Opens the Playground with the current `worker/main.js` from GitHub. The tab opens during the click, before the
 * download, so popup blockers allow it; it closes again when the download fails. Resolves `blocked` when the browser
 * refused the tab and nothing was downloaded.
 */
export async function openWorkerPlayground(): Promise<'opened' | 'blocked'> {
  const tab = window.open('about:blank', '_blank')
  if (!tab) return 'blocked'
  tab.opener = null
  try {
    const response = await fetch(WORKER_SOURCE_URL, { credentials: 'omit', cache: 'no-cache', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`)
    tab.location.href = await playgroundUrl(await response.text())
    return 'opened'
  } catch (error) {
    tab.close()
    throw error
  }
}
