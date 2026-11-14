# 配置变体设计审查稿

状态：提案，尚未实现。当前 component schema 不支持下述资源、逻辑目的地或 variants 字段；`setup`、`plan` 和配置 apply 也尚未实现。字段名（包括 `native-config`）仅为讨论示意，待 setup 有真实消费者时再收敛 schema，不向现有声明添加占位字段。

## 资源与组合

建议每个部件在 `stack/components/` 的声明中拥有其配置资源；profile 选择可重组的部件和集成，不为每个操作系统复制一整份 coding profile。资源的 `source` 统一相对 `stack/`，原生 JSON、TOML 等文件保存在 `stack/configs/`，不伪装为声明。共享仓库记录内容与逻辑目的地；设备绝对路径只进入本机计划或设备覆盖，不进入共享锁。

普通配置建议绑定逻辑目的地（示意 `native-config`），由具名工具 adapter 按**锁定版本**的官方路径规则、实际环境和工具入口解析目标。仅路径因平台不同而变化时使用同一份 source；只有内容不同或确实需要独立绑定规则时才增加平台 variant。若以后提供显式 base 加相对路径，它只能表示默认分支，仍必须尊重工具原生环境变量，不能机械套用通用 OS 配置目录。

内容变体采用默认 source 加零个或多个平台 source：唯一匹配时替换默认 source，未指定的平台复用默认。多个规则同时匹配、有歧义或必需目标不支持时失败，不静默跳过。禁止任意模板和 Shell 表达式；不定义含糊的通用深合并。原生文件内部哪些字段归属本项目、如何保留用户修改与合并，由各工具 adapter 明确规定并测试。

## 原生路径证据与边界

- [herdr 文档](https://herdr.dev/tui/docs/configuration/)列出 Linux/macOS `~/.config/herdr/config.toml` 与 Windows `%APPDATA%\\herdr\\config.toml`。[当前源码](https://raw.githubusercontent.com/herdrdev/herdr/master/src/config/io.rs)中，`HERDR_CONFIG_PATH` 覆盖完整文件路径；否则使用 `XDG_CONFIG_HOME`，再使用平台 fallback，包括 Windows。源码还存在临时目录 fallback，但缺少可靠 HOME、APPDATA 等必要前提时，受管配置不能默默写到临时目录；应明确失败。平台 fallback 的具体顺序应按锁定版本核对。
- [Pi 配置文档](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/configuration.md)与[当前源码](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/config.ts)说明 `PI_CODING_AGENT_DIR` 可改变用户 agent 目录，默认位于 home 下 `.pi/agent`，设置文件为其中的 `settings.json`。

上述当前分支文档与源码不能证明所有历史版本的规则。实施时须核对锁定的确切版本、入口和支持平台；证据不足时拒绝相应目标，而非猜测路径。直接运行原生工具实际读取的位置与 setup 写入目标必须一致。

## 计划、冲突与设备边界

未来 plan 应展示源、所选内容变体、实际目标、归属、路径解析依据和生效环境前提。设备本地覆盖与原生环境变量不一致时明确报告冲突；未解决前不写入。共享锁不含设备绝对路径；本机计划冻结解析路径、环境前提和目标文件基线，apply 前重新核对。源内容、环境或目标在计划后变化时拒绝旧计划并要求重新计划。

WSL 按其 Linux 环境解析，不自动写入 Windows 用户目录。缺少可靠用户目录等必要前提时失败；不将临时目录当作托管目标。配置备份、原子写入、未知字段和本地修改的处理应按 adapter 的实际文件归属设计，并支持安全重复应用。

## 未来 CLI 验收

通过真实 CLI 和临时 HOME、环境、工具 fixture 验证：

- Linux、macOS、Windows 各自的工具路径与原生环境变量优先级；Windows 和 WSL 相互隔离。
- 仅路径不同时复用同一 source；平台内容差异选择唯一 variant，歧义、缺必需目标或不支持时失败。
- 空格和中文路径、设备覆盖与工具环境冲突时不写入；重复应用稳定且保留未知内容和本地修改。
- 计划后源内容、环境前提或目标文件改变时阻止旧计划；doctor 报告实际解析位置及偏差，不将静态文件存在等同运行成功。

模拟 `path.win32` 只能验证路径逻辑，不能当作 Windows 原生集成通过；各平台和锁定工具版本需分别实测。
