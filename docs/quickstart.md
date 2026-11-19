# 从源码启动 coding

在原生 macOS Apple Silicon 或 Intel 上，checkout 中的共享锁已经选定 Pi 1.5.2、Herdr 0.9.5、pnpm 12.15.0 和 uv 0.13.8。首次 setup 需要 Git、Node.js 24+、npm 11.12.1 和网络。CLI 自身用 pnpm 构建。

## 构建并检查共享锁

PR 合入前，从包含该功能的分支获取源码。在终端运行：

```sh
git clone --branch p0-final-acceptance https://github.com/ShawnDen-coder/agent-stack.git
cd agent-stack
node --version
npm --version
npm exec --yes --package=pnpm@12.15.0 -- pnpm install --frozen-lockfile
npm run build
export AGENT_STACK_REPO="$PWD"
node "$AGENT_STACK_REPO/dist/cli.js" validate --repo "$AGENT_STACK_REPO" --lock
```

临时的构建用 pnpm 只在该 npm exec 子进程中进入 PATH。校验应显示 4 个部件、1 个集成、1 个 profile、2 个目标和 10 个资产。首次使用直接消费仓库中的锁。

## 准备设备

```sh
mkdir -p "$HOME/.agent-stack/bin"
export PATH="$HOME/.agent-stack/bin:$PATH"
node "$AGENT_STACK_REPO/dist/cli.js" setup --repo "$AGENT_STACK_REPO" --profile coding --dry-run
node "$AGENT_STACK_REPO/dist/cli.js" setup --repo "$AGENT_STACK_REPO" --profile coding
node "$AGENT_STACK_REPO/dist/cli.js" doctor --repo "$AGENT_STACK_REPO" --profile coding
```

先检查计划显示的路径与变更，再在 setup 中确认。工具经过锁定资产校验，Pi/Herdr 状态集成通过后才绑定当前 checkout。若报告发现用户自行安装的 Pi 或 pnpm，先查看计划中的路径。可使用独立的 shell PATH，仅提供受管 bin、已验证的 Node/npm、Git 及系统命令。原有安装无需卸载。运行模型的凭证由设备上的 Pi 管理。

## 在业务目录启动

在同一个 shell 中切换到要工作的业务项目目录，运行 `herdr`。在它的活动 pane 中，确认 `pwd` 是业务目录，再执行：

```sh
node "$AGENT_STACK_REPO/dist/cli.js" run coding --cwd "$PWD"
```

Pi 从配置 checkout 加载 coding Agent 和 `shape`、`implement`、`verify`，在当前业务目录工作。若 pane 使用其他登录环境，请在其中重新设置上述两个环境变量，或直接使用配置 checkout 内 `dist/cli.js` 的绝对路径。

## 从之前的配置迁移

更新 checkout 并重新构建后，预览并运行 setup。新默认配置只引用三个项目 skills 与 Herdr 状态集成。对于此前由本项目导入的扩展声明、角色偏好、模型默认值与 Reui 项，setup 仅撤回同一目标路径中仍与旧回执匹配的部分。用户新增或改动的值和扩展安装目录留在设备上。配置修改沿用原有备份与中断恢复流程。若 checkout 中已有本地生成的 `stack/stack.lock.json` 阻止 Git 更新，先将旧锁另存以便比较，再更新 checkout；本版本使用随仓库提供的双架构锁。

[架构与分工](architecture.md) · [锁的来源与更新](../test/fixtures/coding-lock/README.md) · [开发与分发](development.md) · [Windows x64 Herdr 单工具验收](herdr-windows-smoke.md)
