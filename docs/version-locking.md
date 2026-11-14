# 版本解析与锁定：阶段 E 审查方案

本文是设计提案，**尚未实现 resolver、锁生成或安装**。示例字段和命令不是现有 CLI 接口。现有 `validate` 检查声明一致性，`doctor` 观察本机路径与版本；两者均不解析发布源，也不能证明所选工具或集成可运行。项目约束见 [架构](architecture.md)、[开发](development.md) 和 [roadmap](roadmap.md)。

## 建议与实施边界

推荐按两个可审查切片推进：先实现 npm 来源的 Pi/pnpm 候选解析和可机器检查的**临时计划**，并对未支持的来源明确失败；再接入 uv 和 herdr 发布源，覆盖显式选择的全部目标，才允许为默认 `coding` 生成正式锁。第一个切片可以通过专用测试 profile 验证，但不能对包含四个部件的 `coding` 写入缺项锁、改 profile、删除 herdr 或降低 `agent-status` 等能力要求。未完成第二个切片前，完整默认组合不可锁定。

一次支持四个来源可更早得到完整 `coding` 产物，但 npm 的包/可选原生包与两个 GitHub Release 的资产、digest 和平台映射必须同时可靠；GitHub 元数据不可用或目标缺失时仍需整体失败。先做较小来源集合降低首个网络与锁契约增量的复杂度，并通过拒绝不完整 profile 保持语义诚实。两种方案的最终验收标准相同：每个所选组件和明确目标都有证据；四个顶层包齐全也不代表集成已运行或 npm 传递依赖闭包已固定。

## 用户链路和拟议命令

1. 在 Git checkout 编辑 profile 与部件/集成声明，先用现有 `validate` 检查引用、平台及能力；保留原生工具入口。用户显式指定目标集合与 Node 版本假设，不能由 resolver 当前机器静默代替其他目标。现有 profile 只有 OS 列表，目标的架构、ABI 与 Node 假设需要新增真实消费者后明确提供；初版优先命令输入，不先扩充声明 schema。
2. **拟议** `agent-stack lock plan --repo . --profile coding --target <target>... --node-version <exact>` 只读拉取来源元数据，生成可审阅的候选计划，展示每个版本、目标、来源、期望 digest、变化及失败原因。输出稳定 JSON/文本；对缺失来源/目标报错并列出问题，不产生可应用的部分计划。初次建立锁是唯一允许解析全部组件的普通创建操作。
3. **拟议** `agent-stack lock write --repo . --plan <file>` 读取已审阅的完整计划，重新验证其 schema、目标、声明摘要、旧锁摘要及来源标识；写入前重检选定元数据是否仍符合计划。内容或 digest 变化、计划过期、缺项或验证失败时中止，要求重新规划；不能悄悄改成最新版本。计划可以保存在临时文件供审阅，不含凭证和本机绝对路径；不会因仅运行 plan 自动写仓库。
4. **拟议** `agent-stack lock plan --repo . --profile coding --update <component> ...` 才对该组件重新解析；其他已锁组件和目标原样保留。新选择与其余锁或当前声明不兼容时整体失败并报告依赖关系，不自动扩大更新范围。新增/删除目标、声明变化或换 profile 是显式重规划，必须展示受影响内容，而不是伪装成单部件更新；已有组件保持其锁定版本，只补查该版本的目标资产，不追踪可变渠道或重新选择版本。若原版本无法满足新要求，则失败并提示用户逐项显式更新。
5. 后续单独实现的 apply 只读取已审阅锁和 checkout，检查目标、digest、现有安装渠道与冲突；缺目标或来源未知的已有工具时停止，不自行选择 latest、覆盖或接管。下载、校验、安装和运行验证不属于本轮，也不由 plan 声称完成。

`doctor` 的实际路径、实际版本和未知渠道属于本机观察，能帮助用户发现差异；它们不进入共享锁、不决定远程候选，也不把 channel 标成已满足。锁记录的是期望字节与目标，不能取代实际环境检查。

## 最小锁契约与消费者

建议 `stack.lock.json` 顶层有 schema version、profile ID、明确的 targets、selected integrations 和组件集合；每个组件记录精确版本、来源类型及不可变识别、每目标发行物与预期 digest。**以下是字段设计示意，不是真实锁或可用版本/digest：**

```text
schemaVersion: 1
profile: <profile-id>
definitionDigests: { profile: <sha256>, components: { <id>: <sha256> }, integrations: { <id>: <sha256> } }
targets: [{ os: <darwin|win32|linux>, arch: <x64|arm64>, abi: <native|gnu|musl>, nodeVersion: <exact>, executionArch: <x64|arm64> }]
components:
  <id>: { version: <exact>, source: <registry-and-package-or-repository-and-release-id>, artifacts: [
    { target: <target-reference>, identity: <package-version-or-release-asset-id>, url: <metadata-returned-https-url>, expectedDigest: <algorithm-and-value>, digestSource: <registry-or-release-asset-or-publisher-checksum> }
  ] }
integrations: [<selected-integration-id>]
```

示意的目标是**运行环境**，`executionArch` 与物理架构分开，允许显式表达 Windows ARM64 上的 x64 仿真；`abi` 在 Linux 区分 `gnu`/`musl`，其他平台为 `native`。实际实现可采用不会重复数据的规范化 target key；不能让多个字段产生歧义。Node 版本假设供 npm engines 检查，未来 apply 必须核对实际 Node；当前 profile 中没有 Node 部件，不能暗示已锁定或安装 Node。Windows 的运行时 ABI/最低系统版本、Linux glibc 最低版本、macOS 最低版本仅在可信来源足够且未来 apply 能检查时编码；未知不是兼容。静态二进制可表达其构建 ABI 和适用宿主条件，不能把目标名当成对所有宿主的兼容证明。

字段只为真实消费者存在：schema version 给解析器；profile、integrations、definitionDigests 给计划校验及失效检测；targets 和 Node 假设给选择与未来 apply；版本、来源、资产 identity、URL、digest 及其来源给 diff、下载校验及审计。对 JSON 声明先 schema 解析，再对规范化后的语义 JSON（稳定 key 顺序、UTF-8，无时间戳）计算 SHA-256；记录所选 profile、每个所选 component 和 integration 的摘要。格式化变化不触发失效，语义变化会触发。算法版本和 canonicalization 规则必须随 schema version 固定；重读 checkout 时重新计算。集成声明被记录并静态检查，但不声称对应集成已安装或运行。

npm 的 artifact identity 包含 registry、package name、精确版本及 metadata 中的 tarball；GitHub 的 identity 包含 owner/repo、release ID、tag、asset ID 和 asset name。URL 是实际来源返回的值，不承载认证信息；仅接受经配置的官方 HTTPS 域及经过校验的下载重定向，拒绝 URL 中的凭据、查询 token 或跨源非预期跳转。计划阶段读到的是**预期** digest，未来下载后计算并比较才是字节校验通过；digest 来源与传输来源的信任边界要显示。缺可验证的预期 digest 时失败，不能把下载后自行计算的 hash 冒充发行方事先承诺，也不能默默降级为无校验。SHA-256 / SHA-512 只能检测与期望不一致，不自动证明发布者身份；签名与 provenance 验证是另行实现的能力。

不锁本机路径、已安装版本、认证、会话、缓存。共享配置、Agent 和 skills 继续以 Git checkout 为准；当前锁只对被解析声明记录摘要，不伪称已锁配置内容。CLI 自己的 `pnpm-lock.yaml` 和未来外部工具的 `stack.lock.json` 是两套锁，业务项目锁文件仍由业务项目管理。

## 来源与选择规则

### npm：Pi 和 pnpm

读取官方 [npm package metadata/packument](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md) 的 `versions`、`dist-tags`、每版本 manifest 和 `dist`；对指定包名核对 name/version，选定版本的 tarball URL 和 `dist.integrity` 使用 registry 实际返回值。[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) 说明发布时提交 SHA-512 integrity；历史或镜像响应不保证有足够信息，本方案要求受支持的 SHA-512 SRI，缺失即失败，不从 URL 推导 hash。2026-11-14 对公开 registry 的只读抽样中，Pi `@earendil-works/pi-coding-agent` 的 `latest` 为 1.5.2，manifest 包含 Node `>=22.19.0` 与 tarball integrity；pnpm 的抽样返回精确版本、integrity 和按平台的 `@pnpm/exe.*` optionalDependencies。这只是该次观察，不是永远有效的版本或可用性保证。[Pi manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) 给出包名和 `pi` bin；[pnpm manifest](https://github.com/pnpm/pnpm/blob/main/pnpm/npm/pnpm/package.json) 的入口与 install 脚本表明 npm 顶层包不等同最终目标二进制。

使用现有 `semver` 的范围语义；默认排除 prerelease，范围明确允许对应 prerelease 才考虑。`version` 与 `channel` 互斥：npm 渠道只有在来源的明确映射可解释时才解析，`stable` 可提议映射为 registry `latest`，记录 tag 和落点；不得将 `beta` 默认映射为未核实的 tag。tag 是可变指针，计划固定其当时落点，write 前重检，普通 apply 不追踪 tag。不存在或解析不出有效范围、空候选、非 semver 或不支持的渠道均明确失败。

npm 没有通用的 PyPI yank 字段：`deprecated` 是维护者警告，建议默认排除新选择并展示原因；`unpublish` 导致版本/包不可获取，应失败，不以废弃等同撤回。[npm deprecate](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/) 和 [unpublish](https://docs.npmjs.com/cli/v11/commands/npm-unpublish/) 是不同操作。旧锁已固定版本不会自动升级；apply 时下载不可用或校验失败则失败，是否允许显式使用废弃版本是待定策略，不能静默改写锁。

对每个明确目标，检查所选版本的 `engines.node` 与显式 Node 假设，以及 manifest 中适用的 `os`、`cpu`、`libc` 允许/拒绝规则；缺字段表示没有该项声明，不证明实际运行通过。[npm package.json 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) 对这些字段的含义与 npm 的默认 engines 警告行为有说明，本方案的计划校验可比默认安装更严格。

对于 pnpm 的目标专属 native optional package，不以包名拼接来假定存在：从所选 pnpm manifest 读取依赖映射，依据经官方发布材料确认的目标映射选出包，再从同一可信 registry 获取**精确版本**及其 integrity 和 tarball；在锁中关联目标和顶层包。若某版本不具备可证实的目标包/映射、依赖范围无法解析为精确值、二进制选择逻辑或安装脚本边界无法保证，则对该目标失败，不靠运行 install 脚本或猜测平台包。对于不同 pnpm 主版本的不同布局，按有证据的版本范围逐步支持。锁定这些顶层和目标包仍不表示其其他传递依赖或生命周期脚本闭包可复现。

### uv 和 herdr：GitHub Releases

[uv 安装文档](https://docs.astral.sh/uv/getting-started/installation/) 指向官方 GitHub Releases；[uv release workflow](https://github.com/astral-sh/uv/blob/main/.github/workflows/release.yml) 描述构建和上传发行归档及 hashes。[herdr 安装文档](https://herdr.dev/tui/docs/install/) 列出 Linux/macOS 二进制和 Windows zip，并明确 Windows 包需保留 app-local ConPTY 内容；[herdr release workflow](https://github.com/herdrdev/herdr/blob/master/.github/workflows/release.yml) 的当前构建矩阵提供平台与资产的对应证据。当前 workflow/文档只证明所查版本的发布方式，历史 release 须逐个核对。

GitHub adapter 从官方仓库的 [release API](https://docs.github.com/en/rest/releases/releases) 逐页读取正式 release，排除 draft；稳定选择排除 prerelease，按可解析 tag 的 semver 和 profile 范围选最高匹配版本。herdr `stable` 使用非 draft、非 prerelease 且符合正式版本 tag 的 release 集合作为**拟议策略**，记录 release ID/tag；`beta` 不等于 GitHub 任意 prerelease，必须先有该来源明确映射，否则失败。不存在 PyPI 风格通用 yank 字段；release/asset 删除、draft 化或来源显式撤回时禁止新选择或写入，并按旧锁失败策略处理，不将标记为 prerelease 当作撤回。

按实际 release 资产列表和经来源证明的映射匹配目标，要求唯一、状态可用、精确 URL 与 asset ID；同名多项、缺项或未知新命名均失败。不能凭目标字符串合成 URL。对 zip 锁整个 zip 的预期 digest，后续 apply 还必须安全解压并保留所需文件；不单独假称 zip 内程序已校验或可运行。[GitHub asset API](https://docs.github.com/en/rest/releases/assets) 示例提供 `digest`；仅在实际响应提供受支持 SHA-256 时使用，记录其为 GitHub 资产 digest，不称为发行方独立签名。若采用发行方发布的 checksum 文件，必须从同一 release 的资产列表识别并读取该文件，严格匹配资产名；当两者均有值但冲突时失败，不优先忽略冲突。

本轮直接查询 GitHub Releases API 返回 HTTP 403，**未确认**当前默认 `coding` 约束下 uv 的具体候选、每个 herdr/uv 历史资产是否存在或其 digest 可用性。后续 adapter 必须对真实响应、分页、限流与缺 digest 建立 fixture 与实测证据；这些不确定性是推荐分片并保持整体失败的重要原因。

## 目标矩阵：设计范围，非运行验证

下面是计划需要表达的目标，不是声称每一版本都有资产或已通过安装验证。目标中的架构为进程架构，不直接等同物理 CPU；选择某一行仍须满足四个部件、Node 假设与实际 release 元数据。

| 目标候选                      | 需处理的边界                                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS x64 / arm64             | Pi/pnpm 为 npm 源；uv/herdr 需各自版本的对应资产与最低系统条件。Rosetta 不自动启用，仿真须显式计划。                                                                                                                                |
| Linux x64 / arm64，gnu / musl | 明确 libc 和最低版本；[uv 平台文档](https://docs.astral.sh/uv/reference/platforms/)区分 glibc 与 musl，部分 musl 二进制是静态链接。herdr 当前 workflow 构建 musl 目标，但必须验证具体 release，不把构建三元组直接视作所有系统兼容。 |
| Windows x64 原生              | 使用 win32/x64 目标；herdr Windows zip 与其 app-local 文件共同作为一个资产。`.cmd` 入口检测与后续安装渠道不是同一问题。                                                                                                             |
| Windows ARM64 原生或 x64 仿真 | uv 官方列出 ARM64，pnpm 是否有对应目标依赖需按版本核对；herdr 官方文档列出 Windows x64 构建并说明 ARM64 可在仿真下运行。需要显式请求 x64 仿真并记录，不把 x64 当原生 ARM64；Pi/pnpm/Node 及目标环境的组合仍需各自验证。             |

Windows 原生、WSL 的 Linux 用户态和普通 Linux runner 是不同目标/设备状态；WSL 使用 Linux 目标，不复用 Windows 锁项。profile 的 OS 列表不等于已经选择全部架构与 ABI。默认目标集合与最小 OS/ABI 兼容要求尚待决定；不能基于单台机器自动扩大为整个矩阵。Rex 的 macOS App 声明也不能扩展到独立 Linux/Windows server。

## 更新、失败与可恢复性

计划输入包括当前锁的内容摘要（首次创建记为不存在）、所有相关声明摘要、目标和所需 Node 假设。更新单项时，对未更新组件保留其序列化后语义完全一致的版本、来源和资产；若声明变化影响这些项则中止并要求明确重规划。输出按组件 ID、规范 target key、资产 identity 排序，禁止写入时间戳、设备路径与无关网络响应字段；相同规范输入及元数据生成相同字节。

候选选择完成且每个目标完整后才能写；网络错误、403/限流、元数据变化、digest 缺失/冲突、未知 ABI、资产歧义、能力缺口或单项更新影响未授权组件时返回非零和明确原因，旧锁字节不变。写入时在同目录创建临时文件，完整写入并 flush，再原子替换；失败清理自己的临时文件。使用进程间协作锁和旧锁/声明摘要复核防止本工具并发覆盖；文件系统不支持原子替换、Windows 文件被占用或复核变化时失败。协作锁无法阻止不遵守约定的外部编辑器，原子替换也不是跨进程通用 CAS：实现需明确剩余竞争窗口并测试，不承诺无条件解决所有并发写入。断电持久性及目录 fsync 的跨平台支持另行验证。

后续 apply 必须预览、识别渠道与冲突，未知来源不覆盖；版本解析不修改已有工具。恢复配置来自有归属的备份/合并策略，程序降级必须逐渠道验证是否可行；二者都不保证恢复运行数据或会话。保留原生工具命令和管理渠道，CLI 更新不隐式升级外部工具。

## npm 传递依赖与保证等级

固定 Pi/pnpm 顶层版本、顶层 tarball integrity 和已明确选择的 pnpm 原生目标包，只能保证这些**列出的资产身份**；npm 依赖范围、optional/platform 分支、生命周期脚本、下载行为和工具自己的资源不因此被冻结。npm 的 [package-lock](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) 或 [npm-shrinkwrap](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/) 及 [pnpm-lock.yaml](https://pnpm.io/lockfile) 是各生态自己的依赖图机制；发布包是否包含 shrinkwrap、消费安装器是否遵守、OS/CPU 分支及脚本网络行为必须逐项核实。未来若需要完整闭包，应为受控安装项目建立并审阅对应原生锁、确定包管理器版本与脚本策略，验证每目标的传递资产；不把 CLI 自己的 `pnpm-lock.yaml` 冒充外部工具锁。即使有原生锁，外部脚本或运行时数据下载仍需单独约束。

## 代码切片与验收

建议在真实消费者出现时增加：`src/core/` 的 Zod 锁/计划 schema、semver 和纯选择/差异判断（类型从 schema 推导）；`src/adapters/` 的 npm registry 与 GitHub Releases 只读客户端、文件快照和原子写入；`src/commands/` 的 plan/write 组装。先沿用单包 CLI 和已有 semver，HTTP 用受控超时、大小限制、分页和清晰错误的 Node 原生能力；需要新依赖须由具体缺口证明，不先建立通用插件框架。fixtures 使用临时目录与本地受控 HTTP server，不能依赖用户网络、凭证或真实工具。

1. npm fixture：范围、预发布、tag 变动、deprecated/unpublish、engines、os/cpu/libc、目标包缺失、无 integrity、registry URL 与意外重定向；验证 Pi/pnpm 实际元数据形状和拒绝无证据映射。
2. Release fixture：分页、稳定/预发布、draft、缺/重复 asset、缺 digest、checksum 冲突、跨域跳转、403/限流及失败；验证 uv 与 herdr 资产精确关联，而非拼 URL。
3. 契约 fixture：四组件 `coding` 有任何未支持或缺目标时无法产生可写计划；保留 `agent-status`、Pi/herdr 集成及原 profile；只支持 npm 的首切片明确失败并不写锁。
4. 原子性 fixture：相同输入字节稳定；更新一个组件不改变其他项；旧锁/声明或远端元数据在审阅后变化、写入失败、并发 writer 均不得静默覆盖旧锁。
5. 平台 fixture：macOS 两架构、Linux 两 libc、Windows 原生与显式 ARM64→x64 仿真；WSL 分开；未知平台/ABI/最低版本不能默认成功。
6. 后续 apply 独立验收：下载后的 digest 匹配/不匹配、锁定资产缺失、归档安全、已有未知渠道、本机观察与锁不一致、重复操作及恢复。静态计划通过不算这些测试已通过。

## 审查前未决事项

- 默认目标列表、Node 精确版本假设由谁提供，以及最低 OS/glibc 兼容信息不足时的统一失败策略。
- GitHub API 403 的可用性、限流和认证方案；认证不得进入锁/日志。所选 uv 版本与 herdr release 的资产和 digest 需在可访问环境逐项核实。
- herdr stable 对 GitHub release 的筛选是否与其官方渠道 manifest 完全一致；如不一致，以可验证的明确渠道映射为准，不能猜测。
- npm 包安装的受控原生锁、生命周期脚本和 pnpm 各版本原生二进制物化策略；首轮只承诺列出的资产，不保证依赖闭包。
- 计划的过期策略、元数据重检与离线操作的取舍，以及协作锁无法约束外部编辑器的剩余竞争窗口。
