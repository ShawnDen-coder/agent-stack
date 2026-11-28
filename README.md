# Agent Stack

Agent Stack 用 Git checkout 管理个人 Agent 的配置与工作方法。可执行命令为 `agent-stack`，CLI 包使用 GitHub Packages 分发。项目许可为 `UNLICENSED`。

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

CLI 可校验 checkout 中的声明、创建共享锁和按锁准备受管工具。使用 Node.js 24+ 和有包读取权限的 GitHub 账号安装首版。在登录提示中输入 GitHub 用户名，并用含 `read:packages` 权限的 personal access token (classic) 作为密码。[GitHub Packages 认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)

```sh
npm login --scope=@shawnden-coder --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @shawnden-coder/agent-stack@0.1.1
agent-stack --version
agent-stack validate --repo . --lock
```

在上面克隆的仓库中运行 `validate`，也可以用 `--repo` 指向其他 checkout。

完整 `setup --profile coding` 目前仅支持原生 macOS arm64/x64；已有外部 Pi 或 pnpm 会阻塞受管安装。`run coding` 要求受管环境和 Herdr pane。静态校验不等于工具运行验收。

- [Quickstart](docs/quickstart.md)：原生 Pi、受管 setup 与迁移。
- [CLI 行为与验收](docs/cli-acceptance.md)：命令边界与证据范围。
- [架构与声明](docs/architecture.md)、[开发与发布](docs/development.md)、[后续路线](docs/roadmap.md)。
