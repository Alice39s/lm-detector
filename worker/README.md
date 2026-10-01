# Fingerpoint forwarding proxy

Some LLM APIs refuse calls made from a web page, because of the browser's cross-origin rule (CORS). For such an API the Fingerpoint web app can send the request through a forwarding proxy, a server that passes the request on and streams the answer back. `main.js` in this directory is that proxy, written as a Cloudflare Worker, a small program that runs on Cloudflare's servers. It has no dependencies and no build step.

Deploy your own copy if you would rather have your API key pass through a server you control than through the proxy the site provides, or if you host the web app yourself on a site without server functions, such as GitHub Pages. You need a Cloudflare account. The Workers free plan allows 100,000 requests a day, which is plenty for personal checks, and [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/) has the details. When you finish, you have a Worker address such as `https://fingerpoint-api-proxy.<subdomain>.workers.dev`, which you enter under Forwarding proxy → Own Worker in the API configuration of the web app.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ikaleio/lm-detector/tree/main/worker)

## Deploy

Pick one of three methods.

### Deploy to Cloudflare button

This fits anyone with a GitHub or GitLab account. The button above copies this directory into a new repository in that account, then builds and deploys it with Workers Builds, Cloudflare's service that redeploys a Worker whenever its repository changes. The setup page's "Create private Git repository" option decides whether the new repository is private or public. It holds only the Worker's code and configuration, never an API key. Pushing to the repository redeploys the Worker. The copy does not follow later changes to this repository.

### Workers Playground

This fits anyone without a GitHub or GitLab account, or anyone who wants a one-off deployment with nothing to install. In the web app, open the API configuration, choose Forwarding proxy → Own Worker, then select Open in the Playground. The page downloads the current `main.js` from this repository and opens it in the Workers Playground, Cloudflare's in-browser editor. After you sign in to Cloudflare, the Playground's Deploy button creates the Worker in your account. No repository is created, and the Worker keeps the code it was deployed with, so it never updates by itself. To get newer code, deploy again.

### Wrangler

This fits anyone who already has a checkout of this repository, or who wants to edit `main.js` or `wrangler.json` first. Wrangler is Cloudflare's command-line tool. Run `bun install`, sign in with `bunx wrangler login`, then run `bun run deploy:worker` from the repository root.

## After deploying

Open the Worker address in a browser. A working Worker answers `{"service":"fingerpoint-api-proxy","formats":["openai","responses","anthropic"]}`. Enter the address under Own Worker and select Check proxy. The web app asks for your consent before it sends the first request through that Worker, and names the Worker in the dialog.

## Configuration

`ALLOWED_ORIGINS` lists the web pages that may call the Worker from a browser. Each entry is an origin, the protocol, domain, and port of a page address, such as `https://example.com`. Separate entries with commas; `*` allows any page. The default is `https://lm.ikale.io`, which also applies when the variable is missing, as after a Playground deployment. If you only use the Worker from lm.ikale.io, change nothing. If you host the web app yourself, add its origin. The origin of a GitHub Pages site is `https://<username>.github.io`, without the repository name.

With the button, edit `vars` in `wrangler.json` in your new repository. With Wrangler, edit `worker/wrangler.json` and deploy again. Every deployment applies that file and replaces values changed in the dashboard. After a Playground deployment, set the variable in the Cloudflare dashboard under Settings → Variables and Secrets.

## Logs

`wrangler.json` turns Workers Logs off, which is Cloudflare's per-request log viewer, and `main.js` writes no log lines. A Worker deployed with the button or Wrangler therefore leaves no prompts, replies, or API keys in your Cloudflare logs. The Playground does not read the log setting from `wrangler.json`, so after a Playground deployment, check in the Cloudflare dashboard that Workers Logs is off.

## Keep the address private

`ALLOWED_ORIGINS` only limits which web pages can use the Worker from a browser. A client that sends no `Origin` header, such as curl, can use any Worker address it knows, with its own API key, and those requests count toward your Worker's quota. Anyone who learns the address can therefore use up your allowance. Your API keys stay out of it, since callers send their own keys and the Worker stores none. On the free plan, Cloudflare stops serving the Worker once it passes 100,000 requests in a day (error 1027) and resumes at midnight UTC. A paid plan has no daily cap and bills the extra requests. Do not post the address publicly. If it leaks, delete the Worker and deploy a new one under a different name, which gives it a new address.

## Limits

The Worker forwards no cookies and stores no keys, and cancelling a request in the browser cancels the request to the API. It enforces the limits below.

| Limit | If you run into it |
| --- | --- |
| HTTPS on port 443 only | Use the command line, which connects to the API directly and also accepts `http://` addresses. |
| Public domain names only, with no IP addresses, `localhost`, `.local`, or `.internal` names | Use the command line. |
| No credentials, query string, or fragment in the URL | Enter the key in the API Key field. If the API needs a query string, use the command line. |
| Request bodies up to 128 KiB | Fingerpoint's own requests stay far below the limit. |
| Redirects are not followed | Use the API's final address. |
| Requests to the API time out after 250 seconds | Retry, or choose a faster model or a lower reasoning effort. |

## Request format

Clients other than the web app can call the Worker too. `GET` returns the health check shown above, `OPTIONS` answers the browser's CORS preflight (204 for an allowed origin, 403 otherwise), and `POST` forwards an API request. A `POST` carries `Authorization: Bearer <API key>` and the JSON body `{ "url", "format", "body" }`, where `url` is the complete API endpoint. JSON and streamed (SSE) responses come back unchanged. For Messages requests, the Worker sends the key as `x-api-key` with `anthropic-version: 2023-06-01`. The full schema is in the [proxy API reference](https://lm.ikale.io/docs/en/reference/proxy-api).

| Protocol | `format` | `url` ends in | Command line `-a` |
| --- | --- | --- | --- |
| Chat Completions | `openai` | `/chat/completions` | `chatcompletion` (or `cc`) |
| Responses | `responses` | `/responses` | `responses` |
| Messages | `anthropic` | `/messages` | `message` |

## For maintainers

The site's Pages Function, the Vercel function, and the Vite dev server import `main.js` too, so every deployment runs the same code. `bun run dev:worker` serves the Worker locally at `http://127.0.0.1:8787`.
