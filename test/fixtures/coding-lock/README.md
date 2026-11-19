# 默认 coding 锁的来源与更新

[共享锁](../../../stack/stack.lock.json) 使用生产 CLI `lock` 真实解析生成，记录的目标为 `darwin-arm64` 和 `darwin-x64`。本次生成于 **2026-11-16 22:46:25 UTC**，基于提交 `4c9a996e768b6fad28fe3dc947302c1a6e237a68`，运行 Node.js **24.15.0**（锁内的 Node 解析假设）；后续安装仍检查实际外部 Node 和包 engines。[默认 profile](../../../stack/profiles/coding.yaml) 固定 Pi 1.5.2、pnpm 12.15.0、uv 0.13.8、Herdr stable 及全部 coding 能力。

最初在临时 checkout 中使用这份 profile 生成。现在它和对应的锁已成为用户与 CI 共用的默认配置。重新生成候选时仅在临时 checkout 移出旧锁：

```sh
node --import "$metadata_preload" dist/cli.js lock --repo "$temporary_repo" --profile coding --target darwin-arm64 --target darwin-x64 --json
node dist/cli.js validate --repo "$temporary_repo" --lock --json
```

`metadata_preload` 仅将 `https://herdr.dev/latest.json` 固定为仓库已有的 [Herdr 0.9.5 官方 manifest 快照](../herdr-release/v0.9.5.json)；uv 的 GitHub release 和分页 metadata 均真实联网解析，npm metadata 来自官方 registry。生成时没有使用认证 token。生产 CLI 校验结果为 `valid: true`，覆盖 2 个目标与 10 个资产；CLI 输出经过 Biome 格式化，JSON 内容未改写。格式化后锁文件 SHA-256 为 `3af2abd9f989beb6b544fa69f0dff85a952a0f0758d96b02f15e09133ab52736`，与 `scripts/lib/coding-fixture.mjs` 的校验值一致。

维护者可先 `pnpm build`，再用以下命令在不存在的路径生成并离线校验新候选；脚本不会覆盖现有文件：

```sh
node scripts/refresh-coding-fixture.mjs --out ./coding-lock-candidate.json
```

可选环境变量 `AGENT_STACK_TEST_GITHUB_TOKEN` 仅在 lock 的 uv GitHub API 首页面和已验证数字仓库分页路径使用，不传给 validate、setup、npm 或 SEA；不要把 token 写入仓库。审查候选的来源、版本、资产和差异后再更新共享锁；格式化 JSON、重新计算 SHA-256 并同步 `codingLockSha256`。若官方来源、摘要或校验失败，保留失败并调查，不手填锁。

CI 每次直接校验 checkout 中的共享锁、真实下载并验证发行资产、执行 setup 和 Pi/Herdr TUI，再检查幂等、doctor 与 run；它**不在每次安装 smoke 中重新解析在线版本目录**。此 fixture 的历史 metadata 解析证据与每次 CI 的实际资产安装和运行证据是不同的；锁不固定 npm 的完整传递依赖闭包，也不是发布者签名证明。

原失败证据：PR 的 ARM64 SEA job `133651413594` 在 metadata-only `lock` 返回的部分 `resolution-report` 中报告 uv `Release metadata request timed out`，Pi、pnpm 和 Herdr metadata 已解析，uv 资产因版本元数据缺失不可用；该 job 尚未进入 setup。这个网络/metadata 失败不是实际资产安装失败，也不能证明生产 resolver 的所有路径无问题。生产 resolver 和其测试仍保留，不针对部分报告扩大重试。
