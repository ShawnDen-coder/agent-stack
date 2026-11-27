# Agent Stack

Agent Stack 用 Git checkout 管理个人 Agent 的配置与工作方法。项目尚未发布，`UNLICENSED`；请使用源码 checkout，不要安装同名公开 npm 包。

## 配置已有 Pi

准备 Git 和已安装的 Pi，选择一个稳定保留的 checkout 路径，然后运行：

```sh
git clone https://github.com/ShawnDen-coder/agent-stack.git
cd agent-stack
pi install "$PWD/stack"
```

此后在任意业务目录直接运行 `pi`。Pi 的 local package 从 checkout 加载 coding Agent 和 `shape`、`implement`、`verify` skills；更新 checkout 后重新启动 Pi 即可使用新内容。Pi 保留原有 settings、认证、会话、已安装插件和自动发现的个人 skills。使用 `pi list`、`pi config` 和 `pi remove` 管理该 package；不要移动或删除仍在使用的 checkout。

Herdr 集成继续由 Herdr 原生安装或受管 setup 提供。迁移及重复加载说明见 [Quickstart](docs/quickstart.md)。

## CLI 与受管安装

CLI 可校验声明、创建共享锁和按锁准备受管工具；使用已有 Pi 不需要构建 CLI。开发时运行 `pnpm install --frozen-lockfile`、`pnpm build` 和 `pnpm check`。

完整 `setup --profile coding` 目前仅支持原生 macOS arm64/x64；已有外部 Pi 或 pnpm 会阻塞受管安装。`run coding` 要求受管环境和 Herdr pane。静态校验不等于工具运行验收。

- [Quickstart](docs/quickstart.md)：原生 Pi、受管 setup 与迁移。
- [CLI 行为与验收](docs/cli-acceptance.md)：命令边界与证据范围。
- [架构与声明](docs/architecture.md)、[开发与发布](docs/development.md)、[后续路线](docs/roadmap.md)。
