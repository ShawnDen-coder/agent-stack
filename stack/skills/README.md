# 可复用工作流

按标准的 `stack/skills/<name>/SKILL.md` 组织说明、脚本、references 与 assets。当前尚未编写或安装三个核心工作流，先保留职责：

- `shape`：读取项目，收敛需求、范围和验收条件。
- `implement`：完成小范围改动，修 bug 先建立复现。
- `verify`：从真实入口验证，保留命令、关键结果和未解决缺口。

通用工作流不直接依赖 herdr 或 Rex 的命令。工具专属指引随所选部件与集成启用。项目自己的启动、数据准备与验收方法留在业务仓库。

格式依据：[Agent Skills specification](https://agentskills.io/specification)。工具前置条件以后由部件声明和环境检测共同处理，不把未知自定义字段当成跨工具通用的 SKILL.md 契约。
