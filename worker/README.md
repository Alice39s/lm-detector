# Fingerpoint API proxy

`main.js` is a complete Cloudflare Worker that relays requests from the Fingerpoint web app to LLM APIs that do not allow browser CORS. It has no dependencies and no build step. The site's Pages Function, the Vercel function and the Vite dev server import the same file, so every deployment runs the same code.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ikaleio/lm-detector/tree/main/worker)

## Deploy

- **Deploy to Cloudflare**: the button above copies this directory into a new GitHub or GitLab repository in your account, then builds and deploys it with Workers Builds. Pushes to that repository redeploy the Worker. The setup page lets you change `ALLOWED_ORIGINS`.
- **Workers Playground**: in the web app, open the API configuration, choose Relay proxy → Own Worker, then Import from GitHub into the Playground. The page downloads the current `main.js` from this repository and opens it in the Workers Playground, whose Deploy button creates the Worker in your account. No repository is created, and the Worker keeps the code it was deployed with.
- **Wrangler**: from the repository root, run `bun run deploy:worker`. `bun run dev:worker` serves the Worker at `http://127.0.0.1:8787`.

Paste the Worker address, such as `https://fingerpoint-api-proxy.<subdomain>.workers.dev`, into Own Worker and select Check proxy. The web app then asks before it sends the first request through that Worker, and names the Worker in the dialog.

## Configuration

`ALLOWED_ORIGINS` lists the origins of the pages that may call the Worker from a browser, separated by commas, or `*` for any page. It defaults to `https://lm.ikale.io`, also when the variable is missing, as after a Playground deploy. Add the origin of your own deployment of the web app.

With the Deploy button, edit `vars` in `wrangler.json` of the new repository: every deploy applies the file and replaces values changed in the dashboard. After a Playground deploy, set the variable in the dashboard under Settings → Variables and Secrets.

`wrangler.json` turns Workers Logs off, so invocations of the Worker are not stored in Workers Logs.

## Requests

| Method | Answer |
| --- | --- |
| `OPTIONS` | CORS preflight: 204 for an allowed origin, 403 otherwise |
| `GET` | Health check `{"service":"fingerpoint-api-proxy","formats":["openai","responses","anthropic"]}` |
| `POST` | The relayed API request |

A `POST` carries `Authorization: Bearer <upstream key>` and the JSON body `{ "url", "format", "body" }`. `url` is the complete endpoint and ends in `/chat/completions`, `/responses` or `/messages` for the formats `openai`, `responses` and `anthropic`. For `anthropic`, the Worker sends the key as `x-api-key` with `anthropic-version: 2023-06-01`. JSON and SSE responses stream back unchanged.

The Worker accepts only HTTPS on port 443 and public hostnames: no IP addresses, `localhost`, `.local` or `.internal` names, and no credentials, query or fragment in the URL. It rejects bodies over 128 KiB, follows no redirects, forwards no cookies and stores no keys. An upstream request times out after 250 seconds, and a cancelled browser request cancels the upstream request.

`ALLOWED_ORIGINS` limits which web pages can use the Worker; it is not authentication. Clients without an `Origin` header, such as curl, can relay requests with their own keys through any Worker address they know, and those requests count toward the Worker's quota.
