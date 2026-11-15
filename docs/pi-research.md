# Pi 调研：特性、目录与启动流程

[架构](architecture.md) · [Setup 方案](setup-plan.md) · [Herdr 调研](herdr-research.md) · [Otty 调研](otty-research.md)

调研日期：2026-11-15。对象是本仓库 `pi` component 指向的 **`@earendil-works/pi-coding-agent`**。本次读取 npm 官方元数据，并检出上游 `v1.5.2`，固定 commit 为 `b4afdddf44e059c67ccf5097e5317d913521b470`。以下是该版本的文档与源码证据；未安装 npm 发行物、启动 Pi、读取个人认证/会话或调用模型。

## 1. 版本、定位与功能

调研时 npm `latest` 为 `1.5.2`，与本仓库 `coding` profile 的 `>=1.5.2 <2` 下限一致。后续安装以共享锁的确切版本为准，不跟随本页的 latest 观察值。[npm latest 元数据][registry-latest]、[固定版本 manifest][manifest]

| 项目         | 固定版本中的声明与边界                                                            |
| ------------ | --------------------------------------------------------------------------------- |
| npm 包与命令 | `@earendil-works/pi-coding-agent@1.5.2`；`pi` → `dist/bundle/cli.js`              |
| Node 下限    | Pi 自身要求 `>=22.19.0`；Agent Stack 的 Node `>=24.0.0` 是另一个要求              |
| 运行形态     | 原生 TUI、一次性 print、JSONL 事件输出、JSONL RPC、进程内 SDK                     |
| 默认工具     | `read`、`bash`、`edit`、`write`；其他工具可按配置启用                             |
| 扩展机制     | extensions、标准 skills、prompt templates、themes，以及打包这些资源的 Pi packages |
| 模型与认证   | 多 provider、API key/OAuth、自定义模型/endpoint；用户独立维护凭证                 |
| MCP          | 内置扩展支持 stdio 与 HTTP server；连接可能启动进程或联网                         |
| 会话         | JSONL 对话树、续接、分支与 fork；不负责维持终端进程或 Herdr server                |

终端 stdin/stdout 均为 TTY 时默认打开 TUI；重定向任一流时通常转为 print。`--print` 表示一次性执行，`--mode text` 单独使用不保证一次性退出；`--mode json` 输出事件后退出，`--mode rpc` 持续从 stdin 接受命令。RPC 不是自动启动的本地 daemon 或 socket 服务。[CLI][cli-doc]、[集成方式][integration-doc]、[MCP][mcp-doc]

Pi、Herdr、Otty 的职责分别是 Agent runtime、终端工作区、桌面终端。安装 Pi 不等于安装或验收另外两者；Pi 的 SDK 也不代表 Agent Stack 应把 Pi 当作自身 npm 依赖打包。

## 2. 配置、资源与本机状态目录

### 2.1 Agent 根目录与环境覆盖

下文用 `A` 表示 agent directory。CLI 的解析为：**非空 `PI_CODING_AGENT_DIR` → 否则 `os.homedir()/.pi/agent`**，自定义路径支持前导 `~` 展开。默认 macOS 是 `~/.pi/agent`，Windows 原生也是用户 home 下的 `.pi\agent`，没有另选 `%APPDATA%` 或 XDG 配置根目录的分支。[路径源码][src-config]、[路径规范化][src-paths]

- `PI_CODING_AGENT_DIR` 同时移动多类配置、认证、会话与缓存，不是单个配置文件覆盖。
- `PI_CODING_AGENT_SESSION_DIR` 只覆盖会话目录，优先级见后文。
- `PI_PACKAGE_DIR` 覆盖程序资源/package 目录，不是 agent directory；不能用它重定位认证或会话。
- 本包不以 `PI_CONFIG_DIR` 作为配置根入口；不要从其他 Pi fork 或终端工具套用变量名。
- 测试和安装计划应采用明确的绝对目标，避免相对目录随 cwd 改变含义；不要把设备绝对路径提交为共享配置。

### 2.2 文件归属

| 路径                                                                       | 内容                                     | Agent Stack 的归属边界                               |
| -------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `A/settings.json`                                                          | 全局设置、资源引用、Pi package 声明      | 只应用明确受管字段，保留未知内容和本地修改           |
| `A/keybindings.json`                                                       | TUI 快捷键                               | 可有共享默认值，仍需平台终端验收                     |
| `A/models.json`、`A/mcp.json`                                              | 自定义模型与 MCP 配置                    | 可能含密钥、命令、环境和设备路径，不能默认整文件共享 |
| `A/auth.json`、`A/mcp-auth.json`                                           | 模型及 MCP 的认证、刷新 token            | 原生工具独占，不导入、不覆盖、不进 Git/共享锁        |
| `A/trust.json`                                                             | 按本机 canonical path 保存的项目信任决定 | 本机状态，不作为共享默认许可                         |
| `A/AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` | 用户上下文，按文件名优先级选择           | 保留用户入口，不用共享 Agent 覆盖个人规则            |
| `A/SYSTEM.md`、`A/APPEND_SYSTEM.md`                                        | 替换或追加 system prompt                 | 按具体语义应用，不能当作等价入口                     |
| `A/extensions/`、`skills/`、`prompts/`、`themes/`                          | 用户资源                                 | 按资源/字段归属管理，不整体接管                      |
| `A/sessions/<encoded-cwd>/*.jsonl`                                         | 对话树、工具参数与结果、消息             | 私有运行数据，不同步                                 |
| `A/npm/`、`A/git/`                                                         | Pi package 安装目录                      | 工具管理的安装树，不是共享原生配置                   |
| `A/tmp/extensions/`                                                        | 显式 `-e` npm/git 资源的临时安装缓存     | 不提交、不把缓存存在视作锁定证据                     |
| `A/bin/`、`A/tools/`                                                       | 受管 `fd`/`rg` 等工具目录                | 安装/缓存状态，与 npm 入口分别识别                   |
| `A/models-store.json`                                                      | provider/model catalog 持久数据          | 动态本机数据，不当作固定模型声明                     |
| `A/pi-debug.log`、`A/mcp.log`、`A/mcp.log.1`                               | 诊断与 MCP 日志/轮转                     | 可能含敏感信息，不进 Git                             |

目录依据：[配置文档][config-doc]、[路径源码][src-config]、[认证存储][src-auth]、[信任存储][src-trust]、[会话存储][src-session]、[Package manager][src-packages]、[模型 runtime][src-model-runtime]、[MCP][mcp-doc]。

项目原生目录是**最终 runtime cwd 下的 `.pi/`**：包含 `settings.json`、`mcp.json`、`SYSTEM.md`、`APPEND_SYSTEM.md` 及 `extensions/skills/prompts/themes/`。从另一个项目恢复会话时，cwd 可能改变，不能一直以调用目录推断实际加载的项目资源。

另有独立入口 `~/.agents/skills/`，以及 cwd 向上到仓库根的 `.agents/skills/`。前者不会随 `PI_CODING_AGENT_DIR` 搬迁。因此仅设置 `A` 不足以隔离所有用户资源；测试还要隔离 home、cwd 和环境。[Skills][skills-doc]、[资源加载源码][src-resources]

### 2.3 设置合并与文件读写

`settings.json` 使用 JSON；全局与项目设置的普通对象递归合并，项目字段覆盖全局，普通数组替换。**资源列表另有专门的解析规则**：全局/项目的 extensions、skills、prompts、themes 都参与加载，支持排除和显式包含；不能用通用数组替换推断最终资源集合。`defaultTools` 的普通名称列表替换选择，`+name`/`-name` 列表则修改继承的选择。[设置文档][settings-doc]、[设置源码][src-settings]

资源路径按所属设置范围解析：用户侧相对 `A`，项目侧相对 `.pi`；不自动相对 Agent Stack checkout。把 `stack/skills` 字面量写进用户设置不等于引用仓库中的资源。未来 adapter 应生成设备上的明确引用，并记录字段归属和旧基线。[Package manager][src-packages]

项目配置须通过 trust 才加载大多数设置；`defaultProjectTrust`、`httpProxy` 等只能从全局取得。`sessionDir` 是启动前读取的例外。`/reload` 会重新加载设置和资源，可能解析/安装 packages 并执行扩展；它不是被动的 JSON 重读。Pi 原生设置操作也会写回本机文件，不能直接把整个 `A` 或可写 settings 文件指向 Git 共享源。[配置文档][config-doc]、[设置源码][src-settings]、[资源加载源码][src-resources]

## 3. 上下文、skills 与 extensions 的加载边界

### 3.1 Agent 指引与 system prompt

在每一个上下文目录内，优先选择 `AGENTS.override.md`，再依次尝试 `AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`。目录之间继续组合：先用户 agent 目录，再祖先目录到 cwd；一个目录的 override 不会删除其他目录的上下文。**上下文文件不受项目 trust 保护**，拒绝 trust 后仍会加载，除非使用 `--no-context-files`。[配置文档][config-doc]、[资源加载源码][src-resources]

`SYSTEM.md` 替换 Pi 默认 system prompt，`APPEND_SYSTEM.md` 追加。对于每个文件名，可信项目文件优先于全局文件，同名文件不拼接。CLI `--system-prompt` / `--append-system-prompt` 可覆盖对应文件发现逻辑；参数若是已存在文件则读取内容，否则当作字面文本，后者可重复使用。[CLI][cli-doc]、[资源加载源码][src-resources]

**对本仓库的建议：**计划中的 coding Agent 使用经存在性检查的 `--append-system-prompt <文件>` 入口，保留 Pi 的默认能力和原有上下文。路径不存在时必须由 adapter 先报错，避免把失效路径静默当成指令。`stack/agents/` 当前只有约定文件，本次不声称已提供或自动加载 coding Agent。

### 3.2 Skills 是指引，extensions 是进程内代码

- **Skills：**兼容标准 `SKILL.md` 与 front matter；启动扫描名称、描述和路径，需要时再读完整指引。目录递归发现；缺描述/格式错误可能跳过，同名保留先发现者并给诊断。`disable-model-invocation` 控制自动选择，显式 `/skill:name` 仍可用。skill 附带脚本不会仅因目录存在就自动执行，但可被后续任务调用。
- **Extensions：**通过 TypeScript/JavaScript 入口加载并执行，可注册工具、事件、provider、命令和参数。初始化本身就可读写文件、启动进程或联网，不需要先有模型请求。
- **发现顺序：**资源解析区分项目设置、项目自动发现、用户设置、用户自动发现，显式 CLI 资源另行加入。不要假设同名资源会按文件内容合并；最终诊断与实际被加载的路径才是验收对象。
- **关闭标志：**`--no-extensions` 禁用通常发现的扩展及 built-ins，但显式 `-e` 仍可加载；skills、prompts、themes 的显式参数也有类似例外。package 解析在最终资源筛选之前，关闭资源类型不等于禁止所有 package I/O。

依据：[Skills][skills-doc]、[Extensions][extensions-doc]、[CLI][cli-doc]、[资源加载源码][src-resources]、[Package manager][src-packages]。

### 3.3 Pi packages 会引入安装与更新行为

Pi packages 可从 npm、git、本地目录提供多类资源；用户声明写入 `A/settings.json`，`--local` 写入项目 `.pi/settings.json`。缺失的配置 package 可在启动或 `/reload` 时安装；失败时原生启动会警告、跳过其资源并继续。显式 `pi install` / `pi update --extensions` 的安装失败才以非零退出。这意味着“Pi 正常启动”不能证明必需 skill/extension 已加载。[Packages][packages-doc]

`-e` 的 npm/git 临时 package 缓存在 `A/tmp/extensions/`，未固定的选择会在启动/重载检查更新，失败或 offline 时可能使用缓存；确切 npm 版本与已检出的 Git commit 有避免更新检查的分支。Agent Stack 不应借用未锁定的临时资源来满足必需集成，也不能把固定顶层版本表述为已锁完整传递依赖。[Packages][packages-doc]

## 4. 原生启动流程与 project trust

### 4.1 普通 CLI 路径

以下按 `v1.5.2` 的主要路径整理；auth、package、config、MCP 子命令有各自的提前返回分支。[CLI 初始化][src-setup]、[main][src-main]、[runtime services][src-services]

1. CLI 初始化进程标题、Agent 环境标记和 HTTP dispatcher，进入 `main()`；识别 `--offline` / `PI_OFFLINE`。
2. 处理 auth 子命令；其他路径先做受管安装清理，Windows 还有 self-update quarantine 清理。确定 cwd、`A`，读取不含项目设置的 bootstrap settings 并应用全局代理。
3. 分派 package/config/MCP 子命令；普通路径解析参数。`--version` 此处输出并退出，尚未进入常规资源加载，但**已经经过前述清理和全局设置阶段**。
4. 普通运行执行迁移，读取 startup settings；首次交互启动可能选择主题/analytics 并写设置。选择或创建 session，先解析 `sessionDir`，再确定最终 runtime cwd。
5. 创建 cwd-bound model/auth/settings/resource services。需要 trust 决策时先加载用户和显式 CLI 扩展，再决定项目信任；随后解析对应 packages、加载最终 extensions、skills/prompts/themes、上下文和 system prompt。
6. runtime 建好后才处理 `--help` 和 `--list-models`。help 需要显示扩展注册的参数，因此此前已加载扩展；这两个分支用内存 session，也不会显示普通交互 trust 提问。
7. 其余路径读取初始消息、`@file` 和管道输入，配置主题/工具，进入 TUI、print/JSON 或 RPC。交互运行还会安排辅助工具检查、模型目录刷新、版本/package 更新提示等活动。

**检测结论：**不能把 `pi --help`、`--list-models`、`/reload` 或 `pi mcp list` 当作无副作用的健康探针。`pi --version` 更早退出，但也不应据此承诺任意版本/安装渠道完全只读。当前 Agent Stack `doctor` 静态核对 npm 入口与 package metadata、不执行 Pi，与这一边界一致；它只证明观察到的声明版本，不证明程序可运行。[main][src-main]、[MCP CLI][cli-doc]

### 4.2 Trust 的范围与优先级

项目 `.pi/settings.json`、MCP、四类资源、SYSTEM/APPEND_SYSTEM，以及项目祖先 `.agents/skills` 属于 trust-gated 资源；只有空 `.pi` 不触发提问。决定顺序为：**CLI `--approve` / `--no-approve` → 首个返回 yes/no 的用户或 CLI 扩展 → 当前目录/最近祖先的已存决定 → 全局 `defaultProjectTrust`（默认 ask）**。[安全文档][security-doc]、[信任解析][src-project-trust]

print/JSON/RPC 没有内置交互提问；无其他决定时，`always` 加载受保护项目资源，`ask` / `never` 跳过。`/trust` 保存未来进程的决定，需要重启才按新决定加载。安装器不能为了消除提示而全局设成 `always`，也不能把自动化的单次 `--approve` 偷换成永久信任。[安全文档][security-doc]

trust 不覆盖用户扩展、显式 `-e`、上下文文件，且不能撤销启动前的项目 `sessionDir` 读取。它控制资源发现，不是逐工具审批或 OS 沙箱；Pi、扩展和子进程仍具有启动用户的权限。运行不可信扩展的测试应把整个 Pi 进程置于容器/VM/专用账户边界内，只隔离工具函数不足以隔离 extension。[安全文档][security-doc]

### 4.3 自动网络和本机写入

原生启动可能安装配置 packages、准备 `fd`/`rg`（缺失时下载到 `A/bin`）、刷新 provider catalog、检查版本和 package 更新、提交启用的安装/更新遥测。MCP session 启动时后台连接已启用 server，stdio server 会启动进程；`pi mcp list` 也连接 server，不只是显示配置。[交互启动][src-interactive]、[工具管理][src-tools]、[MCP][mcp-doc]、[CLI][cli-doc]

`--offline` / `PI_OFFLINE=1` 禁用 Pi 管理的自动网络活动；`PI_SKIP_VERSION_CHECK` 只针对版本检查，`PI_TELEMETRY=0` 只针对安装遥测和相关 attribution，不代表所有网络都关闭。offline 不是网络防火墙，也不保证 extension、MCP、用户命令或显式模型请求不能联网。[环境变量][env-doc]、[CLI][cli-doc]、[遥测设置][settings-doc]

`--no-session` 只改变会话持久化；`--no-tools` 只改变可用工具选择，两者都不能阻止扩展初始化或其他状态 I/O。`--no-mcp` 禁用该次运行的内置 MCP，但不约束另一个实现 MCP 的扩展。[CLI][cli-doc]

## 5. 认证、会话与恢复

### 5.1 认证保留原生归属

用户可通过 `/login` 或 `pi auth login` 保存 API key/OAuth 到 `A/auth.json`，也可使用 provider 环境变量。`--api-key` 是不持久化的运行时覆盖，需要明确模型选择。Agent Stack 负责检测前置条件和保留入口，不复制个人认证，不把登录结果写进应用 receipt 或共享锁。[Providers][providers-doc]、[CLI][cli-doc]

认证和模型/MCP JSON 不一定是被动数据：凭证配置支持 `!command`，使用凭证时可执行命令取 stdout 并缓存；OAuth 刷新也可能联网并写文件。不要在只读检查中解析并求值这些字段。源码对新建 auth 文件/目录分别请求 `0600`/`0700`，保留已有权限；Windows ACL 不能等同于 Unix mode 保证。[认证源码][src-auth]、[配置求值][src-config-value]、[Models][models-doc]、[MCP][mcp-doc]

模型认证与 MCP OAuth 独立存储，登出原生保存项不等于删除环境变量、其他配置或在 provider 侧撤销凭证。验收日志只记录状态，不回显 key、token 或 credential 命令结果。

### 5.2 会话是对话数据，不是进程快照

会话目录优先级为：**`--session-dir` → 非空 `PI_CODING_AGENT_SESSION_DIR` → settings `sessionDir` → `A/sessions/<encoded-cwd>/`**。自定义相对目录按调用 cwd 解析；默认编码将绝对 cwd 的分隔符/冒号转换并包裹为目录名，它包含设备目录信息，不是可跨机器稳定共享的项目 ID。[main][src-main]、[设置源码][src-settings]、[会话源码][src-session]

持久会话是 JSONL 树，条目使用 id/parentId 表示分支；`--continue` 找当前 cwd 的近期会话，`--resume`/`--session` 可选其他项目并改变 runtime cwd，fork 创建新会话。恢复会话是在新 Pi 进程中重建上下文，不保活 Bash 子进程，也不回滚之前对文件或外部系统的操作。[Sessions][sessions-doc]、[CLI][cli-doc]、[会话源码][src-session]

内置 `bash` / `powershell` 工具在每次执行时注入当前 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`；临时会话没有 session file。它们不注入到用户输入的 `!` / `!!` 命令，不能把这些变量当成所有子进程都具备的静态启动环境。[环境变量][env-doc]

会话可能包含提示词、文件内容、工具参数/输出和意外暴露的凭证；只在隔离测试创建新会话。Herdr/Otty 保存 Pi session 引用后能否正确续接，仍需对各自固定版本单独验收；恢复布局或找到 JSONL 不足以证明完整恢复。

## 6. macOS / Windows 安装与运行边界

本轮研究 npm 渠道；上游另有 standalone binary，不能混用其安装路径、Node 需求或升级行为。npm manifest 没有顶层 install/postinstall hook，但这不证明整个依赖树没有脚本，也不证明 `--ignore-scripts` 后所有平台均可运行。[Manifest][manifest]、[Quickstart][quickstart-doc]

| 平台         | 已有源码/文档证据                                                                | 仍需运行验证                                                        |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| macOS        | npm + Node；内置 shell 优先配置 `shellPath`，再 `/bin/bash`，再 PATH 的 Bash/sh  | arm64/x64 安装树、资源文件、TUI/PTY、键盘和 Herdr/Otty 联动         |
| Windows 原生 | npm + Node；默认 Bash 来自 Git for Windows 或指定位置；可选模型工具 `powershell` | cmd/PowerShell 入口、Git Bash、带空格/中文路径、ConPTY 和终端快捷键 |
| WSL          | Linux Node、文件系统和 Bash                                                      | 独立 Linux/WSL 安装与设备状态，不能借 Windows 原生结果代替          |

Windows Bash 查找顺序为 `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` → `%ProgramFiles(x86)%\Git\bin\bash.exe` → PATH `bash.exe`。仅有 `git --version` 不能证明 Bash 存在。可选 PowerShell 工具先找 PATH `pwsh.exe`，再标准 PowerShell 7 安装位置，再 PATH/系统 Windows PowerShell；即使替换模型侧 bash 工具，`!` / `!!` 仍使用 Bash。[Windows 文档][windows-doc]、[Shell 源码][src-shell]

macOS 也不自动使用当前终端的交互 `$SHELL`：Otty 运行 zsh 不等于 Pi 的 `bash` 工具执行 zsh。Windows 官方建议使用带较新 console host 的终端，并列出 fullscreen/regular 与按键的兼容问题；这些证据不等于已经验证 Herdr 的 Windows 终端实现。[Shell 源码][src-shell]、[Windows 文档][windows-doc]

未来 Pi 安装片继续按 [Setup 方案](setup-plan.md)执行：下载并校验锁定 tarball，核对实际 manifest/Node engines，在独立 npm staging 中禁用 scripts、启用 engine 检查，检查安装树和入口后再发布；保留原生 `pi` 入口与既有安装渠道。顶层 SRI 和本机生成的 package-lock 分别证明不同范围，不把它们写成已经完成的跨设备依赖闭包锁。

本次 registry 返回的顶层 tarball 为 `pi-coding-agent-1.5.2.tgz`，SRI 为 `sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==`。这只是官方元数据中的**预期值**；本轮未下载/校验 tarball 字节，也未将其写入共享锁。[Registry][registry]

## 7. 落到本仓库的实施与验收建议

当前 `stack/components/pi.yaml` 仅声明 npm 来源、平台和 `agent-runtime` 能力，`pi-herdr` 仅声明状态集成；`stack/configs/`、`stack/agents/`、`stack/skills/` 尚只有约定文档。本次不新增安装命令、自动应用配置或扩展，不把源码分析表述为已安装/已运行。

后续实现顺序：

1. **安装身份与发布：**按锁验证顶层资产、实际依赖 engines、入口和必需资源；安装 staging 完成前不切换入口，不允许临时退回 latest 或启用脚本掩盖失败。
2. **配置和共享资源：**明确 `A` 与 home/cwd/环境，按字段和资源基线处理冲突；引用 checkout 的真实 skills/Agent 文件，不整体覆盖用户 settings、AGENTS 或认证。
3. **受控启动：**检查实际加载的路径与诊断，缺必需扩展/skill 时失败；不能因为 Pi 对安装失败仅警告就判 setup 成功。显式 trust 只授权该 fixture，使用自建无密钥 provider/mock 或不发送 prompt 的 RPC 边界验证，不自动调用付费模型。
4. **Pi ↔ Herdr/Otty：**固定终端与扩展版本，分别验证事件、IPC 不可达、进程退出、恢复引用；保留原生 Pi 使用方式。Pi 的 extension 可执行代码，部署前需记录来源、内容和受管目标。

### GitHub Actions 与虚拟机如何分工

| 验收层              | 建议环境                                          | 能证明什么                                                                                |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Agent Stack 自身    | 现有 Actions OS/Node 矩阵                         | 构建、声明、CLI 边界；当前不安装真实 Pi                                                   |
| Pi 固定版本安装     | 新增 macOS / Windows Actions 集成任务             | tarball 字节、实际依赖/入口、重复安装、失败恢复；需真的运行后才有证据                     |
| Pi 资源与模式       | 隔离 home/`A`/cwd 的 Actions fixture              | settings/trust、扩展与 skills 加载、print/JSON/RPC 协议；mock provider 不证明真实服务可用 |
| TUI、终端与桌面集成 | 干净 macOS / Windows VM 或实机；按需加 PTY 自动化 | 交互键盘、resize、Git Bash/PowerShell、Herdr/Otty、OAuth 浏览器回调和重启恢复             |
| WSL                 | 单独 WSL 环境                                     | Linux 资源/路径与 Windows 互操作；普通 Linux runner 不代表 WSL                            |

**结论：**CLI 安装和大部分资源测试可以由 Actions 承担；首次支持一个 OS/架构/终端组合以及涉及 GUI、登录、会话恢复的变更，仍需要 VM/实机验收。记录具体 OS、架构、终端、Node/npm/Pi/扩展版本和证据；不能从一个 macOS runner 推断两种架构都通过，也不能把路径模拟当成 Windows 原生通过。

## 参考来源

以下 GitHub 链接均固定到本次检出的 commit；registry 是调研时读取的官方版本元数据入口，不是发行字节已核验的证明。

[registry]: https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/1.5.2
[registry-latest]: https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest
[manifest]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/package.json
[quickstart-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/quickstart.md
[config-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/configuration.md
[settings-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/settings.md
[env-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/environment-variables.md
[cli-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/cli.md
[integration-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/cli-integration.md
[security-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/security.md
[skills-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/skills.md
[extensions-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/extensions.md
[packages-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/packages.md
[providers-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/providers.md
[models-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/models.md
[mcp-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/mcp.md
[sessions-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/sessions.md
[windows-doc]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/docs/windows.md
[src-config]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/config.ts
[src-paths]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/utils/paths.ts
[src-settings]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/settings-manager.ts
[src-auth]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/auth-storage.ts
[src-config-value]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/resolve-config-value.ts
[src-trust]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/trust-manager.ts
[src-project-trust]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/project-trust.ts
[src-session]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/session-manager.ts
[src-packages]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/package-manager.ts
[src-model-runtime]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/model-runtime.ts
[src-resources]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/resource-loader.ts
[src-setup]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/cli/setup.ts
[src-main]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/main.ts
[src-services]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/agent-session-services.ts
[src-interactive]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/modes/interactive/interactive-mode.ts
[src-tools]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/utils/tools-manager.ts
[src-shell]: https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/utils/shell.ts
