# CLI 行为验收矩阵

此矩阵记录当前已实现能力；`setup`、`run`、`lock`、安装和应用仍未实现。测试均运行编译后的 CLI，不需要真实工具、网络或用户凭证。

| 行为                                                | 状态   | 测试证据                                          |
| --------------------------------------------------- | ------ | ------------------------------------------------- |
| help、无参数、版本                                  | 已实现 | `test/cli.test.mjs`                               |
| YAML、YML、JSON 过渡、重复定义与非法 YAML           | 已实现 | `test/cli.test.mjs`                               |
| 只读、路径含空格与 `&`、保留替换后的能力要求        | 已实现 | `test/cli.test.mjs`、`test/interaction.test.mjs`  |
| 根/子命令共享选项、重复单值、用法错误与 JSON stdout | 已实现 | `test/interaction.test.mjs`                       |
| 非 TTY、CI、TERM=dumb、NO_COLOR、彩色 40/80 列布局  | 已实现 | `test/interaction.test.mjs`                       |
| stdout 结果、stderr 交互/进度、重定向时不询问       | 已实现 | `test/interaction.test.mjs`、`test/pty_driver.py` |
| 真实 TTY 选择、Ctrl-C 取消及检查中中断              | 已实现 | `test/interaction.test.mjs`、`test/pty_driver.py` |
| doctor 的版本证据、超时和输出上限                   | 已实现 | `test/doctor.test.mjs`、`test/cmd-shim.test.mjs`  |
| setup / run / resolver / 安装 / 配置应用            | 待实现 | 不注册占位命令                                    |

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
