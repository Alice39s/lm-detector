# Web 检测网站

从 monorepo 根目录运行 `bun run dev`、`bun run build` 或 `bun run preview`。

`src/` 包含检测页面、只读样本库与中英文文案。检测复用 `../shared/`，正式数据来自 `../data/`。接口允许浏览器 CORS 时直接请求；否则经用户授权后由转发代理发往用户填写的 HTTPS 服务，不设供应商域名白名单。代理默认为同源 `/api/proxy`，也可在 API 配置中改为自建 Worker。代理实现是单文件 Worker `../worker/main.js`，Vite 开发及预览服务复用该实现。

网站没有入库功能。浏览器不读取旧的 IndexedDB 自定义库，也不合并或重建参考数据。只读库页面支持查看和导出。

路由使用 React Router v7 的 HashRouter。界面使用 shadcn/ui（Base UI）、Tailwind v4 和 Framer Motion。`design.md` 定义本项目的视觉原语和交互约束。

`src/i18n/messages.ts` 包含中英文文案，`src/i18n/index.tsx` 提供语言偏好、插值及日期/数字格式化。语言切换不修改算法提示词或用户回复。API 设置和密钥自动保存在 localStorage，刷新或重新打开浏览器后恢复；旧版 sessionStorage 密钥自动迁移。PNG 导出在浏览器 Canvas 中生成，不包含密钥、接口地址或回复正文。

API 模式的新配置默认开启流式输出、并行请求、宽松模式和自动验证；现有配置保留已保存的开关状态。宽松模式的 SSE 取样在收到要求数量的完整有效整数后停止，非流式完整回复超量时只取前 N 个有效整数；两者在界面标为“已截断”。关闭宽松模式后要求上游自然完整结束，不主动截断。状态文案由中英文词典提供。

构建前的 `scripts/sync-data.ts` 校验并脱敏正式数据，将参考库、派生库与检测器压缩成 zstd 静态分段，并生成数据清单。静态产物为 `dist/`。Cloudflare Pages 从本仓库根目录部署；函数入口、上游地址要求及运行命令见 [部署说明](../docs/deployment.md)。GitHub Pages 没有服务器函数：允许 CORS 的接口直接请求，其余接口需要在 API 配置中改用自建 Worker。

生产构建从 `telemetry.json` 注入 Koitoyu 和 Recorder 脚本；本地开发不加载。站点 ID 和脚本来源集中在该配置文件。Recorder 回放会遮蔽 API 配置区和错误详情；输入框由 Recorder 默认遮蔽。
