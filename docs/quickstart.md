# Quickstart：从源码试用

当前包为 `private`、`UNLICENSED`，尚未发布 npm；本指南使用源码 checkout，不安装同名公开包。以下命令使用当前实现的只读检查与版本候选报告，不会安装 Pi、uv 或 herdr 等外部工具，也不会应用原生配置。`pnpm install` 安装的是 CLI 自身的依赖。

## 准备与获取源码

准备 Node.js 24 或更高版本（含 npm）、Git，以及 `packageManager` 指定的 pnpm 12.15.0。先用 `node --version`、`npm --version`、`git --version` 检查。尚未安装 pnpm 时，可通过 npm 安装对应版本；已有 pnpm 时，先检查版本并沿用自己的安装渠道：

```sh
npm install --global pnpm@12.15.0 --ignore-scripts
pnpm --version
```

确认输出为 `12.15.0` 后继续。版本不符时先检查 PATH 中的 pnpm 入口；项目不会替你安装前置工具。

PR 尚未合并时，远端默认 `master` 只有初始提交，必须指定 PR 分支。以下命令可用于 macOS/Linux shell 与 Windows PowerShell：

```sh
git clone --branch research-agent-stack https://github.com/ShawnDen-coder/agent-stack.git
cd agent-stack
pnpm install --frozen-lockfile
pnpm build
pnpm cli --help
```

安装或构建失败时先检查 Node、pnpm 版本和网络/registry 可用性，不要更改锁文件来绕过版本要求。

## 校验声明

在 checkout 根目录运行：

```sh
pnpm cli validate --repo .
pnpm cli validate --repo . --json
```

成功的文本报告包含 `[OK] Definitions: 6 components, 2 integrations, 2 profiles`；JSON 包含 `valid: true`、`checked` 和空的 `issues`。退出 0 表示声明结构、引用、平台和能力要求通过静态检查，不证明工具安装或集成可运行。退出 1 时按报告的 `stack/...` 文件和问题修正声明，再重试。

`--repo` 始终指向仓库根目录。若路径包含空格，macOS/Linux 和 PowerShell 都可引用，例如 `pnpm cli validate --repo "../my agent-stack"`。声明位于 `stack/components/`、`stack/profiles/`、`stack/integrations/`，读取 YAML、YML 和过渡期 JSON；`stack/configs/` 保存原生工具配置。

## 检查工具链

```sh
pnpm cli doctor --repo . --profile coding
pnpm cli doctor --repo . --profile coding --json
```

报告包含 `profile`、每项 `checks` 的版本要求、观察状态和证据，以及 `unchecked` 和 `scope`。`[FAIL]` 或 `[UNKNOWN]` 表示缺失、版本不符或无法核对；退出 1 时根据报告检查 PATH 和原生安装渠道即可，不必为了完成本指南安装工具。Pi/pnpm 的 package metadata 不证明程序可运行，herdr 版本不证明集成工作；Otty、Rex 和集成状态未检查。`doctor` 不写配置或刷新认证。

## 可选：在线查看版本候选

```sh
pnpm cli lock --repo . --profile coding --dry-run --json
```

该命令访问官方 npm registry、uv GitHub Releases 和 herdr stable manifest。成功 JSON 的 `kind` 为 `resolution-report`，`components` 列出版本或阻塞原因；uv 按范围选择正式 release，herdr 使用 stable manifest。任一来源网络失败、限流或元数据不足时退出 1，检查网络和报告后重试；不要求凭证。这个报告不是锁或 apply 计划，不下载工具，不验证目标资产、release digest、传递依赖或运行兼容性，也不创建 `stack/stack.lock.json`。

## 退出码与平台

已实现命令一般使用 0 表示本次检查范围通过，1 表示业务检查或来源失败，2 表示用法错误，交互取消为 130。`doctor` 和 `lock` 在脚本或 JSON 模式下必须显式提供 `--profile`，交互 TTY 可选择；`validate` 不需要 profile。查看上一条命令退出码：

```sh
# macOS / Linux shell
echo $?
```

```powershell
# Windows PowerShell
$LASTEXITCODE
```

Windows 原生与 WSL 应使用各自环境中的 Node、pnpm 和 checkout，不共享本机配置路径。已审查基线 `c6cea45` 的 [CI 运行](https://github.com/ShawnDen-coder/agent-stack/actions/runs/43606679733) 在 macOS/Linux/Windows 与 Node 24/26 六组通过；后续版本候选切片需以其自己的 CI 结果为准。Windows PTY、WSL 与真实外部工具安装尚未由该运行验证。

继续阅读 [CLI 行为与验收](cli-acceptance.md)、[架构](architecture.md)、[配置变体提案](config-variants.md)、[开发和打包](development.md)及 [roadmap](roadmap.md)。`setup`、`run coding`、完整锁生成和配置应用尚未实现。

指定 `--target darwin-arm64`、`darwin-x64` 或 `win32-x64` 可预览 Pi、pnpm 顶层与 pnpm native 包的 npm tarball 及预期 SHA-512，以及 herdr 发行物 URL 和 manifest 给出的预期 SHA-256；选项可重复。不指定目标时仅报告版本。pnpm native 预览识别 12.15.0 起的 pnpm 12 发行契约，依赖映射或 native 平台元数据不符时阻塞；CLI 自身使用的 pnpm 版本仍由 packageManager 固定。默认 coding 的 uv 目标资产未覆盖，因而目标预览退出 1；Linux ABI 未核实，明确阻塞。预期 digest 不是下载字节验证、签名或运行兼容证明，Windows 摘要对应完整 zip。
