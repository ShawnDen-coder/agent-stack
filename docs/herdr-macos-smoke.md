# Herdr macOS 原生安装与运行验收

先实际打包 CLI，并在独立目录安装运行依赖，再执行：

```sh
node scripts/smoke-herdr-macos.mjs --cli /absolute/path/to/package/dist/cli.js --target darwin-x64
# 原生 Apple Silicon 使用 --target darwin-arm64。
```

脚本要求真实的 macOS、匹配 target 的 Node 架构，以及 Node、npm、Git。Intel 查询强制使用与 Node 相同的 x86_64 架构；未知或仿真结果失败。不会模拟 platform/arch，也不会复用本机已有的 Herdr。

## 固定 metadata 与真实下载

脚本复制独立 `stack`，生成只要求 workspace 能力的 Herdr-only profile。锁创建读取 [v0.9.5 macOS 发行证据快照](../test/fixtures/herdr-release/v0.9.5.json)：它记录 2026-11-15 从官方 stable manifest 观察到的版本、URL 与摘要字段，不是 live metadata 查询。preload 只接受该 manifest URL，且仅在创建锁的进程使用。

首次 setup 不 mock fetch，从锁中的官方 HTTPS 地址真实下载资产，检查 managed 回执、目标、SHA-256 与入口版本。重复 setup 使用独立的禁止 fetch preload，任何网络尝试都会记录并使检查失败；两次 managed 回执须相同。CLI 和依赖来自独立安装的 npm 包，配置 checkout 为复制内容，不软链回源码工作树。

## 隔离运行与清理

临时 HOME、原生配置和状态目录使用短的 `/private/tmp` 独立根，避免已观察到的 Unix socket 路径长度限制。PATH 仅提供本次受管 bin 和真实的必需工具。脚本只启动自己的专用 session：

- 核对 Herdr 0.9.5、private protocol 22 与 endpoint 兼容状态。
- 创建 workspace/root pane，运行并读取无害 printf；通过多个独立 CLI IPC 连接核对同一 pane、terminal 和输出。
- 停止并重启本次 server，核对 workspace/pane 标识恢复、terminal 重建、旧输出不保留；新 pane 能继续执行命令。

等待与命令均有超时。finally 只停止本次 server，确认退出后清理临时目录；清理失败不会被转换为成功。setup 本身不启动或停止用户 server，也不导入配置、会话或认证。

上述结果是 IPC/CLI 证据，不等于 GUI、TUI attach/detach、键盘交互、ConPTY、Pi 集成或模型调用验收。

## 已有证据与 CI 目标

2026-11-15，候选 `93dd76208c002e7a75f45fff47cf344c9fb853be` 的独立解包 CLI 在原生 macOS x64 通过了本脚本：live HTTPS 下载、managed 首装、零下载重跑和上述运行流程均通过。资产 SHA-256 为 `5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369`。更早的隔离运行使用相同官方字节的受控响应，不能计作 live 下载证据。

`Herdr macOS installation` workflow 使用 Intel 与 arm64 原生 runner，Node 24；各目标的最终结论以对应整合提交的 Actions 结果为准。macOS arm64 尚无本机实测；Windows 安装仍未实现，GUI 和交互式 TUI 均不在该脚本的验收范围。
