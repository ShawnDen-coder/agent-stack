# 后续实施顺序

[Quickstart](quickstart.md) · [CLI 验收](cli-acceptance.md) · [架构](architecture.md) · [开发](development.md) · [路线图](roadmap.md)

首版目标是经过真实 CLI 验证的 setup → doctor → run coding 闭环。按以下依赖顺序独立实现、提交并交根会话复审；前一阶段通过审查后再推进下一阶段。当前已实现 `validate`、有限只读 `doctor` 和仅报告版本候选的 `lock --dry-run`，其他命令不得在帮助或 README 中宣称可用。

## 1. stack/ 目录迁移：根会话审查通过

声明、原生配置、Agent 和 skills 收拢在仓库根目录下的 `stack/`；`--repo` 仍指向仓库根目录。验收包括真实 CLI 的新布局读取、缺失目录提示、根级旧声明不混读、YAML/JSON 和既有 doctor/交互回归，以及 `pnpm check` 和实际打包解包检查。默认外部部件锁位置为 `<repo>/stack/stack.lock.json`，尚未创建。

## 2. lock：npm 与 uv/herdr 版本候选报告已实现，完整锁待实现

实现公开单入口 `lock`，基于新目录的完整 profile 解析 Pi、pnpm、uv 和 herdr。锁记录确切版本、来源、目标及发行物的预期 digest；完整 profile 和全部目标通过校验后才能写锁，不能靠删除部件或能力要求生成伪完整锁。仅显式更新指定部件，其他项保持原版本与资产；支持可验证的 dry-run、offline 和完整候选锁行为。失败、并发或输入变化时保留旧锁。

验收须从编译后的真实 CLI 使用受控网络元数据和临时仓库，覆盖完整 coding 候选、缺失资产或 digest、范围及渠道、平台和 Node 约束、最小更新、多目标、声明变化、离线、并发与写入失败；实际来源 dry-run 的成功或受阻分别报告。网络受限时仍需实现可独立验证的行为和真实失败路径，不编造来源或 digest。当前实现带结构化来源身份和所选声明摘要的 npm 顶层包与 uv/herdr 版本候选报告，以及部分 Pi、pnpm、uv、herdr 目标资产和预期摘要的只读预览；其他目标资产、传递依赖闭包和锁生成均未实现。详细契约见 [版本锁定方案](version-locking.md)；顶层 npm 包锁定不等于锁住全部传递依赖。

## 3. setup：待实现，lock 审查通过后开始

先审查 [配置变体方案](config-variants.md)，再基于已验收的锁与真实 adapter 安装和对齐配置，明确安装来源与文件归属；配置和 skills 从 Git checkout 读取。实际处理 Node/npm/Git 前置检查及各平台差异，保留原生工具入口，不覆盖来源或归属未知的内容。

验收须在临时环境覆盖新机器、已有工具、重复执行、路径与本地修改冲突、失败恢复和锁不完整；只在临时测试环境安装或写入，不直接修改用户本机工具、PATH、凭证或原生配置。

## 4. doctor 与 run coding：待实现，setup 审查通过后开始

在已有有限只读 `doctor` 基础上验证应用结果，补足 coding Agent 与 `shape`、`implement`、`verify` 的真实资源及加载路径。`run coding` 保留原生入口，透传参数、退出码、TTY 和中断。验收须从真实 CLI 完成 setup → doctor → run coding，并区分静态声明、工具观察与实际集成运行；Otty、Rex 和尚未实现的集成不得报告为已检查。

## 共同验收与后续扩展

继续使用 Commander 生态、现有终端呈现、YAML 源和实际 CLI 集成测试；每阶段运行 `pnpm check`，涉及打包时实际 pack、核对内容并解包验证。只报告实际运行过的 OS/Node 组合；CI 矩阵配置不等于多平台通过。不推送或发布。

闭环验收后，再按独立切片扩展单部件升级、配置恢复与程序回退、Rex 替换实验和其他工具的检测。保留能力要求，不能将 Pi skill 等同于 herdr Agent 状态集成。

pnpm native 预览按 12.15.0 起的 pnpm 12 发行契约核对所选版本的确切 optional package 及其元数据；未知系列或形态不符时阻塞。此预览不证明安装或运行。

只读报告已提供供后续消费者使用的结构化来源与规范声明摘要；首次写锁、来源复核和无覆盖发布仍待实现。
