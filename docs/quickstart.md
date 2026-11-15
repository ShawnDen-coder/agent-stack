# Quickstart：从源码试用

当前包为 `private`、`UNLICENSED`，尚未发布 npm；本指南使用源码 checkout，不安装同名公开包。前半部分介绍声明检查、工具检测与共享锁；文末的 macOS uv-only/Herdr-only setup 会安装或复用对应工具，并记录本机绑定。完整 coding 和配置应用仍未实现。`pnpm install` 安装的是 CLI 自身的依赖。

## 准备与获取源码

准备 Node.js 24 或更高版本（含 npm）、Git，以及 `packageManager` 指定的 pnpm 12.15.0。先用 `node --version`、`npm --version`、`git --version` 检查。尚未安装 pnpm 时，可通过 npm 安装对应版本；已有 pnpm 时，先检查版本并沿用自己的安装渠道：

```sh
npm install --global pnpm@12.15.0
pnpm --version
```

确认输出为 `12.15.0` 后继续。版本不符时先检查 PATH 中的 pnpm 入口；项目不会替你安装前置工具。

基础 CLI 已合入 `master`；试用本指南中的原生 macOS uv/Herdr 按锁安装与 v2 设备状态，请检出 `herdr-macos-install` 分支。以下命令可用于 macOS/Linux shell 与 Windows PowerShell：

```sh
git clone --branch herdr-macos-install https://github.com/ShawnDen-coder/agent-stack.git
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

继续阅读 [CLI 行为与验收](cli-acceptance.md)、[架构](architecture.md)、[配置变体提案](config-variants.md)、[开发和打包](development.md)及 [roadmap](roadmap.md)。原生 macOS 的 uv-only setup 可安装或复用 uv，Herdr-only 可按锁安装或复用匹配的已有入口；其他安装、`run coding`、锁更新和配置应用尚未实现。

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

已有完整共享锁时，可运行 `node dist/cli.js setup --repo . --profile coding --dry-run` 离线预览；该命令不安装或应用配置，未实现步骤会导致退出码 1。支持检测原生 macOS arm64/x64 和 Windows x64；未知或仿真宿主阻塞。`--lock` 指向候选锁时相对当前目录解析。

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

Windows zip、Linux/WSL、仿真、完整 coding 和其他安装 adapter 尚不可应用。异常中断后重跑可恢复已记录的受管操作；若本机记录不完整或目标已被更改，保留文件并提示人工检查。


## macOS 的 Herdr-only setup

在独立 checkout 的 `stack/profiles/herdr-only.yaml` 创建组合：

```yaml
schemaVersion: 1
id: herdr-only
description: Herdr workspace
platforms: [darwin]
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

脚本执行可加 `--yes`。安装核对锁中的 SHA-256、Mach-O 架构及版本，发布 Herdr 受管入口和 v2 回执；匹配的已有原生入口可 external 复用，来源仍为 unknown。重复执行会复核文件与锁，不重新下载匹配的受管安装。下载、确认后漂移或恢复冲突会失败并保留需要人工核查的证据；`--yes` 不覆盖未知入口或本地修改。

此 profile 只安装 workspace 工具，不启用 Pi 集成或 coding 配置。setup 不启动、停止或迁移用户的 Herdr server，也不导入会话或认证。Windows ZIP 安装尚未实现；未知、仿真宿主或锁中缺少当前目标时继续阻塞。
