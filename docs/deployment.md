# Web 部署

以下路径和命令均相对于产品根目录 `projects/`。当前 WebUI 位于 `web/`。

接口允许浏览器跨域时，前端直接请求接口；否则在用户授权后请求转发代理：默认为同源 `/api/proxy`，也可以在 API 配置中改为自建 Worker。代理实现是单文件 Cloudflare Worker `worker/main.js`，Pages Function、Vercel Function 与 Vite 开发服务器都导入它的 `proxyRequest`。它使用标准 Request/Response，JSON 和 SSE 响应直接透传，不等待完整流。请求超时为 250 秒，客户端取消会传给上游。使用 HashRouter，无需页面路由重写。

## Cloudflare Pages

Pages 项目使用本目录作为根目录。Git 集成的生产分支为 `main`，构建命令为 `bun run build`，输出目录为 `web/dist`，构建环境变量 `BUN_VERSION=1.4.2`。`functions/api/proxy.ts` 提供同源代理；`wrangler.jsonc` 固定兼容日期并启用 `enable_request_signal`。

`web/public/_routes.json` 仅让 `/api/proxy` 进入 Pages Function。首页、哈希路由、JS/CSS、字体、数据清单和 zstd 分段均由 Pages 静态服务直接返回。`/api/proxy` 的响应标记为 `no-store`。不要为整个自定义域添加 Cache Everything 规则，否则可能缓存 API 响应或阻碍部署更新。Pages 自带 CDN 和 Tiered Cache；哈希命名的 JS/CSS 与数据分段在浏览器缓存一年，`index.html` 与数据清单沿用 Pages 的重新验证策略。

参考库、派生库与检测器在构建时分别 zstd 压缩，再按 4 MiB 切分到 `web/dist/data/chunks/`。浏览器按 `data/manifest.json` 拼接、解压；检测只加载需要的数据。最大的静态文件小于 Pages 的 25 MiB 限制。CLI 包仍从构建时生成的脱敏派生库和原始检测器文件打包，不依赖压缩后的站点数据。

使用 Wrangler 直接发布时，在本目录运行：

```sh
bun run build:pages
bun run preview:pages
bun run deploy:pages
```

若创建的是直接上传项目，也可运行 `bun run build:pages:upload`，将生成的 `web/dist/` 上传至 Pages。这个命令会把已编译的函数放入 `_worker.js`；仅上传 `bun run build` 生成的纯静态目录会丢失 API 模式。直接上传项目需在控制台设置与 `wrangler.jsonc` 一致的兼容日期和 `enable_request_signal`。本地 Pages 预览位于 `http://127.0.0.1:8788`。

先在 Pages 项目中绑定 `lm.ikale.io`，再确认 Cloudflare DNS 指向该项目的 `*.pages.dev` 主机名。只有 Pages URL 的静态资源、`/api/proxy` JSON/SSE 转发和自定义域都通过后，才能停止旧站点的自动部署。

## 自建 Worker 代理

`worker/` 可以单独部署为 Cloudflare Worker，供 GitHub Pages 等没有服务器函数的站点，或不想经过本站代理的用户使用。部署方式、`ALLOWED_ORIGINS` 与请求约定见 [worker/README.md](../worker/README.md)：

- [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/Ikaleio/lm-detector/tree/main/worker) 把 `worker/` 复制为用户自己的仓库，并用 Workers Builds 部署；
- 网页 API 配置中的“从 GitHub 导入 Playground”读取 GitHub 上最新的 `worker/main.js`，在 Workers Playground 中打开，登录后可直接部署；
- 在本目录运行 `bun run deploy:worker`，或用 `bun run dev:worker` 在 `http://127.0.0.1:8787` 本地运行。

Worker 默认只允许 `https://lm.ikale.io` 从浏览器调用。自行部署网页时，把网页的 origin 加入 `ALLOWED_ORIGINS`；同源的 Pages Function 不需要此变量。网页在 API 配置的“转发代理”中保存 Worker 地址，“检查代理”用 GET 健康检查区分可用、浏览器无法读取响应（来源未被允许，或该地址不是代理）和无法连接。

## 上游地址与本地开发

代理不限制供应商域名。在网页中填写自定义 HTTPS API 地址即可使用，无需额外配置服务器环境变量。地址必须使用完整域名；不接受 IP 字面量、单标签主机名，以及 `localhost`、`.local`、`.internal` 域名。

代理只接受 HTTPS 的默认 443 端口、三种协议端点和不超过 128 KiB 的 JSON 请求。不跟随重定向，不透传 Cookie 或任意请求头。客户端必须提供自己的上游密钥。`Origin` 校验限制浏览器跨站调用，但不替代站点鉴权或平台限流。

`bun run dev` 和 `bun run preview` 已接入同一代理，无需再启动后端服务。CLI 仍直接连接上游。

## GitHub Pages

`.github/workflows/pages.yml` 在推送时构建并保存静态产物，手动触发时发布到 GitHub Pages。手动发布前需在仓库设置中启用 GitHub Actions 作为 Pages 来源。GitHub Pages 没有服务器函数：允许浏览器跨域的接口仍可直连使用 API 模式和词表探测；需要代理的接口在 API 配置中改用自建 Worker，Worker 的 `ALLOWED_ORIGINS` 需包含 Pages 站点的 origin。
