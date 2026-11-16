# Quickstart：从源码试用

当前包为 `UNLICENSED`，尚未正式发布；本指南使用源码 checkout，不安装同名公开包。`pnpm install` 安装 CLI 自身依赖。完整 coding setup 支持原生 macOS arm64/x64；Windows x64 支持下文的 Herdr-only 流程，其他系统的完整 coding 仍阻塞。

## 准备与获取源码

准备 Node.js 24 或更高版本（含 npm）、Git，以及 `packageManager` 指定的 pnpm 12.15.0。先用 `node --version`、`npm --version`、`git --version` 检查。尚未安装 pnpm 时，可通过 npm 安装对应版本；已有 pnpm 时，先检查版本并沿用自己的安装渠道：

```sh
npm install --global pnpm@12.15.0
pnpm --version
```

确认输出为 `12.15.0` 后继续。版本不符时先检查 PATH 中的 pnpm 入口；项目不会替你安装前置工具。

clone 后切换到包含当前功能的提交或分支；功能合入默认分支前，默认 checkout 可能较旧。以下命令可用于 macOS/Linux shell 与 Windows PowerShell：

```sh
git clone https://github.com/ShawnDen-coder/agent-stack.git
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

报告包含各项检查与证据。对于已绑定的 coding，`doctor` 还核对锁、受管回执及整树、资源和历史隔离 TUI 验证签名；它不启动未知 Pi，也不重新运行 TUI 或验证模型调用。`[FAIL]` 或 `[UNKNOWN]` 表示缺失、版本不符或无法核对；根据报告检查本机状态。`doctor` 不写配置或刷新认证。

## 可选：在线查看版本候选

```sh
pnpm cli lock --repo . --profile coding --dry-run --json
```

该命令访问官方 npm registry、uv GitHub Releases 和 herdr stable manifest。成功 JSON 的 `kind` 为 `resolution-report`，`components` 列出版本或阻塞原因；uv 按范围选择正式 release，herdr 使用 stable manifest。任一来源网络失败、限流或元数据不足时退出 1，检查网络和报告后重试；不要求凭证。这个报告不是锁或 apply 计划，不下载工具，不验证目标资产、release digest、传递依赖或运行兼容性，也不创建 `stack/stack.lock.json`。

## 退出码与平台

已实现命令一般使用 0 表示本次检查范围通过，1 表示业务检查或来源失败，2 表示用法错误，交互取消为 130。`doctor` 在脚本或 JSON 模式下可通过 `--profile`、`AGENT_STACK_PROFILE` 或所选仓库的本机绑定取得 profile；均不可用时明确拒绝，不猜测。`lock` 在这些模式下仍须显式提供 `--profile`；交互 TTY 可选择，`validate` 不需要 profile。查看上一条命令退出码：

```sh
# macOS / Linux shell
echo $?
```

```powershell
# Windows PowerShell
$LASTEXITCODE
```

Windows 原生与 WSL 应使用各自环境中的 Node、pnpm 和 checkout，不共享本机配置路径。已审查基线 `c6cea45` 的 [CI 运行](https://github.com/ShawnDen-coder/agent-stack/actions/runs/43606679733) 在 macOS/Linux/Windows 与 Node 24/26 六组通过；后续版本候选切片需以其自己的 CI 结果为准。Windows PTY、WSL 与真实外部工具安装尚未由该运行验证。

继续阅读 [CLI 行为与验收](cli-acceptance.md)、[架构](architecture.md)、[配置变体提案](config-variants.md)、[开发和打包](development.md)及 [roadmap](roadmap.md)。锁更新、离线解析及其他系统的完整 coding 尚未实现。

指定 `--target darwin-arm64`、`darwin-x64` 或 `win32-x64` 可预览 Pi、pnpm 顶层与 pnpm native 包的 npm tarball 及预期 SHA-512，以及 uv release 归档、herdr 发行物 URL 和预期 SHA-256；选项可重复。不指定目标时仅报告版本。pnpm native 预览识别 12.15.0 起的 pnpm 12 发行契约，依赖映射或 native 平台元数据不符时阻塞；CLI 自身使用的 pnpm 版本仍由 packageManager 固定。使用 `--dry-run` 时，若四个部件的目标元数据均完整可返回 0，但不会生成锁；Linux ABI 未核实，明确阻塞。预期 digest 不是下载字节验证、签名或运行兼容证明，Windows 摘要对应完整 zip。

首次创建共享锁（会联网读取和复核所选来源；目标必须明确指定）：

```sh
pnpm cli lock --repo . --profile coding --target darwin-arm64
```

也可重复指定 `--target darwin-x64` 或 `--target win32-x64`。默认新建 `stack/stack.lock.json`；`--out ./candidate.json` 新建另一份共享候选锁，相对路径以当前目录解析，且不能与 `--dry-run` 同用。默认锁或目标文件（含链接）已存在即拒绝，不覆盖。失败请检查来源、平台及摘要；在线限流会阻止创建。锁记录预期元数据，并不证明下载字节、依赖闭包、配置或运行兼容。Linux ABI、锁更新和离线模式尚未实现。

已有共享锁可离线校验：

```sh
pnpm cli validate --repo . --lock
pnpm cli validate --repo . --lock "./candidate lock.json" --json
```

裸 `--lock` 读取 `<repo>/stack/stack.lock.json`；显式相对路径以当前调用目录解析。检查只覆盖本地结构、声明与资产身份关系，不能证明远端未撤回、签名或下载字节正确，也不验证安装或运行。

已有完整共享锁时，可运行 `node dist/cli.js setup --repo . --profile coding --dry-run` 预览，不安装或应用配置；缺少前置条件时返回 1。完整 coding 应用仅支持原生 macOS arm64/x64；Windows、Linux/WSL、未知或仿真宿主阻塞。`--lock` 指向候选锁时相对当前目录解析。

## macOS 的完整 coding

准备 Node.js 24+、可核对的 npm 和 Git、网络，以及包含本机目标资产的完整 coding 锁。首次受管安装 Pi 的 staging 当前要求 npm 11.12.1；命令计划会报告不满足的前置条件。将受管 bin 加入当前 shell 的 PATH（setup 不修改 shell 配置）：

如果尚无共享锁，可先执行上文的 `lock` 创建步骤；Apple Silicon 选择 `darwin-arm64`，Intel Mac 选择 `darwin-x64`。`lock` 不覆盖已有文件；也可使用 `lock --out ./coding.lock.json`；使用候选锁时，将下方的 `validate --lock` 改为 `validate --lock ./coding.lock.json`，并为两条 setup 命令添加 `--lock ./coding.lock.json`。

```sh
mkdir -p "$HOME/.agent-stack/bin"
export PATH="$HOME/.agent-stack/bin:$PATH"
pnpm cli validate --repo . --lock
pnpm cli setup --repo . --profile coding --dry-run
pnpm cli setup --repo . --profile coding
pnpm cli doctor --repo . --profile coding
```

执行 setup 会安装或复用锁定部件、应用受管配置，交互时要求确认；非交互可明确传入 `--yes`。已有外部 Pi/pnpm 不接管，其入口会阻塞完整 coding；冲突、未知归属或缺失前置条件需先按计划报告处理。setup 不替用户配置认证或模型。

Pi、pnpm、uv 和 Herdr 先完成准备，受管配置、checkout 中的 Agent 与三个 skills 通过隔离的真实 Pi TUI 和 Herdr v9 私有 socket 验证后才提交默认绑定。重新运行会复核输入；已验证且未变化时保持绑定，并避免重新获取 npm 根包。npm 传递依赖树的本机回执用于检测安装漂移，不代表共享锁固定了完整依赖闭包。未知配置字段、用户会话和凭证保留。

在本机 Herdr 的活动 pane 中运行：

```sh
pnpm cli run --repo . coding --cwd "$PWD" --dry-run --json
pnpm cli run --repo . coding --cwd "$PWD"
# 原生 Pi 参数放在 -- 之后
pnpm cli run --repo . coding --cwd "$PWD" -- --mode text
```

`--dry-run --json` 不启动 Pi，但仍检查 coding 绑定和当前 Herdr pane；未就绪时报告 blockers 或错误并退出 1。实际启动要求交互 TTY 和有效 Herdr 上下文，使用 checkout 中的 Agent 与 `shape`、`implement`、`verify`，传递允许的 Pi 参数、终端和退出状态。管理子命令、非交互模式以及禁用 skills/扩展的参数会被拒绝；Pi 的原生入口仍可独立使用。`--json` 只与 `--dry-run` 组合。

根会话在原生 macOS 实测 Pi 1.5.2、pnpm 12.15.0、uv 0.13.8 和 Herdr 0.9.5 的完整 setup、无根包重新获取的重跑，以及独立 Herdr server/pane 中的真实 Pi TUI、资源加载、session/idle、cwd、Ctrl-C 退出 0 和随后 doctor 退出 0。这些结果不证明其他系统、模型调用或后续 commit 已验证。

## macOS 的 uv-only setup

在 `stack/profiles/uv-only.yaml` 创建一个保留真实能力要求的组合：

```yaml
schemaVersion: 1
id: uv-only
description: Python tools
platforms: [darwin, linux, win32]
components:
  - component: uv
    version: ">=0.13.8 <0.14"
integrations: []
requires: [python-tools]
```

在没有默认共享锁的 checkout 中，选择本机架构（Apple Silicon 使用 `darwin-arm64`，Intel 使用 `darwin-x64`）并生成候选锁。锁解析需要访问官方元数据；若已有默认锁，首次锁命令拒绝覆盖，须使用合适的独立 checkout。

```sh
mkdir -p "$HOME/.agent-stack/bin"
export PATH="$HOME/.agent-stack/bin:$PATH"
pnpm cli lock --repo . --profile uv-only --target darwin-x64 --out ./uv-only.lock.json
pnpm cli setup --repo . --profile uv-only --lock ./uv-only.lock.json --dry-run
pnpm cli setup --repo . --profile uv-only --lock ./uv-only.lock.json
```

交互式 setup 展示计划并要求确认；脚本可用 `--yes`。`--dry-run` 不下载或持久写入（版本观察使用并清理临时目录）；执行只下载锁中资产、核对 SHA-256 和归档，再验证 `uv`/`uvx` 版本。已有相同版本的外部入口只读复用，来源仍为 unknown；未知或冲突入口不覆盖。示例 `export` 只影响当前 shell；请自行确保后续 shell 也包含该目录，setup 不编辑 shell 配置。成功才登记本机绑定；重复执行会核对受管文件并 no-op。

Windows 的 uv ZIP、Linux/WSL、仿真和非支持目标的安装 adapter 尚不可应用。异常中断后重跑可恢复已记录的受管操作；若本机记录不完整或目标已被更改，保留文件并提示人工检查。

## macOS / Windows x64 的 Herdr-only setup

在独立 checkout 的 `stack/profiles/herdr-only.yaml` 创建组合：

```yaml
schemaVersion: 1
id: herdr-only
description: Herdr workspace
platforms: [darwin, win32]
components:
  - component: herdr
    channel: stable
integrations: []
requires: [workspace]
```

沿用上文的受管 bin 目录准备方式，在没有默认共享锁的 checkout 中为本机原生架构生成锁。以下示例使用 Intel macOS；Apple Silicon 将 target 改为 `darwin-arm64`。

```sh
mkdir -p "$HOME/.agent-stack/bin"
export PATH="$HOME/.agent-stack/bin:$PATH"
pnpm cli lock --repo . --profile herdr-only --target darwin-x64 --out ./herdr-only.lock.json
pnpm cli setup --repo . --profile herdr-only --lock ./herdr-only.lock.json --dry-run
pnpm cli setup --repo . --profile herdr-only --lock ./herdr-only.lock.json
```

脚本执行可加 `--yes`。安装核对锁中的 SHA-256、原生架构（macOS Mach-O / Windows PE）及版本，发布 Herdr 受管入口和 v2 回执；匹配的已有原生入口可 external 复用，来源仍为 unknown。重复执行会复核文件与锁，不重新下载匹配的受管安装。下载、确认后漂移或恢复冲突会失败并保留需要人工核查的证据；`--yes` 不覆盖未知入口或本地修改。

此 profile 只安装 workspace 工具，不启用 Pi 集成或 coding 配置。setup 不启动、停止或迁移用户的 Herdr server，也不导入会话或认证。Windows x64 支持完整七文件 ZIP 安装与 external 复用，Node 24/26 的[原生安装与 IPC 验收](herdr-windows-smoke.md)已通过；未知、仿真宿主或锁中缺少当前目标时继续阻塞。setup 仍要求可验证的 npm 入口；Node 自带动态 prefix 的 `npm.cmd` 按现有只读探测规则属于未核对入口，需使用可静态验证的标准 cmd-shim 等受支持入口。

Windows PowerShell 使用同一份 Herdr-only 声明，将锁目标改为 `win32-x64`：

```powershell
$stackHome = if ($null -ne $env:HOME) { $env:HOME } else { $env:USERPROFILE }
$stackBin = Join-Path $stackHome '.agent-stack/bin'
New-Item -ItemType Directory -Force -Path $stackBin | Out-Null
$env:PATH = "$stackBin;$env:PATH"
pnpm cli lock --repo . --profile herdr-only --target win32-x64 --out ./herdr-only.lock.json
pnpm cli setup --repo . --profile herdr-only --lock ./herdr-only.lock.json --dry-run
pnpm cli setup --repo . --profile herdr-only --lock ./herdr-only.lock.json
```

`HOME` 未设置时使用 `USERPROFILE`；显式设置的 HOME 必须是有效的 Windows 绝对路径。受管目录须归当前用户或管理员所有，且不能允许其他主体写入；权限不符合时 setup 阻塞，不自动修改 ACL。PATH 示例只作用于当前 PowerShell。安装保留 ConPTY、两架构 OpenConsole 和 notices；请保留整个布局，不单独移动 `herdr.exe`。Windows uv、WSL、仿真宿主和完整 coding 仍不支持应用。
