# Herdr Windows native smoke

在 Windows x64 原生 Node 24.x runner 上，先构建、`npm pack` 并在临时目录安装包及其运行时依赖，再运行：

```powershell
node scripts/smoke-herdr-windows.mjs --cli <独立安装目录>/node_modules/@shawnden-coder/agent-stack/dist/cli.js
```

脚本拒绝非 Windows 或非 x64 Node；setup 自身还执行严格的原生宿主检查。脚本将 stack 复制到独立目录，使用 v0.9.5 [官方 manifest 摘要快照](../test/fixtures/herdr-release/v0.9.5.json)生成锁。快照仅供锁生成；首次 setup 不拦截网络，必须从锁定 GitHub URL 真实 HTTPS 下载 ZIP 并校验 SHA-256，重跑使用单独 preload 禁止 fetch。npm 包从当前 Node 发行版复制到临时目录，生成标准 cmd-shim 并核对真实包版本；Git 与 Bash 均为 runner 真实程序，Bash 另行执行无害命令验证。

HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG、临时目录和 Herdr config/session 均隔离；临时根目录采用仅当前用户可写的显式 ACL。脚本核对 managed 回执及七个文件的摘要，启动自己的 server，检查 version/protocol、workspace 和 pane；使用独立客户端连接运行并读取无害命令，检查 client 重连与 server 停止、重启后的行为。finally 只处理本次 server 和临时目录。测试失败必须返回非零，不将 marker 文件存在视作 IPC 健康。

2026-11-15 的官方 Windows x64 ZIP 已在本机按 SHA-256 `d2c6c9c971c43a0bfdde8c692a9a1a7a45c3e4807cd01ae45662b4734fac1cbf` 核对七文件布局和 PE 类型；这不是 Windows 原生执行证据。随后 `eba44c9` 的 [Windows Node 24/26 原生运行](https://github.com/ShawnDen-coder/agent-stack/actions/runs/43743135846)已通过：解包 CLI 真实 HTTPS 下载、七文件摘要核对、零 fetch 重跑、protocol 22、workspace/pane 命令和独立客户端重连。server 重启后 workspace/pane ID 保留，terminal 重建，旧输出不保留，新命令可运行。GUI、真实 TTY、键盘及普通用户桌面体验仍需 VM/实机验收。
