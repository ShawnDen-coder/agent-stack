# Agent Stack 开发约定

- 本仓库采用 TypeScript + Node.js 单包 npm CLI，开发使用 packageManager 指定的 pnpm。
- 先阅读 `docs/architecture.md` 和 `docs/development.md`，保持配置源、部件、profile、集成与设备状态的边界。
- `stack/components/`、`stack/profiles/`、`stack/integrations/` 是声明；`stack/configs/` 保存原生配置。元数据不要伪装成工具原生配置。
- `src/core/` 不读文件、不联网、不启动进程；外部 I/O 放入 adapters，commands 负责组装。
- 类型从 Zod schema 推导。新增字段和模块应有真实消费者。
- 只在 CLI 帮助和 README 中展示已实现命令。静态校验通过不能描述为工具安装或运行验证通过。
- 保留用户原生工具入口；第三方工具独立于 CLI 升级，配置与 skills 以 Git checkout 为准。
- 不把 token、OAuth、会话、缓存、绝对设备路径提交到仓库。
- 测试实际边界和结果，使用临时目录；不能通过移除能力要求让部件替换测试通过。
- 修改后运行 `pnpm check`。涉及打包时检查 npm pack 的内容；不要发布未授权的包。
