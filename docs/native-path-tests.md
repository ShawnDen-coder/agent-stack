# 路径与本机状态边界测试

最初的边界测试基于 `b22b6ea2188027ad94fd19d6ea44053c11fd3ecc`。当前 macOS coding 资源规划器已消费其中 Pi agentDir 和 Herdr configFile 的 fixture 子集；其他字段和平台仍保留为原生契约，不作为已实现或已验收证据。

## A：真实消费者的可运行回归

`test/path-boundaries.test.mjs` 导入编译后的 `setup-state`、`managed-operation`，并启动编译后的 CLI。它们已由 setup/doctor/uv 使用，预期来自 Agent Stack 当前状态及归属契约，不是第三方原生路径规则。

| 边界            | 可观察结果                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| setup state     | 缺失或非绝对 home 返回无绑定且不创建目录；接受现有 uv v1 外部/受管输入且不改写字节；默认投影仅有 repo/profile/lock                      |
| 损坏/未来状态   | 非法 JSON、未知字段/版本、相对绑定路径及不一致 uv 归属拒绝；原文件字节不变                                                              |
| 有界读取        | 恰好 65,536 bytes 的合法状态可读；多一 byte 拒绝；空文件、缺失和非普通文件分别处理；FIFO 无 writer 时及时拒绝                           |
| 受管目录        | 当前用户的普通安全目录可用；group/world 可写、末端与祖先符号链接拒绝                                                                    |
| 身份与摘要      | 普通文件/目录的 dev/ino 来自实际 stat；固定 `abc` SHA-256；硬链接共享身份；原地修改摘要变化；相同内容的新 inode 拒绝                    |
| 归属删除        | 新 inode 或 symlink 保留；仅 unlink 已证明归属的入口；其他硬链接内容保留；已缺失入口可重试                                              |
| operation guard | 等待中的 owner 排斥 contender；动作异常后释放并保留原异常；既有中断 guard 与证据保留                                                    |
| CLI 上下文      | 调用 cwd 与 repo 不同时解析中文/空格相对 repo 和 lock；HOME 与 USERPROFILE 指向不同临时目录时 doctor 使用当前 HOME 绑定，双方原文件不变 |

`readSetupState` 只断言缺失、接受合法 v1 输入或拒绝非法输入；不冻结 `UvBinding` 返回对象排布。默认上下文由 `readDefaultBinding` 的 repo/profile/lock 投影断言，原文保持与 raw-byte fingerprint 是磁盘边界。后续 v2 的 `defaultBinding` / `installations` 归一化内容应由其真实消费者的测试验证。未知版本 fixture 使用 `999`，不把即将实现的 v2 固定成不支持版本。

CLI 用例使用空 PATH，故工具缺失返回 1 是明确预期，只核对上下文/错误及无写入结果。它们不执行系统 npm/git/Agent，也不修改 `process.env`。`HOME` 行为测试锁住当前消费者的显式输入，不承诺实现 Windows 原生 home fallback。

临时根先 `realpath`，避免 macOS 自带的 `/var` alias 误触“目录不能穿过 symlink”约束。Unix mode、FIFO 与 symlink 用例精确跳过 Windows；其余使用宿主真实文件系统。未伪造 Windows `process.platform`，未用 `path.win32` 的结果冒充产品实现。

未覆盖：不同 uid 所有者（不使用提权/chown）、任意外部进程在单次检查与文件操作之间的竞态、Windows ACL/原生 symlink、WSL 实机。现有 guard 用实际 mkdir 和受控 Promise 顺序验证互斥，不依赖延时碰运气。

现有 doctor option/env/binding 优先级、空白 option 与损坏绑定，以及 setup 相对候选锁的成功应用仍由原有测试负责；本片没有复制那些大文件或无效 UTF-8 fingerprint 回归。

## B：原生路径契约与当前生产消费者

| 文件                                           | 证据等级                                                        | 内容                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `test/fixtures/native-paths/herdr-v0.9.5.json` | 固定官方源码，commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` | 14 项原生路径预期；2 项单列的 Agent Stack 策略/待定处理 |
| `test/fixtures/native-paths/pi-v1.5.2.json`    | 固定官方源码，commit `b4afdddf44e059c67ccf5097e5317d913521b470` | 14 项 agentDir、home skills 与独立 session-dir 预期     |

每个 case 都有 `input`、独立写出的 `expected`、`status` 与 `sourceRefs`。`sourceRefs` 引用固定官方证据，不通过复制解析算法生成预期。`consumer.coverage` 标明当前 adapter 的子集；未覆盖的 `contract-only` 字段不能算通过。

`test/path-native-contracts.test.mjs` 调用真实 `planCodingResources`，核对 macOS Pi 默认、空值、非空覆盖、前导 `~`，以及 Herdr 默认、独立 XDG 和配置文件覆盖。相对 Pi/Herdr 目标及 Herdr 空覆盖明确拒绝，避免随调用 cwd 写入。CLI 的 `localSetupHome` 也覆盖缺失/空 HOME，不静默采用 Herdr 的临时目录 fallback。Windows/WSL 完整 coding 与 Pi session 选择仍有一项待验收测试。Pi 的独立 home skills、session 和 Herdr C/S 没有因这个子集而被宣称通过。真实 Herdr server 的 socket 路径与 Pi 加载路径另由官方资产烟测验证。

Fixture 约定：

- `input.env` 是完整的受控环境集合，缺失键表示 unset；空字符串表示已设置为空。Pi 的 `homedir` 是 `os.homedir()` 的受控返回值，不把环境变量推断为该返回值。
- Herdr 只描述 release build；分别记录配置文件 F、配置目录 C 和状态目录 S。`HERDR_CONFIG_PATH` 只覆盖 F；XDG 两根独立；Windows 保留 APPDATA/LOCALAPPDATA → USERPROFILE → HOME → temp fallback 的区别。空值及字面 `~` 是原生规则。Agent Stack 拒绝隐式 temp fallback，并明确拒绝用于受管资源的相对覆盖。
- Pi 非空 agentDir 覆盖、空值 fallback、前导 `~`、Windows/WSL 分开；全局 home `.agents/skills` 独立于 agentDir；session CLI/env/settings 单独选择。相对 agentDir 的 `getAgentDir()` 返回值仍为相对值，不给它虚构 cwd 归一化。
- Windows fixture 统一用 `/` 表达目标路径身份，便于审阅，不承诺 Rust/Node 输出的分隔符拼写。未来 consumer 须按原生语义比较并在 Windows 实跑；当前这些案例没有执行覆盖。

后续继续接入 Herdr C/S、Pi 独立 home skills/session-dir 与其他平台。接入时应将对应 TODO 替换为对生产消费者的断言，同时保留未知项和平台验收限制。标为 `pending-policy` 的用例等待产品行为确定后再补断言。

## 本地运行

```sh
pnpm build
node --test test/path-boundaries.test.mjs test/path-native-contracts.test.mjs
pnpm check
```

默认测试不联网、不安装第三方 Agent、不启动用户 server、不读取真实 home、认证或会话。官方源码仅用于人工核对 fixture，执行测试不需要访问来源 URL。完整检查仍包含原有 Unix fixture 的开发环境依赖，见 [开发说明](development.md)。
