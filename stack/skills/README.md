# Skills

这些标准 Agent Skills 保存在 Git checkout 中。原生 macOS coding setup 引用 `shape`、`implement`、`verify`，run coding 会验证实际加载；独立的 `dependency-layers` 按需使用，不自动加入该组合。

- [shape](shape/SKILL.md)：从调用者体验设计 API，并与适用的终端或可视交互共同收敛方案。
- [dependency-layers](dependency-layers/SKILL.md)：项目和语言无关的 L0–L3 依赖规范，附按需使用的 Python、TypeScript 检查器材料；整个目录可独立复制。

- [implement](implement/SKILL.md)：按已确定的范围实施最小变更。
- [verify](verify/SKILL.md)：运行必要检查并记录结果与证据边界。

静态检查不代表工具或集成已运行。

## 编写约定

- 使用标准 Agent Skills 目录与 `SKILL.md` frontmatter，保持跨工具可移植；工具专属扩展不作为通用契约。
- 项目启动、数据与验收细节归目标项目；工具专属命令归相应工具资源，通用 skill 只描述可复用的工作方法和边界。
- 只写影响决策的信息；正文保留共同流程，按需引用支持文件。示例用于说明输入、输出和取舍，确定性且重复的操作适合脚本；根据真实任务评估并迭代，不按篇幅机械删减。

写作参考：[Anthropic skill 编写最佳实践](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)与 [Claude Code skills](https://code.claude.com/docs/en/skills)。其中 Claude Code 的专属功能不自动成为跨工具要求。

## 维护验证

格式检查、检查器 fixture 和 skill 的真实任务行为是三种不同证据，分别报告。行为试用只给目标与原始项目，不向执行者提供期望答案或评分标准，也不要求自报遵循规则；审查实际产物、执行痕迹和可观察结果。可选场景包括纯库、仅 HTTP 后端、依赖方向合法但空转发的层，以及不合法的直接依赖边。

比较版本时保持任务、输入和环境一致，匿名评判产物并报告样本局限；单次试用不证明改善。这是维护时按需采用的方法，不是每次立项的步骤。方法借鉴并改写 [pstack eval](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/eval.md)，不引入其评测流程或框架。
