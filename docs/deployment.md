# Web 部署

以下路径和命令均相对于产品根目录 `projects/`。当前 WebUI 位于 `web/`。

前端统一请求 `/api/proxy`。`server/proxy.ts` 使用标准 Request/Response，JSON 和 SSE 响应直接透传，不等待完整流。请求超时为 250 秒，客户端取消会传给上游。使用 HashRouter，无需页面路由重写。

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

## 上游地址与本地开发

代理不限制供应商域名。在网页中填写自定义 HTTPS API 地址即可使用，无需额外配置服务器环境变量。地址必须使用完整域名；不接受 IP 字面量、单标签主机名，以及 `localhost`、`.local`、`.internal` 域名。

代理只接受 HTTPS 的默认 443 端口、三种协议端点和不超过 128 KiB 的 JSON 请求。不跟随重定向，不透传 Cookie 或任意请求头。客户端必须提供自己的上游密钥。`Origin` 校验限制浏览器跨站调用，但不替代站点鉴权或平台限流。

`bun run dev` 和 `bun run preview` 已接入同一代理，无需再启动后端服务。CLI 仍直接连接上游。

## GitHub Pages

`.github/workflows/pages.yml` 在推送时构建并保存静态产物，手动触发时发布到 GitHub Pages。手动发布前需在仓库设置中启用 GitHub Actions 作为 Pages 来源。GitHub Pages 没有服务器函数，仅支持手动检测和参考库查看。API 模式需要 Cloudflare Pages 或本地预览；不会自动回退到浏览器直连。
