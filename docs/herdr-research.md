# Herdr 调研：特性、目录与启动流程

当前 Agent Stack 安装与运行验证范围另见 [Herdr 原生验收](herdr-macos-smoke.md)；下文为固定版本的上游调研证据。

[架构](architecture.md) · [Setup 方案](setup-plan.md) · [路线图](roadmap.md)

调研日期：2026-11-15。对象是本仓库 `herdr` component 对应的 **Herdr TUI**（`herdrdev/herdr`），不包含 Herdr desktop app 或 herdr-core 的安装与配置契约。

本次官方 stable manifest 返回 `0.9.5`；源码核对固定在 tag `v0.9.5`、commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`。网页会更新，后续安装仍以用户共享锁中的确切版本为准；本调研不修改锁或把 `stable` 固定为该版本。[官方 manifest][manifest]、[固定版本源码][source]

**证据范围：**已阅读官方文档、安装/打包脚本与上述版本源码；未执行发行物、启动 Herdr server、安装集成或完成 macOS/Windows 运行验收。下文将上游行为与 Agent Stack 的实现建议分别说明。

## 1. Herdr 提供什么

Herdr 在真实终端进程上组织项目、布局和 Agent 状态。它不替代 Pi 等 Agent runtime，也不替用户安装这些 Agent。[概念说明][concepts]

| 对象/能力                  | 含义及边界                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Workspace → Tab → Pane     | Workspace 对应项目或任务；Tab 保存布局；Pane 持有终端和进程，可以分屏、读输出、发送输入                              |
| Session                    | 独立 server 命名空间；隔离 workspace、pane、通信端点与会话快照；具名 session 仍共用全局配置                          |
| Client / Server            | Client 绘制 TUI；后台 server 持有终端和进程。一个 server 可连接多个 client                                           |
| Agent 状态                 | 结合进程识别、屏幕检测和可选 integration；区分 working、blocked、done、idle、unknown。安装二进制不等于状态集成已启用 |
| 自动化                     | CLI 和本地 JSON API 可以操作 workspace、pane、Agent；许多命令依赖已有 server                                         |
| Git worktree、SSH、plugins | 支持 worktree 操作、远程连接和插件；这些能力有自己的状态及副作用，不属于单纯下载二进制                               |

各 client 的“已看过完成状态”可以不同；CLI/API 的状态不必与某个 client 的 Done 标记完全相同。跨平台能力也不能仅凭同名命令推断一致。[概念说明][concepts]、[CLI reference][cli-doc]

## 2. 配置文件与目录解析

### 2.1 三个独立位置

用 `C` 表示 `config_dir()`，`S` 表示 `state_dir()`，`F` 表示实际 TOML 文件。以下均针对 release build；debug build 的应用目录名为 `herdr-dev`。[路径源码][src-config]

| 位置                               | macOS 默认                 | Windows 默认           |
| ---------------------------------- | -------------------------- | ---------------------- |
| `C`：配置及部分 session 数据根目录 | `$HOME/.config/herdr`      | `%APPDATA%\herdr`      |
| `S`：客户端、插件等状态根目录      | `$HOME/.local/state/herdr` | `%LOCALAPPDATA%\herdr` |
| `F`：原生配置文件                  | `C/config.toml`            | `C\config.toml`        |

路径优先级来自固定版本源码，不只依据网页给出的常用路径：

1. **`F`**：有 `HERDR_CONFIG_PATH` 时直接使用其值，否则使用 `C/config.toml`。
2. **`C`**：两平台都先使用 `$XDG_CONFIG_HOME/herdr`。未设置时，macOS 使用 `$HOME/.config/herdr`；Windows 依次尝试 `%APPDATA%\herdr`、`%USERPROFILE%\AppData\Roaming\herdr`、`$HOME/.config/herdr`。最后回退系统临时目录下的 `herdr`。
3. **`S`**：两平台都先使用 `$XDG_STATE_HOME/herdr`。未设置时，macOS 使用 `$HOME/.local/state/herdr`；Windows 依次尝试 `%LOCALAPPDATA%\herdr`、`%USERPROFILE%\AppData\Local\herdr`、`$HOME/.local/state/herdr`。最后回退临时目录下的 `herdr-state`。

`HERDR_CONFIG_PATH` 是**文件覆盖**，不会把 session、socket、日志等全部搬到该文件旁边。`XDG_CONFIG_HOME` 和 `XDG_STATE_HOME` 分别影响上述两类目录。环境值在这些函数中直接转为路径，不做 Shell 求值或 `~` 展开，也不主动跳过空字符串。[路径源码][src-config]

**实现建议：**计划同时显示 `F`、`C`、`S` 及各自环境依据；缺少必要用户目录、空白或含糊的相对覆盖时明确处理，不默默采用上游临时目录 fallback。隔离测试仅设置 `HERDR_CONFIG_PATH` 不足以隔离运行状态。

### 2.2 哪些文件归 Herdr 本机所有

默认 session 的数据目录 `D = C`；具名 session 的 `D = C/sessions/<name>`。不要把“session 数据”和源码中名字为 `state_dir()` 的 `S` 混为一谈。[Session 源码][src-session]

| 位置                                                          | 内容                                                     | Agent Stack 的归属边界                                 |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `F`                                                           | 用户 TOML 配置                                           | 只对经确认的字段应用共享默认值，保留未知字段和本地修改 |
| `D/session.json`                                              | 布局、cwd、焦点和 Agent 原生 session 引用                | 本机运行状态，不进 Git/共享锁                          |
| `D/session-history.json`                                      | 可选的终端画面历史                                       | 可能含敏感输出，不同步                                 |
| `D/session-backups/`、`D/session-snapshots/`                  | 损坏快照恢复副本、历史布局快照                           | Herdr 自己的恢复数据，不是配置备份                     |
| `D/herdr.sock`、`D/herdr-client.sock`                         | JSON API 与 TUI client 端点                              | 本机通信对象，不复制、不用文件存在代替健康检查         |
| `D/herdr*.log`                                                | 按角色产生的日志                                         | 本机诊断数据；具名 session 有自己的日志目录            |
| `S/client/endpoints.json`、`S/client/endpoint-selection.json` | 保存的 SSH 机器和选择状态                                | 保留本机归属，安装不自动导入                           |
| `S/client-shell/`                                             | 按本地端点或远程目标/session 保存的 UI 偏好              | 不当作共享主题配置                                     |
| `C/plugins/`、`C/plugins.json`                                | 插件安装/配置及 registry；插件配置在 `C/plugins/config/` | 不把整个目录当作可无条件覆盖的原生配置                 |
| `S/plugins/`、`S/agent-detection/`                            | 插件状态、远端 Agent detection manifest 缓存等           | 不进共享配置                                           |
| `F` 同目录的 `release-notes.json`                             | 更新提示的持久数据                                       | 这是从 `config_path()` 派生的例外，隔离/归属判断应计入 |

依据：[会话持久化][src-persist]、[日志][src-logging]、[客户端目录][src-client-catalog]、[UI 偏好][src-client-preferences]、[插件路径][src-plugin-paths]、[插件 registry][src-plugin-registry]、[manifest 缓存][src-manifest-update]、[release notes][src-release-notes]。

### 2.3 配置格式、首次启动与重载

Herdr 使用 TOML，无配置文件也能以默认值启动。读取/解析出错时可能回退默认值并显示诊断；因此“能启动”不能证明共享配置有效。`herdr config check` 单独检查配置并在有诊断时返回非零；`herdr --default-config` 输出内置模板，不是当前配置的解析结果。[配置文档][config-doc]、[配置检查源码][src-cli]

常用配置域包括 `terminal`、`keys`、`theme`、`ui`、`server`、`session`、`update`、`worktrees`、`remote`、`experimental`。没有需求时不生成一整份默认模板。

`onboarding` 缺失或为 true 时显示首次引导；继续引导会写入 `onboarding = false` 并打开集成设置。这意味着原生程序会修改配置，不能未经设计就把 `HERDR_CONFIG_PATH` 指向 checkout 中的共享源文件。[配置文档][config-doc]

编辑后可用 `herdr server reload-config` 重载 server。UI 的 reload action 同时处理本地 client 与所选 server 的配置；主题等呈现设置主要归 client，pane 默认值、worktree、集成和自定义命令归执行它们的 server。部分启动设置必须重启才能生效。[配置文档][config-doc]

## 3. 原生启动流程

### 3.1 运行 `herdr` 时发生什么

以下是没有 `--remote`、没有保存的 SSH federation 的普通本地路径；具名 session 使用相同流程和独立端点。主流程由 [main.rs][src-main]、[autodetect.rs][src-autodetect] 和 [server bootstrap][src-bootstrap] 核对。

1. **解析目标。**处理 `--session`、`HERDR_SESSION`、socket 覆盖和远程参数；将 CLI 子命令与 TUI 启动分流。
2. **加载配置并检查嵌套启动。**普通启动会读取配置，执行嵌套限制检查；随后确认当前终端能提供可用尺寸。没有可用终端时，在自动启动 daemon 之前失败。
3. **查找所选 session 的 client 端点。**已有 server 时检查可连接性及所需协议能力；不会单凭磁盘上的 `.sock` 名称判定运行。
4. **没有 server 时启动后台进程。**使用当前二进制的 `server` 子命令，标准输入输出重定向为空；传递启动 cwd 和相关环境。等待 client 端点就绪，当前源码上限 15 秒。
5. **Server 初始化。**处理平台进程上下文、日志、配置和 JSON API；创建 App 并恢复会话/终端；无已恢复 workspace 且有启动 cwd 时尝试建立初始 workspace；建立 client 端点，执行插件启动 hooks，进入事件循环。
6. **Client 连接并绘制 TUI。**建立 client 协议连接，提供终端上下文；server 持有真实终端进程，client 负责显示和交互。满足条件的 Agent session 恢复可在 client attach 后发生。

```text
外层 Terminal / PowerShell
  └─ herdr client ── client 协议 ── herdr server
                                    ├─ Pane shell / Agent / 项目进程
                                    └─ JSON API ← herdr CLI / integrations
```

有已保存 SSH 机器时，客户端可以在 Local 启动失败后继续展示远程端点；`--remote` 走独立的 SSH setup/bridge 路径，可能请求安装或更新远端。安装验收首片不应使用这两条路径代替本地启动。[自动启动源码][src-autodetect]、[远程说明][remote-doc]

### 3.2 macOS 和 Windows 的进程、通信差异

| 项目           | macOS                                                                      | Windows                                                                     |
| -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Pane 终端      | Unix PTY                                                                   | ConPTY，发行包携带 app-local runtime                                        |
| 本地 IPC       | 文件系统 Unix domain socket                                                | Named pipe；`.sock` 路径还对应本机 marker，不能使用 Unix socket API 检测    |
| 后台进程       | `setsid`，忽略 SIGHUP；自动启动还尝试切换到持久用户 Mach bootstrap context | detached process；遇到关闭时杀进程的 Job Object，可使用 WMI 路径创建 daemon |
| 默认 shell     | 配置值，否则 `$SHELL`，再 `/bin/sh`                                        | 配置值，否则 PATH 上的 `pwsh.exe`，再 `powershell.exe`                      |
| Shell 启动模式 | `shell_mode = "auto"` 为新交互 pane 启动 login shell                       | `auto` 保持非 login 行为；自定义命令字符串走 Windows 命令执行路径           |

依据：[IPC 源码][src-ipc]、[平台分离][src-platform]、[macOS bootstrap][src-macos-bootstrap]、[Windows 平台代码][src-windows]、[配置文档][config-doc]。后台 session 不等于已经注册开机自启服务；不要在 installer 中额外创建 LaunchAgent 或 Windows Service 来模拟此流程。

Windows 的 elevated server 默认只接收同账户的管理员 client；普通 server 接受该账户的普通/管理员 client，attach 不改变 server 权限。`[server] allow_unelevated_clients = true` 会放宽 elevated server 的访问策略，且需新 server 启动才生效。安装器不应默认打开它或用管理员测试代替普通用户验收。[Windows 官方说明][windows-doc]

### 3.3 Session 与 socket 覆盖规则

- `--session <name>` 或 `session attach <name>` 为显式选择，优先使用该 session 的端点，并在自动启动子 server 时清除继承的 socket 覆盖。
- 没有显式 session 时，`HERDR_SOCKET_PATH` 优先覆盖 API 端点；client 端点从它派生，例如 `custom.sock` 对应 `custom-client.sock`。
- 没有 API socket 覆盖时，client 端点还可读取旧的 `HERDR_CLIENT_SOCKET_PATH`；否则使用活动 session 目录。
- 未显式选择且未覆盖端点时，`HERDR_SESSION` 选择具名 session；默认是 `default`。测试应清除继承的 session/socket 环境，防止连入真实用户进程。

依据：[Session 选择][src-session]、[client 端点规则][src-sockets]。session 名称必须符合上游规则，不把任意设备路径或项目路径直接作为名称。

## 4. 退出、恢复、更新分别意味着什么

| 操作/事件                                         | 进程与数据行为                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ctrl+b q` detach，再次运行 `herdr`               | server、pane 和 Agent 原进程继续运行；重新连接它们                               |
| `herdr server stop` / `herdr session stop <name>` | 停止对应 server 和 pane 进程；不是单纯关闭 TUI                                   |
| Server 完整重启                                   | 从 `session.json` 重建布局和 cwd；任意进程不会原样复活                           |
| Native Agent session restore                      | 对有有效集成 session 引用的支持 Agent 重新运行恢复命令；是新进程接续原生会话     |
| Pane history replay                               | 默认关闭；启用后可重放画面，但不会恢复旧进程                                     |
| 更新二进制                                        | 已运行的 server 可能仍为旧版本；client 版本、server 版本和协议能力分别检查       |
| Live handoff                                      | 显式、实验性路径；固定版本源码的 import 路径仅支持 Unix，不作为 Windows 安装保证 |

会话快照及 Agent 引用留在设备。重启/回退可能涉及状态格式与 Agent 会话，不能把切换二进制或 Git 回退配置描述为完整运行状态回滚。[会话恢复说明][session-doc]、[handoff 源码][src-bootstrap]

Release build 默认启用 `[update] version_check` 和 `manifest_check`。前者查询新版本、保存提示，源码中的 `auto_update` 等待显式安装；后者可以下载并激活较新的 Agent detection manifests。即使二进制版本锁定，运行检测规则也可能变化。[配置默认值][src-config-model]、[App 启动更新检查][src-app]、[版本更新检查][src-update]、[manifest 更新][src-manifest-update]

**实现建议：**受管安装的升级入口和 manifest 更新策略需明确。Herdr 原生 `update`/channel 切换可绕过 Agent Stack 共享锁；不把它们当按锁安装步骤。仅禁用检查也不能阻止用户显式执行更新。

## 5. Pi 集成不是 Herdr 安装的一部分

`herdr integration install pi` 部署二进制内置的扩展；`v0.9.5` 源码中 bundled Pi integration version 为 **9**，与网页提到的 native restore 最低集成版本 2 是不同概念。[集成版本源码][src-integration]、[集成文档][integration-doc]

| 项目     | 固定版本行为                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 默认目标 | 用户 home 下 `.pi/agent/extensions/herdr-agent-state.ts`                                                                               |
| 覆盖目标 | `PI_CODING_AGENT_DIR` 非空时，在该 agent 目录的 `extensions/` 下部署；这里的路径帮助函数支持 `~`，不要与 Herdr TOML 覆盖的解析规则混用 |
| 前置目录 | Pi agent 目录须已存在；可以创建其下缺失的 `extensions/`                                                                                |
| 写入行为 | 写入固定扩展文件名，可能覆盖同名内容；不能未经归属判断直接向真实用户目录运行安装命令                                                   |
| 上报条件 | 扩展检查 `HERDR_ENV=1`、`HERDR_SOCKET_PATH`、`HERDR_PANE_ID`；通过本地 JSON API 上报生命周期和原生 session 引用                        |
| Pi 模式  | 此版本扩展只将 Pi TUI 作为受管 root session；RPC/JSON/print 模式不应当作等价集成测试                                                   |

依据：[集成环境/路径][src-integration-env]、[安装目标][src-integration-targets]、[Pi 扩展][src-pi-extension]。扩展已写入、Pi 能加载、状态上报成功、恢复原生会话是不同验收结果；仍须核对锁定 Pi 版本的事件 API，不能仅凭声明范围推断兼容。

## 6. macOS / Windows 安装首片的约束

### 6.1 发行布局与原生入口

| Agent Stack target | 上游资产                   | 部署要求                                        |
| ------------------ | -------------------------- | ----------------------------------------------- |
| `darwin-arm64`     | `herdr-macos-aarch64`      | 独立二进制，校验字节 SHA-256 后设置可执行权限   |
| `darwin-x64`       | `herdr-macos-x86_64`       | 同上；不要用 Rosetta 运行代替原生 x64 验收      |
| `win32-x64`        | `herdr-windows-x86_64.zip` | 校验完整 ZIP 的 SHA-256，安全解包并保留整包布局 |

Windows 打包源码列出 `herdr.exe`、`conpty/conpty.dll`、架构子目录中的 `OpenConsole.exe`、ConPTY marker 和第三方 notices。不能只发布 exe，也不能任意扁平化目录。以上来自打包契约，本次未下载 ZIP 核对实际清单。[官方安装文档][install-doc]、[ConPTY metadata][src-conpty]、[打包脚本][src-package]

上游安装器的目录不等于 Agent Stack 应接管的目录：

- macOS 官方脚本默认写入 `$HOME/.local/bin/herdr`，可用 `HERDR_INSTALL_DIR` 改变；PATH 缺失时给出 shell 配置提示。
- Windows 官方脚本默认在 `%USERPROFILE%\.herdr\packages\standalone\releases` 保存版本，维护 `current`，使用 `%LOCALAPPDATA%\Programs\Herdr\bin` 兼容入口，并调整用户 PATH；`HERDR_HOME` 改的是安装根，不是 TOML 的 `C`。
- 两者属于原生安装渠道；Agent Stack 应使用自己的版本目录和归属记录，识别既有入口并保留其渠道，不覆盖这些位置来“接管”。

依据：[macOS 安装脚本][src-install-sh]、[Windows 安装脚本][src-install-ps]。普通 setup 只消费共享锁中的版本、URL 与摘要，不执行追踪 latest 的在线脚本；用户仍能直接运行原生 `herdr`。

### 6.2 从观察到运行的验收层次

| 层次                 | 验收内容                                                                               | 不代表什么                     |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| 文件/资产            | 来源、摘要、目标架构、完整布局、可执行权限                                             | 不代表依赖可加载或终端可创建   |
| 本地只读命令         | 绝对路径执行 `--version`，核对 `--help` 路径、`config check` 诊断                      | 不代表 server 或 Pi 集成通过   |
| 隔离 headless server | 原生 `server` 启动、API ready、创建 workspace/pane、运行无害命令、读取结果、停止和重启 | 不代表用户外层终端的交互体验   |
| 真实 TTY/桌面        | 新终端 PATH、普通用户权限、输入/分屏/resize、detach/reattach                           | 不代表付费模型或业务项目已验收 |

`--version`、`--help` 和 `--default-config` 在固定版本主流程中位于普通 App/server 初始化之前；`config check` 走独立 CLI 分支。`status server` 观察已运行 server，不能只比较安装后的 client 版本。[主流程][src-main]、[CLI 配置检查][src-cli]、[CLI reference][cli-doc]

受控测试使用临时用户目录、`XDG_CONFIG_HOME`、`XDG_STATE_HOME`，明确 `HERDR_CONFIG_PATH`，清除继承的 session/socket 变量；Windows 同时隔离 USERPROFILE/APPDATA/LOCALAPPDATA 等实际消费者。使用独立 session 和端点，不把真实用户日志、插件、Pi session 或配置纳入 fixture。

测试 TOML 可显式跳过首次引导、版本/manifest 联网检查和原生 Agent session 自动恢复；这是测试配置示例，不是本项目已经应用的共享默认值：

```toml
onboarding = false

[update]
version_check = false
manifest_check = false

[session]
resume_agents_on_restore = false
```

此配置不是 OS 沙箱；shell 初始化、已安装插件或显式命令仍可能产生 I/O。测试从空目录开始，控制进程环境和加载资源，结束时仅停止本次 server。不要对测试者的默认 session 执行 stop/delete。

## 7. 实施前还需要补的证据

1. 按实际锁定版本下载三个目标资产，核对摘要、Windows ZIP 清单和最低 OS/运行条件；本次源码阅读不证明发行字节与源码一致。
2. 在原生 macOS arm64/x64、Windows x64 跑安装、重跑、冲突、失败清理及 headless pane 测试；现有 Agent Stack `pnpm check` 不安装真实 Herdr。
3. 单独验证 PATH 持久化、新 shell 和普通用户权限；Windows 管理员 CI 不能替代普通用户验收，macOS login shell 也不能只靠当前进程修改 PATH 来验证。
4. 确定受管版本与原生 `herdr update`、channel 和 Agent detection manifest 更新的共存策略；不默认升级/停止已有 server。
5. 资源片再核对 Pi 的确切版本、扩展事件与加载路径，以隔离 socket 验证状态；保留 `coding` 对 `pi-herdr` / `agent-status` 的要求。

本轮仅落地调研。安装 adapter、配置写入、PATH 修改、集成安装、默认绑定和首版闭环均未因此实现。

[manifest]: https://herdr.dev/latest.json
[source]: https://github.com/herdrdev/herdr/tree/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01
[concepts]: https://herdr.dev/tui/docs/concepts/
[config-doc]: https://herdr.dev/tui/docs/configuration/
[cli-doc]: https://herdr.dev/tui/docs/cli-reference/
[session-doc]: https://herdr.dev/tui/docs/session-state/
[remote-doc]: https://herdr.dev/tui/docs/persistence-remote/
[integration-doc]: https://herdr.dev/tui/docs/integrations/
[windows-doc]: https://herdr.dev/tui/docs/windows-beta/
[install-doc]: https://herdr.dev/tui/docs/install/
[src-config]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/config/io.rs
[src-config-model]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/config/model.rs
[src-main]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs
[src-cli]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/cli.rs
[src-session]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/session.rs
[src-sockets]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/socket_paths.rs
[src-autodetect]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/autodetect.rs
[src-bootstrap]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/server/headless/bootstrap.rs
[src-platform]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/platform/mod.rs
[src-macos-bootstrap]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/platform/macos/bootstrap.rs
[src-windows]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/platform/windows.rs
[src-ipc]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/ipc.rs
[src-persist]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/io.rs
[src-logging]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/logging.rs
[src-client-catalog]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/client/endpoint/catalog.rs
[src-client-preferences]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/client/shell/preferences.rs
[src-plugin-paths]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/plugin_paths.rs
[src-plugin-registry]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/persist/plugin_registry.rs
[src-manifest-update]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/detect/manifest_update.rs
[src-release-notes]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/release_notes.rs
[src-app]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/mod.rs
[src-update]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/update.rs
[src-integration]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/mod.rs
[src-integration-env]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/env.rs
[src-integration-targets]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/targets.rs
[src-pi-extension]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/assets/pi/herdr-agent-state.ts
[src-conpty]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/packaging/windows/conpty.json
[src-package]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/scripts/package_windows_conpty.py
[src-install-sh]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/distribution/install.sh
[src-install-ps]: https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/distribution/install.ps1
