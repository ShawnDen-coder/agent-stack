# CLI 行为验收矩阵

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md) · [路线图](roadmap.md)

此矩阵区分受控 fixture、原生实测和待验收范围。完整 coding 支持原生 macOS arm64/x64；锁更新及其他系统的完整 coding 尚未实现。自动化测试使用临时环境，真实外部工具和网络验收另行标明。

| 行为                                                       | 状态             | 测试证据                                                                          |
| ---------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| help、无参数、版本                                         | 已实现           | `test/cli.test.mjs`                                                               |
| YAML、YML、JSON 过渡、重复定义与非法 YAML                  | 已实现           | `test/cli.test.mjs`                                                               |
| 只读、路径含空格与 `&`、保留替换后的能力要求               | 已实现           | `test/cli.test.mjs`、`test/interaction.test.mjs`                                  |
| 根/子命令共享选项、重复单值、用法错误与 JSON stdout        | 已实现           | `test/interaction.test.mjs`                                                       |
| 非 TTY、CI、TERM=dumb、NO_COLOR、彩色 40/80 列布局         | 已实现           | `test/interaction.test.mjs`                                                       |
| stdout 结果、stderr 交互/进度、重定向时不询问              | 已实现           | `test/interaction.test.mjs`、`test/pty_driver.py`                                 |
| 真实 TTY 选择、Ctrl-C 取消及检查中中断                     | 已实现           | `test/interaction.test.mjs`、`test/pty_driver.py`                                 |
| doctor 的版本证据、超时和输出上限                          | 已实现           | `test/doctor.test.mjs`、`test/cmd-shim.test.mjs`                                  |
| 显式目标的首次共享锁创建、复核、并发拒绝                   | 已实现           | `test/lock.test.mjs`                                                              |
| macOS uv-only / Herdr-only 与 Windows x64 Herdr-only setup | 已实现           | `test/lock.test.mjs`、`test/herdr-windows-archive.test.mjs`                       |
| macOS 完整 coding setup 与配置资源                         | 已实现，原生实测 | `test/lock.test.mjs`、`test/npm-state.test.mjs`、`test/coding-resources.test.mjs` |
| coding doctor 回执、整树、锁、资源及历史验证签名           | 已实现           | `test/doctor.test.mjs`、`test/managed-tree.test.mjs`                              |
| `run coding` 参数、TTY、中断与状态传递                     | 已实现，原生实测 | `test/coding-launch.test.mjs`、`test/coding_launch_pty.py`                        |
| 锁更新、其他系统完整 coding                                | 待实现           | 不将声明或 fixture 作为已支持证据                                                 |

`validate` 与 `doctor` 成功 JSON 保留既有业务形状；`doctor` 的业务错误仍为 `{ "error": "..." }`，`validate` 失败仍为报告。Commander 用法错误为版本化 `{ "schemaVersion": 1, "error": { "kind": "usage", "message": "..." } }`，退出 2；JSON 帮助和版本为 `{ "schemaVersion": 1, "output": "..." }`。业务失败为 1，交互取消为 130。机器输出没有标题、spinner 或 ANSI，日志只走 stderr。

## 可重复演示

macOS/Linux 安装 `python3` 后，在仓库根目录运行以下命令。脚本使用空 PATH fixture，不调用本机 Pi、herdr 或其他工具；输出是分别包含 stdout 结果与 stderr 交互的实际伪终端 JSON 记录。`select` 选择第二个 profile 后显示缺失工具，`cancel` 演示取消；40 列报告主动按显示宽度折行，长路径可通过拼接续行还原。`color` 为正常彩色 TTY，`no-color` 模拟 NO_COLOR。临时目录不入仓库。

```sh
pnpm build
demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-stack-demo.XXXXXX")
mkdir -p "$demo_dir/bin" "$demo_dir/repo/tmp"
cp -R stack "$demo_dir/repo/"
python3 test/pty_driver.py "$(command -v node)" "$PWD/dist/cli.js" "$demo_dir/repo" "$demo_dir/bin" select 80 color
python3 test/pty_driver.py "$(command -v node)" "$PWD/dist/cli.js" "$demo_dir/repo" "$demo_dir/bin" select 40 color
python3 test/pty_driver.py "$(command -v node)" "$PWD/dist/cli.js" "$demo_dir/repo" "$demo_dir/bin" select 80 no-color
python3 test/pty_driver.py "$(command -v node)" "$PWD/dist/cli.js" "$demo_dir/repo" "$demo_dir/bin" select 40 no-color
python3 test/pty_driver.py "$(command -v node)" "$PWD/dist/cli.js" "$demo_dir/repo" "$demo_dir/bin" cancel 80
rm -r "$demo_dir"
```

文本报告以 `[MATCH]`、`[OBSERVED]`、`[FAIL]`、`[UNKNOWN]` 区分符合要求、无版本要求的观察、确认失败和未核对，并列出计数与下一步；metadata 匹配不证明程序可运行。交互需要 stdin、stdout 和 stderr 均为 TTY；任一被重定向时不会弹出选择框。

自动化 PTY 使用 Python 标准库 `pty`，仅在 macOS/Linux 执行；Windows 原生终端交互尚未验证。非交互、JSON 和静态包装器测试仍可在 Windows 运行。CI 矩阵配置不等同于已实际运行的平台结果。

布局迁移：真实 CLI 测试从仓库根的 `stack/` 读取声明，覆盖中文和空格路径、缺失目录错误、旧根级声明不读取；测试见 `test/cli.test.mjs`。

`lock --profile <id> --dry-run [--json]` 的 npm 与 uv/herdr 版本候选及阻塞报告由 `test/lock.test.mjs` 从编译后的真实 CLI 和受控网络边界验证；报告不是锁或执行计划，不验证目标资产、传递依赖或安装。默认 coding 可在全部来源返回有效元数据时报告四个版本。

npm 候选选择先筛选范围、预发布、废弃状态及 Node engines，再对最高兼容候选严格检查 tarball 与 SHA-512；被排除的历史版本不要求现代 integrity 字段。范围内无兼容 Node 版本或 engines 范围非法时失败，选中版本缺摘要不回退。真实 CLI 测试覆盖此策略及只读边界。`test/lock_pty_driver.py` 和 `test/lock.test.mjs` 使用受控网络响应，验证 lock 自身 40/80 列彩色/无色候选与阻塞报告、终端控制字符清理、profile 选择/取消、查询中中断、重定向及 CI/TERM=dumb。PTY 使用 Python 标准库，Windows 原生终端尚未实测。

`lock --dry-run --target <target>` 对 herdr 的 macOS arm64/x64 和 Windows x64 预览 manifest 资产与预期 SHA-256；Linux ABI 仍未覆盖。真实 CLI fixture 验证单快照、目标映射、错误和只读性，PTY 验证 40/80 列输出。

`--target` 还可预览 Pi 顶层 npm tarball 和 pnpm 顶层及对应 native optional package；当前限 macOS arm64/x64 与 Windows x64，pnpm native 按已识别的 pnpm 12 发行契约核对确切依赖及平台元数据。SHA-512 SRI 为 registry 预期值；不执行安装脚本、不锁定传递依赖。uv 目标资产从所选 release 快照读取，仅接受 GitHub 提供的有效 SHA-256。

完整 coding 的三目标版本与资产报告由 `test/lock.test.mjs` 的受控 release fixture 从真实 CLI 验证；预期摘要不等于下载校验，目标资产齐全也不代表锁生成或运行验证。

首次创建期间的实际 SIGINT/清理回归仅在 POSIX 运行；Windows 原生 Ctrl-C 尚未验证。Windows 上仍运行创建、并发与拒绝覆盖的通用测试。[Node.js child_process 文档](https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/child_process.md)说明 Windows 的 `subprocess.kill()` 信号行为与 POSIX 不同。

uv 官方分页的数字仓库 ID、owner/name 形式和跨页最高版本，以及每页 12 MiB、总计 64 MiB、10 页和超时限制，由真实 CLI 受控网络 fixture 验证；实际 GitHub API 仍可能限流或返回 403。

`validate --lock [file]` 从真实 CLI 验证共享锁与声明一致性，覆盖离线、篡改、格式等价、路径迁移与 40/80 列输出；不验证远端真实性、下载或安装。

`setup --dry-run` 预览已有锁的计划，不安装或写入；真实 CLI fixture 覆盖阻塞与只读边界。uv/Herdr 及 npm staging 的 fixture 覆盖安装、复用、摘要、冲突和恢复；Windows x64 Herdr-only 的官方资产验收见 [Windows 验收](herdr-windows-smoke.md)。fixture 和声明不代表其他平台的完整 coding 已支持。

完整 coding 预览在计划前列出 checkout、profile、执行目标、可应用状态与阻塞；JSON 中 `canApply` 与各部件的 `disposition`、`blockingReasons` 表示当前判断。仅存在待恢复资源操作时，`canApply` 为 false、`canRecover` 为 true，dry-run 退出 1 且只读；确认执行仅恢复资源并退出 1，`recoveryNext` 或恢复结果的 `next.argv` 指向需重新审阅的预览。原有 `action` 是观察结果，安装 `mode` 是阻塞解除后的动作，不证明当前可执行。外部 Pi/pnpm 不会因版本相同而获得受管所有权；预览发现冲突时保留原安装。doctor 对缺失前置工具和受管部件分别给出准备或预览建议，未核实的冲突交给预览判断。空白显式 `--repo` 在解析时拒绝；缺锁、不可访问和无效锁提供路径及原因，未绑定的 `run coding` 提供指向选中 checkout 的 setup 预览 argv。文本恢复命令单独输出一行，分别标明 POSIX sh 或 PowerShell 7；无法安全单行展示控制字符时使用 JSON 的 `next.argv`。机器帮助保留 `schemaVersion` 和 `output`，并补充注册命令的路径、参数及选项。相关回归见 `test/interaction.test.mjs`、`test/lock.test.mjs`、`test/setup-resource-recovery.test.mjs` 与 `test/recovery-output.test.mjs`；Windows 命令格式在非 Windows 上仅作 formatter 测试。

根会话在原生 macOS 实测 Pi 1.5.2、pnpm 12.15.0、uv 0.13.8、Herdr 0.9.5 的完整 coding setup：部件延迟绑定，配置、Agent、三个 skills 及真实 Pi TUI / Herdr v9 私有 socket 验证通过后才提交绑定；重跑不重新获取 npm 根包，绑定保持不变。本机 npm 传递依赖树回执不等于共享锁固定完整闭包。

另在专用 Herdr server/pane 实测 `run coding`：官方 Pi TUI、Agent 和 `shape`/`implement`/`verify`、Herdr session 与 idle、cwd、Ctrl-C 后退出 0，以及随后 doctor 退出 0。`doctor` 核对的是当前回执、整树、锁、资源与历史 TUI 签名，不启动未知 Pi，也不证明模型调用。此原生结果不替代其他平台的实测，也不代表最终候选的 full check 或四平台二进制 CI 已通过。

macOS 选择 coding 但没有匹配的完成证据（含损坏状态、缺失回执或不匹配绑定）时，doctor 返回未就绪与退出 1；工具链 metadata 全部符合也不能代替完整 setup。TTY 启动通过 POSIX execve 交接原前台终端，真实 PTY 覆盖 900ms 慢清理只收到一次 SIGINT、直接 PID 信号、controlling TTY、resize 和退出状态。
