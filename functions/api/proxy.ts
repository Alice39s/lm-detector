import { proxyRequest } from '../../worker/main.js'

export function onRequest({ request }: { request: Request }) {
  return proxyRequest(request)
}
