# Agent Stack

Agent Stack 是一个以 Git checkout 管理个人 Agent 环境的项目。部件、组合与集成通过 YAML 分别维护；当前 CLI 可以校验声明、只读检查部分工具链，并预览 npm、uv 和 herdr 的版本候选。

**项目尚未发布：**包标记为 `private`、`UNLICENSED`，当前没有授予使用许可。请从源码试用，不要安装同名公开 npm 包。

## 快速试用

需要 Node.js 24+、npm、Git 和仓库 `packageManager` 指定的 pnpm 12.15.0。基础 CLI 已合入 `master`；试用本次 macOS uv 安装增量，请检出 PR #2 的分支：

```sh
git clone --branch uv-macos-setup https://github.com/ShawnDen-coder/agent-stack.git
cd agent-stack
pnpm install --frozen-lockfile
pnpm build
pnpm cli --help
pnpm cli validate --repo .
```

`validate` 成功时显示声明计数；已有共享锁可用 `pnpm cli validate --repo . --lock` 离线检查锁结构与声明一致性（`--lock ./candidate.json` 指定其他锁）。锁校验不验证发行方、下载字节或安装。它不证明工具已安装或可以运行。可继续使用 `pnpm cli doctor --repo . --profile coding` 只读检查环境；缺失工具或有未核对项时退出 1 是可解释的检查结果。

[完整 Quickstart](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/quickstart.md) 包含 pnpm 安装、Windows PowerShell、JSON、退出码和可选的在线版本候选报告。

## 文档

- [CLI 已实现行为与验收](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/cli-acceptance.md)；[CLI 行为稿](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/cli-behavior.md) 后半部分为拟议接口。
- [架构与声明](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/architecture.md)、[配置变体提案](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/config-variants.md)。
- [开发、测试与打包](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/development.md)、[后续路线](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/roadmap.md)。

## 当前边界

`lock --dry-run` 报告版本元数据；提供 `--target` 时可预览 Pi、pnpm、uv 和 herdr 的 macOS arm64/x64 与 Windows x64 资产元数据及预期摘要。pnpm native 预览核对已识别的 pnpm 12 发行契约；未知系列或依赖形态不符时阻塞。该报告不生成锁或执行计划；它只读取发行方元数据，不下载发行物，也不完成字节摘要验证、签名验证、传递依赖闭包或运行验收。显式指定已支持目标时，`lock` 可首次创建共享锁；已有默认锁或输出文件时拒绝覆盖。更新、离线解析、其他部件安装、配置应用和 `run coding` 尚未实现。共享声明位于 `stack/components/`、`stack/profiles/` 和 `stack/integrations/`；`stack/configs/` 保留工具原生格式。认证、会话与设备状态留在本机。

`setup --profile coding --dry-run` 可离线预览已有共享锁的本机计划；当前不安装或应用配置，必需步骤未实现时返回 1。需明确锁覆盖的原生目标；支持检测原生 macOS arm64/x64 和 Windows x64，未知或仿真宿主阻塞。

在原生 macOS arm64/x64，`setup` 可按完整锁安装或复用能力完整的 uv-only profile；预览不联网，执行前需确认或显式 `--yes`。新安装的受管入口位于 `$HOME/.agent-stack/bin`，须预先创建并加入 PATH；匹配的外部入口可只读复用。原生 macOS Herdr-only 可按锁安装或复用匹配的已有入口；外部入口归属为 unknown。它不代表 coding 已配置；Windows、Linux/WSL、仿真和其他部件仍不能应用。详见 [Quickstart](https://github.com/ShawnDen-coder/agent-stack/blob/uv-macos-setup/docs/quickstart.md)。
