# Agent Stack

Agent Stack 用 Git checkout 管理个人 Agent 环境的部件、组合、原生配置和工作方法。CLI 可校验声明、创建共享锁，并在原生 macOS 上按锁准备 Pi、pnpm、uv 和 Herdr 的 `coding` 环境。

**尚未发布；`UNLICENSED`。** 当前未授予使用许可，请从包含这些功能的源码 checkout 试用，不要安装同名公开 npm 包。

## 从源码试用

在原生 macOS 上准备 Node.js 24+、npm 11.12.1 和 Git。checkout 自带四个部件的双架构锁。用临时 pnpm 构建，再从同一 checkout 执行 setup。

```sh
git clone --branch p0-final-acceptance https://github.com/ShawnDen-coder/agent-stack.git
cd agent-stack
npm exec --yes --package=pnpm@12.15.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm run build
node dist/cli.js validate --repo . --lock
mkdir -p "$HOME/.agent-stack/bin"
export PATH="$HOME/.agent-stack/bin:$PATH"
node dist/cli.js setup --repo . --profile coding
node dist/cli.js doctor --repo . --profile coding
```

在业务目录打开 Herdr pane 后运行 `run coding`。完整命令、已有工具的处理及旧配置迁移见 [Quickstart](docs/quickstart.md)。

## 当前范围

- 原生 macOS arm64/x64 支持完整 `coding` setup；原生 macOS 的 uv-only/Herdr-only 和 Windows x64 Herdr-only 也支持按锁安装或复用。其他系统的完整 coding、升级和锁更新仍未实现。
- setup 管理其拥有的配置字段和官方扩展，并从 checkout 引用 coding Agent 与 `shape`、`implement`、`verify` skills；保留用户未知字段、凭证和会话。已有外部 Pi/pnpm 入口不会被接管，并会阻塞完整 coding setup。
- 已绑定 coding 的 `doctor` 核对受管安装回执、文件树、锁、资源及历史 TUI 验证签名；不启动未知 Pi。`run coding` 在当前 Herdr pane 启动受管 Pi，透传允许的原生参数和退出状态。
- macOS 原生环境已实际验证完整 setup、重复运行和 Herdr pane 内 Pi TUI；该结果不替代其他平台或后续提交的验证。共享锁固定顶层资产；本机 npm 传递依赖树回执不等于共享锁固定完整依赖闭包。

## 文档

- [Quickstart](docs/quickstart.md)：准备、共享锁、setup、doctor 与 run。
- [CLI 行为与验收](docs/cli-acceptance.md)：命令边界与证据范围。
- [架构与声明](docs/architecture.md)、[开发与发布](docs/development.md)、[后续路线](docs/roadmap.md)。
