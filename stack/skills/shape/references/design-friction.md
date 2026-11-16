# 设计摩擦的线索

在调用样例、实现草图或实际任务中，留意：

- 一个操作要求调用者协调多个步骤，或暴露内部表示和策略。
- 按执行阶段拆分模块，导致多处重复掌握同一知识；一层只原样转发同一接口。
- 同一状态有多个写入者；内部实现可被外部直接导入；多份同源列表需要手工同步。

这些是调查线索，不是自动判错。先结合真实调用者与职责判断代价；反复出现同类摩擦时考虑调整边界，一个边角问题不足以要求重写架构。有独立适配、策略或隔离职责的 adapter 可以保留。

本清单借鉴并改写 [pstack architect](https://github.com/cursor/plugins/blob/main/pstack/skills/architect/SKILL.md) 和其 [设计红旗](https://github.com/cursor/plugins/blob/main/pstack/skills/architect/references/design-red-flags.md)，不要求采用其完整流程。
