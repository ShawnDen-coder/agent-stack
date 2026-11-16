# L0–L3 依赖规范

唯一规范及验收案例见 [dependency-layers skill](../stack/skills/dependency-layers/SKILL.md)。该目录可独立复制，包含 Python 和 TypeScript 的按需检查器参考及覆盖脚本；没有经验证的 Rust 检查器配置。资源指导目标项目接入，不会自动启用检查或加载到 Pi。

此前在 Python 3.14.8 / Import Linter 2.16 和 Node 24.15.0 / dependency-cruiser 18.7.2 / TypeScript 6.0.3 的临时 fixture 中验证过参考配置；dependency-cruiser 18.7.2 配合 TypeScript 7.0.2 可能跳过源码并返回成功。具体覆盖与限制见 skill 参考；这些结果不代表本项目已接入架构检查或完成运行验收。
