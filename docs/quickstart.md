# Quickstart

首次配置已有 Pi 见 [README](../README.md#配置已有-pi)。`pi install` 将 local package 路径写入 Pi 原生 settings，不复制 checkout 内容；Pi 后续启动时读取 checkout。重复安装、启停资源、移除 package 由 `pi list`、`pi config`、`pi remove` 管理。package 声明三个 skills 与 Agent hook，不安装或更新其他 packages；用户配置的 `pi-mcp-adapter`、个人 skills、模型及凭证仍由 Pi 管理。

Agent hook 把共享约定追加到 Pi 已组装的 system prompt，保留 Pi 自身及用户已有指令。同一份约定已经在 prompt 中时不会再追加，兼容现有 `run coding` 的 Agent 参数。Pi 对相同资源路径的去重依赖 Pi 本身；同名但不同路径的 skills 由 Pi 的冲突规则处理。`dependency-layers` 不自动启用。

Herdr 官方状态扩展由 Herdr 或受管 setup 安装；本 package 不安装第二份扩展。

若曾运行受管 setup，原先写入 settings 的三个 checkout skill 路径仍由原回执管理；Pi 1.1.0 对同一路径去重。原有 Herdr 扩展和受管 `run coding` 继续可用，无需移除或重新安装。迁移到不同 checkout 时，旧路径和新路径是不同资源：先用原受管 setup 迁移或手动检查原生 settings，再移除不再使用的路径，避免同名 skills 冲突。更换 local package 路径时，使用 `pi remove` 移除旧路径后再安装新路径。

## 受管 coding

在原生 macOS Apple Silicon 或 Intel 上，checkout 自带 Pi 1.5.2、Herdr 0.9.5、pnpm 12.15.0 和 uv 0.13.8 的双架构共享锁。首次 setup 需要 Git、Node.js 24+、npm 11.12.1 和网络。构建后：

```sh
npm exec --yes --package=pnpm@12.15.0 -- pnpm install --frozen-lockfile --ignore-scripts
npm run build
node dist/cli.js validate --repo . --lock
mkdir -p "$HOME/.agent-stack/bin"
export PATH="$HOME/.agent-stack/bin:$PATH"
node dist/cli.js setup --repo . --profile coding --dry-run
node dist/cli.js setup --repo . --profile coding
node dist/cli.js doctor --repo . --profile coding
```

检查计划后在 setup 中确认。已有外部 Pi 或 pnpm 不会被接管，会阻塞完整 setup；如需受管安装，可在独立 shell PATH 中使用受管 bin、Node/npm、Git 和系统命令。原有安装无需卸载。在业务项目的 Herdr pane 中运行 `node /path/to/agent-stack/dist/cli.js run --repo /path/to/agent-stack coding --cwd "$PWD"`。

更新 checkout 并重新构建后，可重新预览和运行 setup。此前由项目导入的扩展声明、角色偏好、模型默认值与 Reui 项，仅在同一目标中仍与旧回执匹配时撤回；用户新增或改动的值和扩展安装目录保留。配置修改沿用备份与中断恢复流程。

[架构与分工](architecture.md) · [锁的来源与更新](../test/fixtures/coding-lock/README.md) · [开发与分发](development.md)
