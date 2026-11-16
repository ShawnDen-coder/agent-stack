# Windows 旧版编译探针诊断

当前 Windows host probe 使用 .NET Framework Reflection.Emit 在内存中定义相同的 Win32 调用，保留严格的架构证据判定和有界子进程管理。本文脚本保留旧版 Add-Type 链路，用于复现和解释已观察到的延迟，不代表当前生产实现。

常规 Check 运行实际生产 probe 的原生 Windows 测试。旧编译链的慢速对照已移到 [Windows legacy probe diagnostics](../.github/workflows/windows-probe-diagnostics.yml) 手动 workflow；可选择环境模式，在 Node 24/26 上记录四次调用，生产验收不依赖这些旧版对照成功。

历史基线：7f54e9618878cb3ab0efefeab96bd34a3886adcf。Node 24/26 的 Windows PR job 都在约 30.7 秒返回 probe-unknown；相同 SHA 的另一轮通过。现有日志不足以区分 PowerShell 冷启动、Add-Type/.NET 编译、Win32 调用或退出后等待 pipe，因此这些只是待证假设。

Windows 原生 runner 获取证据（可分别在 Node 24 和 26 下运行）：

```powershell
node scripts/diagnose-windows-host-probe.mjs --iterations 20 --concurrency 4 --env minimal
node scripts/diagnose-windows-host-probe.mjs --iterations 20 --concurrency 4 --env inherited
```

第一条复刻该旧版 child 的精简环境、30 秒 execFile budget、16 KiB 输出上限、SIGKILL、stdin EOF 和等待 close；第二条仅用于定位环境影响。每次输出一行 JSON：包含 parent 和 PowerShell 时钟阶段、stdout、受限 stderr、底层错误码/信号/killed、close 状态与时间。原生 API 失败记录 Win32 错误。额外的 35 秒诊断 watchdog 在已有 timeout 后关闭仍被持有的 pipe；这个 watchdog 仅用于诊断，不改变产品。相对耗时以同一进程的两个时钟分别解释，不将其相加。建议并发运行时同样保留原始完整 `pnpm check` 日志，比较系统负载；失败时保留全部 JSON，而不是只重试至通过。避免打印环境变量与凭据。

- 未出现 `powershell-started`：优先调查 PowerShell 启动、进程调度或 pipe。
- 出现 `add-type-start` 但没有 `add-type-complete`：优先调查 .NET 编译、临时目录、子进程和并发资源争用。
- `iswow64-start` 后无完成：调查 Win32 调用和进程访问；错误行提供 Win32 code。
- `probe-complete` 已出现但 close 延迟：调查进程退出及仍持有的 pipe；注意 watchdog 不能证明孙进程已被回收。

这些是定位分支，不是已证实根因。脚本不模拟 Windows、不变更生产实现，也不提供原生通过结论；请将两种 Node 版本的原始输出交回分析。

## c50314e 阶段观察与下一步对照

2026-11-15 的 Check run `43725666874` 中，Node 26 的四次精简环境 `Add-Type` 约 19.6–19.9 秒，Node 24 约 24.9–25.8 秒；同一次作业继承环境时分别约 0.12–0.17 秒。两种环境中的 `IsWow64Process2` 约 6–8 毫秒。精简环境重复两轮仍慢，因此不能简单归结为一次性冷启动；同时这些运行自身均在 30 秒内成功，不能声称已在诊断中捕获此前超时。完整 JSON 和 `Preparing modules for first use` stderr 保留在对应 Actions 日志。继承环境更快是相关性，不证明具体缺失变量。

追加三种只增受信任 SystemRoot 路径的隔离对照（仍使用临时 USERPROFILE/TEMP，不读取个人 PATH 或 PowerShell profile）：

```powershell
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env system-path
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env module-path
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env system-path-and-module-path
```

`system-path` 只提供 `%SystemRoot%\System32` 的 PATH；`module-path` 只提供系统 PowerShell v1.0 Modules 的 PSModulePath；组合则同时提供。按同一 runner 的 minimal、三种对照、inherited 分组记录，不要删掉原有失败结果或只报告最快一次。三种对照均慢时应继续查找其他变量或调用方式，不应宣称模块路径已证实为根因。以上模式只是诊断，不能改变生产接受条件。

追加单变量和组合对照，值全部来自系统固定位置或该次临时用户目录，不拷贝 runner 的用户环境：

```powershell
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env windir
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env comspec
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env appdata
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env local-appdata
node scripts/diagnose-windows-host-probe.mjs --iterations 4 --concurrency 2 --env system-runtime
```

单变量模式分别设置 `windir=SystemRoot`、`ComSpec=SystemRoot\System32\cmd.exe`、临时 `APPDATA` 和临时 `LOCALAPPDATA`。`system-runtime` 同时设置这四项以及前述系统 PATH 和 PSModulePath，用来判断这一组是否足够；不会继承认证、其他用户环境或 PowerShell profile。每次运行都创建独立的临时 AppData 目录，不模拟真实用户缓存。比较所有样本及失败原始输出，组合快但单项不快时继续逐项缩减组合，不据此宣称单一变量已证实。

## 单变量对照结果

[c9dbb08 的 PR 对照](https://github.com/ShawnDen-coder/agent-stack/actions/runs/43726683796)中，系统 PATH、PSModulePath、windir、ComSpec、临时 APPDATA/LOCALAPPDATA 及其组合均未消除 Add-Type 延迟；Node 24/26 仍约需 11.5–13.5 秒，继承环境约需 0.09–0.17 秒。该次原生检查成功不等于瓶颈已解决。

[同 SHA 的 push 对照](https://github.com/ShawnDen-coder/agent-stack/actions/runs/43726679619)进一步捕获 Node 24 的 APPDATA、LOCALAPPDATA 组各两次在 Add-Type 阶段达到 30 秒并被 SIGKILL；尚未进入 Win32 调用。旧版生产 probe 还出现临时目录清理 EBUSY。上述证据支持移除这项编译依赖，不能证明某一环境变量是唯一根因。新 probe 的验收以对应整合 SHA 的原生测试和重复查询结果为准。
