# 当前状态与后续路线

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md)

## 已实现的闭环

- `validate` 校验声明，`validate --lock` 离线核对共享锁结构与声明；`lock` 可在指定目标时首次创建共享锁，不覆盖已有锁。
- 原生 macOS arm64/x64 支持完整 coding setup：按锁准备 Pi、pnpm、uv、Herdr，应用受管配置与官方扩展，并从 checkout 引用 coding Agent 和 `shape`、`implement`、`verify` skills。隔离 Pi TUI 和 Herdr v9 私有 socket 验证通过后才提交默认绑定。
- 已绑定 coding 的 `doctor` 核对锁、回执、整树、资源和历史 TUI 签名，不启动未知 Pi。`run coding` 在当前 Herdr pane 启动 Pi，保留允许的原生参数、TTY、cwd 与退出状态。
- macOS uv-only/Herdr-only 及 Windows x64 Herdr-only 支持按锁安装或复用。Windows Herdr 保留完整七文件 ZIP 布局；已有外部 Pi/pnpm 不接管，会阻塞完整 coding setup。
- npm 打包、Node SEA 二进制和 Cocogitto 版本流程已有实现。尚未正式 npm publish、推正式 tag、创建正式 Release 或 merge；发布外部配置见 [开发文档](development.md#受控发布流程)。

根会话已在原生 macOS 实测 Pi 1.5.2、pnpm 12.15.0、uv 0.13.8、Herdr 0.9.5 的完整 setup、幂等重跑、真实 Herdr pane 中的 Pi TUI 和随后 doctor。具体证据范围见 [验收矩阵](cli-acceptance.md)；该结果不等同于本候选的最终 full check 或其他平台通过。

## 待完成

1. 完成当前候选的根会话审查、`pnpm check` 与 npm pack 验收；运行并记录 macOS arm64/x64、Linux x64、Windows x64 的原生 SEA CI。矩阵定义本身不是运行证据。
2. 在确认支持契约和原生证据后扩展 Windows、Linux/WSL 的完整 coding，以及 Windows uv、其他平台的安装和交互；现有 Windows x64 Herdr-only 能力继续保留。不能用 Linux runner 替代 WSL 原生证据。
3. 实现锁更新与离线解析、单部件升级、配置恢复和程序回退。共享锁记录顶层发行资产；本机 npm 传递依赖树回执不表示共享锁固定完整闭包。
4. 完善真实用户终端、ConPTY、GUI 及模型调用的独立验收。隔离 TUI 和静态检查不能代替这些场景；认证、会话和凭证留在原生工具本机目录。
5. 在另行授权后确定 npm 包名/所有权和许可，并配置可信发布、GitHub environment 与 tag/master 保护；不得把未配置的 OIDC 或未执行的发布描述成已完成。

继续保留 profile 的能力要求和原生工具入口；Rex 是独立实验组合，不能通过删除 herdr 的 agent-status 要求使替换看似通过。架构与状态边界见 [架构](architecture.md)和 [setup 方案](setup-plan.md)。
