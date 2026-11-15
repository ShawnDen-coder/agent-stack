# Windows native host probe diagnostics

基线：7f54e9618878cb3ab0efefeab96bd34a3886adcf。Node 24/26 的 Windows PR job 都在约 30.7 秒返回 probe-unknown；相同 SHA 的另一轮通过。现有日志不足以区分 PowerShell 冷启动、Add-Type/.NET 编译、Win32 调用或退出后等待 pipe，因此这些只是待证假设。

Windows 原生 runner 获取证据（可分别在 Node 24 和 26 下运行）：

```powershell
node scripts/diagnose-windows-host-probe.mjs --iterations 20 --concurrency 4 --env minimal
node scripts/diagnose-windows-host-probe.mjs --iterations 20 --concurrency 4 --env inherited
```

第一条复刻生产 child 的精简环境、30 秒 execFile budget、16 KiB 输出上限、SIGKILL、stdin EOF 和等待 close；第二条仅用于定位环境影响。每次输出一行 JSON：包含 parent 和 PowerShell 时钟阶段、stdout、受限 stderr、底层错误码/信号/killed、close 状态与时间。原生 API 失败记录 Win32 错误。额外的 35 秒诊断 watchdog 在已有 timeout 后关闭仍被持有的 pipe；这个 watchdog 仅用于诊断，不改变产品。相对耗时以同一进程的两个时钟分别解释，不将其相加。建议并发运行时同样保留原始完整 `pnpm check` 日志，比较系统负载；失败时保留全部 JSON，而不是只重试至通过。避免打印环境变量与凭据。

- 未出现 `powershell-started`：优先调查 PowerShell 启动、进程调度或 pipe。
- 出现 `add-type-start` 但没有 `add-type-complete`：优先调查 .NET 编译、临时目录、子进程和并发资源争用。
- `iswow64-start` 后无完成：调查 Win32 调用和进程访问；错误行提供 Win32 code。
- `probe-complete` 已出现但 close 延迟：调查进程退出及仍持有的 pipe；注意 watchdog 不能证明孙进程已被回收。

这些是定位分支，不是已证实根因。脚本不模拟 Windows、不变更生产实现，也不提供原生通过结论；请将两种 Node 版本的原始输出交回分析。
