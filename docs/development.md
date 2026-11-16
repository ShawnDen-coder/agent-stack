# 技术栈与开发

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md) · [路线图](roadmap.md)

首版采用单包 TypeScript CLI。开发使用 pnpm，分发目标为 npm；使用者运行编译后的 JavaScript，无需安装 TypeScript 编译器。

## 技术选择

| 部分                       | 选择                           | 原因                                                        |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Runtime                    | Node.js 24+，ESM               | 使用受支持的 LTS 基础，跨 macOS、Windows、Linux 运行        |
| Language                   | TypeScript 7，strict           | 对命令、数据与 adapter 边界做静态检查                       |
| Build                      | 官方 `tsc`，NodeNext           | 当前直接编译即可，保留原生 ESM 与目录关系                   |
| CLI                        | Commander 15                   | 处理子命令、参数、帮助、错误与退出码                        |
| Runtime validation         | Zod 4                          | 校验 Git 中的 YAML/JSON，类型从 schema 推导                 |
| Repository package manager | pnpm 12.15.0                   | 开发依赖使用确切版本和提交的锁文件                          |
| Tests                      | Node.js `node:test` + `assert` | 从编译后的真实 CLI 验证行为，当前无需额外 runner            |
| Format / lint              | Biome 2                        | 统一 TypeScript、JavaScript 与 JSON 检查                    |
| CI                         | GitHub Actions                 | Node 24/26 × Linux、macOS、Windows 检查；Action 固定 commit |

所有 npm 依赖使用确切版本，传递依赖由 `pnpm-lock.yaml` 锁定。开发 pnpm 版本由 `packageManager` 固定；这与 profile 中将来安装到用户环境的 pnpm 要求分别维护。

人编写的 components/profiles/integrations 已采用 YAML 1.2；读取器兼容 `.yml` 与 JSON，并拒绝同 ID 跨格式冲突。原生配置和生态锁保持原格式；首次共享锁、`validate --lock` 离线一致性检查和 setup 本机计划已实现并使用 JSON。首次锁仅记录支持目标的预期元数据与摘要，不证明下载字节、完整依赖闭包或运行兼容性；原生 macOS uv-only/Herdr-only 与 Windows x64 Herdr-only 可按锁安装；Linux ABI、更新、离线解析及其他部件安装尚未实现。

运行下限由 `package.json` 的 engines 定义，CI 使用 Node 24 和 26；支持周期见 [Node 发布计划](https://nodejs.org/en/about/previous-releases)。编译选项参考 [TypeScript Node ESM 指南](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)；校验与测试使用 [Zod](https://zod.dev/) 和 [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)。

## 本地命令

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm cli validate --repo . --json
pnpm check
```

| 命令                                                            | 行为                                             |
| --------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm build`                                                    | 编译 `src/` 到 `dist/`                           |
| `pnpm cli --help`                                               | 运行已编译的 CLI；源码变化后先 build             |
| `pnpm cli doctor --repo . --profile coding`                     | 只读检测部分工具链；先 build                     |
| `pnpm cli lock --repo . --profile coding --target darwin-arm64` | 显式目标首次创建共享锁；不覆盖现有文件；先 build |
| `pnpm cli lock --repo . --profile coding --dry-run`             | 在线读取版本候选；不写锁；先 build               |
| `pnpm validate`                                                 | 从仓库根目录校验当前声明；先 build               |
| `pnpm typecheck`                                                | TypeScript 只读检查                              |
| `pnpm lint`                                                     | Biome 只读检查                                   |
| `pnpm format`                                                   | 格式化支持的文件，不执行工具安装或配置应用       |
| `pnpm test`                                                     | 构建后运行真实 CLI 边界测试                      |
| `pnpm check`                                                    | lint、类型、测试、仓库声明检查                   |

测试使用临时目录和 `process.execPath`，不依赖 Bash 展开命令或本机安装 Pi/herdr/Rex。临时路径刻意含空格；测试结束清理自己的目录。

在 macOS/Linux 运行 `pnpm test` 或 `pnpm check` 还需要 PATH 中有 C 编译器 `cc`，用于编译 herdr 的临时原生测试程序。这是开发测试依赖，使用打包后的 CLI 不需要编译器；Windows 会跳过这些 Unix fixture。

## 添加内容

1. 修改部件/组合/集成：维护对应 YAML，文件名与 `id` 一致，运行 `pnpm check`。
2. 修改 schema：先确认实际消费者与兼容方式，从 schema 推导类型，不维护第二份手写 interface。
3. 添加 adapter：外部 I/O 放入 `src/adapters/`，通过 command 组装；用临时目录或工具原生测试环境验证行为。
4. 添加 CLI 命令：只注册真实可用的能力。当前帮助中不会显示尚未实现的安装/升级命令。
5. 修改配置应用：先定义文件/字段归属、冲突和恢复行为，再实现写入。

## 打包与发布

当前保留 `license: UNLICENSED`，尚未确定 npm 发布名称和授权；尚未正式发布。可以本地检查包内容：

```sh
pnpm build
npm pack --dry-run --ignore-scripts
```

包只分发 CLI 代码，checkout 中的原生配置、profile 和 skills 继续走 Git。发布前另行确定名称、授权、发布检查和版本策略。

## 多系统验证

`Check` 覆盖 Linux/macOS/Windows × Node 24/26 六组组合，验证构建、定义校验和真实 CLI 边界及受控 fixture。`Herdr macOS installation` 另用 `macos-15-intel` 与 `macos-latest` 的原生 x64/arm64、Node 24，实际打包并独立安装 CLI，再下载固定版本官方 Herdr 资产，验证 managed 安装、无下载重跑和隔离 server/IPC。`Herdr Windows installation` 在 Windows x64、Node 24/26 上验证完整七文件 ZIP 安装、原生 ACL、幂等与隔离 server/IPC。只有对应提交的实际运行结果才算证据；这些任务不证明 WSL、GUI、交互式 TUI 或完整 coding 集成通过。

原生 smoke 的接口、固定 metadata 与 live 资产下载分工及验收边界见 [macOS 验收](herdr-macos-smoke.md)和 [Windows 验收](herdr-windows-smoke.md)。runner 标签与架构依据 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

后续增加实际安装/应用时，需要分别验证 Windows 原生与 WSL，并覆盖已有工具、多个 PATH 候选、本地修改、重复应用、失败重试和恢复。不能把 Linux runner 等同于 WSL，也不能通过删除能力要求掩盖替换后的缺口。

`doctor` 以独立临时目录运行固定版本查询，限制 3 秒和 16 KiB 输出；不继承凭证环境变量。pnpm 和 Pi 不执行，只有入口匹配 npm package metadata 时报告声明版本。Windows 批处理入口不执行；标准 cmd-shim v8 / v9 的 Node 和直接目标模板在入口、目标和包元数据均匹配时可静态核对。Node 自带动态 prefix 的 npm.cmd、Corepack 和其他包装器为未核对。该检测不证明集成可用。

入口依据：[npm cmd-shim v8](https://github.com/npm/cmd-shim/blob/v8.0.0/lib/index.js) 与 [当前 cmd-shim](https://github.com/npm/cmd-shim/blob/main/lib/index.js) 的完整模板；[Node 自带 npm.cmd](https://github.com/nodejs/node/blob/main/deps/npm/bin/npm.cmd) 使用动态 prefix；[Corepack](https://github.com/nodejs/corepack) 可能解析并下载工具；[Pi manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) 声明其 bin；[pnpm 发行 manifest](https://github.com/pnpm/pnpm/blob/main/pnpm/npm/pnpm/package.json) 与安装脚本说明入口可替换。本地另核对 `@pnpm/exe@12.15.0` 官方 tarball：manifest 的 `bin.pnpm` 为 `pnpm`，发行入口可在安装时被替换。元数据只证明声明，不证明入口可运行或安装渠道。

herdr 仅在 profile 选择时检查；仅对当前平台的原生可执行文件运行固定 `--version`，文件头检查不能证明文件来源或完整性。脚本和未知包装器不执行，版本查询不证明工作区或集成运行。`stable` 是未解析渠道，不由版本反推。依据：[官方安装文档](https://herdr.dev/tui/docs/install/)列出各平台二进制与 Windows `herdr.exe`；[main.rs](https://github.com/herdrdev/herdr/blob/master/src/main.rs) 的 `--version` 分支在配置加载及服务启动之前输出 `herdr <version>` 并返回；[build_info.rs](https://github.com/herdrdev/herdr/blob/master/src/build_info.rs) 描述版本与预发布后缀。该判断针对所查源码，无法证明任意旧版或被替换的二进制行为。

macOS/Linux 的交互验收还需要 `python3` 标准库的 `pty`；Windows 跳过 PTY 用例。测试从编译后的 CLI 发送真实按键，覆盖 80/40 列、选择、取消与运行中中断；终端演示和覆盖范围见 [验收矩阵](cli-acceptance.md)。

来源解析与 `validate --lock` 共用 `core` 中各来源的 URL、资产身份与摘要规则；只有来源解析负责选择真实版本和核对远端响应。修改规则时同时检查受控来源与离线锁的真实 CLI 回归，不构造假的来源响应作为锁校验路径。

`lock-resolution` 汇集已有来源 adapter 的版本结果和本次快照，再按目标收集资产；命令层负责单次操作的中断与呈现，复核复用同一快照。测试应从真实 CLI 验证解析、取消和发布结果，尤其区分发布前取消与发布后的结果；不要为未来来源预建注册框架。

网络响应体共用有界读取，但 npm、herdr 与 uv 的预算、超时和错误是各自契约。重查回归使用按 URL 的受控响应快照与请求次数，在真实 CLI 中比较结果；锁文件读取和需要真实终端的测试仍分别处理。

Windows 架构观察的常规回归调用实际 probe，覆盖并发重复查询和无效 PID 失败关闭。旧 Add-Type 链路的阶段与环境对照保留为[手动诊断](windows-host-probe-diagnostics.md)，不再附加到每次 PR 的 Check。

### 独立二进制与版本实验

`pnpm build:binary` 使用 Node 26 的 SEA 构建当前平台的 `binary/agent-stack`（Windows 为 `.exe`）；普通 npm CLI 仍要求 Node 24+。`pnpm verify:binary` 将二进制和声明复制到临时目录，在没有外部 Node 的 PATH 中检查 help、version 和 validate。CI 定义了四个平台的原生构建；以具体 CI 运行结果为准。macOS 构建使用 ad-hoc 签名，不是 Apple 公证；Windows 构建未签名。共享配置与 skills 仍由独立 Git checkout 提供。安装外部工具仍可能需要外部 Node、npm 和 Git。

二进制构建把 Node 自带 LICENSE 和所有声明的运行依赖许可及 NOTICE 放进 `binary/licenses/`；依据 esbuild 输入图与运行依赖闭包收集，以覆盖依赖自身预打包的代码。`node scripts/package-binary.mjs <platform-arch>` 把二进制和这些材料归档，解包后在隔离目录重跑 smoke，并生成 SHA-256。Node 安装目录找不到 LICENSE 时构建失败；如本地 Node 发行方式将许可放在其他位置，可用 `NODE_LICENSE_FILE` 指向该 Node 发行包的原始 LICENSE。

`cog.toml` 使用裸 SemVer tag 与 pre-bump hook 同步 package version，Cocogitto 生成 changelog 和版本提交。首次建立版本时须先核对发布基线，再显式运行 `cog bump --version 0.1.0`；后续可使用 `cog bump --auto`。这些命令会创建本地提交和 tag，但不会推送或发布。pre-bump 失败时检查 Cocogitto 留下的 stash，不能假定修改已自动恢复。当前项目尚无正式发布 tag；发布前仍需明确 npm 名称、许可和受信任发布配置。

### 受控发布流程

仓库尚未正式发布；`agent-stack` 只是当前包名，发布前必须确认其 npm 所有权、最终名称与授权。`UNLICENSED` 不表示项目已授予开源许可。发布名称改变时同时修改 `package.json` 并重新核对 npm trusted publisher；不改变 `bin.agent-stack` 入口。

发布 workflow `.github/workflows/release.yml` 只在本仓库推送裸 SemVer tag 时运行；PR 和 fork 只运行普通验证。支持正式版及预发布后缀，不接受 `v` 前缀或 build metadata。它要求 tag 指向本次事件的确切 commit、package version 与 tag 相同、该 commit 是远端 `master` 的祖先。此校验依赖仓库管理员保护 `master`、限制 tag 创建/修改及确保合入经过审查；祖先关系本身不证明审查已经发生。发布前两次重新抓取并核对 tag 与 master，tag 在操作期间发生变更将失败。

版本流程：本地运行 `cog bump --auto`（首次显式版本），检查生成的版本提交、tag 和 changelog；将版本提交通过受审 PR 合入 `master`，保留该 commit 身份；确认 tag 指向已合入的确切 commit 后，再按另行授权推送 tag。不可在版本提交进入 `master` 前推送 tag。PR squash 或 rebase 会改变 commit，必须重新核对版本和 tag 身份。该 workflow 不创建或推送 tag。

构建 job 运行 `pnpm check`，只打包一次 npm tarball 并从该 tarball 实际独立安装验证；四个平台原生构建 SEA、归档许可材料并从解包归档运行 smoke。发布 job 下载上述产物并核对 SHA-256；npm 发布直接消费验收 tarball，GitHub Release 附带同一个包、四个二进制归档和 `SHA256SUMS`。macOS 为 ad-hoc 签名而非公证，Windows 未签名。目标平台的成功以实际 CI 运行结果为准。

发布前的外部配置，均未由本仓库自动完成：

1. 确认 npm 包名和账号/组织拥有权，处理首次包注册及最终许可；当前不能假定 `agent-stack` 可注册或属于本项目。
2. 在 GitHub 配置并保护 `release` environment，限制可信 tag、配置必要审批；保护 `master` 及 tag。限制可执行 Actions 为本 workflow 所需的固定 SHA。
3. 在 npm 包设置添加 GitHub Actions trusted publisher：owner `ShawnDen-coder`、repository `agent-stack`、workflow 文件 `release.yml`、environment `release`，并明确允许 `npm publish`。npm 要求 Node >=22.14 和 npm >=11.5.1；发布 job 使用 Node 26 并检查 npm 版本。新 trusted publisher 配置需在 npm 规定期限内完成首次成功发布。无需在仓库保存 token；首次注册是否可直接使用 OIDC 取决于 npm 账户和包状态，先按 npm 当前流程完成配置。
4. tag 推送和正式发布须另行授权。本地 `cog bump`、构建及校验不会推送或发布。

npm 查询只把明确的 HTTP 404 视为版本不存在；已有版本只有 registry `dist.integrity` 与待发布 tarball 的 SHA-512 完全一致时才跳过。权限、限流、网络、错误响应和内容不一致均中止。预发布进入 `next` dist-tag，正式版进入 `latest`。若 npm 已发布但 GitHub Release 创建失败，重跑会先核对 npm integrity；已存在的 GitHub Release 不会覆盖，需由维护者检查处理。
