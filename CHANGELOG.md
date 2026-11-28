# Changelog

## 0.1.1 — 2026-11-28

- 修复 GitHub Packages 上传路径。发布脚本将已验收的 tarball 转为绝对路径，避免 npm 将其解释为 Git 仓库地址。
- PR 和发布构建用同一 tarball 执行离线 `npm publish --dry-run`，核对实际发布参数。

## 0.1.0 — 2026-11-28

- 首个 Git tag。Node.js 24+ 的 npm CLI 和四个平台的独立可执行文件已通过构建验收。npm 上传失败，GitHub Release 创建步骤跳过。
- `agent-stack validate` 校验 checkout 中的声明及共享锁，`lock` 从受支持的目标创建首份共享锁。
- 原生 macOS 支持完整 coding setup、doctor 与 Herdr pane 中的 `run coding`。Windows x64 支持 Herdr-only 安装。
- 已有 Pi 可以通过 `pi install` 从 Git checkout 加载 coding Agent 和三个共享 skills。
