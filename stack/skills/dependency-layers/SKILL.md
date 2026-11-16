---

name: dependency-layers
description: 建立、调整或审查项目的 L0–L3 模块依赖边界，并验证公共入口、依赖方向和覆盖范围。适用于接入或修复架构约束，而非一般业务调试。
---

# 依赖边界

先读 [依赖契约与验收案例](references/contract.md)，它是本 skill 的权威规范。按目标项目职责确定生产源码范围、模块归属、公共入口、L0 消费者和例外；保留项目更严格的规则。不要为了消除违规制造空转发或改变能力要求。

先运行已有检查并区分违规、解析错误与工具缺失。选择目标语言实际可用的依赖图检查器，用项目包管理器锁定并接入既有检查和 CI。按需读取：

- Python 的 [Import Linter 映射](references/import-linter.md)。
- TypeScript 的 [dependency-cruiser 映射](references/dependency-cruiser.md)，含版本兼容和 [源码覆盖脚本](scripts/check-layer-coverage.mjs)。

其他语言自行选择并验证检查器；不能推断参考配置覆盖其语法。按契约用临时 fixture 验证正反例，核对负例确实因预期边失败。检查全部生产模块，包括孤立文件、类型引用、别名和重导出；解析缺口与动态行为另行报告。

交付模块表、公共入口、允许范围、精确例外、检查命令和实际结果。静态分析不证明运行行为；未执行或未覆盖的验证明确列出。
