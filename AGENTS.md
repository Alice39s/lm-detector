# 产品 monorepo

- 使用 Bun 管理依赖并运行 TypeScript。CLI 使用 Bun + TypeScript。
- `web/` 只提供检测和只读参考库页面；采样在 `cli/`，算法在 `shared/`，数据在 `data/`。
- 产品构建不得依赖本目录之外的文件。配置、锁文件和部署入口放在本目录。
- 不新增测试文件，除非用户明确要求。变更后运行 `bun run typecheck` 和 `bun run build`。
- 参考库模型标签的数字版本使用小数点（如 `claude-opus-5.5`），不要写成 `claude-opus-5-5`；`claude-haiku-4-5-20251001` 的展示/参考标签固定为 `claude-haiku-4.5`。API 请求型号和原始采样证据保持上游原值。
- 不自动请求模型 API。只有用户要求采集或检测上游时才发送请求。
- 评估样本不得进入参考库、模型中心或校准。采样记录保留失败和旧尝试。
