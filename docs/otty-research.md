# Otty 调研：特性、目录与启动流程

[架构](architecture.md) · [Setup 方案](setup-plan.md) · [Herdr 调研](herdr-research.md)

调研日期：2026-11-15。对象是本仓库 `otty` component 指向的 **otty.sh / appmakes.io 桌面终端**。本次依据官方产品页、文档和更新记录；没有取得该产品可固定 commit 的实现源码，也未安装、启动 Otty 或读取用户配置/会话。

官网更新记录的最新条目为 `1.6.5`（2026-11-10）。官方在线文档未按该版本冻结，下面记录的是调研时的文档契约，不宣称每个行为已在 `1.6.5` 发行物中验证。安装前仍须固定实际版本、资产、应用身份与摘要。[官网][home]、[更新记录][changelog]

## 1. 定位、功能与平台范围

Otty 是带 Agent 工作流的桌面终端；用户仍运行原生 Pi、Codex 等 CLI。它提供终端之外的文件/网页面板、会话导航和集成入口，不是这些 Agent 的安装器。[产品介绍][home]、[Agent setup][agent-setup]

| 能力                 | 作用与边界                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Window / Tab / Split | 组织终端、分屏及项目工作环境；窗口是桌面 App 的组成部分                                  |
| Shell integration    | 用 prompt/命令结束/cwd 标记支持导航和状态；启用时有 shell 注入或文件写入行为             |
| Agent integration    | 通过各 Agent 自己的 hook/plugin/extension 回报状态，支持的恢复、历史和 fork 能力各不相同 |
| 文件与 Web 面板      | 内置编辑/预览和网页视图；不是纯终端输出，GUI/网页验收另算                                |
| Recipes              | 保存布局、命令或片段；应用 recipe 可能执行命令，不能把导入等同于无副作用地复制配置       |
| 会话恢复             | 恢复布局、cwd、scrollback，并可接续 Agent 或 tmux；不等于任意进程一直存活                |

依据：[文件与链接][files]、[CLI 使用][cli-usage]、[Recipes][recipes]、[恢复说明][recovery]。

平台证据需要分别维护：

| 平台                        | 调研时官方信息                                                                    | 本仓库现状                                                |
| --------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| macOS Apple Silicon / Intel | 安装页要求 macOS 14+，并提供两种架构入口                                          | `otty.yaml` 仅声明 `darwin`；没有安装/doctor/锁定 adapter |
| Windows                     | 安装页仍写 In development；首页已列 Windows beta；Agent 文档也描述了 Windows 功能 | 保留待核对，不自动扩大 component 的平台范围               |
| Linux                       | 安装页写 In development，首页提供等待列表                                         | 未声明、不推断已可安装                                    |

另一个文档差异是安装页文字说解压包后拖入 Applications，而首页当前链接为 `Otty.dmg` 和 `Otty-x64.dmg`。两者都是未带版本的下载地址，本次未读取镜像内容。安装 adapter 不能仅凭文件后缀或旧文字固定解包逻辑。[安装页][install]、[首页][home]、[Apple Silicon 下载入口][download-arm]、[Intel 下载入口][download-intel]

## 2. 配置、资源与本机状态目录

### 2.1 已有官方证据的位置

| 位置/入口                                        | 内容                                       | Agent Stack 的归属边界                     |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| `~/.config/otty/config.toml`                     | 主配置；Settings 会编辑它                  | 共享源与设备应用文件分别维护，按受管键对齐 |
| `~/.config/otty/config.local.toml`               | 本机覆盖，与主配置同目录                   | 不覆盖、不提交；安装时不能把它视为无关文件 |
| `~/.config/otty/fonts/`、`themes/`               | 用户字体、主题资源                         | 只同步有明确来源和消费者的资源             |
| `~/.config/otty/recipes/`                        | 保存的 recipes                             | 检查是否包含命令、输出或设备路径再决定共享 |
| `~/.config/otty/views/<id>`                      | 自定义 TUI view 的默认 cwd；首次启动可创建 | 可能含工具工作数据，不整体当作静态配置复制 |
| `Otty.app/Contents/Resources/shell-integration/` | App 自带的 shell payload 与 loader         | 随 App 版本核对，不复制旧版本脚本到新 App  |
| `/usr/local/bin/otty`                            | macOS 原生 Install CLI 创建的命令链接      | 与 App 安装分开识别，保留已有入口及其归属  |

依据：[配置文件][config-file]、[Data Sync][sync]、[配置 reference][config-ref]、[Shell integration][shell]、[CLI 安装][cli-usage]。配置文件不存在时可使用默认值；Settings 的 Open Config File 操作可能创建空文件。

路径读取优先使用当前版本的 `otty config path`、`otty config path --local` 或 Settings → Advanced 显示的实际位置。CLI 文档提供 `--config-file` 和 `--socket`，但本次未确证它们是否改变 GUI 启动、会话存储和所有子进程的目录。[CLI reference][cli-ref]

以下事项**没有足够证据**，不从 Herdr 或其他终端推断：

- `XDG_CONFIG_HOME`、APPDATA 等对 Otty 主目录是否生效，以及完整的环境变量优先级。
- App bundle ID、会话快照、终端日志、history/cache、runtime control socket 的精确默认路径及迁移规则。
- `--config-file` 是否足以隔离完整 App 状态；控制 socket 的传输方式、权限及自动发现算法。

日志可从 Settings → Advanced 的 Debug 入口定位；这比猜测 `~/Library/Logs/...` 更可靠。本轮不把未确认路径写成安装契约。[Advanced Settings][advanced]

### 2.2 原生格式和覆盖顺序

官方把主配置称为 TOML，但其 reader 接受未加引号的字符串、`on/off` 布尔值、重复键列表等宽松形式；不能用严格 TOML parser 的结果直接判断原生配置非法，也不能用普通对象覆盖丢掉重复条目。[格式说明][format]

读取关系按官方文档整理：

```text
includes（后面的覆盖前面的）
  → config.toml 的主文件赋值
  → config.local.toml 的本机覆盖
```

本机文件中的同名键优先；列表是**整组替换**而非追加。特殊的 `# key = … (reset to default)` 标记也有本机重置语义，不能当作无效注释删除。Settings 会写回值原本所属的文件，Reset All Settings 会清空两份文件。[配置文件][config-file]

`include`、字符串中的 `~` / `$VAR` 展开和重复项次序也属于原生语义。未知键可能被静默忽略，因此启动成功不能证明某项共享设置生效。保存主/本机文件会热加载；改 included 文件后可能需要显式 Reload Config。[格式说明][format]

**实现建议：**保留原文、注释、重复项和未知键；用当前版本 schema 发现受支持字段，再检查应用后的有效值及来源。Git 源相对上次应用变化正常进入新计划；用户目标漂移仍按本仓库三方比较规则处理。不能通过整体覆盖 `config.local.toml` 让计划显示成功。

## 3. App 与 CLI 的启动流程

以下是从官方用户文档拼合的可观察流程，**不是逐函数源码审计，也不是实测启动记录**：

1. **打开 App。**从 Finder 启动已安装的 Otty，或用 `otty open` 发起新窗口；后者可在 App 未运行时启动它。
2. **读取配置与恢复策略。**使用主/本机配置；根据正常退出、崩溃、更新及恢复选项决定重建窗口或打开新窗口。
3. **创建 Window / Tab / Pane。**选择新终端 cwd、shell 和布局；恢复操作可能创建新进程、恢复 Agent 原生会话或重新连接 tmux。
4. **加载 shell integration。**按 shell 类型注入 loader 或使用受管 rc block；随后通过 OSC 133、OSC 7 等标记跟踪命令及 cwd。
5. **用户启动 Herdr/Pi 等原生程序。**Agent 集成另行安装并在 Agent 重启后加载；安装 App 本身不证明这些状态上报已生效。
6. **CLI 操作运行中的 App。**窗口/pane 操作、recipe apply 等通过运行时控制入口执行；不能把一次 CLI 调用成功扩大为完整 GUI、恢复或集成验收。

依据：[First Launch][first-launch]、[CLI 使用][cli-usage]、[恢复说明][recovery]、[Shell integration][shell]。

```text
Finder / otty open
  └─ Otty desktop App ← otty CLI 的运行时控制
       └─ Window / Tab / Pane
            └─ shell → 原生 Herdr / Pi / 项目命令
```

CLI 在 App bundle 内，但放进 Applications 不等于 `otty` 已在 PATH。原生 Install CLI 除创建链接外，还安装 bash/zsh/fish 补全及适用编辑器的语法支持；是否需要管理员取决于目标目录权限。这不是一个只复制二进制的动作。[CLI 使用][cli-usage]

“设为默认终端”又是独立操作：它会注册系统 handler，也可修改其他编辑器/Git GUI 的配置。关闭最后窗口与退出 App 也不是一个操作。安装首片不默认执行系统接管、恢复旧会话或运行 recipe。[First Launch][first-launch]、[配置 reference][config-ref]

### 3.1 Shell integration 的副作用

| Shell/场景              | 官方描述的加载方式                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| zsh                     | 通过本次会话的 ZDOTDIR 指向 bundle loader，再恢复用户环境并加载 payload；普通路径不编辑用户 rc |
| fish                    | 临时调整 XDG_DATA_DIRS 加载 vendor entry，再清理该项                                           |
| bash                    | 在 `.bashrc` 加受管 block，并使用 `.bash_profile` shim                                         |
| 安装了 tmux 的 zsh/fish | 还会写入受管 rc block，使 tmux 后续创建的 pane 能加载集成                                      |

关闭相关集成会移除相应 block 并停止注入。由此不能把“启动 GUI 做一次检查”当成一定无写入的观察操作；包内脚本、用户 shell、tmux 和开关状态都需要隔离核对。[Shell integration][shell]

## 4. 配置命令、恢复与运行副作用

### 4.1 适合未来 adapter 核对的命令

| 命令类别                                            | 官方用途                               | 验收边界                                            |
| --------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| `otty --version` / `otty version`                   | 版本；后者还报告 build hash 和协议摘要 | 先核对入口归属与具体版本行为，尚未接入本仓库 doctor |
| `otty config path` / `path --local`                 | 解析主/本机文件位置                    | 不证明 session/cache 已隔离                         |
| `otty config schema --json`                         | 当前 build 的配置字段元数据            | 是内置 schema/defaults，不是用户实际配置            |
| `config validate`、`config get <key> --show-origin` | 检查配置、观察选中值及来源             | 输出可能含设备信息，测试和报告只取需要的字段        |
| `config set/unset/edit/reload`                      | 持久或临时修改、重载                   | 有写入/IPC 副作用，不放入只读 doctor                |
| `otty open`、window/tab/pane、recipe apply          | 启动或控制桌面工作区                   | 可能创建进程、发送输入或重放命令                    |

尤其是未带 `--local` 的 `config unset`，文档说明会同时移除主/本机文件的键；不能拿它当作无条件回滚动作。某些发送输入、敏感 session 控制还受 IPC 配置限制，不为通过测试而全局放宽。[CLI reference][cli-ref]、[配置 reference][config-ref]

### 4.2 恢复不等于进程一直存活

正常退出后的启动由 `on-launch` 控制，官方默认是 `restore_session`。布局/cwd/scrollback 恢复、Agent 原生会话恢复、重新附着 tmux、重跑普通命令是不同路径；普通命令默认不重跑，可另设白名单或全部重跑。[恢复说明][recovery]

崩溃恢复页同时出现“自动恢复”和“提示恢复”的不同描述，本轮不把提示方式固化为接口。需要在指定 build 上分别验证正常退出、关闭窗口、force quit、更新重启与重复失败；不能把保存了画面解释为原 shell、server 或测试进程仍然存活。[恢复说明][recovery]

Recipe 文件是可共享的原生资源，但可能包含命令和 scrollback。原生默认对已保存与外部文件采用不同的重放策略；import 后也可能改变后续信任/重放规则。只检查 layout 不足以声明 recipe 可以安全执行。[Recipes][recipes]

### 4.3 更新、Agent 读取和可选 helper

Otty 官方说明会检查更新；它不是完全离线的静态界面。Agent usage 可读取原生日志，而 Claude/Codex/omp 的 quota 读取还可能在后台执行相应 CLI、使用已有登录状态并访问其服务。两者不是同一类只读元数据检查。[隐私说明][privacy]、[Agent setup][agent-setup]

“合盖保持唤醒”等可选功能会请求 macOS 批准后台 helper；不是基本终端安装的必要步骤。Data Sync 文档仍标为开发中，不能将 Git 配置同步等同于该产品已有跨设备同步。[Agent setup][agent-setup]、[Data Sync][sync]

## 5. 与 Pi、Herdr 的关系

官方列出 Pi 支持 extension、resume、fork 和 history，默认扩展目录为 `~/.pi/agent/extensions/`；更新记录也提到 `PI_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 和可配置的 Agent config homes。确切扩展文件名、版本、完整路径优先级和 Pi 事件 API 仍需对具体 bundle 核对，不能复用 Herdr 扩展的版本/路径契约。[支持的 Agents][agents]、[更新记录][changelog]

集成开关会向 Agent 原生配置或扩展目录写入内容；已运行的 Agent 需要重新启动才能加载。支持的 Agent 不代表这些工具已经安装，也不代表本仓库的 `pi-herdr` 集成已满足。[Agent setup][agent-setup]

**对 Agent Stack 的推论：**Otty 可以作为 Herdr 的外层桌面终端，但 Otty pane 和 Herdr 内部 pane 是不同寻址单位。嵌套情况下的输入、OSC、状态归属与恢复需要专项验收，不能以两个二进制都能启动代替组合验收。当前 `otty` 只提供 `desktop-terminal`，不把它自动当作 `workspace` 或 `agent-status` 的替代实现。

## 6. 安装与测试的落地边界

1. **先固定发行物。**核对真实 bundle 的版本/build、bundle ID、架构、最低系统要求、签名/公证和可信摘要；主页可变下载地址不是版本锁。先完成 macOS 两种架构的证据，Windows beta 另核对发行渠道和格式。
2. **分开处理 App、CLI 与资源。**保留原生 App/命令入口；不将 App 打进 npm 包，不接管未知安装渠道。CLI 安装、补全、shell rc、默认终端注册、Agent 集成、helper 分别展示动作与归属。[许可][license]
3. **先形成配置应用方案。**明确主文件、本机覆盖、includes、重复键及 Settings 写回关系；schema/原文/有效值共同验证，不依赖通用 TOML 深合并。
4. **自动化测试先验证受控边界。**在临时目录覆盖归档/资产错误、已有 App/入口冲突、重复运行、配置漂移和恢复；不对用户真实 shell 或 Agent 配置执行原生安装集成。
5. **GUI 验收使用隔离用户或可恢复的 macOS VM。**验证首次启动、权限提示、新 shell 的 PATH、rc 改动、窗口/分屏、退出/恢复和 App 更新。CLI 配置覆盖尚不能证明完整隔离；CI 的构建/静态检查不代替这些观察。

本轮仅落地调研，没有改变 `otty.yaml`、profile、能力要求或 CLI 支持范围；Otty 的锁定、安装、doctor 与配置应用仍未实现。

## 7. 安装实现前待补证据

- 实际发行镜像中的目录清单、GUI/CLI 文件名及版本关系；签名/公证与字节摘要证据。
- 配置根覆盖、日志、会话/scrollback、控制 socket、history/cache 的精确路径及权限；如何完整隔离 App 测试。
- Install CLI、shell/tmux 集成的精确写入清单、冲突处理和卸载恢复行为。
- 正常启动/崩溃恢复中进程创建顺序，以及 Agent/recipe/helper 的实际副作用。
- Windows beta 与安装页状态不一致的范围；每个平台/架构分别记录实测，不从 CLI 或 Agent 功能表反推安装支持。

[home]: https://otty.sh/
[changelog]: https://otty.sh/releases/all
[install]: https://docs.otty.sh/getting-started/installation
[download-arm]: https://downloads.otty.sh/macos/Otty.dmg
[download-intel]: https://downloads.otty.sh/macos/Otty-x64.dmg
[first-launch]: https://docs.otty.sh/getting-started/first-launch
[config-file]: https://docs.otty.sh/customization/config-file
[format]: https://docs.otty.sh/reference/config-file-format
[config-ref]: https://docs.otty.sh/reference/configuration
[advanced]: https://docs.otty.sh/customization/advanced-settings
[cli-ref]: https://docs.otty.sh/reference/cli
[cli-usage]: https://docs.otty.sh/workflows/cli-usage
[shell]: https://docs.otty.sh/terminal-features/shell-integration
[recovery]: https://docs.otty.sh/workflows/session-recovery
[recipes]: https://docs.otty.sh/workflows/recipes
[sync]: https://docs.otty.sh/workflows/data-sync
[files]: https://docs.otty.sh/user-interface/files-and-links
[agent-setup]: https://docs.otty.sh/agents/setup
[agents]: https://docs.otty.sh/agents/supported-agents
[privacy]: https://docs.otty.sh/privacy
[license]: https://docs.otty.sh/license
