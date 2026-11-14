# Agent Stack

一套个人 Agent 配置与开发仓库：从 Git 恢复常用工具和配置，在真实任务中沉淀 skills，并逐步把可验证的流程交给自动化。

采用 TypeScript + Node.js 实现 npm CLI。部件可以独立升级、锁定版本和重新组合；Pi 是首个 Agent 运行时，herdr 是当前工作区选项，Rex 作为实验组合保留。

**当前阶段：项目基础骨架。** 已实现仓库定义的只读校验。工具检测、安装、升级、配置应用和部件锁文件生成尚未实现。

## 试用当前能力

需要 Node.js 24+、Git 和 pnpm 12.15.0。在本仓库目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm cli --help
pnpm cli validate --repo .
```

校验成功时输出：

```text
Definitions valid: 6 components, 2 integrations, 2 profiles.
Tool installation, versions, and runtime compatibility have not been checked.
```

从其他目录检查这份 checkout，或获取 JSON 结果：

```sh
node /path/to/agent-stack/dist/cli.js validate --repo /path/to/agent-stack --json
```

校验成功退出码为 `0`；定义、引用或声明的能力不满足要求时为 `1`。该命令不安装工具、不联网，也不修改本机配置。

## 组合示例

| Profile      | 部件                | 集成声明              | 适用平台声明               |
| ------------ | ------------------- | --------------------- | -------------------------- |
| `coding`     | Pi、herdr、pnpm、uv | Pi/herdr 状态报告     | macOS、Windows 原生、Linux |
| `coding-rex` | Pi、Rex、pnpm、uv   | Pi/Rex 终端控制 skill | macOS 实验组合             |

这两份 profile 的平台和能力是静态声明，不代表对应平台已运行验证或完成实际安装。Rex 组合没有宣称提供与 herdr 相同的 Agent 状态能力；替换部件后遗漏原组合要求的能力，校验会失败。

共享配置以这份 Git checkout 为准，CLI 的 npm 包仅包含工具代码。认证、会话、缓存和设备覆盖留在本机。`pnpm-lock.yaml` 锁定 CLI 自身依赖；外部部件的 `stack.lock.json` 尚未实现或生成。当前包设置为 `private`，尚未发布到 npm。

## 继续开发

- [项目结构与架构](docs/architecture.md)：部件、组合、集成、原生配置和版本锁定的边界。
- [技术栈与开发命令](docs/development.md)：构建、测试、CI 和打包。
- [后续实施顺序](docs/roadmap.md)：从工具检测推进到配置应用、锁定与升级。

```sh
pnpm check
```
