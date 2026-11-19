# Pi 配置导入

共享配置来自用户提供的 Pi 备份：[settings.json](../stack/configs/pi/settings.json) 保存默认 provider/model、七个 `subagents.agentOverrides` 角色的模型与 thinking 偏好，以及七个扩展的固定版本声明；[mcp.json](../stack/configs/pi/mcp.json) 保存 Reui 服务器配置。扩展声明保持备份中的顺序。

coding 资源事务将这些设置合并到本机原生 agent 配置。未知字段、其他角色、其他 MCP 服务器、凭证及会话保留；受管值被本地修改或已有不同内容时报告冲突。旧版只有 `skills: []` 的配置源仍可使用；源 checkout 没有 `mcp.json` 时，不管理本机 MCP 文件。

每个扩展声明均为确切 npm 版本，并显式设置 `skills: []`。Pi 1.5.2 的原生包过滤会排除包附带的 skills，包括 `pi-subagents` 的 skills；项目原有的 `shape`、`implement`、`verify` 保留。此过滤不禁用包的其他资源，例如 prompt templates。已有同名 npm 包使用范围、tag 或其他版本时，也会作为同一个包检查本地冲突，不追加重复声明。

正常 Pi 启动时，由 Pi 的原生包管理器解析或安装缺失的配置包；安装可能执行包脚本，也可能连接配置的远程 MCP 服务器。Pi 的扩展安装目录独立于 CLI 自身依赖，备份中的 npm 安装树和锁文件未导入。固定顶层版本不表示本项目已锁定这些扩展的完整传递依赖树。

Agent Stack 的核心 setup 验证使用临时 agent 目录，只加载 coding Agent、三个标准 skills 和 Herdr 集成，不加载这七个可选包或 Reui 配置。`validate`、`doctor` 和 setup 计划不会安装或执行它们。专用的核心运行验收使用 offline 与 `--no-mcp` 隔离可选网络行为，仍保留原有 Agent、skills、Herdr 和真实 TTY 验收。原生 `mcp.json` 由 Pi 的内置 MCP 支持读取；禁用或替换该内置扩展会影响其消费。

原生设置、包资源过滤及 MCP 解析通过离线本地 stub 验证，不代表真实第三方扩展功能、远端服务可达性、凭证或模型调用已经验证。本次未导入备份 skills、依赖树、缓存、认证、会话或已读版本记录。Pi 自写的 `lastChangelogVersion` 和 `extensionChangelogVersions` 不作为共享输入，且不影响 readiness 签名；其他设置变化继续被检测。
