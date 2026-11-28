# Changelog

## 0.1.0 — 2026-11-28

- 首次分发 `@shawnden-coder/agent-stack`。npm CLI 需要 Node.js 24+。GitHub Release 提供 macOS arm64/x64、Linux x64 和 Windows x64 的独立可执行文件及 SHA-256 清单。
- `agent-stack validate` 校验 checkout 中的声明及共享锁，`lock` 从受支持的目标创建首份共享锁。
- 原生 macOS 支持完整 coding setup、doctor 与 Herdr pane 中的 `run coding`。Windows x64 支持 Herdr-only 安装。
- 已有 Pi 可以通过 `pi install` 从 Git checkout 加载 coding Agent 和三个共享 skills。
