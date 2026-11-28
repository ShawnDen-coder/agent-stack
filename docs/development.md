# 技术栈与开发

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md) · [路线图](roadmap.md)

首版采用单包 TypeScript CLI。开发使用 pnpm，分发目标包括 npm 与独立 SEA；使用者运行编译后的 JavaScript 或 SEA 二进制，无需安装 TypeScript 编译器。

## 技术选择

| 部分                       | 选择                           | 原因                                                       |
| -------------------------- | ------------------------------ | ---------------------------------------------------------- |
| Runtime                    | Node.js 24+，ESM               | 使用受支持的 LTS 基础，跨 macOS、Windows、Linux 运行       |
| Language                   | TypeScript 7，strict           | 对命令、数据与 adapter 边界做静态检查                      |
| Build                      | 官方 `tsc`，NodeNext           | 当前直接编译即可，保留原生 ESM 与目录关系                  |
| CLI                        | Commander 15                   | 处理子命令、参数、帮助、错误与退出码                       |
| Runtime validation         | Zod 4                          | 校验 Git 中的 YAML/JSON，类型从 schema 推导                |
| Repository package manager | pnpm 12.15.0                   | 开发依赖使用确切版本和提交的锁文件                         |
| Tests                      | Node.js `node:test` + `assert` | 从编译后的真实 CLI 验证行为，当前无需额外 runner           |
| Format / lint              | Biome 2                        | 统一 TypeScript、JavaScript 与 JSON 检查                   |
| CI                         | GitHub Actions                 | Node 24.x × Linux、macOS、Windows 检查，Action 固定 commit |

所有 npm 依赖使用确切版本，传递依赖由 `pnpm-lock.yaml` 锁定。开发 pnpm 版本由 `packageManager` 固定；这与 profile 中将来安装到用户环境的 pnpm 要求分别维护。

人编写的 components/profiles/integrations 已采用 YAML 1.2；读取器兼容 `.yml` 与 JSON，并拒绝同 ID 跨格式冲突。原生配置和生态锁保持原格式；首次共享锁、`validate --lock` 离线一致性检查和 setup 本机计划已实现并使用 JSON。首次锁仅记录支持目标的预期元数据与摘要，不证明下载字节、完整依赖闭包或运行兼容性；原生 macOS arm64/x64 支持完整 coding 及 uv-only/Herdr-only，Windows x64 支持 Herdr-only；Linux ABI、更新、离线解析及其他系统的完整 coding 尚未实现。

运行下限由 `package.json` 的 engines 定义，CI 的单元测试使用 Node 24.x 的最新稳定补丁版。支持周期见 [Node 发布计划](https://nodejs.org/en/about/previous-releases)。编译选项参考 [TypeScript Node ESM 指南](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)；校验与测试使用 [Zod](https://zod.dev/) 和 [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)。

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
| `pnpm cli doctor --repo . --profile coding`                     | 只读核对工具及已绑定 coding 的验收证据；先 build |
| `pnpm cli setup --repo . --profile coding --dry-run`            | 预览本机锁定计划，不安装；先 build               |
| `pnpm cli run --repo . coding --dry-run --json`                 | 预览 coding 启动并检查当前 Herdr pane；先 build  |
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
4. 添加 CLI 命令：只注册真实可用的能力。当前帮助只显示已实现的命令，不显示尚未实现的升级命令。
5. 修改配置应用：先定义文件/字段归属、冲突和恢复行为，再实现写入。

## 打包与发布

根包 `@shawnden-coder/agent-stack` 的发布目标为 GitHub Packages，许可为 `UNLICENSED`。在本地检查文件清单并验证独立安装：

```sh
pnpm build
npm pack --dry-run --ignore-scripts
pnpm verify:package
```

包只分发 CLI 代码，checkout 中的原生配置、profile、Agent 和 skills 继续走 Git。版本与发布步骤见下文。

## 多系统验证

`Check` workflow 配置 Linux、macOS、Windows 三组作业，每组使用 Node 24.x，用于验证构建、定义校验和真实 CLI 边界及受控 fixture；当前候选的最终结果以实际运行记录为准。`Herdr macOS installation` 另用 `macos-15-intel` 与 `macos-latest` 的原生 x64/arm64、Node 24，实际打包并独立安装 CLI，再下载固定版本官方 Herdr 资产，验证 managed 安装、无下载重跑和隔离 server/IPC。`Herdr Windows installation` 在 Windows x64、Node 24.x 上验证完整七文件 ZIP 安装、原生 ACL、幂等与隔离 server/IPC。只有对应提交的实际运行结果才算证据；这些任务不证明 WSL、GUI、交互式 TUI 或完整 coding 集成通过。

原生 smoke 的接口、固定 metadata 与 live 资产下载分工及验收边界见 [macOS 验收](herdr-macos-smoke.md)和 [Windows 验收](herdr-windows-smoke.md)。runner 标签与架构依据 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

后续增加实际安装/应用时，需要分别验证 Windows 原生与 WSL，并覆盖已有工具、多个 PATH 候选、本地修改、重复应用、失败重试和恢复。不能把 Linux runner 等同于 WSL，也不能通过删除能力要求掩盖替换后的缺口。

`doctor` 的一般工具观察以独立临时目录运行固定版本查询，限制 3 秒和 16 KiB 输出；不继承凭证环境变量。它不执行未知 Pi，pnpm 和 Pi 可通过入口与 npm package metadata 的匹配观察声明版本。对于已绑定 coding，另核对锁、回执、受管整树、资源和历史隔离 TUI 签名；不会据此声称本次重新运行了 TUI。Windows 批处理入口不执行；标准 cmd-shim v8 / v9 的 Node 和直接目标模板在入口、目标和包元数据均匹配时可静态核对。Node 自带动态 prefix 的 npm.cmd、Corepack 和其他包装器为未核对。该检测不证明集成可用。

入口依据：[npm cmd-shim v8](https://github.com/npm/cmd-shim/blob/v8.0.0/lib/index.js) 与 [当前 cmd-shim](https://github.com/npm/cmd-shim/blob/main/lib/index.js) 的完整模板；[Node 自带 npm.cmd](https://github.com/nodejs/node/blob/main/deps/npm/bin/npm.cmd) 使用动态 prefix；[Corepack](https://github.com/nodejs/corepack) 可能解析并下载工具；[Pi manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) 声明其 bin；[pnpm 发行 manifest](https://github.com/pnpm/pnpm/blob/main/pnpm/npm/pnpm/package.json) 与安装脚本说明入口可替换。本地另核对 `@pnpm/exe@12.15.0` 官方 tarball：manifest 的 `bin.pnpm` 为 `pnpm`，发行入口可在安装时被替换。元数据只证明声明，不证明入口可运行或安装渠道。

herdr 仅在 profile 选择时检查；仅对当前平台的原生可执行文件运行固定 `--version`，文件头检查不能证明文件来源或完整性。脚本和未知包装器不执行，版本查询不证明工作区或集成运行。`stable` 是未解析渠道，不由版本反推。依据：[官方安装文档](https://herdr.dev/tui/docs/install/)列出各平台二进制与 Windows `herdr.exe`；[main.rs](https://github.com/herdrdev/herdr/blob/master/src/main.rs) 的 `--version` 分支在配置加载及服务启动之前输出 `herdr <version>` 并返回；[build_info.rs](https://github.com/herdrdev/herdr/blob/master/src/build_info.rs) 描述版本与预发布后缀。该判断针对所查源码，无法证明任意旧版或被替换的二进制行为。

macOS/Linux 的交互验收还需要 `python3` 标准库的 `pty`；Windows 跳过 PTY 用例。测试从编译后的 CLI 发送真实按键，覆盖 80/40 列、选择、取消与运行中中断；终端演示和覆盖范围见 [验收矩阵](cli-acceptance.md)。

来源解析与 `validate --lock` 共用 `core` 中各来源的 URL、资产身份与摘要规则；只有来源解析负责选择真实版本和核对远端响应。修改规则时同时检查受控来源与离线锁的真实 CLI 回归，不构造假的来源响应作为锁校验路径。

`lock-resolution` 汇集已有来源 adapter 的版本结果和本次快照，再按目标收集资产；命令层负责单次操作的中断与呈现，复核复用同一快照。测试应从真实 CLI 验证解析、取消和发布结果，尤其区分发布前取消与发布后的结果；不要为未来来源预建注册框架。

网络响应体共用有界读取，但 npm、herdr 与 uv 的预算、超时和错误是各自契约。重查回归使用按 URL 的受控响应快照与请求次数，在真实 CLI 中比较结果；锁文件读取和需要真实终端的测试仍分别处理。

Windows 架构观察的常规回归调用实际 probe，覆盖并发重复查询和无效 PID 失败关闭。旧 Add-Type 链路的阶段与环境对照保留为[手动诊断](windows-host-probe-diagnostics.md)，不再附加到每次 PR 的 Check。

### 独立二进制与版本

`pnpm build:binary` 使用 Node 26 的 SEA 构建当前平台的 `binary/agent-stack`（Windows 为 `.exe`）；普通 npm CLI 仍要求 Node 24+。`pnpm verify:binary` 将二进制和声明复制到临时目录，在没有外部 Node 的 PATH 中检查 help、version 和 validate。CI 定义了四个平台的原生构建；以具体 CI 运行结果为准。macOS 构建使用 ad-hoc 签名，不是 Apple 公证；Windows 构建未签名。共享配置与 skills 仍由独立 Git checkout 提供。安装外部工具仍可能需要外部 Node、npm 和 Git。

二进制构建把 Node 自带 LICENSE 和所有声明的运行依赖许可及 NOTICE 放进 `binary/licenses/`；依据 esbuild 输入图与运行依赖闭包收集，以覆盖依赖自身预打包的代码。`node scripts/package-binary.mjs <platform-arch>` 把二进制和这些材料归档，解包后在隔离目录重跑 smoke，并生成 SHA-256。Node 安装目录找不到 LICENSE 时构建失败；如本地 Node 发行方式将许可放在其他位置，可用 `NODE_LICENSE_FILE` 指向该 Node 发行包的原始 LICENSE。

首版基线为 `0.1.0`。使用 SemVer 的 `MAJOR.MINOR.PATCH`，修复递增 patch，兼容的新功能递增 minor。1.0.0 起，不兼容的公共 CLI 或 JSON 接口变更递增 major。预发布可使用 `0.2.0-rc.1` 这样的版本。

### 受控发布流程

1. 首次运行 `cog bump --version 0.1.0`，后续根据 Conventional Commits 运行 `cog bump --auto`，审查版本、changelog 和 tag。`cog.toml` 的 pre-bump hook 将版本写入 `package.json`。若 hook 失败，检查 Cocogitto 留下的 stash。
2. 将版本提交通过 PR 合入 `master`，检查版本 tag 指向已合入的 commit。使用 squash 或 rebase 合入时，要按合入后的 commit 复核本地 tag。
3. 在获得本次发布授权后，单独推送对应的裸 SemVer tag，例如 `git push origin refs/tags/0.1.0`。`.github/workflows/release.yml` 核对 tag、package version、事件 SHA 和远端 `master` 祖先关系。发布 tag 支持预发布后缀，不接受 `v` 前缀或 build metadata。

npm 构建 job 在 Node 24.x 上运行 `pnpm check`，打包一次并从该 tarball 独立安装验证。四个平台使用 Node 26 原生编译 SEA，再切换到 Node 24.x 运行产物验收并归档许可材料。发布 job 下载上述产物并核对 SHA-256；npm 发布直接消费验收 tarball，GitHub Release 附带同一个包、四个二进制归档和 `SHA256SUMS`。macOS 为 ad-hoc 签名而非公证，Windows 未签名。目标平台的成功以实际 CI 运行结果为准。

发布 job 通过 `packages: write` 和临时 `GITHUB_TOKEN` 将验收过的 tarball 上传到 `https://npm.pkg.github.com`。包名为 `@shawnden-coder/agent-stack`，`repository.url` 将它关联到本仓库。GitHub Packages 首次发布默认私有，读取权限和可见性在包设置中管理。仓库管理员可为 `release` environment、`master` 和版本 tag 设置保护规则。[GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)

发布前会用同一凭证查包。registry 返回 404 或有效包元数据中缺少目标版本时执行上传。重跑相同版本时，仅当已有版本的 SHA-512 integrity 与验收 tarball 一致才跳过上传。认证失败、网络错误或内容不一致会中止发布。预发布使用 `next`，正式版使用 `latest`。若 GitHub Release 创建失败，可重跑失败的 job，已存在的 Release 需由维护者检查。

### coding 安装 smoke 的共享锁 fixture

macOS npm/SEA 安装 smoke 与用户 checkout 共用由生产 CLI 解析生成并离线校验的 [双架构 coding 锁 fixture](../test/fixtures/coding-lock/README.md)。CI 复制整个默认 stack，核对锁与当前声明，再实际下载并验证锁定发行资产，执行 setup、隔离 TUI、doctor、run 和幂等检查；它不再在每个矩阵任务重复联网解析版本目录。版本来源解析、fixture 生成与每次真实安装/运行属于不同证据；更新 fixture 按链接中的流程生成候选、审查并复核，不手填 digest 或资产 ID。CI 的 setup、npm 和 SEA 不接收 metadata 认证 token。
