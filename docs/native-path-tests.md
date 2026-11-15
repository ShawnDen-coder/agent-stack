# 路径与本机状态边界测试

本片基于 `b22b6ea2188027ad94fd19d6ea44053c11fd3ecc`，只新增测试与证据 fixtures。它不实现 Herdr/Pi/Otty 路径解析器，也不证明第三方工具已安装或 Windows 已验收。

## A：真实消费者的可运行回归

`test/path-boundaries.test.mjs` 导入编译后的 `setup-state`、`managed-operation`，并启动编译后的 CLI。它们已由 setup/doctor/uv 使用，预期来自 Agent Stack 当前状态及归属契约，不是第三方原生路径规则。

| 边界            | 可观察结果                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| setup state     | 缺失或非绝对 home 返回无绑定且不创建目录；保留现有 uv v1 外部/受管回执；默认投影仅有 repo/profile/lock                                  |
| 损坏/未来状态   | 非法 JSON、未知字段/版本、相对绑定路径及不一致 uv 归属拒绝；原文件字节不变                                                              |
| 有界读取        | 恰好 65,536 bytes 的合法状态可读；多一 byte 拒绝；空文件、缺失和非普通文件分别处理；FIFO 无 writer 时及时拒绝                           |
| 受管目录        | 当前用户的普通安全目录可用；group/world 可写、末端与祖先符号链接拒绝                                                                    |
| 身份与摘要      | 普通文件/目录的 dev/ino 来自实际 stat；固定 `abc` SHA-256；硬链接共享身份；原地修改摘要变化；相同内容的新 inode 拒绝                    |
| 归属删除        | 新 inode 或 symlink 保留；仅 unlink 已证明归属的入口；其他硬链接内容保留；已缺失入口可重试                                              |
| operation guard | 等待中的 owner 排斥 contender；动作异常后释放并保留原异常；既有中断 guard 与证据保留                                                    |
| CLI 上下文      | 调用 cwd 与 repo 不同时解析中文/空格相对 repo 和 lock；HOME 与 USERPROFILE 指向不同临时目录时 doctor 使用当前 HOME 绑定，双方原文件不变 |

CLI 用例使用空 PATH，故工具缺失返回 1 是明确预期，只核对上下文/错误及无写入结果。它们不执行系统 npm/git/Agent，也不修改 `process.env`。`HOME` 行为测试锁住当前消费者的显式输入，不承诺实现 Windows 原生 home fallback。

临时根先 `realpath`，避免 macOS 自带的 `/var` alias 误触“目录不能穿过 symlink”约束。Unix mode、FIFO 与 symlink 用例精确跳过 Windows；其余使用宿主真实文件系统。未伪造 Windows `process.platform`，未用 `path.win32` 的结果冒充产品实现。

未覆盖：不同 uid 所有者（不使用提权/chown）、任意外部进程在单次检查与文件操作之间的竞态、Windows ACL/原生 symlink、WSL 实机。现有 guard 用实际 mkdir 和受控 Promise 顺序验证互斥，不依赖延时碰运气。

现有 doctor option/env/binding 优先级、空白 option 与损坏绑定，以及 setup 相对候选锁的成功应用仍由原有测试负责；本片没有复制那些大文件或无效 UTF-8 fingerprint 回归。

## B：原生路径契约，尚无生产 consumer

| 文件                                                   | 证据等级                                                        | 内容                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `test/fixtures/native-paths/herdr-v0.9.5.json`         | 固定官方源码，commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01` | 14 项原生路径预期；2 项单列的 Agent Stack 策略/待定处理      |
| `test/fixtures/native-paths/pi-v1.5.2.json`            | 固定官方源码，commit `b4afdddf44e059c67ccf5097e5317d913521b470` | 14 项 agentDir、home skills 与独立 session-dir 预期          |
| `test/fixtures/native-paths/otty-docs-2026-11-15.json` | 未按发行版本冻结的官方在线文档                                  | 4 项主/本机文件及覆盖预期；3 项证据缺口保持 `expected: null` |

每个 case 都有 `input`、独立写出的 `expected`、`status` 与 `sourceRefs`。`sourceRefs` 引用该文件的 `sources`；没有执行第三方源码或复制一份解析算法来生成预期。`consumer: null` 和 `contract-only` 表示仍待接入，不能算功能测试通过。`test/path-native-contracts.test.mjs` 只登记 3 个 `test.todo`，不会把 JSON 自我比较算作通过。

Fixture 约定：

- `input.env` 是完整的受控环境集合，缺失键表示 unset；空字符串表示已设置为空。Pi 的 `homedir` 是 `os.homedir()` 的受控返回值，不把环境变量推断为该返回值。
- Herdr 只描述 release build；分别记录配置文件 F、配置目录 C 和状态目录 S。`HERDR_CONFIG_PATH` 只覆盖 F；XDG 两根独立；Windows 保留 APPDATA/LOCALAPPDATA → USERPROFILE → HOME → temp fallback 的区别。空值及字面 `~` 是原生规则。拒绝 temp fallback 是另列的 Agent Stack 计划策略，相对覆盖的具体处理尚待定。
- Pi 非空 agentDir 覆盖、空值 fallback、前导 `~`、Windows/WSL 分开；全局 home `.agents/skills` 独立于 agentDir；session CLI/env/settings 单独选择。相对 agentDir 的 `getAgentDir()` 返回值仍为相对值，不给它虚构 cwd 归一化。
- Windows fixture 统一用 `/` 表达目标路径身份，便于审阅，不承诺 Rust/Node 输出的分隔符拼写。未来 consumer 须按原生语义比较并在 Windows 实跑；当前这些案例没有执行覆盖。
- Otty 仅记录文档已确认的主/本机位置和后者的覆盖规则。普通对象形式的 `main`/`local` 是有效值输入，不代表通用 TOML parser 能处理它的宽松语法、重复键与 reset marker。XDG/APPDATA、完整状态/socket、Windows 发行支持保持待补证据，不能从其他工具推断。

后续由真实 Herdr 配置/状态 adapter 消费 F/C/S fixtures；Pi 资源 adapter 消费 agentDir、home skills，启动/session adapter 消费独立 session-dir；Otty 先固定 build 与路径/语法证据再接入。接入时应将对应 TODO 替换为对生产消费者的断言，同时保留未知项和平台验收限制。`pending-policy` 没有精确定案的产品行为，`pending-evidence` 没有足够上游证据，两者都不应转成通过断言。

## 本地运行

```sh
pnpm build
node --test test/path-boundaries.test.mjs test/path-native-contracts.test.mjs
pnpm check
```

默认测试不联网、不安装第三方 Agent、不启动用户 server、不读取真实 home、认证或会话。官方源码仅用于人工核对 fixture，执行测试不需要访问来源 URL。完整检查仍包含原有 Unix fixture 的开发环境依赖，见 [开发说明](development.md)。
