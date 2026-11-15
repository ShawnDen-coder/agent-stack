# 项目结构与架构

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md) · [路线图](roadmap.md)

Agent Stack 使用同一份 Git 仓库保存共享配置与工作方法，npm CLI 读取这份 checkout，并逐步实现检测、安装、配置应用和升级。当前代码提供声明校验、有限只读工具链检测，npm、uv、herdr 的候选报告，以及显式支持目标的首次共享锁创建；原生 macOS 的 uv-only setup 已可按锁安装或复用，Herdr-only 可按锁安装或复用匹配的已有入口；锁更新、离线解析、其他部件安装和配置应用尚未实现。

## 目录职责

```text
agent-stack/
├── stack/                  # Git 管理的共享配置与声明
│   ├── components/         # 工具来源、平台和能力声明
│   ├── profiles/           # 组合声明
│   ├── integrations/       # 部件之间的协作声明
│   ├── configs/            # 各工具的原生共享配置
│   ├── agents/             # Agent 的职责与工作约定
│   └── skills/             # 标准 SKILL.md 及支持文件
├── src/
│   ├── cli.ts              # 命令入口和参数解析
│   ├── commands/           # 组装一次用户操作，决定输出和退出码
│   ├── core/               # Schema、声明校验；不读文件或启动进程
│   └── adapters/           # 仓库文件等外部边界
├── test/                   # 从编译后的 CLI 验证外部行为
├── docs/                   # 架构、技术选型、实施计划
├── .github/workflows/      # 跨系统检查
├── pnpm-lock.yaml          # CLI 自身的依赖锁
└── package.json            # 单个 npm CLI 包
```

目录对应实际内容和职责，新增能力时再增加模块。当前不拆 workspace 包；以后出现第二个独立发布或部署的应用，再确定需要共享的包边界。

`stack/configs/`、`stack/agents/`、`stack/skills/` 已建立各自的编写约定，尚未放入自动应用的原生配置或可执行工作流。它们不属于当前 `validate` 命令的校验范围。

## 声明书写格式

自有的人编写声明采用 YAML 1.2：`stack/components/<id>.yaml`、`stack/profiles/<id>.yaml`、`stack/integrations/<id>.yaml`，接受 `.yml`，过渡期兼容 JSON。仓库现有声明已迁移，数据模型与能力要求不变。

YAML/JSON 解析后统一经过 Zod 校验；同一 ID 跨格式重复时失败，不静默选择一个。单文件单文档，拒绝重复键和未知自定义标签，不做 include 或环境变量/Shell 求值。只读候选报告对所选、已校验的规范数据输出声明摘要；首次锁可从完整元数据创建，`validate --lock` 可离线核对结构与声明；原生 macOS uv-only 可按锁应用，锁更新和其他部件应用尚未实现。读取或锁定不自动重写作者文件。

工具原生配置保持 JSON/TOML/YAML 等原格式；skills 保持标准 Markdown 与 YAML front matter。机器生成的 `stack/stack.lock.json`、执行计划和 CLI JSON 输出继续使用 JSON。人编写的声明与机器产物分别维护。完整示例和命令分工见 [CLI 行为审查稿](cli-behavior.md)。

## 四种声明

### 部件

`stack/components/<id>.yaml` 描述一个外部工具的身份、来源、适用平台与能力。Pi、pnpm、uv、herdr、Otty、Rex 各自维护，不作为 CLI 的运行依赖打包。升级某个工具不要求先发布新的 Agent Stack。

当前 `kind` 覆盖 runtime、CLI、workspace、terminal。MCP 和第三方 skills 的来源与锁定契约，等对应能力实现时增加；不使用看似通用但尚无消费者的协议。

一个部件可以提供多个能力。当前 Rex 条目表示带本地 server 的 macOS App，同时声明 workspace 与 desktop-terminal；独立部署的 Linux/Windows Rex server 以后单独描述，不能由 macOS App 的支持范围推断。

`source` 记录 npm 包名或官方发布入口，当前不包含任意可执行安装脚本。安装器以后由 TypeScript adapter 实现，并尊重本机已有安装渠道。

### 组合

`stack/profiles/<id>.yaml` 选择部件及版本要求、启用哪些集成、需要哪些能力，并明确这份组合覆盖的平台。

- `version` 是期望的版本要求；`channel` 是期望渠道，二者互斥。
- `validate` 仅校验选择器结构；`doctor` 对已观察到的版本使用 semver 比较范围，不查询渠道，也不证明部件之间兼容。
- 一个部件只能选择一次；同一 profile 的每个目标平台都必须在所选部件和集成的平台声明中。
- `requires` 声明组合必须具备的能力。组件与已选且依赖完整的集成共同提供这些能力。
- 平台只接受 `darwin`、`win32`、`linux`。Windows 原生与 WSL 分开安装和记录状态；WSL 使用 Linux 部件。

`coding-rex` 是独立实验组合。它要求终端控制，未声称具备 herdr 集成所提供的 Agent 状态报告。若在保留原需求的情况下替换 herdr，缺失能力必须明确报告，不能偷偷删除需求让校验通过。

### 集成

`stack/integrations/<id>.yaml` 独立记录参与部件、平台和额外能力。静态校验确保所引用部件存在、profile 已选齐参与部件、平台声明一致。

例如 Pi/herdr 的状态报告与 Pi/Rex 的控制 skill 是不同集成。通用工作流表达目标、验收和证据，工具专属 skill 保存原生命令；选择组合时再加载对应指引。

这些条目是本仓库内部标识，不是同名 npm 包，也不代表安装 adapter 已实现。真实功能还需要对应版本与平台上的运行验证。

### 锁文件

`stack/stack.lock.json` 可由 `lock` 在显式目标且证据完整时首次生成；不提交空锁或手写假版本。锁中记录预期 digest，并不代表下载字节校验、依赖闭包或运行兼容性已完成。它与 `pnpm-lock.yaml` 作用不同：

| 文件                                | 锁定对象                                              |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm-lock.yaml`                    | Agent Stack 自身的 npm 依赖，包括编译、校验和格式工具 |
| `stack/stack.lock.json`（首次创建） | 所选 profile 中外部部件的确切版本、来源及各平台发行物 |
| 业务项目自己的锁文件                | 业务依赖；由 pnpm、uv 等原生工具管理                  |

锁文件的实施约束：

1. 从 profile 的范围或渠道解析到确切版本；Git 来源解析到 commit，下载发行物记录可验证的校验值。
2. 平台目标包含 OS、架构及所需 ABI；缺少目标记录时失败，不能临时安装 latest。
3. 记录所选集成和相关定义变化，保留稳定的 diff；绝对路径、认证和会话不写入锁文件。
4. 普通安装按锁应用；显式更新才重新解析，展示最小必要依赖变化并验证。
5. 已有生态的传递依赖使用原生锁机制；不宣称固定顶层版本就固定了整个依赖树。
6. 无法可靠固定或降级的 App/系统包明确报告限制。Git 回退配置不等于运行数据迁移可以回退。

## 配置与状态归属

| 内容                                               | 位置与所有者                                                  |
| -------------------------------------------------- | ------------------------------------------------------------- |
| 部件、profile、集成、共享原生配置、Agent、skills   | 当前 Git checkout                                             |
| CLI 代码与自身依赖                                 | npm 安装的 Agent Stack 包                                     |
| 实际版本、可执行路径、安装渠道、应用记录、配置备份 | 设备本地状态目录，已实现 uv-only 绑定与恢复记录，其余后续实现 |
| Token、OAuth、会话、缓存                           | 各工具的原生本地目录                                          |
| 项目规则、验收入口、pnpm/uv 业务依赖               | 各业务项目                                                    |

[Setup 实施方案](setup-plan.md) 定义按锁对齐的分片与验收；[配置变体审查稿](config-variants.md) 说明未来如何将逻辑目标与平台内容变体分开；当前 schema 和配置应用尚不支持该设计。配置 adapter 应明确文件或字段的归属，保留未知内容和本地修改。能直接引用的资源可以引用；需要写入的文件再复制或合并。跨系统不能只依赖软链接。凭证不通过仓库或 npm 包分发。

当前 npm 包的 `files` 仅包含 `dist`，npm 自动附带的 README/package metadata 除外。CLI 不从安装包内查找一份陈旧的配置副本，`--repo` 明确指定源 checkout。

## 代码边界

调用方向为 `cli → commands → core / adapters`。core 只接收已解析的数据并返回结果；文件、网络、子进程等外部操作由 adapter 承担。导入业务模块不启动服务、不连接网络、不应用配置。

现阶段 repository adapter 读取定义，toolchain adapter 执行受限版本查询和读取包元数据，npm-registry 与 releases adapter 只读查询官方版本元数据。uv adapters 负责有界下载、摘要与归档检查、版本查询、受管发布及本机绑定和恢复；配置应用尚未实现。CLI 不直接拼接 Shell 命令。Windows 标准 cmd-shim 经完整模板与包元数据静态核对；未知包装器不执行。

`--repo` 指向仓库根目录；声明仅读取其 `stack/` 下的目录，不读取根目录旧布局。默认外部部件锁位置为 `<repo>/stack/stack.lock.json`；首次创建必须显式指定已支持目标。Linux ABI、更新、离线解析及其他部件安装尚未实现。

### 来源规则与锁校验

来源解析核对真实响应及身份，并与离线锁校验共同调用对应来源的纯资产规则；锁校验直接使用锁内字段，不虚构远端记录。报告与持久锁仍是不同产物；本地规则匹配不能证明远端发布或下载字节。

### 锁操作协调

`lock` 命令负责参数、profile、报告、退出码和整个操作的中断生命周期。来源 adapter 将版本结果与本次快照一起返回，资产收集和写前复核共用该快照；每个进度阶段自行清理。一次操作只维护一个 handler，发布成功后不报告取消。来源规则仍在 core，文件和网络 I/O 仍在 adapters。

### 共享边界与保留差异

网络 adapter 共用响应体的有界读取、JSON 解析和 reader 清理；npm 与 release 仍各自决定请求、超时、预算及错误。锁文件是本机普通文件，使用独立的 1 MiB 读取边界。报告和持久锁共用来源身份与声明摘要字段形状，报告保留部分失败和宽松解析，锁继续严格拒绝未知字段；两者不合并为一个模型。

## 校验的证据范围

`validate` 证明定义之间一致，不证明工具已安装、版本可下载或集成能运行。平台和能力声明本身仍需证据维护。当前 `doctor` 仅检测部分工具链，pnpm/Pi 通过可核对的包元数据观察版本而不启动程序；安装与更新流程负责运行验证，两者不能由静态校验代替。

当前 CLI 返回结构化 JSON 和稳定的成功/失败退出码。测试从编译后的 CLI 验证未知引用、平台不兼容、部件替换后的能力缺口、损坏文件、带空格路径及只读行为。

## 参考来源

- [Pi 配置与 packages](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)：使用原生资源与配置机制。
- [herdr 集成](https://herdr.dev/tui/docs/integrations/)：Pi 状态报告的声明来源。
- [Rex Agent 支持](https://www.superlogical.com/rex/docs/automate/agent-skill)：Pi skill 与 hook 的支持范围不同。
- [Rex 安装](https://www.superlogical.com/rex/docs/installation)、[Otty 安装](https://docs.otty.sh/getting-started/installation)：客户端、服务端与平台范围需要分别核对。

## 调研与后续状态边界

[Herdr 调研](herdr-research.md)、[Pi 调研](pi-research.md)和 [Otty 调研](otty-research.md)记录固定证据及未验证范围；它们不替代共享锁。多部件状态的默认绑定、回执、资源归属与 journal 迁移契约见 [setup 方案](setup-plan.md#多部件状态兼容契约)。

当前 `setup-state` 严格读取 v1/v2 状态并投影默认上下文；v1 只在内存归一化，真正成功写入使用 v2 快照。`managed-operation` 提供安全文件读取、身份与摘要、归属删除和 guard。uv 特定 owner、journal、提交及恢复仍由 uv adapter 负责；Herdr managed 安装目前仅支持原生 macOS。
