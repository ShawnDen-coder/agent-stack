# 版本解析与锁定：阶段 E 审查方案

当前 `lock --dry-run` 已实现版本候选解析报告；完整锁生成、目标发行物和安装尚未实现。本文的锁契约、写入、更新和执行计划仍为设计提案，不能将其中的完整示例当作现有接口。已实现行为见 [CLI 行为稿第 1 节](cli-behavior.md#1-当前确实能用的接口)，操作入口见 [Quickstart](quickstart.md)。`validate` 检查声明一致性，`doctor` 观察本机路径与版本；候选报告、静态校验和版本观察都不证明工具或集成可运行。项目约束见 [架构](architecture.md)、[开发](development.md) 和 [roadmap](roadmap.md)。

按用户明确的书写偏好，自有声明优先 YAML；当前读取器支持 YAML 与过渡期 JSON。共享候选锁、正式 `stack/stack.lock.json` 与本机执行计划继续使用 JSON。公共入口按日常 setup/doctor/run/update 与进阶命令分组，具体命令行为仍待用户审查。

## 建议与实施边界

推荐按两个可审查切片推进：先实现 npm 来源的 Pi/pnpm 内部候选解析和 `lock --dry-run` 解析报告，并对未支持的来源明确失败；再接入 uv 和 herdr 发布源，覆盖显式选择的全部目标，才允许为默认 `coding` 生成正式锁。第一个切片可以通过专用测试 profile 验证，但不能对包含四个部件的 `coding` 写入缺项锁、改 profile、删除 herdr 或降低 `agent-status` 等能力要求。未完成第二个切片前，完整默认组合不可锁定。

一次支持四个来源可更早得到完整 `coding` 产物，但 npm 的包/可选原生包与两个 GitHub Release 的资产、digest 和平台映射必须同时可靠；GitHub 元数据不可用或目标缺失时仍需整体失败。先做较小来源集合降低首个网络与锁契约增量的复杂度，并通过拒绝不完整 profile 保持语义诚实。两种方案的最终验收标准相同：每个所选组件和明确目标都有证据；四个顶层包齐全也不代表集成已运行或 npm 传递依赖闭包已固定。

## 用户链路和拟议命令

以下命令均为待用户审查的拟议接口；解析、复核与原子写入是内部步骤，不增加 `lock` 的公共子命令。

1. 在 Git checkout 编辑 profile 与部件/集成声明，用现有 `validate` 检查引用、平台及能力。**待审查推荐**：首次 `lock` 没有 `--target` 时仅选可靠识别的本机目标，Linux ABI 等无法确定时要求显式指定；已有锁未指定目标时保留原目标集合，显式 `--target` 列表替换为新的完整目标集合并展示增删。首建默认 Node 假设为当前运行 Node 的确切版本，后续保留，`--node-version <exact>` 显式改变并展示差异。它是 npm engines 的假设，不安装或管理 Node。
2. 拟议 `agent-stack lock --profile coding --dry-run --json` 在线解析并输出**版本候选/解析报告**及差异，不写锁；`--dry-run` 不能与 `--out` 同用。报告可以包含失败原因和不完整诊断，不能作为 `apply --plan` 的输入。首次建立锁解析完整 profile；仅显式 `--update <component[@exact]>` 时重新选择该部件的版本，选定版本仍需满足声明及来源策略。其他部件保持原版本，新增目标只补查原版本的资产；无法满足时失败并提示逐项更新。
3. 拟议 `agent-stack lock --profile coding --update pi --out ./stack.next.lock.json` 再次解析并生成完整的**可共享候选锁**；默认写所选锁，`--out` 写另一份锁而不改变输入锁或设备绑定。首建、更新与落盘均先展示差异，内部在一次调用中建立解析快照、核对相关声明/旧锁基线与来源元数据，再原子写入；不将上一次 dry-run 当成冻结授权。候选锁和正式锁的完整性规则相同，不含设备路径，不能直接作为 `apply --plan` 输入。缺来源、资产或 digest 时不写缺项锁，旧锁保持不变。
4. 拟议顶层 `agent-stack plan --out ./.agent-stack/device.plan.json` 在有效完整锁与本机观察基础上生成**本机执行计划**，预览动作、阻塞项、目标路径、归属和目标文件基线。它属于被 Git 忽略的本机产物，不应共享或提交。`agent-stack update pi --dry-run --out ./.agent-stack/pi-update.plan.json` 可保存包含完整候选锁及本机前提的执行计划；只有这类无阻塞、完整且基线有效的执行计划供 `apply --plan` 使用，不重新选择版本。普通 `lock --out` 产生的是锁，不是执行计划。
5. 拟议 `apply --plan <file>` 在修改前核对计划中的 checkout 声明、锁/候选锁摘要、目标、本机版本、归属及目标文件基线；变化即失败并要求重新规划。核对锁定资产的可用性及下载字节的 digest，不追踪频道。未知来源的已有工具若需修改则阻塞；应用、安装与验收均属后续阶段。`update` 执行本机动作并验收后才尝试发布候选锁，失败可能已有部分设备变化，需报告与恢复证据，不能声称跨工具事务原子。

三种产物分别服务于解析审查、共享期望和本机执行。`doctor` 的路径、版本与未知渠道属于本机观察，不写入共享锁、不决定远程候选，也不把 channel 标成已满足；锁固定期望字节与目标，不代替实际环境检查。

### 在线、落盘与离线复核

- **在线解析**：只在首建或显式更新时采样渠道/范围及版本元数据；已有锁普通使用不解析新版本。一次解析使用一致快照，来源不支持、目标缺失或 digest 冲突则失败。`lock --dry-run` 的报告不是后续调用的冻结输入。
- **`lock` 落盘**：同一次调用里，以声明/旧锁基线复核和选定版本的来源快照复核作为提交前置条件；若解析期间所用 tag 落点或选定资产/digest 已变化，失败并保留旧锁。重检仅约束本次正在解析并写入的快照，不让后来发布的 latest 追溯地使已冻结锁失效。缓存一致性、重检时限和来源不支持条件请求的处理仍待实现切片确定。
- **冻结锁与执行计划应用**：普通 `apply` / `apply --plan` 不查询可变 tag、不重解版本。在线应用按固定资产获取字节并与锁中预期 digest 比较；若实际可观察到资产身份/digest 变化、资产不可获取、声明/锁或本机前提变化则失败，不切换候选。计划中的本地基线每次执行前复核。
- **`--offline`**：拟议的 `lock`、`setup`、`apply`、`update` 严禁网络。离线 `lock` 只可使用足够完整且可校验的本地元数据快照与已有锁；无法证明输入一致、满足目标和 digest 契约时失败，不使用 latest 兜底。离线应用必须有匹配锁的本地资产，仍计算 digest、核对声明与本机前提；缺缓存、摘要不符或阻塞即失败。离线无法发现远端撤回或元数据变动，不能宣称已复核远端状态；下次在线操作另行报告可观察到的变化。缓存来源、完整性与有效期策略仍待审查。

## 最小锁契约与消费者

建议 `stack/stack.lock.json` 顶层有 schema version、profile ID、明确的 targets、selected integrations 和组件集合；每个组件记录精确版本、来源类型及不可变识别、每目标发行物与预期 digest。**以下是字段设计示意，不是真实锁或可用版本/digest：**

```text
schemaVersion: 1
profile: <profile-id>
definitionDigests: { profile: <sha256>, components: { <id>: <sha256> }, integrations: { <id>: <sha256> } }
nodeVersion: <exact-node-assumption>
targets: [{ os: <darwin|win32|linux>, arch: <x64|arm64>, abi: <native|gnu|musl> }]
components:
  <id>: { version: <exact>, source: <registry-and-package-or-repository-and-release-id>, artifacts: [
    { target: <target-reference>, identity: <package-version-or-release-asset-id>, url: <metadata-returned-https-url>, expectedDigest: <algorithm-and-value>, digestSource: <registry-or-release-asset-or-publisher-checksum> }
  ] }
integrations: [<selected-integration-id>]
```

共享锁 target 的 `arch` 是**选用资产的执行架构**；`abi` 在 Linux 区分 `gnu`/`musl`，其他平台为 `native`。Node 假设为锁级输入，供 npm engines 检查；不暗示已锁定或安装 Node。宿主的物理架构、实际 OS/ABI、执行模式、路径和归属由本机观察与执行计划记录，并与目标匹配，不写共享锁。

原生示例：macOS ARM64 宿主，锁目标为 `{ os: darwin, arch: arm64, abi: native }`，本机计划观察到 ARM64 原生执行。仿真示例：Windows ARM64 宿主若选择 `{ os: win32, arch: x64, abi: native }`，本机计划必须明确记录宿主 ARM64、执行 x64 和可用仿真证据；锁中的 x64 只表示资产执行架构，不能推断宿主是 x64。**首个实现切片不支持仿真**，因此第二个示例须明确拒绝，直到本机检测、计划和应用有真实消费者与验证；macOS Rosetta 同理。无需引入重复的 `executionArch` 字段。

最低条件分三类：可信来源给出必需的最低 OS、libc/ABI 或 Node 条件时记录，并由后续计划/应用检查；若匹配目标、ABI、Node engines 或已知必需条件所需信息缺失或本机无法核对，阻塞，不能猜测通过；来源没有发布某项最低版本信息时标记未知，不虚构阈值或宣称兼容。未知条件是否允许在非执行的锁中保留须按来源确定，若无法证明资产与目标匹配则连锁生成也阻塞；实际运行验收另行验证，不能由 metadata 或已知最低条件代替。

字段只为真实消费者存在：schema version 给解析器；profile、integrations、definitionDigests 给计划校验及失效检测；targets 和 Node 假设给选择与未来 apply；版本、来源、资产 identity、URL、digest 及其来源给 diff、下载校验及审计。先将 YAML/JSON 声明解析为数据并通过同一 Zod schema，再对规范化后的语义 JSON（稳定 key 顺序、UTF-8，无时间戳）计算 SHA-256；记录所选 profile、每个所选 component 和 integration 的摘要。等价的 YAML/JSON、注释与缩进变化不触发失效，语义变化会触发；同一 ID 跨格式重复时先拒绝输入。算法版本和 canonicalization 规则必须随 schema version 固定；重读 checkout 时重新计算。集成声明被记录并静态检查，但不声称对应集成已安装或运行。

npm 的 artifact identity 包含 registry、package name、精确版本及 metadata 中的 tarball；GitHub 的 identity 包含 owner/repo、release ID、tag、asset ID 和 asset name。URL 是实际来源返回的值，不承载认证信息；仅接受经配置的官方 HTTPS 域及经过校验的下载重定向，拒绝 URL 中的凭据、查询 token 或跨源非预期跳转。解析阶段读到的是**预期** digest，未来下载后计算并比较才是字节校验通过；digest 来源与传输来源的信任边界要显示。缺可验证的预期 digest 时失败，不能把下载后自行计算的 hash 冒充发行方事先承诺，也不能默默降级为无校验。SHA-256 / SHA-512 只能检测与期望不一致，不自动证明发布者身份；签名与 provenance 验证是另行实现的能力。

不锁本机路径、已安装版本、认证、会话、缓存。共享配置、Agent 和 skills 继续以 Git checkout 为准；当前锁只对被解析声明记录摘要，不伪称已锁配置内容。CLI 自己的 `pnpm-lock.yaml` 和未来外部工具的 `stack/stack.lock.json` 是两套锁，业务项目锁文件仍由业务项目管理。

## 来源与选择规则

### npm：Pi 和 pnpm

读取官方 [npm package metadata/packument](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md) 的 `versions`、`dist-tags`、每版本 manifest 和 `dist`；对指定包名核对 name/version，选定版本的 tarball URL 和 `dist.integrity` 使用 registry 实际返回值。[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) 说明发布时提交 SHA-512 integrity；历史或镜像响应不保证有足够信息，本方案要求受支持的 SHA-512 SRI，缺失即失败，不从 URL 推导 hash。2026-11-14 对公开 registry 的只读抽样中，Pi `@earendil-works/pi-coding-agent` 的 `latest` 为 1.5.2，manifest 包含 Node `>=22.19.0` 与 tarball integrity；pnpm 的抽样返回精确版本、integrity 和按平台的 `@pnpm/exe.*` optionalDependencies。这只是该次观察，不是永远有效的版本或可用性保证。[Pi manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) 给出包名和 `pi` bin；[pnpm manifest](https://github.com/pnpm/pnpm/blob/main/pnpm/npm/pnpm/package.json) 的入口与 install 脚本表明 npm 顶层包不等同最终目标二进制。

使用现有 `semver` 的范围语义；默认排除 prerelease，范围明确允许对应 prerelease 才考虑。`version` 与 `channel` 互斥：npm 渠道只有在来源的明确映射可解释时才解析，`stable` 可提议映射为 registry `latest`，记录 tag 和落点；不得将 `beta` 默认映射为未核实的 tag。tag 是可变指针，在线 `lock` 内解析快照固定其当时落点，并在同一次调用写入前复核；普通 apply 不追踪 tag，离线按上文缓存规则处理。不存在或解析不出有效范围、空候选、非 semver 或不支持的渠道均明确失败。

npm 没有通用的 PyPI yank 字段：`deprecated` 是维护者警告，建议默认排除新选择并展示原因；`unpublish` 导致版本/包不可获取，应失败，不以废弃等同撤回。[npm deprecate](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/) 和 [unpublish](https://docs.npmjs.com/cli/v11/commands/npm-unpublish/) 是不同操作。旧锁已固定版本不会自动升级；apply 时下载不可用或校验失败则失败，是否允许显式使用废弃版本是待定策略，不能静默改写锁。

对每个明确目标，检查所选版本的 `engines.node` 与显式 Node 假设，以及 manifest 中适用的 `os`、`cpu`、`libc` 允许/拒绝规则；缺字段表示没有该项声明，不证明实际运行通过。[npm package.json 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) 对这些字段的含义与 npm 的默认 engines 警告行为有说明，本方案的计划校验可比默认安装更严格。

对于 pnpm 的目标专属 native optional package，不以包名拼接来假定存在：从所选 pnpm manifest 读取依赖映射，依据经官方发布材料确认的目标映射选出包，再从同一可信 registry 获取**精确版本**及其 integrity 和 tarball；在锁中关联目标和顶层包。若某版本不具备可证实的目标包/映射、依赖范围无法解析为精确值、二进制选择逻辑或安装脚本边界无法保证，则对该目标失败，不靠运行 install 脚本或猜测平台包。对于不同 pnpm 主版本的不同布局，按有证据的版本范围逐步支持。锁定这些顶层和目标包仍不表示其其他传递依赖或生命周期脚本闭包可复现。

### uv 和 herdr：GitHub Releases

[uv 安装文档](https://docs.astral.sh/uv/getting-started/installation/) 指向官方 GitHub Releases；[uv release workflow](https://github.com/astral-sh/uv/blob/main/.github/workflows/release.yml) 描述构建和上传发行归档及 hashes。[herdr 安装文档](https://herdr.dev/tui/docs/install/) 列出 Linux/macOS 二进制和 Windows zip，并明确 Windows 包需保留 app-local ConPTY 内容；[herdr release workflow](https://github.com/herdrdev/herdr/blob/master/.github/workflows/release.yml) 的当前构建矩阵提供平台与资产的对应证据。当前 workflow/文档只证明所查版本的发布方式，历史 release 须逐个核对。

GitHub adapter 从官方仓库的 [release API](https://docs.github.com/en/rest/releases/releases) 逐页读取正式 release，排除 draft；稳定选择排除 prerelease，按可解析 tag 的 semver 和 profile 范围选最高匹配版本。herdr `stable` 使用非 draft、非 prerelease 且符合正式版本 tag 的 release 集合作为**拟议策略**，记录 release ID/tag；`beta` 不等于 GitHub 任意 prerelease，必须先有该来源明确映射，否则失败。不存在 PyPI 风格通用 yank 字段；release/asset 删除、draft 化或来源显式撤回时禁止新选择或写入，并按旧锁失败策略处理，不将标记为 prerelease 当作撤回。

按实际 release 资产列表和经来源证明的映射匹配目标，要求唯一、状态可用、精确 URL 与 asset ID；同名多项、缺项或未知新命名均失败。不能凭目标字符串合成 URL。对 zip 锁整个 zip 的预期 digest，后续 apply 还必须安全解压并保留所需文件；不单独假称 zip 内程序已校验或可运行。[GitHub asset API](https://docs.github.com/en/rest/releases/assets) 示例提供 `digest`；仅在实际响应提供受支持 SHA-256 时使用，记录其为 GitHub 资产 digest，不称为发行方独立签名。若采用发行方发布的 checksum 文件，必须从同一 release 的资产列表识别并读取该文件，严格匹配资产名；当两者均有值但冲突时失败，不优先忽略冲突。

本轮直接查询 GitHub Releases API 返回 HTTP 403，**未确认**当前默认 `coding` 约束下 uv 的具体候选、每个 herdr/uv 历史资产是否存在或其 digest 可用性。后续 adapter 必须对真实响应、分页、限流与缺 digest 建立 fixture 与实测证据；这些不确定性是推荐分片并保持整体失败的重要原因。

## 目标矩阵：设计范围，非运行验证

下面是共享锁需要表达的目标，不是声称每一版本都有资产或已通过安装验证。目标架构为资产执行架构，物理宿主由本机计划观察；选择某一行仍须满足四个部件、Node 假设与实际 release 元数据。

| 目标候选                      | 需处理的边界                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS x64 / arm64             | Pi/pnpm 为 npm 源；uv/herdr 需各自版本的对应资产与最低系统条件。Rosetta 不自动启用；首片明确拒绝仿真，后续须显式计划和验证。                                                                                                                                        |
| Linux x64 / arm64，gnu / musl | 明确 libc 和最低版本；[uv 平台文档](https://docs.astral.sh/uv/reference/platforms/)区分 glibc 与 musl，部分 musl 二进制是静态链接。herdr 当前 workflow 构建 musl 目标，但必须验证具体 release，不把构建三元组直接视作所有系统兼容。                                 |
| Windows x64 原生              | 使用 win32/x64 目标；herdr Windows zip 与其 app-local 文件共同作为一个资产。`.cmd` 入口检测与后续安装渠道不是同一问题。                                                                                                                                             |
| Windows ARM64 原生或 x64 仿真 | uv 官方列出 ARM64，pnpm 是否有对应目标依赖需按版本核对；herdr 官方文档列出 Windows x64 构建并说明 ARM64 可在仿真下运行。首片拒绝 x64 仿真；后续必须在本机计划中明确记录宿主与执行架构和仿真证据，不把 x64 当原生 ARM64；Pi/pnpm/Node 及目标环境的组合仍需各自验证。 |

Windows 原生、WSL 的 Linux 用户态和普通 Linux runner 是不同目标/设备状态；WSL 使用 Linux 目标，不复用 Windows 锁项。profile 的 OS 列表不等于已经选择全部架构与 ABI。首建默认仅可靠识别的本机目标、后续保留目标集合是待审查推荐；无法可靠识别即要求明确指定，不能自动扩大为整个矩阵。最低 OS/ABI 证据与可执行性仍需分别审查。Rex 的 macOS App 声明也不能扩展到独立 Linux/Windows server。

## 更新、失败与可恢复性

解析快照输入包括当前锁的内容摘要（首次创建记为不存在）、所有相关声明摘要、目标和所需 Node 假设。更新单项时，对未更新组件保留其序列化后语义完全一致的版本、来源和资产；若声明变化影响这些项则中止并要求明确重规划。共享锁与解析报告按组件 ID、规范 target key、资产 identity 排序，共享锁禁止写入时间戳、设备路径与无关网络响应字段；本机执行计划可按需要保存设备路径与前提；共享锁在相同规范输入及元数据下生成相同字节。

候选选择完成且每个目标完整后才能写；网络错误、403/限流、元数据变化、digest 缺失/冲突、未知 ABI、资产歧义、能力缺口或单项更新影响未授权组件时返回非零和明确原因，旧锁字节不变。写入时在同目录创建临时文件，完整写入并 flush，再原子替换；失败清理自己的临时文件。使用进程间协作锁和旧锁/声明摘要复核防止本工具并发覆盖；文件系统不支持原子替换、Windows 文件被占用或复核变化时失败。协作锁无法阻止不遵守约定的外部编辑器，原子替换也不是跨进程通用 CAS：实现需明确剩余竞争窗口并测试，不承诺无条件解决所有并发写入。断电持久性及目录 fsync 的跨平台支持另行验证。

后续 apply 必须预览、识别渠道与冲突，未知来源不覆盖；版本解析不修改已有工具。恢复配置来自有归属的备份/合并策略，程序降级必须逐渠道验证是否可行；二者都不保证恢复运行数据或会话。保留原生工具命令和管理渠道，CLI 更新不隐式升级外部工具。

## npm 传递依赖与保证等级

固定 Pi/pnpm 顶层版本、顶层 tarball integrity 和已明确选择的 pnpm 原生目标包，只能保证这些**列出的资产身份**；npm 依赖范围、optional/platform 分支、生命周期脚本、下载行为和工具自己的资源不因此被冻结。npm 的 [package-lock](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) 或 [npm-shrinkwrap](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/) 及 [pnpm-lock.yaml](https://pnpm.io/lockfile) 是各生态自己的依赖图机制；发布包是否包含 shrinkwrap、消费安装器是否遵守、OS/CPU 分支及脚本网络行为必须逐项核实。未来若需要完整闭包，应为受控安装项目建立并审阅对应原生锁、确定包管理器版本与脚本策略，验证每目标的传递资产；不把 CLI 自己的 `pnpm-lock.yaml` 冒充外部工具锁。即使有原生锁，外部脚本或运行时数据下载仍需单独约束。

## 代码切片与验收

建议在真实消费者出现时增加：`src/core/` 的 Zod 锁/计划 schema、semver 和纯选择/差异判断（类型从 schema 推导）；`src/adapters/` 的 npm registry 与 GitHub Releases 只读客户端、文件快照和原子写入；`src/commands/` 的公开 `lock` 组装与后续顶层 `plan` 组装。先沿用单包 CLI 和已有 semver，HTTP 用受控超时、大小限制、分页和清晰错误的 Node 原生能力；需要新依赖须由具体缺口证明，不先建立通用插件框架。fixtures 使用临时目录与本地受控 HTTP server，不能依赖用户网络、凭证或真实工具。

1. npm fixture：范围、预发布、tag 变动、deprecated/unpublish、engines、os/cpu/libc、目标包缺失、无 integrity、registry URL 与意外重定向；验证 Pi/pnpm 实际元数据形状和拒绝无证据映射。
2. Release fixture：分页、稳定/预发布、draft、缺/重复 asset、缺 digest、checksum 冲突、跨域跳转、403/限流及失败；验证 uv 与 herdr 资产精确关联，而非拼 URL。
3. 契约 fixture：四组件 `coding` 有任何未支持或缺目标时无法生成可写的完整候选锁；保留 `agent-status`、Pi/herdr 集成及原 profile；只支持 npm 的首切片明确失败并不写锁。
4. 原子性 fixture：相同输入字节稳定；更新一个组件不改变其他项；同次 `lock` 解析至落盘期间的旧锁/声明或所用元数据变化、写入失败、并发 writer 均不得静默覆盖旧锁；已冻结锁应用时 latest 变化不触发重新解析。
5. 平台 fixture：macOS 两架构、Linux 两 libc、Windows 原生及 ARM64→x64 仿真明确拒绝；WSL 分开；未知目标/必需 ABI 不默认成功，来源未提供的其他最低版本标明未知并按上述规则处理。
6. 网络与冻结 fixture：`lock --dry-run` 不写锁且不能直接用于 `apply --plan`；`lock --out` 是候选锁，`plan --out` / `update --dry-run --out` 是含本机前提的计划。冻结后 tag/latest 推进不影响 apply；已观察到的资产/digest 或本机基线变化则失败。`--offline` 无网络且缓存缺失/损坏失败，缓存完整时仍校验 digest，并标记未核查远端撤回。
7. 后续 apply 独立验收：下载后的 digest 匹配/不匹配、锁定资产缺失、归档安全、已有未知渠道、本机观察与锁不一致、重复操作及恢复。静态计划通过不算这些测试已通过。

## 审查前未决事项

- 首建可靠本机目标、当前 Node 确切版本及后续保留的推荐默认值仍待用户审查；各来源的最低 OS/glibc 未知信息是否足以建立目标映射仍需逐项决定。
- GitHub API 403 的可用性、限流和认证方案；认证不得进入锁/日志。所选 uv 版本与 herdr release 的资产和 digest 需在可访问环境逐项核实。
- herdr stable 对 GitHub release 的筛选是否与其官方渠道 manifest 完全一致；如不一致，以可验证的明确渠道映射为准，不能猜测。
- npm 包安装的受控原生锁、生命周期脚本和 pnpm 各版本原生二进制物化策略；首轮只承诺列出的资产，不保证依赖闭包。
- 解析快照复核的时限与离线缓存完整性/有效期策略、本机执行计划过期策略，以及协作锁无法约束外部编辑器的剩余竞争窗口。

## 当前版本候选来源实现

`lock --dry-run` 对 uv 使用 [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases) 分页，仅选择正式 release 的确切 semver tag；例如官方 [0.13.8 release](https://github.com/astral-sh/uv/releases/tag/0.13.8) 使用不带 `v` 的 tag。herdr stable 从 [官方 manifest](https://herdr.dev/latest.json) 的 `version` 字段读取；[官方更新源码](https://raw.githubusercontent.com/herdrdev/herdr/master/src/update.rs) 将该 URL 指定为 stable manifest。未指定 `--target` 时只报告来源版本和身份，不解析发行资产或其 digest；无论是否指定目标，当前均不生成完整锁。

当前 `--target` 可从同一次 [herdr stable manifest](https://herdr.dev/latest.json) 快照预览 macOS arm64/x64 和 Windows x64 的 URL 与预期 SHA-256；Windows 为 zip 整体。对应入口与格式见[官方安装文档](https://herdr.dev/tui/docs/install/)。Linux ABI 和最低系统条件尚未在本切片得到足够证据，故不作兼容判断；uv 目标资产尚未覆盖。预期摘要不等于已下载验证或签名，报告不是锁。

当前 npm 目标预览只覆盖 macOS arm64/x64 和 Windows x64；pnpm native 映射只接受已核对源码的 12.15.0 和 12.18.0，其余版本明确阻塞。Pi 报告选中顶层 tarball；pnpm 报告顶层包及选中 manifest 的确切 native optional package，分别保留 registry 的 SHA-512 SRI。目标映射依据 [pnpm 12.15.0 native-binary.mjs](https://github.com/pnpm/pnpm/blob/v12.15.0/pnpm/npm/pnpm/native-binary.mjs) 、[12.18.0 native-binary.mjs](https://github.com/pnpm/pnpm/blob/v12.18.0/pnpm/npm/pnpm/native-binary.mjs) 与 [install.js](https://github.com/pnpm/pnpm/blob/v12.15.0/pnpm/npm/pnpm/install.js)，并核对实际发布 manifest 的依赖声明。此元数据不证明脚本执行、传递依赖闭包或目标运行兼容性。
