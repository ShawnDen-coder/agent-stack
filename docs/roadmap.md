# 后续实施顺序

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md) · [路线图](roadmap.md)

首版目标是经过真实 CLI 验证的 setup → doctor → run coding 闭环。按以下依赖顺序独立实现、提交并交根会话复审；前一阶段通过审查后再推进下一阶段。当前已实现 `validate` 及其共享锁离线校验、有限只读 `doctor`、首次新建共享锁的 `lock`、macOS uv-only 按锁安装，以及 Herdr-only 外部复用和 v2 设备状态；其余能力不得在帮助或 README 中宣称可用。

## 1. stack/ 目录迁移：根会话审查通过

声明、原生配置、Agent 和 skills 收拢在仓库根目录下的 `stack/`；`--repo` 仍指向仓库根目录。验收包括真实 CLI 的新布局读取、缺失目录提示、根级旧声明不混读、YAML/JSON 和既有 doctor/交互回归，以及 `pnpm check` 和实际打包解包检查。默认外部部件锁位置为 `<repo>/stack/stack.lock.json`，首次创建由显式 `lock` 执行。

## 2. lock：首次创建已实现，更新和离线待实现

实现公开单入口 `lock`，基于新目录的完整 profile 解析 Pi、pnpm、uv 和 herdr。锁记录确切版本、来源、目标及发行物的预期 digest；完整 profile 和全部目标通过校验后才能写锁，不能靠删除部件或能力要求生成伪完整锁。仅显式更新指定部件，其他项保持原版本与资产；支持可验证的 dry-run、offline 和完整候选锁行为。失败、并发或输入变化时保留旧锁。

验收须从编译后的真实 CLI 使用受控网络元数据和临时仓库，覆盖完整 coding 候选、缺失资产或 digest、范围及渠道、平台和 Node 约束、最小更新、多目标、声明变化、离线、并发与写入失败；实际来源 dry-run 的成功或受阻分别报告。网络受限时仍需实现可独立验证的行为和真实失败路径，不编造来源或 digest。当前实现带结构化来源身份和所选声明摘要的 npm 顶层包与 uv/herdr 版本候选报告，以及部分 Pi、pnpm、uv、herdr 目标资产和预期摘要的只读预览；已支持显式目标的首次写锁；其他目标资产、传递依赖闭包、更新和离线均未实现。详细契约见 [版本锁定方案](version-locking.md)；顶层 npm 包锁定不等于锁住全部传递依赖。

## 3. 共享锁校验与 KISS 架构简化

`validate --lock` 离线读取共享锁并校验结构、声明与资产身份关系，已通过根会话审查。KISS 三片已通过根会话总审；[setup 实施方案](setup-plan.md)和 macOS uv-only 增量已审查，后续逐片推进其他部件、doctor 和 run。用户已授权该顺序，无需再次确认是否简化。

简化的目标是减少理解和修改现有行为所需跨越的概念、重复决策与调用层级，不以减少行数或机械拆分为目标。已收拢 `lock` 的操作生命周期、来源资产规则、相同的来源/摘要字段及有界响应体读取。报告仍可表达部分失败，持久锁仍拒绝未知字段；文件读取与网络读取边界不同，来源预算和错误也分别保留。测试中的重查场景用按 URL 的响应快照表示；不为其余差异强行引入统一模型。

保留单包 TypeScript/Node、Commander 和 Zod：core 负责纯业务判断，adapters 负责 I/O，commands 负责组装；只为已有消费者提取小型共享逻辑，不引入插件框架、依赖注入容器、抽象基类、复杂工厂、拆包或未来功能占位。命令及参数、JSON 形状、schemaVersion 1 锁和规范摘要算法、版本/目标选择、部件组合、能力要求和不同证据等级均保持兼容。

保留来源信任和 SHA-512/SHA-256 区别、缺项与身份冲突失败、无覆盖发布和并发保护、声明与来源复核、各来源的读取/分页/超时限制、中断清理，以及 stdout/stderr、JSON 和 40/80 列彩色与无色行为。以真实 CLI 行为为回归契约；可以简化重复或脆弱的 fixture，但不能删除失败测试或镜像实现。每片运行精确 pnpm `check`、实际 pack 和解包 CLI 验证，更新现状架构及开发文档，并交根会话独立审查。

## 4. setup：macOS uv 安装与 Herdr 外部复用已审查

先审查 [setup 方案](setup-plan.md) 和 [配置变体方案](config-variants.md)，再基于已验收的锁与真实 adapter 安装和对齐配置，明确安装来源与文件归属；配置和 skills 从 Git checkout 读取。实际处理 Node/npm/Git 前置检查及各平台差异，保留原生工具入口，不覆盖来源或归属未知的内容。

验收须在临时环境覆盖新机器、已有工具、重复执行、路径与本地修改冲突、失败恢复和锁不完整；只在临时测试环境安装或写入，不直接修改用户本机工具、PATH、凭证或原生配置。

当前 macOS uv-only 支持按锁安装、external 复用、受管入口及本机恢复；Herdr-only 支持复用与锁定版本匹配的已有原生入口，并记录 external/unknown 回执。状态严格读取 v1/v2，读取只做内存归一化，成功写入使用分开默认上下文与部件回执的 v2 快照；no-op 保留磁盘原文。uv/Herdr 两种应用顺序保留另一部件回执，旧 uv journal 保持兼容；新 journal 按 before/after/第三态恢复，空或损坏 journal 保留证据并阻塞。Herdr managed 安装、Windows 工具执行与完整 coding 仍未实现。

## 5. doctor 与 run coding：待实现，setup 审查通过后开始

在已有有限只读 `doctor` 基础上验证应用结果，补足 coding Agent 与 `shape`、`implement`、`verify` 的真实资源及加载路径。`run coding` 保留原生入口，透传参数、退出码、TTY 和中断。验收须从真实 CLI 完成 setup → doctor → run coding，并区分静态声明、工具观察与实际集成运行；Otty、Rex 和尚未实现的集成不得报告为已检查。

## 共同验收与后续扩展

继续使用 Commander 生态、现有终端呈现、YAML 源和实际 CLI 集成测试；每阶段运行 `pnpm check`，涉及打包时实际 pack、核对内容并解包验证。只报告实际运行过的 OS/Node 组合；CI 矩阵配置不等于多平台通过。npm 发布需单独授权。

闭环验收后，再按独立切片扩展单部件升级、配置恢复与程序回退、Rex 替换实验和其他工具的检测。保留能力要求，不能将 Pi skill 等同于 herdr Agent 状态集成。

pnpm native 预览按 12.15.0 起的 pnpm 12 发行契约核对所选版本的确切 optional package 及其元数据；未知系列或形态不符时阻塞。此预览不证明安装或运行。

只读报告已提供供后续消费者使用的结构化来源与规范声明摘要；首次写锁已复核来源并通过 no-clobber 发布；`validate --lock` 已能离线检查锁结构与声明一致性，不证明远端或安装；更新与离线仍待实现。

## 下一步分片与证据

setup 与 doctor 已对齐 repo/profile 的 option、env 和匹配本机绑定选择；doctor 仍只观察工具链，不核验应用结果。状态迁移契约见 [setup 方案](setup-plan.md#多部件状态兼容契约)，现有 uv 恢复保证继续适用。

1. macOS Herdr managed 安装：按锁下载单二进制、验证字节及版本、发布回执并恢复；隔离验证 server、IPC、pane、重启和重连。
2. Windows x64 Herdr 整包安装：保留 ZIP 中 ConPTY、OpenConsole 等运行文件及目录关系，单独验收原生执行与恢复；不能只复制 `herdr.exe`。
3. Pi npm staging、pnpm native 与 Windows uv；随后应用原生配置与 pi-herdr 资源。
4. doctor 应用核验及 `run coding`，完成 setup → doctor → run coding 闭环。Otty 保持独立可选桌面层，Rex 维持实验组合。

每片独立提交并评审。GitHub Actions 的 Linux/macOS/Windows × Node 24/26 矩阵目前运行构建、CLI 和受控 fixture；外部工具 adapter 交付后，再加入官方发行物的实际安装、幂等、隔离协议及恢复任务。VM/实机补充交互终端、ConPTY 和 GUI 验收；Linux runner 不能作为 WSL 原生证据。报告分别标明 fixture、官方发行物和交互实测，不能互相替代。

参考 [Herdr v0.9.5 调研](herdr-research.md)、[Pi v1.5.2 调研](pi-research.md)和 [Otty 官方文档调研](otty-research.md)。这些快照不改变共享锁，Otty Windows 发行支持尚未确认。

setup 计划展示 Herdr 三目标的锁定资产与预期摘要，不代表下载字节已验证。路径边界测试已覆盖真实文件、状态和 CLI 消费者；[原生路径契约](native-path-tests.md)的 3 项 TODO 仍待生产 adapter 接入，不能计入功能通过。
