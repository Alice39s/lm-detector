import { createOpenAPI } from 'fumadocs-openapi/server'

/** The proxy's contract lives next to its implementation, so a change to `worker/main.js` has its schema at hand. */
export const openapi = createOpenAPI({ input: ['../worker/openapi.json'] })
