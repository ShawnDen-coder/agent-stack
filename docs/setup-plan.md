# Setup 实施方案：按锁对齐 coding

状态：方案待根会话审查；`setup`、计划执行和安装均未实现。先实现受控 CLI 行为，再由根会话逐片审查，不注册占位命令。[CLI 行为稿](cli-behavior.md#setup按已有锁配置或重新对齐设备)描述目标交互，[配置变体](config-variants.md)解释路径设计，[版本锁定](version-locking.md)说明共享锁边界。

## 推荐路径与成功条件

推荐一个公开入口 `setup --repo <root> --profile coding [--lock <file>] [--dry-run] [--yes] [--json]`，复用现有 Commander、呈现、声明读取和锁校验。选定仓库/profile/锁后：**完整离线校验锁 → 检查前置条件与本机 → 生成整份本机计划 → 确认 → 按锁安装和对齐资源 → 检查结果 → 最后登记默认绑定与归属**。普通 setup 不查频道、不重选版本、不修改共享锁。缺失任何必需组件、资源、集成或 adapter 时整份计划阻塞；不能删除 `agent-status` 或忽略 `pi-herdr` 宣称成功。

上下文沿用行为稿的明确优先级：仓库为 `--repo` → `AGENT_STACK_REPO` → 本机登记的仓库 → cwd；profile 为 `--profile` → `AGENT_STACK_PROFILE` → 该仓库的本机绑定。无 profile 时仅可交互 TTY 选择，脚本/JSON 明确指定或使用已登记绑定，不猜 `coding`。锁为 `--lock` → 当前仓库/profile 已登记锁 → `<repo>/stack/stack.lock.json`；显式相对文件相对调用 cwd。临时覆盖不改变绑定，只有完整成功后登记。

`--dry-run` 只观察并展示计划及阻塞，不写工具、配置、PATH、绑定或应用记录；有阻塞返回非零。它不是闭环验收。正常交互展示每项来源、目标、已有归属、覆盖/备份与风险后确认；非交互必须显式 `--yes`，取消返回 130。`--yes` 只同意已显示动作，不覆盖未知归属、冲突或失效基线。JSON 结果与用法错误保持机器可读，进度走 stderr。公开 `plan`/`apply` 和持久计划文件暂不实现：当前消费者只有 setup，一次调用内生成并消费内部计划，避免先建通用执行引擎。

成功必须同时满足 coding 的 Pi、pnpm、uv、herdr 与 `pi-herdr` 必需能力及配置/资源检查；状态集成的受控本地验证通过才可登记成功，不能仅以版本命令或文件存在代替。真实用户会话和付费模型调用不由 setup 自动启动，未观察到的真实会话另列未验证。未实现步骤必须阻塞，即使其他组件已可安装。

## 目标、观察与已有工具

当前 schemaVersion 1 共享锁含 profile、集成、规范声明摘要、Node 确切假设、目标 OS/执行架构/native ABI、部件精确版本与结构化来源、资产身份/URL/预期 SHA-512 SRI 或 SHA-256 及其来源。首次仅接受锁实际覆盖的 `darwin-arm64`、`darwin-x64`、`win32-x64` 原生目标；Linux/WSL、未知 ABI、Windows ARM64 上 x64 仿真及 Rosetta 均阻塞。主机物理架构、运行 CLI 的架构和资产执行架构分别观察；无法可靠区分仿真时阻塞，不能仅以 `process.arch` 推断物理宿主。新机器没有匹配锁时先明确提示维护者生成锁，不在 setup 重解析。锁未记录最低 OS 条件；安装 adapter 必须按确切版本的官方发布证据与实际宿主核对已知必需条件，无法确认必需条件时阻塞，不把缺项当兼容。

先检查当前 Node、npm、Git 可用；Node 满足 CLI engines，首片保守要求当前 Node 确切版本等于锁假设，之后若要放宽须先补锁定版本的 engines 证据。npm/Git 没有声明范围时只要求可用，不虚构最低版本。命令固定参数、无 shell，受限 cwd/环境、超时与输出上限；pnpm/Corepack 不在业务目录执行可能下载的包装器，Pi 不以可能加载扩展/联网的启动当只读观察。`doctor` 的 metadata 证据不能证明程序可运行。

对 PATH 首个有效入口，计划记录路径、观察版本、证据和来源；来源不明时标 unknown。只在实际入口、锁定确切版本、目标及安全查询均可证明匹配时只读复用，且保留原安装渠道；无法确认匹配、已有版本不符、位置冲突或要修改未知归属时阻塞，不自动接管或覆盖。Node/npm/Git 是前置条件，不由本 CLI 升级。Agent Stack 自身升级与四个部件独立。

## 锁定资产、安装与原生入口

推荐所有新安装进入用户级 Agent Stack 专属版本目录，按组件、确切版本和目标区分；不使用全局 npm prefix 或接管 brew、Corepack 等已有渠道。计划中显示目录、原生入口与 PATH 差异，不能把私有绝对路径放入共享锁。原生 `pi`、`pnpm`/其已证实别名、`uv`/`uvx` 和 `herdr` 仍可直接使用；只建立经对应版本验证的入口。若受管目录不在当前及持久 PATH，计划列出所需用户级 PATH 变更并经确认；冲突、无法安全识别 shell/profile 或 Windows 用户环境写入能力时阻塞，不静默改系统 PATH。当前进程不能修改父 shell：成功结果须区分持久 PATH 已写入和需重启 shell 才生效；结果检查使用按计划构造的子进程环境验证原生入口，另须验证新 shell/用户环境能读取持久 PATH，不能声称已修改父 shell。

所有下载只使用锁内 URL 和预期 digest，允许的 HTTPS 跳转链、字节和时间上限须固定且逐跳验证；不携带用户凭证，不追 latest。先在同一受管文件系统临时区下载并计算锁定 SHA-512 SRI/SHA-256，再解包到隔离目录；拒绝绝对路径、`..`、逃逸链接、特殊文件、重复目标、解压炸弹与不匹配的资产布局，限制文件数和展开大小。校验前不执行、不发布。目标缺项、digest 不符、网络失败或正在使用/无法安全替换均停止；不用在线安装脚本绕过锁。

- **uv/herdr**：从锁内资产直接部署，核对所选版本/目标的归档内容与入口。官方允许直接获取 [uv release 资产](https://docs.astral.sh/uv/getting-started/installation/#github-releases) 和 [herdr 发行物](https://herdr.dev/tui/docs/install/#download-manually)。Windows herdr 必须保留 zip 内 app-local ConPTY 目录，不只复制 exe；这是整包 digest，不是 exe digest。
- **pnpm**：校验锁内顶层包及所选 exact native 包的各自 SRI，安全解包后读取已校验顶层 tarball 内 manifest，核对目标 native optional dependency 的确切包名/版本与锁一致；读取已校验 native 包的 manifest 核对 OS/CPU、engines 和入口，再按锁定版本已核实的 [native 映射](https://github.com/pnpm/pnpm/blob/v12.15.0/pnpm/npm/pnpm/native-binary.mjs)部署对应二进制；不运行安装脚本来猜入口。是否可安全提供 `pnpx` 等别名、Windows 可执行布局和所选版本兼容性须先逐版本系列验证，缺证据即阻塞。
- **Pi**：校验锁内顶层 tarball 后，用系统 npm 在隔离的受管 staging prefix 安装该本地 tarball，固定 `--ignore-scripts`、关闭 audit/fund 等附加行为，隔离用户 npmrc、cache 和认证，受限超时及输出；先从已校验包内 manifest 核对包名、确切版本、Node engines 和锁定 Node 假设，安装后验证 npm 产生的入口与包身份才发布；传递依赖若需要被禁用的脚本而无法工作则阻塞。官方当前 [Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)说明 npm 安装可禁用脚本，但这一点须对锁定的确切版本复核。npm 仍可能解析和下载**未锁定的传递依赖**；安装 adapter 必须以精简 PATH/环境和经平台验证的进程网络限制约束子进程只访问可信 npm registry，拒绝 git、任意 URL、本地依赖或凭证继承，并在临时 fixture 证明 npm 的传递解析不能绕开该边界；做不到时阻塞而不是假装隔离。锁只固定列出的顶层/原生资产，不能声称闭包可复现或离线安装。若环境不允许该网络或缺安全安装证据，整份 setup 阻塞。

版本目录发布采用本地 staging、单独归属记录和不覆盖既有目标的原子发布；配置与 PATH 是独立动作，不宣称跨多个工具事务。执行锁只协调 Agent Stack 自身进程，不能阻止外部程序或编辑器；变更前逐项复核，不支持的文件系统语义明确失败。

## Pi/herdr 资源、路径和归属

首片在 `stack/components/` 为实际消费的配置资源添加最小声明；原生内容留在 `stack/configs/pi/` 的 JSON 和 `stack/configs/herdr/` 的 TOML，source 相对 `stack/`。profile 只选择组合；仅路径不同复用同一 source，内容确实不同才用默认 source 加唯一匹配的平台变体；歧义或不支持必需目标即失败。不使用模板/Shell 求值或无定义的通用深合并。

具名 Pi/herdr adapter 将逻辑目的地解析为实际原生路径，计划显示环境依据。当前 [Pi 配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md)与[源码](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/config.ts)说明 `PI_CODING_AGENT_DIR` 优先，默认 home 下 `.pi/agent/settings.json`；[herdr 当前源码](https://raw.githubusercontent.com/herdrdev/herdr/master/src/config/io.rs)显示 `HERDR_CONFIG_PATH` 指定完整文件，否则 `XDG_CONFIG_HOME`，再按平台 fallback（Windows `APPDATA` 等，macOS/Linux `HOME`）。**当前分支不证明每个历史锁定版本**：实现片须核对确切版本和发布入口，未知则阻塞。设备覆盖与原生 env 冲突须展示并阻止；缺 HOME/APPDATA 等必要信息时不采用源码的 temp fallback。WSL 按 Linux，不自动写 Windows 目录；首片因锁不覆盖 Linux 而阻塞。

针对 Pi settings 与 herdr TOML，各 adapter 明确少量受管字段及语义，不全文件覆盖。未归属字段原样保留；首次遇已有相同值可只读复用并记录来源 unknown，不把它登记成已拥有；已有不同值或已有目标文件但无法安全合并/判断归属则冲突。后续以设备记录的上次写入基线做三方比较：源、目标或受管字段均未变才更新；用户本地修改则阻塞，不能用 `--yes` 强制。未知字段、认证、`auth.json`、OAuth、会话和缓存不复制、不读取整份输出、不进入 Git/锁/计划日志。确需修改前仅备份受影响文件并限制本机权限；备份位置及恢复状态写入本机日志，不把凭证打印出来。

现有 `stack/configs/`、`stack/agents/`、`stack/skills/` 都仅有 README，**尚无可应用的 coding 资源**。资源片需补齐经核对的 Pi/herdr 原生默认配置、`stack/agents/` 中实际被运行时加载的 coding 职责及 `shape`、`implement`、`verify` 三个符合标准的 `SKILL.md`，推荐 setup 在 Pi `settings.json` 的 `skills` 数组中只管理指向这三个 checkout 资源的本机路径条目，保留其他条目；`run coding` 在启动时将 `stack/agents/coding.md` 作为附加系统提示传给原生 Pi，不改写用户全局 `AGENTS.md`。当前 [Pi settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#resources) 支持 `skills` 路径，[CLI 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#prompts-and-process)说明 `--append-system-prompt`；确切锁定版本仍须复核，加载结果须在隔离 fixture 验证。checkout 迁移后旧的受管路径不再有效，重新计划并经基线检查后更新；不读取或导入个人 Pi 备份。`pi-herdr` 需按锁定 herdr/Pi 版本核对 [官方 Pi 集成](https://herdr.dev/tui/docs/integrations/#pi)的扩展内容、目标和副作用：当前文档说明扩展位于 Pi agent 目录，受 `PI_CODING_AGENT_DIR` 影响，但不能当作历史版本保证。先在开发验收中于隔离临时目录核对官方固定版本的集成生成边界；dry-run 不运行集成安装器。计划冻结 herdr 已校验发行物摘要、经开发期核实的版本专属生成规则与预期输出摘要及目标基线；确认后仅在能证明无联网、无认证且写入受限于临时 agent 目录时，以固定参数和超时生成并校验扩展，再作为独立受管资源发布。无法在目标平台强制该边界或核对输出时阻塞；不对真实用户目录直接调用集成安装命令。扩展与本机已有文件冲突时阻塞。用假本地 socket/进程 fixture 验证状态报告路径和失败，不调用收费模型、不宣称真实会话已运行；未能核实版本资源或无副作用生成时整体阻塞。

## 本机计划、失败与恢复

计划属于本次设备、不是共享锁或 `apply --plan`；记录锁文件字节摘要、所选声明摘要、源文件内容摘要、已选变体、相关环境变量及归属/路径解析依据、实际目标与目标文件基线、PATH 与入口占用、每个受管动作及预期检测。敏感值不进入日志；必要的 env 比较使用本机内存中的精确值，展示脱敏来源。确认后、下载后和每项写入前重新核对相应前提：锁、源、目标、环境、已有入口或归属变化即中止，不悄悄重算计划；下载只使用已审阅版本。

以用户级互斥锁阻止同设备并发 setup；锁有所有者和恢复提示，进程存活或所有权不明时不删除他人锁。先在本机 journal 记录动作和备份，再原子发布单个受管文件/版本；只清理本次创建的临时物。失败或中断报告已完成、未完成、备份和恢复命令，保留日志以供下次检测；不自动删除外部资源或承诺全部回滚。仅当前目标仍与本次成功写入后记录的摘要匹配时允许恢复受管文件，否则保留并提示人工处理。下一次 setup 先识别未完成 journal，复核后恢复或继续；本地内容变更时阻塞。全部结果检查通过后才原子更新默认 repo/profile/lock 引用和最终归属记录；失败不能将部分结果登记为完整成功。重复执行对已匹配版本、资源、PATH 是 no-op，手工变更受管文件/入口则报告漂移，不覆盖。

## 实施与真实 CLI 验收

1. **计划及前置只读片**：接收已有锁并完整校验；识别物理宿主/执行架构、Node/npm/Git、工具入口和归属，输出完整阻塞和 dry-run 计划，不写文件。临时 HOME/PATH 及假可执行文件验证新机器、匹配/未知/不匹配入口、锁缺目标、Linux/WSL/仿真、空格中文与无副作用；缺任何后续 adapter 始终阻塞，不能称环境 ready。
2. **按锁 staging 与发布片**：先支持四部件的受控下载、摘要、解包/安装、受管目录和原生入口；通过正常声明构造能力完整的单部件临时 profile，从真实 CLI 使用受控 HTTP/归档/假 npm 逐一验证各 adapter、错误摘要、恶意归档、重定向、锁变化、并发和中断；只在临时目录安装，不加生产测试开关。`coding` 的必要 adapter 尚缺时仍不执行不完整计划。该片不宣称已完成 setup 闭环。
3. **配置、资源与集成片**：加入实际 Pi/herdr 原生配置、coding Agent、三项 skills 和版本化集成 adapter；用真实 CLI、隔离原生目录/假 socket 验证平台路径、env 覆盖、变体、字段归属、凭证不触碰、冲突与本地修改。固定版本的路径/扩展证据不足时阻塞；不能用占位资源通过。
4. **确认、恢复与结果片**：贯通同一内部计划的确认、逐项复核、日志、部分失败恢复、幂等及成功后绑定，测试新机器、既有工具、重复运行、两进程竞争、源/锁/env/目标在确认后变化、每一步故障与重试。真实编译 CLI 从临时环境完成 `setup → doctor`；补齐后续 `run coding` 的资源加载与透传后，再用假 runtime/本地集成完成 `setup → doctor → run coding` 验收。仅部分命令或 dry-run 可用不算首版闭环。

真实平台验收分别记录 macOS、Windows 原生和 Linux/WSL；模拟 `path.win32` 不等于 Windows 实机通过。每片 `pnpm check`、适用时实际 pack/解包并交根会话审查。当前锁**没有**传递依赖闭包、各版本安装脚本/入口可运行性、配置/skills 内容摘要、集成扩展身份、最低 OS 条件或本机归属；资源片用本机计划冻结 Git 内容，版本专属 adapter 补安装与路径证据。若需要可跨设备复现 npm 闭包或独立固定扩展，再单独设计生态原生锁/共享锁扩展和迁移，不能把现有字段解释成已有这些保证。
