# 技术栈与开发

首版采用单包 TypeScript CLI。开发使用 pnpm，分发目标为 npm；使用者运行编译后的 JavaScript，无需安装 TypeScript 编译器。

## 技术选择

| 部分                       | 选择                           | 原因                                                        |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Runtime                    | Node.js 24+，ESM               | 使用受支持的 LTS 基础，跨 macOS、Windows、Linux 运行        |
| Language                   | TypeScript 7，strict           | 对命令、数据与 adapter 边界做静态检查                       |
| Build                      | 官方 `tsc`，NodeNext           | 当前直接编译即可，保留原生 ESM 与目录关系                   |
| CLI                        | Commander 15                   | 处理子命令、参数、帮助、错误与退出码                        |
| Runtime validation         | Zod 4                          | 校验 Git 中的 JSON，类型从 schema 推导                      |
| Repository package manager | pnpm 12.15.0                   | 开发依赖使用确切版本和提交的锁文件                          |
| Tests                      | Node.js `node:test` + `assert` | 从编译后的真实 CLI 验证行为，当前无需额外 runner            |
| Format / lint              | Biome 2                        | 统一 TypeScript、JavaScript 与 JSON 检查                    |
| CI                         | GitHub Actions                 | Node 24/26 × Linux、macOS、Windows 检查；Action 固定 commit |

所有 npm 依赖使用确切版本，传递依赖由 `pnpm-lock.yaml` 锁定。开发 pnpm 版本由 `packageManager` 固定；这与 profile 中将来安装到用户环境的 pnpm 要求分别维护。

Node 24 与 26 当前均为 LTS，见 [Node 发布计划](https://nodejs.org/en/about/previous-releases)。编译选项参考 [TypeScript Node ESM 指南](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)；校验与测试使用 [Zod](https://zod.dev/) 和 [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)。

## 本地命令

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm cli validate --repo . --json
pnpm check
```

| 命令                                        | 行为                                       |
| ------------------------------------------- | ------------------------------------------ |
| `pnpm build`                                | 编译 `src/` 到 `dist/`                     |
| `pnpm cli --help`                           | 运行已编译的 CLI；源码变化后先 build       |
| `pnpm cli doctor --repo . --profile coding` | 只读检测部分工具链；先 build               |
| `pnpm validate`                             | 从仓库根目录校验当前声明；先 build         |
| `pnpm typecheck`                            | TypeScript 只读检查                        |
| `pnpm lint`                                 | Biome 只读检查                             |
| `pnpm format`                               | 格式化支持的文件，不执行工具安装或配置应用 |
| `pnpm test`                                 | 构建后运行真实 CLI 边界测试                |
| `pnpm check`                                | lint、类型、测试、仓库声明检查             |

测试使用临时目录和 `process.execPath`，不依赖 Bash 展开命令或本机安装 Pi/herdr/Rex。临时路径刻意含空格；测试结束清理自己的目录。

## 添加内容

1. 修改部件/组合/集成：维护对应 JSON，文件名与 `id` 一致，运行 `pnpm check`。
2. 修改 schema：先确认实际消费者与兼容方式，从 schema 推导类型，不维护第二份手写 interface。
3. 添加 adapter：外部 I/O 放入 `src/adapters/`，通过 command 组装；用临时目录或工具原生测试环境验证行为。
4. 添加 CLI 命令：只注册真实可用的能力。当前帮助中不会显示尚未实现的安装/升级命令。
5. 修改配置应用：先定义文件/字段归属、冲突和恢复行为，再实现写入。

## 打包与发布

当前 `private: true`、`license: UNLICENSED`，尚未确定 npm 发布名称和授权；不运行 publish。可以本地检查包内容：

```sh
pnpm build
npm pack --dry-run --ignore-scripts
```

包只分发 CLI 代码，checkout 中的原生配置、profile 和 skills 继续走 Git。发布前另行确定名称、授权、发布检查和版本策略。

## 多系统验证

CI 覆盖六组 OS/Node 组合，但只有运行后的结果才算证据。它验证构建、定义校验和 CLI 行为，尚不安装外部工具，也不证明各部件原生集成通过。

后续增加实际安装/应用时，需要分别验证 Windows 原生与 WSL，并覆盖已有工具、多个 PATH 候选、本地修改、重复应用、失败重试和恢复。不能把 Linux runner 等同于 WSL，也不能通过删除能力要求掩盖替换后的缺口。

`doctor` 以独立临时目录运行固定版本查询，限制 3 秒和 16 KiB 输出；不继承凭证环境变量。pnpm 和 Pi 不执行，只有入口匹配 npm package metadata 时报告声明版本。Windows 批处理入口不执行；标准 cmd-shim v8 / v9 的 Node 和直接目标模板在入口、目标和包元数据均匹配时可静态核对。Node 自带动态 prefix 的 npm.cmd、Corepack 和其他包装器为未核对。该检测不证明集成可用。

入口依据：[npm cmd-shim v8](https://github.com/npm/cmd-shim/blob/v8.0.0/lib/index.js) 与 [当前 cmd-shim](https://github.com/npm/cmd-shim/blob/main/lib/index.js) 的完整模板；[Node 自带 npm.cmd](https://github.com/nodejs/node/blob/main/deps/npm/bin/npm.cmd) 使用动态 prefix；[Corepack](https://github.com/nodejs/corepack) 可能解析并下载工具；[Pi manifest](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json) 声明其 bin；[pnpm 发行 manifest](https://github.com/pnpm/pnpm/blob/main/pnpm/npm/pnpm/package.json) 与安装脚本说明入口可替换。本地另核对 `@pnpm/exe@12.15.0` 官方 tarball：manifest 的 `bin.pnpm` 为 `pnpm`，发行入口可在安装时被替换。元数据只证明声明，不证明入口可运行或安装渠道。
