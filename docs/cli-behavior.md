# Agent Stack CLI 行为规范

状态：**已实现接口与后续设计并列。** 第 1 节记录当前可运行行为；第 2 节起为后续命令的目标设计，尚未实现，不能作为操作指南。新用户从 [Quickstart](quickstart.md) 开始。

日常只记四个动作：**配、查、跑、升**。`setup` 配置或重新对齐设备，`doctor` 检查问题，`run` 启动 Agent，`update` 升级指定部件。首次配置后通常不用反复输入 repo/profile。

| 想做什么                      | 日常命令（拟议）         |
| ----------------------------- | ------------------------ |
| 首次配置或 Git 拉取后对齐环境 | `agent-stack setup`      |
| 检查当前设备                  | `agent-stack doctor`     |
| 开始开发                      | `agent-stack run coding` |
| 升级 Pi                       | `agent-stack update pi`  |

`lock/plan/apply/validate/profile` 是进阶操作，按需使用。普通用户不必每次手动走 `lock → plan → apply`；setup/update 自己展示计划并复用相同底层步骤。共享配置与工作方法由 Git 管理。

## 1. 当前确实能用的接口

当前包尚未发布到 npm。以下是仓库构建后的实际调用方式：

```sh
pnpm cli --help
pnpm cli --version
pnpm cli validate --repo . --json
pnpm cli doctor --repo . --profile coding --json
```

| 当前接口                                                        | 实际行为与成功含义                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `validate [--repo <dir>] [--lock [file]] [--json]`              | 校验部件、profile、集成的格式、引用、平台声明和能力要求。退出 0 仅说明声明一致。         |
| `doctor [--profile <id>] [--repo <dir>] [--json]`               | 观察当前 Node、npm、Git，以及所选 Pi、pnpm、uv、herdr 的有限版本证据。未检查项单独列出。 |
| `lock --profile <id> --target <target> [--out <file>] [--json]` | 首次新建共享锁，目标可重复；默认锁或输出已存在则拒绝。                                   |
| `lock --profile <id> --dry-run [--json]`                        | 报告版本候选；可用重复的 `--target` 预览部分 Pi、pnpm、uv 和 herdr 资产，不写锁。        |
| `--help`、`help [command]`、`--version`                         | 显示当前已注册命令的帮助或 CLI 自身版本；不执行配置操作。                                |

当前 `--repo` 默认是调用时的当前目录；`--repo` 和 `--json` 可写在根命令或子命令位置。`doctor` 和 `lock --dry-run` 在交互 TTY 可选择 profile；JSON、CI 或非交互环境必须显式提供 `--profile`。声明读取器支持 YAML、YML 和过渡期 JSON，同 ID 冲突时报错。`validate --lock` 离线校验默认共享锁，显式文件相对调用目录；不检查远端、下载字节或安装。首次创建必须指定目标，`--out` 与 `--dry-run` 互斥；锁的 Node 假设为运行时确切版本。当前未实现锁更新、离线模式、设备默认绑定、环境变量选项、部件筛选、资源筛选、其他锁读取功能或后文的新命令。

当前 `doctor` 的 Pi/pnpm 证据来自可核对的 package metadata，不证明程序可启动；herdr 仅查询当前平台的原生入口。`stable` 渠道仍未解析，Otty/Rex 与集成仍未检查。退出 0 只针对报告中已检查的范围，不能解释为整套环境 ready。当前业务检查失败退出 1，用法错误退出 2，取消退出 130。成功 JSON 及业务错误沿用已有形状；参数解析错误为 `{"schemaVersion":1,"error":{"kind":"usage","message":"..."}}`，帮助/版本的 JSON 包装为 `{"schemaVersion":1,"output":"..."}`。后文完整统一输出契约仍待实现。

**从第 2 节开始，所有命令示例均为拟议接口，不能当作当前可运行的说明。**

## 2. 命令层级与职责

顶层使用用户动作；只有成组的只读查询使用第二层。命令层级最多两层。目标帮助页按常用/进阶分组；这只是展示分组，不新增一层命令，也不要求记另一套缩写。帮助始终只列已实现的命令。

```text
agent-stack <command>

常用命令
  setup                     配置或重新对齐设备，登记日常默认值
  doctor [component...]     检查本机实际情况
  run <agent> -- [args...]   启动 Agent，保留运行时原生参数
  update <component...>     显式升级或降级指定部件

进阶命令
  validate                  校验仓库声明与指定的锁
  lock                      生成或维护期望版本锁
  plan [component...]       预览“当前环境 → 期望状态”的差异
  apply [component...]      精细应用或执行已保存计划
  profile list              查看可选组合
  profile show <id>         展开组合的要求与资源
```

| 层次       | 命令                | 输入                                        | 主要输出                               | 持久写入                              |
| ---------- | ------------------- | ------------------------------------------- | -------------------------------------- | ------------------------------------- |
| 日常入口   | `setup`             | checkout、profile、已有完整锁、本机观察     | 全量配置计划与执行结果                 | 用户工具/配置、设备默认绑定与应用记录 |
| 日常入口   | `doctor`            | checkout、profile、本机观察；可指定锁       | 要求、实际证据、问题、未检查项         | 无，查询临时目录除外                  |
| 日常入口   | `run`               | Agent 定义、profile、业务工作目录、原生参数 | 原生 Agent 会话与退出码                | 由运行时按其原生行为写入会话等数据    |
| 可组合操作 | `validate`          | checkout；可指定锁                          | 声明/锁的一致性报告                    | 无                                    |
| 可组合操作 | `lock`              | profile、目标集合、已有锁、官方来源元数据   | 完整锁与版本差异                       | 仅指定的共享锁文件                    |
| 可组合操作 | `plan`              | checkout、完整锁、本机观察、筛选条件        | 具体动作、冲突与可选的计划文件         | 仅显式指定的计划文件                  |
| 可组合操作 | `apply`             | 完整锁与本机差异，或已保存计划              | 执行结果、证据和应用记录               | 计划内的本机资源与状态                |
| 变更入口   | `update`            | 指定部件、profile、旧锁、官方来源元数据     | 候选版本与执行结果                     | 本机资源；成功后更新共享锁            |
| 查看组合   | `profile list/show` | checkout                                    | 平台、部件、来源、要求、资源与能力缺口 | 无                                    |

`setup` 复用 `plan/apply/doctor`，`update` 复用候选锁解析、`plan/apply`。快捷入口与拆分操作使用相同规则和 adapter；不各自实现一套安装逻辑。

## 3. 配置书写：自有声明优先 YAML

YAML 是已实现的声明格式；读取器也兼容 `.yml` 与过渡期 JSON。

| 内容                                          | 目标格式                           | 说明                                                              |
| --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| components、profiles、integrations            | 首选 `.yaml`                       | 人编写的共享声明，可加注释；兼容 `.yml` 和过渡期 JSON。           |
| Agent 元数据                                  | YAML；可作为 Markdown front matter | 具体加载契约在 run 实现时确定，职责和长指令使用 Markdown。        |
| skills                                        | 标准 `SKILL.md`                    | front matter 使用 YAML，工作流正文使用 Markdown。                 |
| configs 中的工具配置                          | 工具原生格式                       | Pi JSON、herdr TOML 等保持原格式；原生支持 YAML 的工具使用 YAML。 |
| `stack/stack.lock.json`、执行计划与 JSON 输出 | JSON                               | 机器生成，便于严格校验和稳定序列化。                              |
| package.json、pnpm-lock.yaml、业务锁          | 各自原生格式                       | 分别由 npm/pnpm/业务生态维护。                                    |

目标 `stack/profiles/coding.yaml` 的完整示例，字段含义与现有 JSON profile 保持一致：

```yaml
schemaVersion: 1
id: coding
description: Pi 与 herdr 的终端开发组合
platforms: [darwin, win32, linux]

components:
  - component: pi
    version: ">=1.5.2 <2"
  - component: pnpm
    version: ">=12.15.0 <13"
  - component: uv
    version: ">=0.13.8 <0.14"
  - component: herdr
    channel: stable

integrations: [pi-herdr]
requires:
  - agent-runtime
  - workspace
  - node-packages
  - python-tools
  - agent-status
```

迁移时遵守以下行为：

- YAML/JSON 都先解析成数据，再由同一份 Zod schema 校验；文件格式不改变 profile 或能力语义。
- 同一 ID 出现于 `.yaml/.yml/.json` 中时明确报重复错误；YAML 优先指作者的默认格式，不表示静默覆盖其他文件。
- 使用 YAML 1.2，单文件单文档；拒绝重复键与未知自定义标签，不做 include、Shell 或环境变量求值。
- 版本范围等字符串建议加引号，`schemaVersion` 保持数字。类型错误明确报字段位置，不自动猜测类型。
- 锁中的声明摘要基于 schema 校验后的规范数据；注释、缩进或等价 JSON→YAML 转换不改变摘要。
- 读取、检测、锁定都不自动重写作者文件或丢弃其注释；配置同步仍由 Git 和明确的应用动作完成。

## 4. 上下文：配置仓库、profile、业务目录

### 配置仓库

需要 checkout 的命令按以下优先级确定来源，并在输出中显示最终选择及其来源：

1. `--repo <dir>`。
2. `AGENT_STACK_REPO`。
3. 本机由成功的 `setup` 登记的默认 checkout。
4. 调用时的当前目录；该目录必须能作为配置仓库读取，否则报错。

不搜索磁盘或偷偷选择其他 Git 仓库。默认 checkout 路径仅保存在本机，不写入共享仓库。显式 `--repo` 是本次覆盖，不修改默认绑定；checkout 被移动或删除时报错并提示重新登记。

### Profile

需要 profile 的命令使用 `--profile <id>` → `AGENT_STACK_PROFILE` → **所选 checkout 对应的**本机默认 profile。没有明确结果时要求指定，不猜一个 `coding`，也不弹出选择器阻塞脚本。`validate` 默认校验整个仓库；`profile list/show` 不要求默认 profile。

`setup --repo ... --profile ...` 在应用成功后登记这组日常默认值，以及此次使用的锁位置。其他命令的 `--profile` 都是临时覆盖，不改默认值；应用记录独立记录实际 profile 与资源归属。换一份 checkout 时不会沿用旧仓库的 profile 默认值。

默认锁按 `--lock <file>` → 所选 checkout/profile 已登记的锁位置 → checkout 下的 `stack/stack.lock.json` 选择。推荐一份锁对应一份 profile；多份组合使用不同锁文件，profile 不匹配时不得套用。设备登记只保存引用，不复制一份私有版本的共享锁。

### Agent 与工作目录

`coding` Agent 定义决定职责、运行时与需要的资源；`coding`、`coding-rex` profile 决定环境组合。两个名字即使相同，也分别解析。

`run` 在调用时的当前目录启动，或用 `--cwd <dir>` 指定业务项目。`--repo` 始终指配置源，不改变业务目录。其他显式相对路径，包括 `--repo`、`--lock`、`--out`、`--plan`，均相对调用时目录解析；默认锁按上一节的规则定位。

```sh
agent-stack run coding --repo ~/agent-stack --profile coding-rex --cwd ~/work/app
```

## 5. 每个命令的行为

### `setup`：按已有锁配置或重新对齐设备

```sh
agent-stack setup --repo ~/agent-stack --profile coding --dry-run
agent-stack setup --repo ~/agent-stack --profile coding --yes
```

首次和后续对齐使用同一入口。已有默认绑定后直接运行 `agent-stack setup`；当前状态已满足时 no-op，不重复安装，也不重新解析版本。普通用户在 Git 拉取后再次 setup 即可；只应用某个资源、限定范围或执行保存计划时再使用进阶 apply。

1. 读取 checkout 和完整锁，验证声明、当前目标及必需 adapter。
2. 观察已有工具、配置与归属，生成完整计划，展示复用、安装、配置、PATH 变更及冲突。
3. 经交互确认或 `--yes` 执行；按 adapter 管理范围备份并应用。
4. 检查可执行入口和配置结果，报告仍需真实会话验证的集成。
5. 成功后登记默认 checkout/profile/锁位置，保留本机应用记录。

配置按已归属字段比较实际值、上次成功写入值与新期望：实际等于新期望时 no-op；实际仍等于上次值时可更新；其他本地漂移冲突。计划形成后的源、目标或环境变化另行阻止执行；详见 [setup 方案](setup-plan.md)。

锁缺失、过期或缺当前目标时，在修改设备前失败，并提示显式运行 `lock`。`setup` 不重新选择版本。新机器的一条配置命令成立的前提，是 Git 中已有覆盖该机器的锁，以及已具备 Node/npm、Git 和 Agent Stack CLI。

`setup` 面向整份组合，不接受部件/资源筛选；只配一部分用 `apply`。需要真实会话的集成验收显示为待验证，不能标成已运行。已知必要步骤失败或必需 adapter 不支持时返回非零，不将部分配置记为完整成功。

### `validate`：检查期望声明是否自洽

```sh
agent-stack validate --repo ~/agent-stack
agent-stack validate --profile coding --lock ./stack.next.lock.json --json
```

默认校验整个 checkout；`--profile` 仅缩小验收对象，其引用仍完整检查。提供 `--lock` 时，额外检查锁结构、profile/声明摘要、组件与目标完整性。未提供锁不把“尚无锁”当作声明错误。资源校验器逐项接入；报告列出已覆盖与未覆盖的资源，不因目录存在就声称原生配置有效。

本命令不查询发行源、不读取安装状态，也不启动 Agent。锁引用一致不等于资产已下载或集成可运行。

### `doctor`：看本机，而不是改本机

```sh
agent-stack doctor
agent-stack doctor pi pnpm --json
agent-stack doctor --scope configs --resource config:pi.settings
agent-stack doctor --lock ./stack.next.lock.json --strict
```

默认执行当前已支持的快速本机检查，分别展示 profile 要求、指定锁的确切版本、实际观察和证据；不查询新的发布版本。Node/npm/Git 等必要前置检查仍会报告。检查范围和未检查项必须保留，筛选后的成功不代表整份 profile 可用。

证据区分包元数据、版本命令、配置一致性、实际运行状态等，不把版本输出视为工作区或集成在线。渠道未解析、入口无法核对、PATH 缺失、版本不符、平台不适用分别报告。

`--strict` 要求本次范围内的必需检查没有失败、未知或未覆盖项；不能提高证据等级。默认不启动 TUI/服务/模型会话，不刷新认证，不自动修复。需要真实入口的后续验收另行设计，不能悄悄加入快速检测。

### `lock`：维护期望版本，不安装工具

```sh
agent-stack lock --profile coding --target darwin-arm64 --target win32-x64
agent-stack lock --profile coding --update pi --dry-run --json
agent-stack lock --profile coding --update pi@1.5.2 --out ./stack.next.lock.json
```

首次创建时为整个 profile 和明确目标集合解析版本。已有锁时保留仍满足要求的版本；只有 `--update <component[@exact]>` 指定的部件重新选版本。该选项可重复，未指定版本时选择符合来源策略与范围的候选；指定确切版本仍须符合 profile 和来源的渠道/预发布策略。新声明或新增目标需要的解析必须在差异中列明；旧版本不再满足要求时，要求显式更新，不能顺手升级其他部件。

`--target` 可重复。初次未指定时，只使用能够可靠识别的当前宿主目标；无法识别 Linux ABI 等条件时要求显式指定。已有锁未指定目标时保留原目标集合；显式提供目标集合表示新的完整集合，增加和移除都显示在差异中。一个部件优先在全部目标共用同一版本；目标缺项时失败，不悄悄让各机器安装不同版本或回退到旧版本。

`--node-version <exact>` 指定 npm 解析的 Node 假设；首建默认为本次 Node 确切版本，后续沿用旧假设，改变须显示。它不安装或管理 Node。实际应用时还要验证当前 Node 与锁内包的兼容条件。

默认在所选锁位置原地维护，`--lock` 可显式指定这份输入/输出锁；`--out` 改为写另一份候选锁，不改输入锁或设备默认值。为另一份 profile 首建时，显式输出到独立文件，不能覆盖其他 profile 的锁，也不将其当作可复用的旧锁；显式 `--lock` 与 profile 不匹配则报错。`--dry-run` 只输出候选和差异，不能同时用 `--out`。所有所选部件与目标完整才可写，任何来源不支持、目标/digest 缺失或解析期间的元数据变化都保留旧文件。正式锁不允许“其余稍后补齐”。

频道是解析时取样的选择器，锁固定审查后的确切落点。普通 apply 不要求重新查询频道；后来出现新版本本身不使旧锁失效。资产可用性、预期摘要与声明兼容条件仍须验证。

锁定保证分层表达：确切顶层包与资产不自动等于 npm 传递依赖闭包可复现；配置/skills 的版本仍由 Git 管理。此命令公开单入口，候选解析、复核和原子写入作为内部步骤。

### `plan`：预览本机将发生的事情

```sh
agent-stack plan
agent-stack plan pi --scope tools
agent-stack plan --scope skills --resource skill:verify --out ./.agent-stack/verify.plan.json
agent-stack plan --scope configs --check --json
```

读取 checkout、本机观察及变更所需的锁，输出安装/复用/配置差异、依赖顺序、归属、备份和冲突。不重新解析版本，不执行安装脚本，不修改工具或配置。即使存在差异，普通 `plan` 成功生成计划仍返回 0；`--check` 则要求没有需要应用的变化，适合漂移检查。

可独立预览已有资源的纯配置/skills 变更；涉及工具版本或依赖版本专属 adapter 时必须有对应有效锁。省略工具安装范围不等于省略其前置条件检查。

`--out` 显式保存机器可读取的计划；没有该选项就不保存文件。计划区分可执行动作与阻塞项，有阻塞项的计划供诊断，不能用于 `apply`。执行计划是本机产物，可能含目标路径；应放在被 Git 忽略的目录，不是跨设备共享锁。

存在阻塞项时返回 1；`--check` 的退出码 3 只表示可生成有效计划但有差异，不能用于掩盖冲突或不支持的 adapter。

### `apply`：执行当前期望，或执行冻结的计划

```sh
agent-stack apply --dry-run
agent-stack apply pi --scope tools --yes
agent-stack apply --resource config:pi.settings --yes
agent-stack apply --plan ./.agent-stack/verify.plan.json --yes
```

直接模式按当前锁和筛选条件计算计划、确认并执行；纯资源操作沿用 plan 的锁要求例外。不追踪频道、不升级到 latest。重复应用无差异时是 no-op。

`--plan <file>` 模式执行保存的动作，核对源声明/锁、本机目标、版本、归属和目标文件基线摘要。任一执行前提变化则失败，要求重新规划，不在后台生成另一份计划替代审查结果。该模式不能再混用 profile、部件、scope、resource 或 lock 覆盖选项；显式 `--repo` 只能定位并核对同一来源。

修改范围以 adapter 声明为准：保留未知配置字段；保留本地修改并报冲突；只恢复/删除本工具有归属记录且基线匹配的内容。已满足要求的外部工具可不写入地复用，同时保留来源与证据限制；要修改来源未知或无法按锁操作的工具时阻塞，不擅自接管安装渠道。必要的额外动作必须进入计划，不能在执行时悄悄扩大选择范围。

`--dry-run` 使用与真实执行相同的规划和前置检查，输出将做什么，不写工具、配置或应用记录。保存计划模式同样可以 dry-run。

### `update`：显式改变部件版本，并应用到本机

```sh
agent-stack update pi --dry-run
agent-stack update pi uv --yes
agent-stack update pi@1.5.2 --yes
agent-stack update --all --dry-run
agent-stack update pi --dry-run --out ./.agent-stack/pi-update.plan.json
```

推荐语义：`update` 完成“指定部件重新解析 → 候选锁与本机计划 → 确认 → 应用与验收 → 发布新锁”。只想维护 Git 中的期望版本，用 `lock --update`。

必须指定部件，或明确 `--all`；空的 `update` 返回用法错误，不默认升级全部。`pi@1.5.2` 也可表达降级，但版本必须符合声明，且安装渠道和迁移边界支持。重复选择去重，同一部件给出冲突版本时报错。失败不会通过修改 profile 范围或删除能力要求继续执行。

新版本为锁中的完整目标集合解析，本次安装只发生在当前设备。未授权部件的版本保持不变；如果兼容要求需要同时修改其他部件，阻塞并列出原因，由用户重新显式选择。当前不管理的外部安装渠道保持原有归属；adapter 无法按锁更新时给出问题，不改用另一渠道。

`--dry-run` 允许查询官方来源但不写共享锁、本机工具或配置；只在此模式允许 `--out` 保存包含候选锁的完整执行计划。后续 `apply --plan` 可执行同一个候选，不重新选择版本。

新锁在本次应用与验收成功后原子替换；同时核对旧锁与声明基线。安装是多个外部动作，失败或最终锁写入冲突时可能已有部分本机变化，必须报告 partial 状态与恢复证据，不能承诺跨工具原子事务。配置备份恢复与程序降级分别处理，运行数据/会话不在通用回退保证内。

### `run`：启动 Agent，保留原生使用体验

```sh
agent-stack run coding
agent-stack run coding --profile coding-rex --cwd ~/work/app
agent-stack run coding -- --model provider/model
agent-stack run coding --dry-run --json
```

解析 Agent 定义、所选组合与必要资源，检查启动前提，再通过运行时 adapter 启动。缺定义、缺运行时或资源不满足时给出明确错误；不临时安装、更新或补写配置。

`--` 后的 token 原样作为参数数组传递给原生运行时；不用 shell 拼字符串，也不重新解释为 Agent Stack 选项。真实运行继承终端输入输出，转发中断并保留原生退出码。正常运行不接受 `--json`；`--dry-run --json` 仅报告启动上下文与前置检查，不启动模型。启动预览只显示透传参数数量与环境变量键名，省略原生参数和环境变量的值。

默认启动当前终端内的 Agent；herdr/Rex 的工作区操作继续由其原生入口负责。需要宿主上下文的 Agent/集成必须检查该上下文，缺失时报告，不默默降级。使用者仍可直接运行 `pi`、`herdr`、`pnpm`、`uv`；成功应用的原生配置无需每次经过 wrapper 才生效。

### `profile list/show`：了解组合，不隐式改组合

```sh
agent-stack profile list --repo ~/agent-stack
agent-stack profile show coding --json
```

展示声明的平台、组件版本/渠道、来源、集成、资源和能力要求；有锁时可附对应锁版本，明确它不是安装状态。它们不编辑文件、不选择默认 profile、不解析新版本。组合变更先在 Git 中编辑并验证，保持可审查的 diff。

## 6. 灵活性由一致的选择器提供

| 需求             | 统一表达                                           | 规则                                                      |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------- |
| 整份组合         | 不写部件参数                                       | 使用所选 profile 的完整范围。                             |
| 一至多个部件     | `doctor/plan/apply pi uv`                          | 按所选 profile 中的组件 ID 选择；陌生或未选择的 ID 报错。 |
| 只处理某类资源   | `--scope tools,configs,skills,agents,integrations` | 可用逗号或重复选项；默认全部适用范围，重复值去重。        |
| 只处理一项资源   | `--resource skill:verify`                          | 可重复；ID 来自所选组合的资源映射，不是任意物理路径。     |
| 指定期望版本     | `update pi@1.5.2` / `lock --update pi@1.5.2`       | 确切版本仍受 profile 范围与来源策略约束。                 |
| 其他机器的发行物 | `lock --target ...`                                | 仅解析/锁定目标；不能远程修改该设备。                     |
| 脚本使用         | `--json`、`--yes`、`--check`                       | 各自只用于适用的命令，含义固定。                          |
| 原生运行时选项   | `run coding -- <args...>`                          | 不为每个 Pi 参数增加包装选项。                            |

scope、部件和资源选择取交集；冲突或空选择报错，不能输出含糊的成功。未显式写 scope 时，资源 ID 本身限定种类，例如 `--resource config:pi.settings` 只处理这一配置资源；指定不相交的 `--scope tools` 则报错。

筛选只缩小本次检查/变更范围，不重写 profile，不删除它的能力要求，也不把部分成功变成整份组合成功。依赖不满足时计划给出阻塞原因，需要额外动作时要求明确纳入计划；本版不提供隐藏扩展的 `--with-deps`。

`skill:shape`、`skill:verify`、`agent:coding`、`config:pi.settings` 是拟议资源 ID 示例，当前尚无对应可应用的资源清单。scope 是行为分类，不把元数据伪装成原生配置。

MCP 的本地程序安装归入 tools，宿主连接配置归入 integrations，凭证留在本机。只有某运行时具有实际 MCP adapter 时才支持相应资源；未接入的 Pi/MCP 组合不能因写了一段 JSON 就报告可用。后续无需为每类 MCP 服务增加顶层命令。

## 7. 选项适用范围与组合规则

以下全部为目标设计；当前支持项以第 1 节为准。

| 选项                                          | 适用命令                                                | 行为                                                                            |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `--repo <dir>`                                | 所有需要配置源的命令                                    | 本次选择 checkout；支持在子命令前或后使用。                                     |
| `--profile <id>`                              | setup、doctor、run、validate、lock、plan、apply、update | 本次组合；保存计划执行模式除外。                                                |
| `--lock <file>`                               | setup、doctor、validate、lock、plan、apply、update      | 指定所读锁；lock 原地维护它，update 成功后替换它。只有 setup 成功会登记其位置。 |
| `--scope <kinds>`、`--resource <id>`          | doctor、plan、apply                                     | 缩小范围；apply 的保存计划模式禁止覆盖。                                        |
| `--target <target>`、`--node-version <exact>` | lock                                                    | 期望目标集合与 Node 解析假设。                                                  |
| `--update <component[@exact]>`                | lock，可重复                                            | 显式允许指定部件重新选版本。                                                    |
| `--all`                                       | update                                                  | 显式选择整份组合，与部件参数互斥。                                              |
| `--out <file>`                                | lock、plan；update 的 dry-run 模式                      | 分别保存候选锁或执行计划，输出类型由命令确定。                                  |
| `--plan <file>`                               | apply                                                   | 执行冻结计划，与重新选择动作的选项互斥。                                        |
| `--cwd <dir>`                                 | run                                                     | 业务进程工作目录。                                                              |
| `--dry-run`                                   | setup、lock、apply、update、run                         | 不改期望锁与设备资源；update 的显式计划输出除外。run 不启动进程。               |
| `--check`                                     | plan                                                    | 有待应用变更时使用专门退出码。                                                  |
| `--strict`                                    | doctor                                                  | 必需检查有未知或未覆盖也失败。                                                  |
| `--offline`                                   | setup、lock、apply、update                              | 只用已有锁与本地缓存；缺元数据/资产失败，不退回 latest。                        |
| `--yes`                                       | setup、apply、update                                    | 跳过计划确认，不绕过冲突、摘要检查或能力要求。                                  |
| `--json`                                      | 查询、规划及执行结果；run 仅 dry-run                    | stdout 输出机器结果，不夹带进度文本。                                           |
| `--verbose` / `--quiet`                       | 各命令                                                  | 调整 stderr 日志；互斥，不隐藏失败或改变 JSON。                                 |

`plan/doctor/validate/profile` 默认不查远程发行源；版本查询的临时文件不算持久配置写入。`lock/update` 可以联网读取元数据，`setup/apply` 可以下载锁内资产。离线更新只使用明确缓存的元数据，显示缓存来源与时间，不能称为刚确认的最新版本。

命令表的写入列描述共享文件、工具和配置；正常下载/解析可另用设备缓存，缓存不进入 Git。dry-run 使用内存或临时目录，不新增持久缓存；显式保存的候选计划是其唯一文件输出例外。

未知命令/选项报错，不自动猜测；重复的单值选项报错，避免不同层级的 repo/profile 值互相覆盖。支持的重复列表去重；重复且冲突的部件版本报错。示例之外的选项组合必须有消费者和验收用例，不能静默忽略不适用选项。

## 8. 完整使用链路示例

以下均是目标行为演示。路径只作用户输入示意，不写入共享锁；实际来源以用户的 Git checkout 为准。

### 维护者先准备可复现的组合

```sh
agent-stack validate --repo ~/agent-stack
agent-stack lock --repo ~/agent-stack --profile coding --target darwin-arm64 --target win32-x64 --target linux-x64-gnu
git -C ~/agent-stack diff
```

全部部件/目标均可解析后，维护者通过 Git 审查并提交 profile、原生配置和锁。尚不支持的来源必须先失败，不能删掉 herdr 或原能力要求来生成一个看似完整的 coding 锁。

### 换机器：恢复配置与工具

先用 Git 获得 checkout，并准备 Node/npm、Git 与 CLI，然后：

```sh
agent-stack setup --repo ~/agent-stack --profile coding --yes
agent-stack doctor
agent-stack run coding --cwd ~/work/app
```

已有工具按归属与证据复用；来源未知且需要改动的工具明确阻塞。认证在本机按工具原生流程完成，不从 Git 恢复。Windows 使用自己的 checkout 与本机状态路径；WSL 独立使用 Linux 目标与状态。

### 日常同步：按 Git 中已有的期望重新对齐

```sh
git -C ~/agent-stack pull --ff-only
agent-stack setup
```

采用拉取后的原生配置和已提交锁，不重新选择发布版本。如果 Git 中锁也被显式更新，计划会展示相应版本变化；如果只改了配置，已匹配的工具保持不变。已对齐时 no-op。

### 仅同步配置：使用进阶范围控制

```sh
git -C ~/agent-stack pull --ff-only
agent-stack plan --scope configs,skills,agents,integrations
agent-stack apply --scope configs,skills,agents,integrations --yes
```

这里只使用已拉取的配置源；如果变化影响依赖或 adapter 版本，先报前置条件，不顺手升级工具。需要环境一起跟随新锁时，用户显式执行不筛选 scope 的 `apply`。

### 升级一个部件：先预览，或冻结后执行

```sh
agent-stack update pi --dry-run
agent-stack update pi --yes
```

需要保存审阅结果时使用另一条等价路径：

```sh
agent-stack update pi --dry-run --out ./.agent-stack/pi-update.plan.json
agent-stack apply --plan ./.agent-stack/pi-update.plan.json --yes
```

前一次普通 dry-run 不冻结下一次重新规划的结果；要保证执行同一候选就使用保存计划。成功后审查并通过 Git 同步新锁，其他设备再运行 `apply`。它们不会因为这台机器更新了工具就自动被更新。

### 只调整某个配置或 skill

```sh
agent-stack plan --resource config:pi.settings
agent-stack apply --resource config:pi.settings --yes
agent-stack apply --scope skills --resource skill:verify --yes
```

先在 checkout 修改源文件再应用。原生工具目录中的临时尝试经人工审查后迁回 configs/skills；首版不做自动反向采集，避免把本机配置整体当成共享源。

### herdr 换成 Rex

```sh
agent-stack profile show coding-rex
agent-stack validate --profile coding-rex
agent-stack lock --profile coding-rex --out ~/agent-stack/coding-rex.lock.json
agent-stack setup --profile coding-rex --lock ~/agent-stack/coding-rex.lock.json --dry-run
```

只有平台、来源与必需能力都满足，候选组合才可继续应用。现有 coding-rex 是不同能力的实验组合，不能宣称等价替换 coding 的 Agent 状态报告。此示例在 Rex 来源未支持时应明确失败；不是承诺当前已能生成该锁。切换计划可移除基线匹配且归属明确的旧集成资源，保留旧程序与会话；完整成功后再更新设备默认绑定。

### 沉淀开发流程

真实任务中直接使用 Pi/herdr/pnpm/uv 等原生入口；将有效方法写入 `stack/skills/<name>/SKILL.md`，将共享默认值写入 configs，将 Agent 职责写入 agents。用已经接入的验证器检查，再通过 Git 审查与同步。项目自身的规则、测试入口和依赖锁留在业务仓库。

CLI 负责分发和确定性检查；如何 shape/implement/verify 由 skills 表达。首版不增加与原生运行时重复的 `skill run` 或自然语言任务解释器。

## 9. 输出、退出码与自动化

默认文本优先展示：选择的 checkout/profile、检查或变更范围、结论、具体差异/问题、下一步。计划至少标明 install/reuse/change/remove/blocked，各动作的原因与管理归属，以及不会被本次覆盖的检查范围。

目标 JSON 契约带 `schemaVersion`、`command`、上下文、scope、result 和 issues。计划正文与 CLI 结果信封区分：`--out` 保存可直接用于 `apply --plan` 的计划文档，stdout 的 `--json` 结果包含其引用/摘要。不同命令不必伪装成相同业务对象，但公共外壳与错误规则一致。schema 不兼容变化必须说明迁移，不把当前 JSON 静默改称这个新契约。

stdout 放结果，stderr 放日志与进度；JSON 无 ANSI 色码和 spinner。参数解析失败在 JSON 模式也输出结构化错误。普通 run 保留原生流，不混入 JSON 外壳；dry-run 的启动说明省略凭证值和可能含秘密的透传参数值。

| 目标退出码 | 含义                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| `0`        | 本命令在声明的范围内成功；不额外推导整套环境已验证。普通 plan 有变更也可以成功。         |
| `1`        | 数据/校验/本机检查失败、未知必需项导致 strict 失败、网络错误、冲突、过期计划或执行失败。 |
| `2`        | 用法错误：未知选项/ID、互斥参数、缺必要选择等。                                          |
| `3`        | 仅用于 `plan --check`：计划有效且可生成，但存在待应用变更。                              |
| `130`      | CLI 操作被用户中断；保留必要的部分完成记录。                                             |

正常 run 优先透传原生进程退出码及信号结果；启动前错误使用 CLI 自身规则。CI/Agent 不解析本地化文本，使用 JSON 与退出码；不把 `plan --check` 的漂移解释为执行崩溃。

setup/apply/update 在 TTY 中展示计划并确认；非交互必须显式 `--yes`，否则返回用法错误。dry-run 无需确认。lock 的写入是显式文件操作，展示 diff 后写指定锁，不另设交互确认。`--yes` 不等于强制覆盖，本版不提供一个绕过所有检查的 `--force`。

## 10. 失败、并发与恢复边界

1. 规划先检查完整范围；已知阻塞项存在时不开始持久变更。
2. 下载使用锁内来源与预期摘要；缺资产、校验失败或重定向不受支持时失败，不补 latest。
3. 本机执行记录步骤与基线。失败重试先重新观察，不盲目重跑安装/覆盖配置。
4. 保存计划有来源摘要与本机前提校验。checkout、旧锁或目标文件变化时中止；本机计划不跨设备套用。
5. 源锁写入使用同目录临时文件、协作锁与原子替换；实际安装不是跨程序事务。中断不终止原有用户会话或无关进程。
6. 首版的确定性回退入口是 Git 恢复旧配置/锁后重新 plan/apply；它仍受迁移、渠道与本地冲突约束。本机备份可辅助恢复已管理的配置，程序降级和运行数据恢复分别给出能力限制，不提供通用的一键历史回滚承诺。

## 11. 三种升级保持独立

| 改变什么                              | 操作入口                         | 对其他层的影响                                                                          |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Agent Stack CLI 自己                  | npm 安装/升级 CLI 的确切发布版本 | 不自动升级 Pi/herdr/uv，不自动拉 Git。当前包未发布。                                    |
| 共享配置、Agent、skills、profile 与锁 | Git 审查、提交和拉取             | 拉取后按需 plan/apply；不自动改本机环境。                                               |
| 某个外部部件                          | `update <id>`，或其原生安装渠道  | Agent Stack 路径按锁和归属操作；原生操作造成的差异由 doctor/plan 显示，不反向偷偷改锁。 |

不另设一个同时执行 npm 升级、Git pull、全部工具升级和凭证同步的 `sync` 命令。版本、配置与设备状态各自有明确所有者。

## 12. 实施顺序与可审查验收

| 切片              | 交付边界                                         | 必须证明的行为                                                                |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| A：命令契约       | 本文审查；统一术语与输出设计                     | 命令用途、写入范围、筛选与失败规则得到确认。                                  |
| B：锁与本机计划   | lock、plan；先支持有证据的来源                   | 完整性拒绝、版本保留、单项更新、全部目标与稳定 diff；不能写不完整 coding 锁。 |
| C：应用与首次配置 | apply、setup；先做一个真实工具和配置资源         | dry-run 与执行一致、冲突保护、重复 no-op、用户入口和管理归属保留。            |
| D：Agent 启动     | run 与首份 coding Agent/skills                   | 业务 cwd、原生参数/TTY/信号/退出码、资源缺失时失败。                          |
| E：升级与扩展     | update、更多来源和资源；profile 查询可按需要提前 | 候选与已执行一致、保存计划防漂移、单项更新不改其他版本、失败清楚记录。        |

跨切片还需验收：带空格和 `&` 的路径；根/子命令选项位置；重复/互斥选项；非交互确认；JSON 无日志污染；环境默认值覆盖；Windows 原生与 WSL 分开；部分筛选不能偷改能力要求。每个平台的运行结果单独记录，不以解析 fixture 替代实机证据。

## 13. 本轮请重点审查的选择

本文给出推荐而非把问题留空，以下三项影响使用习惯，实施前需用户审查：

1. **setup 只按已有锁配置。** 推荐把完整锁纳入 Git；缺锁时提示 lock，不让换机器时顺手解析出不同版本。
2. **update 默认真正应用，lock --update 只维护版本期望。** 两个名字分别对应“升级我的工具”和“修改共享锁”，都支持预览。
3. **组合写在 Git，筛选只作用于本次操作。** 推荐先编辑/审查 profile 后切换；不提供会暗中改能力要求的临时替换参数。

日常操作固定为 setup/doctor/run/update；setup 同时承担首次配置和 Git 拉取后的幂等对齐。自有声明 YAML 优先已按用户偏好纳入约定；本轮尚未迁移读取器或现有声明文件。

本轮批准的是命令行为和分工；来源支持矩阵、锁 schema、安装器及 Agent 资源契约仍按各自切片审查，不因本文列出接口就视为已经实现。

## 设计依据

仓库内依据：[架构与归属](architecture.md)、[开发约定](development.md)、[实施顺序](roadmap.md)；当前事实由 `src/cli.ts` 和各 command 的实际帮助输出核对。

交互与自动化参考 [Command Line Interface Guidelines](https://clig.dev/) 的组合性、stdout/stderr、交互与可预测行为建议；解析实现参考 [Commander 官方文档](https://github.com/tj/commander.js)。这些是设计参考，具体命令语义以本审查稿及后续实现验收为准。

当前实现：`setup --dry-run` 只读预览已有锁，不安装或应用配置；支持检测原生 macOS arm64/x64 和 Windows x64，无法可靠识别的宿主阻塞。`--repo` / `AGENT_STACK_REPO` / cwd 和 `--profile` / `AGENT_STACK_PROFILE` / 交互选择按此顺序生效，尚无绑定 fallback。
