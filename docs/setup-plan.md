# Setup 实施方案：按锁对齐 coding

状态：方案已通过根会话审查；当前实现 macOS uv-only 的只读计划及按锁应用；其他部件与完整 coding 安装尚未实现。先实现受控 CLI 行为，再由根会话逐片审查，不注册占位命令。[CLI 行为稿](cli-behavior.md#setup按已有锁配置或重新对齐设备)描述目标交互，[配置变体](config-variants.md)解释路径设计，[版本锁定](version-locking.md)说明共享锁边界。

## 推荐路径与成功条件

推荐一个公开入口 `setup --repo <root> --profile coding [--lock <file>] [--dry-run] [--yes] [--json]`，复用现有 Commander、呈现、声明读取和锁校验。选定仓库/profile/锁后：**完整离线校验锁 → 检查前置条件与本机 → 生成整份本机计划 → 确认 → 按锁安装和对齐资源 → 检查结果 → 最后登记默认绑定与归属**。普通 setup 不查频道、不重选版本、不修改共享锁。缺失任何必需组件、资源、集成或 adapter 时整份计划阻塞；不能删除 `agent-status` 或忽略 `pi-herdr` 宣称成功。

上下文沿用行为稿的明确优先级：仓库为 `--repo` → `AGENT_STACK_REPO` → 本机登记的仓库 → cwd；profile 为 `--profile` → `AGENT_STACK_PROFILE` → 该仓库的本机绑定。无 profile 时仅可交互 TTY 选择，脚本/JSON 明确指定或使用已登记绑定，不猜 `coding`。锁为 `--lock` → 当前仓库/profile 已登记锁 → `<repo>/stack/stack.lock.json`；显式相对文件相对调用 cwd。临时覆盖不改变绑定，只有完整成功后登记。

`--dry-run` 只观察并展示计划及阻塞，不写工具、配置、PATH、绑定或应用记录；有阻塞返回非零。它不是闭环验收。正常交互展示每项来源、目标、已有归属、覆盖/备份与风险后确认；非交互必须显式 `--yes`，取消返回 130。`--yes` 只同意已显示动作，不覆盖未知归属、冲突或失效基线。JSON 结果与用法错误保持机器可读，进度走 stderr。公开 `plan`/`apply` 和持久计划文件暂不实现：当前消费者只有 setup，一次调用内生成并消费内部计划，避免先建通用执行引擎。

成功必须同时满足 coding 的 Pi、pnpm、uv、herdr 与 `pi-herdr` 必需能力及配置/资源检查；状态集成的受控本地验证通过才可登记成功，不能仅以版本命令或文件存在代替。真实用户会话和付费模型调用不由 setup 自动启动，未观察到的真实会话另列未验证。未实现步骤必须阻塞，即使其他组件已可安装。

## 目标、观察与已有工具

当前 schemaVersion 1 共享锁含 profile、集成、规范声明摘要、Node 确切假设、目标 OS/执行架构/native ABI、部件精确版本与结构化来源、资产身份/URL/预期 SHA-512 SRI 或 SHA-256 及其来源。首次仅接受锁实际覆盖的 `darwin-arm64`、`darwin-x64`、`win32-x64` 原生目标；Linux/WSL、未知 ABI、Windows ARM64 上 x64 仿真及 Rosetta 均阻塞。主机物理架构、运行 CLI 的架构和资产执行架构分别观察；无法可靠区分仿真时阻塞，不能仅以 `process.arch` 推断物理宿主。新机器没有匹配锁时先明确提示维护者生成锁，不在 setup 重解析。锁未记录最低 OS 条件；安装 adapter 必须按确切版本的官方发布证据与实际宿主核对已知必需条件，无法确认必需条件时阻塞，不把缺项当兼容。

先检查当前 Node、npm、Git 可用，当前 Node 必须满足 CLI engines；锁内 `node` 是解析假设，不要求设备安装同一补丁版本。确认后、调用安装器前读取已校验锁定 tarball 的 manifest，核对包名、版本并用 semver 检查当前 Node 对实际 `engines` 的兼容性；对实际安装的 npm 依赖树启用已验证的 engine 检查，再检查安装树内实际 manifest 的 engines。没有要求时不虚构限制，信息未取得时标为待核验/未知，不能当作不兼容；确有不兼容或到发布前仍无法取得必需证据则失败。待下载的 manifest 不妨碍形成标注前置检查的计划，但不允许跳过检查而安装。npm/Git 没有声明范围时只要求可用，不虚构最低版本。命令固定参数、无 shell，受限 cwd/环境、超时与输出上限；pnpm/Corepack 不在业务目录执行可能下载的包装器，Pi 不以可能加载扩展/联网的启动当只读观察。`doctor` 的 metadata 证据不能证明程序可运行。

对 PATH 首个有效入口，计划记录路径、观察版本、证据和来源；来源不明时标 unknown。只在实际入口、锁定确切版本、目标及安全查询均可证明匹配时只读复用，且保留原安装渠道；无法确认匹配、已有版本不符、位置冲突或要修改未知归属时阻塞，不自动接管或覆盖。Node/npm/Git 是前置条件，不由本 CLI 升级。Agent Stack 自身升级与四个部件独立。

## 锁定资产、安装与原生入口

推荐所有新安装进入用户级 Agent Stack 专属版本目录，按组件、确切版本和目标区分；不使用全局 npm prefix 或接管 brew、Corepack 等已有渠道。计划中显示目录、原生入口与 PATH 差异，不能把私有绝对路径放入共享锁。原生 `pi`、`pnpm`/其已证实别名、`uv`/`uvx` 和 `herdr` 仍可直接使用；只建立经对应版本验证的入口。若受管目录不在当前及持久 PATH，计划列出所需用户级 PATH 变更并经确认；冲突、无法安全识别 shell/profile 或 Windows 用户环境写入能力时阻塞，不静默改系统 PATH。当前进程不能修改父 shell：成功结果须区分持久 PATH 已写入和需重启 shell 才生效；结果检查使用按计划构造的子进程环境验证原生入口，另须验证新 shell/用户环境能读取持久 PATH，不能声称已修改父 shell。

共享锁列出的资产下载只使用锁内 URL 和预期 digest，允许的 HTTPS 跳转链、字节和时间上限须固定且逐跳验证；不携带用户凭证，不追 latest。先在同一受管文件系统临时区下载并计算锁定 SHA-512 SRI/SHA-256，再解包到隔离目录；拒绝绝对路径、`..`、逃逸链接、特殊文件、重复目标、解压炸弹与不匹配的资产布局，限制文件数和展开大小。校验前不执行、不发布。目标缺项、digest 不符、网络失败或正在使用/无法安全替换均停止；不用在线安装脚本绕过锁。

- **uv/herdr**：从锁内资产直接部署，核对所选版本/目标的归档内容与入口。官方允许直接获取 [uv release 资产](https://docs.astral.sh/uv/getting-started/installation/#github-releases) 和 [herdr 发行物](https://herdr.dev/tui/docs/install/#download-manually)。Windows herdr 必须保留 zip 内 app-local ConPTY 目录，不只复制 exe；这是整包 digest，不是 exe digest。
- **pnpm**：校验锁内顶层包及所选 exact native 包的各自 SRI，安全解包后读取已校验顶层 tarball 内 manifest，核对目标 native optional dependency 的确切包名/版本与锁一致；读取已校验 native 包的 manifest 核对 OS/CPU、engines 和入口，再按锁定版本已核实的 [native 映射](https://github.com/pnpm/pnpm/blob/v12.15.0/pnpm/npm/pnpm/native-binary.mjs)部署对应二进制；不运行安装脚本来猜入口。是否可安全提供 `pnpx` 等别名、Windows 可执行布局和所选版本兼容性须先逐版本系列验证，缺证据即阻塞。
- **Pi**：校验锁内顶层 tarball 后，在受管 staging prefix 以系统 npm 安装本地 tarball；固定 `--ignore-scripts --engine-strict --no-audit --no-fund`，不传 `--force`，使用精简环境、独立 npmrc 与 cache，不继承用户凭证，限制执行时间和输出。staging 内建立最小私有 npm 项目并保留经摘要校验的本地 tarball，以便 npm 生成根 `package-lock.json`；记录实际 npm 版本与项目 manifest，重试前核对它们与受管文件是否仍匹配，不假定任意 npm 版本都能使用同一 receipt。安装前核对已校验顶层 manifest 的包名、确切版本与当前 Node engines；安装后检查实际依赖树各已安装 manifest 的 engines、顶层身份及生成入口，通过后才发布。npm 的 [`engine-strict`](https://docs.npmjs.com/cli/v11/using-npm/config/#engine-strict) 默认关闭且可被 `--force` 覆盖；[`ignore-scripts`](https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts) 禁止安装时运行 package scripts，不等于通用命令沙箱。若禁用脚本后不能工作，明确失败，不悄悄打开。首片以 npm 11.12.1 为首个 fixture 验证对象：[该版本官方配置定义](https://github.com/npm/cli/blob/v11.12.1/workspaces/config/lib/definitions/definitions.js)包含 `engine-strict` 与 `ignore-scripts`，其 [manifest](https://github.com/npm/cli/blob/v11.12.1/package.json)声明 Node `^20.17.0 || >=22.9.0`，范围包含 Node 24/26；本机只读 `npm --version` 观察到 11.12.1，但本轮未实际安装或验证该组合。实际支持的 npm 版本、Node 24/26 组合和上述参数/树检查须经临时 fixture 实测后公布，不能仅凭版本号宣称支持。

  首次 npm 安装仍可在线解析并获取**未锁定的传递依赖**。安装后、发布前检查实际 [`package-lock.json`](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) 和安装树，记录解析来源、版本及 integrity；保留实际 npm lock 与 receipt 于受限的本机状态目录供同机重试，不把它们冒充共享锁或输出凭证。首版不额外拒绝非 registry 依赖；若解析结果含 git、URL 或本地依赖，发布前如实报告并保留来源记录，不能倒称解析前未访问过这些来源。独立 registry 配置和精简环境不是任意 URL/git 白名单，也不是 OS 网络沙箱；不将 npm `offline`、`ci` 或 registry flag 当隔离保证。锁只固定列出的顶层/原生资产，不能声称闭包跨设备固定或离线安装。摘要错误、凭证继承或意外执行脚本必须失败；正常重跑优先检查并使用本机受管记录，不要求用户反复进行首次证据审查。

版本目录发布采用本地 staging、单独归属记录和不覆盖既有目标的原子发布；配置与 PATH 是独立动作，不宣称跨多个工具事务。执行锁只协调 Agent Stack 自身进程，不能阻止外部程序或编辑器；变更前逐项复核，不支持的文件系统语义明确失败。

## Pi/herdr 资源、路径和归属

首片在 `stack/components/` 为实际消费的配置资源添加最小声明；原生内容留在 `stack/configs/pi/` 的 JSON 和 `stack/configs/herdr/` 的 TOML，source 相对 `stack/`。profile 只选择组合；仅路径不同复用同一 source，内容确实不同才用默认 source 加唯一匹配的平台变体；歧义或不支持必需目标即失败。不使用模板/Shell 求值或无定义的通用深合并。

具名 Pi/herdr adapter 将逻辑目的地解析为实际原生路径，计划显示环境依据。当前 [Pi 配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md)与[源码](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/config.ts)说明 `PI_CODING_AGENT_DIR` 优先，默认 home 下 `.pi/agent/settings.json`；[herdr 当前源码](https://raw.githubusercontent.com/herdrdev/herdr/master/src/config/io.rs)显示 `HERDR_CONFIG_PATH` 指定完整文件，否则 `XDG_CONFIG_HOME`，再按平台 fallback（Windows `APPDATA` 等，macOS/Linux `HOME`）。**当前分支不证明每个历史锁定版本**：实现片须核对确切版本和发布入口，未知则阻塞。设备覆盖与原生 env 冲突须展示并阻止；缺 HOME/APPDATA 等必要信息时不采用源码的 temp fallback。WSL 按 Linux，不自动写 Windows 目录；首片因锁不覆盖 Linux 而阻塞。

针对 Pi settings 与 herdr TOML，各 adapter 明确少量受管字段及语义，不全文件覆盖。未归属字段原样保留；首次遇已有相同值可只读复用并记录来源 unknown，不把它登记成已拥有；已有不同值或已有目标文件但无法安全合并/判断归属则冲突。后续对每个已归属字段或条目，比较实际目标、上次成功写入值和新期望：实际目标等于新期望则 no-op；否则若实际目标仍等于上次成功写入值，则可经计划和确认更新为新期望；其余本地漂移且不等于新期望时冲突，保留本地值。Git 源相对上次应用发生变化是正常更新，不是冲突；`--yes` 不强制覆盖。未知字段、认证、`auth.json`、OAuth、会话和缓存不复制、不读取整份输出、不进入 Git/锁/计划日志。确需修改前仅备份受影响文件并限制本机权限；备份位置及恢复状态写入本机日志，不把凭证打印出来。

现有 `stack/configs/`、`stack/agents/`、`stack/skills/` 都仅有 README，**尚无可应用的 coding 资源**。资源片需补齐经核对的 Pi/herdr 原生默认配置、`stack/agents/` 中实际被运行时加载的 coding 职责及 `shape`、`implement`、`verify` 三个符合标准的 `SKILL.md`，推荐 setup 在 Pi `settings.json` 的 `skills` 数组中只管理指向这三个 checkout 资源的本机路径条目，保留其他条目；`run coding` 在启动时将 `stack/agents/coding.md` 作为附加系统提示传给原生 Pi，不改写用户全局 `AGENTS.md`。当前 [Pi settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#resources) 支持 `skills` 路径，[CLI 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#prompts-and-process)说明 `--append-system-prompt`；确切锁定版本仍须复核，加载结果须在隔离 fixture 验证。checkout 迁移后旧的受管路径不再有效，重新计划并经基线检查后更新；不读取或导入个人 Pi 备份。`pi-herdr` 需按锁定 herdr/Pi 版本核对 [官方 Pi 集成](https://herdr.dev/tui/docs/integrations/#pi)的扩展内容、目标和副作用：当前文档说明扩展位于 Pi agent 目录，受 `PI_CODING_AGENT_DIR` 影响，但不能当作历史版本保证。优先在开发验收时核实锁定版本的官方发布源码或确定的扩展模板，并将经核对、带来源/版本对应关系的资源直接部署；本次计划冻结所用源内容和目标基线。支持的版本/资源对应规则经实现和 fixture 审查后自动复用，正常重跑无需用户重复进行首次证据审查；尚未核实的版本不推断行为。dry-run 不运行集成安装器；若某已支持版本只能通过可信 herdr 原生命令生成，须先在开发验收中核对固定命令、版本和隔离临时 agent 目录的写入清单，确认后仅在该临时目录用固定参数和超时生成，再验证输出并按受管资源发布。精简环境不是 OS 沙箱，不能声称强制禁止联网或额外写入；未核实行为的版本仍阻塞，不向真实用户目录直接调用集成安装命令。扩展与本机已有文件冲突时阻塞。用假本地 socket/进程 fixture 验证状态报告路径和失败，不调用收费模型、不宣称真实会话已运行；未能核实版本资源或生成行为时整体阻塞。

## 本机计划、失败与恢复

计划属于本次设备、不是共享锁或 `apply --plan`；记录锁文件字节摘要、所选声明摘要、源文件内容摘要、已选变体、相关环境变量及归属/路径解析依据、实际目标与目标文件基线、PATH 与入口占用、每个受管动作及预期检测。敏感值不进入日志；必要的 env 比较使用本机内存中的精确值，展示脱敏来源。计划冻结本次读取到的锁、源、目标和环境基线；确认后、下载后和每项写入前重新核对相应前提，计划形成后发生变化即中止，不悄悄重算计划。源相对上次成功应用的变化正常进入新计划，不能与计划后变化混淆；下载只使用已审阅版本。

以用户级互斥锁阻止同设备并发 setup；锁有所有者和恢复提示，进程存活或所有权不明时不删除他人锁。先在本机 journal 记录动作和备份，再原子发布单个受管文件/版本；只清理本次创建的临时物。失败或中断报告已完成、未完成和备份，并给出重跑 setup 或具体人工恢复指引，保留日志以供下次检测；首版不暗示已存在独立恢复命令。不自动删除外部资源或承诺全部回滚。仅当前目标仍与本次成功写入后记录的摘要匹配时允许恢复受管文件，否则保留并提示人工处理。下一次 setup 先识别未完成 journal，复核后恢复或继续；本地内容变更时阻塞。全部结果检查通过后才原子更新默认 repo/profile/lock 引用和最终归属记录；失败不能将部分结果登记为完整成功。重复执行对已匹配版本、资源、PATH 是 no-op；受管字段若既不等于新期望也不等于上次成功写入值，则报告漂移并保留本地内容。

## 实施与真实 CLI 验收

1. **计划及前置只读片**：接收已有锁并完整校验；识别物理宿主/执行架构、Node/npm/Git、工具入口和归属，输出完整阻塞和 dry-run 计划，不写文件。验证当前 Node 与锁假设不同但已校验 manifest engines 允许时可继续；实际 engines 不允许时在安装前失败，未知信息明确待核验。临时 HOME/PATH 及假可执行文件验证新机器、匹配/未知/不匹配入口、锁缺目标、Linux/WSL/仿真、空格中文与无副作用；缺任何后续 adapter 始终阻塞，不能称环境 ready。
2. **按锁 staging 与发布片**：先支持四部件的受控下载、摘要、解包/安装、受管目录和原生入口；通过正常声明构造能力完整的单部件临时 profile，从真实 CLI 使用受控 HTTP/归档/假 npm 逐一验证各 adapter、错误摘要、恶意归档、重定向、锁变化、并发和中断；只在临时目录安装，不加生产测试开关。`coding` 的必要 adapter 尚缺时仍不执行不完整计划。该片不宣称已完成 setup 闭环。
3. **配置、资源与集成片**：加入实际 Pi/herdr 原生配置、coding Agent、三项 skills 和版本化集成 adapter；用真实 CLI、隔离原生目录/假 socket 验证平台路径、env 覆盖、变体、字段归属、凭证不触碰，以及四个三方比较边界：仅源相对上次应用变化可成功更新、目标本地变化冲突、目标与新期望相同时 no-op、计划形成后源变化拒绝旧计划。固定版本的路径/扩展证据不足时阻塞；不能用占位资源通过。
4. **确认、恢复与结果片**：贯通同一内部计划的确认、逐项复核、日志、部分失败恢复、幂等及成功后绑定，测试新机器、既有工具、重复运行、两进程竞争、源/锁/env/目标在确认后变化、每一步故障与重试。真实编译 CLI 从临时环境完成 `setup → doctor`；补齐后续 `run coding` 的资源加载与透传后，再用假 runtime/本地集成完成 `setup → doctor → run coding` 验收。仅部分命令或 dry-run 可用不算首版闭环。

真实平台验收分别记录 macOS、Windows 原生和 Linux/WSL；模拟 `path.win32` 不等于 Windows 实机通过。每片 `pnpm check`、适用时实际 pack/解包并交根会话审查。当前锁**没有**传递依赖闭包、各版本安装脚本/入口可运行性、配置/skills 内容摘要、集成扩展身份、最低 OS 条件或本机归属；资源片用本机计划冻结 Git 内容，版本专属 adapter 补安装与路径证据。若需要可跨设备复现 npm 闭包或独立固定扩展，再单独设计生态原生锁/共享锁扩展和迁移，不能把现有字段解释成已有这些保证。

当前只读预览在 macOS x64 使用 `/usr/bin/arch -x86_64` 启动同架构的固定 sysctl 查询；这确保子进程与 Node 一样需要或不需要 Rosetta。仅接受 `0` 或精确的 ENOENT 输出；其他错误阻塞。macOS arm64 进程为原生。Windows x64 使用固定 PowerShell 内置 `Add-Type` 调用 [`IsWow64Process2`](https://learn.microsoft.com/en-us/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process2)，检查 Node 进程与系统原生架构；调用不可用或返回仿真均阻塞。查询使用临时目录、受限环境、固定参数和有界超时/输出，并在结束时清理。Apple 的 [`sysctl.proc_translated`](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment) 是进程属性；不能使用未控制架构的子进程推断 Node 状态。Windows 原生实机、Rosetta 和 ARM64 仿真仍须实机验证。

当前进度：macOS uv-only 计划显示锁定资产；执行可下载并核对 SHA-256、限制解包和版本验证、创建受管硬链接、记录绑定，并恢复可证明归属的未完成操作。受管目录必须预先存在于 PATH；不修改 shell 配置。Windows、其他部件和完整 coding 仍阻塞。

发行布局核验：以锁中 uv 0.13.8 为例，临时下载的 Intel macOS tar.gz 包含 `uv` 与 `uvx`，Windows x64 zip 还包含 `uvw.exe`；两份 SHA-256 与锁一致。该观察不证明其他版本的布局或安装兼容性；发行格式参见[该版本官方配置](https://github.com/astral-sh/uv/blob/0.13.8/dist-workspace.toml)。

当前 uv adapter 将下载限制为 64 MiB、30 秒和最多四次仅 GitHub release/CDN 的 HTTPS 重定向；使用固定 tar 依赖仅读取已知的两个普通文件，文件内容展开上限 128 MiB、tar 元数据额外上限 1 MiB，拒绝未知路径、重复、链接和特殊文件。每个受管入口使用硬链接 no-clobber 发布；本机锁与恢复日志只协调 Agent Stack，自行修改的文件不会被删除。进程在尚未记录完整所有权或文件内容基线的窗口被强制杀死，或暂存文件被外部修改时，保留不明文件并要求人工检查。确认后与发布前复核锁、声明、绑定、PATH、HOME 和目标目录；外部非协作编辑器仍存在检查与单次文件操作之间的竞争窗口。

受管 uv 回执记录已校验归档的 release ID、asset ID、名称、URL 和 SHA-256；锁中资产变化或旧回执缺少此证据时阻塞，保留现有文件。外部复用仍只有版本证据。过期操作锁的检查和接管使用独占 `operation.guard` 串行化；若进程在持有 guard 时被强制终止，保留该目录并要求人工确认无活跃 setup 后处理，不盲删不明状态。PATH 变更先以静态查找核对首个入口，随后才查询已确认路径；非协作进程仍可能在检查与执行之间修改文件。

## 多部件状态兼容契约

当前 `binding.json` 是 schemaVersion 1 的 uv 专用记录，同时包含默认 repo/profile/lock 和 uv 回执；`pending.json` 与操作锁承载 uv 未完成操作和恢复。它们是已实现格式，不把它们解释成完整 coding 已应用的证明。

后续 Herdr 消费者落地时，应区分四类本机事实：默认绑定仅指向最后完整成功的 repo/profile/lock；部件回执记录实际版本、来源、资产与已验证摘要；资源归属记录实际 checkout 内容摘要、受管字段或条目及上次写入值；未完成 journal 记录操作阶段、可证明的所有权和恢复依据。共享锁仅固定列出的资产，不固定 npm 全依赖闭包或配置正文。

迁移必须识别现有 uv v1 绑定和未完成 journal，先按现有规则恢复或阻塞，再保留 uv 资产证据与外部复用的有限证据；不能凭旧记录推断其他部件或资源已应用。新状态的原子发布、并发和恢复不得削弱现有 uv 保证；失败不得更新完整成功的默认绑定，未知归属和本地漂移保留并报告。profile 切换、资源移除和 checkout 迁移需在真实资源 adapter 中定义三方比较及恢复，不能删除未知内容。具体 schema 随 Herdr 实际消费者实现，不预建空框架。

固定版本调研见 [Herdr](herdr-research.md)、[Pi](pi-research.md) 和 [Otty](otty-research.md)；调研版本是证据快照，安装仍以共享锁为准。Otty 仅有官方在线文档证据，Windows 发行支持尚未确认。

当前 setup 计划会展示已校验共享锁中当前目标的 Herdr 资产名称、URL、格式、预期 SHA-256 和摘要来源；macOS 为 binary，Windows 为 zip。预览不下载资产，预期摘要不代表发行字节已验证。Herdr 安装、部件状态及恢复仍未实现，完整 coding 继续阻塞。

## 本机 v2 状态与复用

`binding.json` 的 v1 输入严格校验后只在内存归一化；读取不写迁移，旧 uv 回执的资产证据原样保留，缺失时不补造。成功写入使用单份 v2 快照：`defaultBinding` 记录最后完整成功的 repo/profile/lock，`installations` 分别保存 uv 与 Herdr 回执。Herdr 本片仅在原生 macOS 复用与锁定版本匹配的已有入口，回执的 `source` 为 `unknown`，入口指纹不代表发行资产摘要已验证。Herdr managed 安装及 Windows 执行尚未实现。

旧 uv v1 journal 继续按旧协议恢复；新 uv v2 journal 在发布入口前记录提交前原始状态摘要和将提交的完整快照摘要，以及 stage、入口和临时文件的身份。当前状态匹配 before 时只撤销可证明归属的本次文件；匹配 after 且回执、stage、入口身份及摘要均一致时保留安装并清理 journal；其他状态或文件变化保留证据并阻塞。状态替换前复核身份与原始字节，但非协作进程仍可能在检查与文件操作之间竞争，这不是文件系统级 CAS。临时文件意图已记录而身份尚不明时，若文件存在则保留并要求人工检查。
