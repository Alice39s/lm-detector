import { proxyRequest } from '../worker/main.js'

export default {
  fetch(request: Request) {
    return proxyRequest(request)
  },
}
