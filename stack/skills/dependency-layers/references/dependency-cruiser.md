# dependency-cruiser 映射

完整契约以 [共享规范](contract.md) 为准。以下样例用于 `src/l1`、`src/l2`、`src/l3` 各为一个模块的项目，L1/L2 的公共入口为 `api.ts`。真实项目先替换路径与模块边界，再配置引用。

## 检查器兼容性

先检查当前依赖版本和报告中的 `summary.environment`，不能只看退出码。实测 dependency-cruiser 18.7.2 要求 TypeScript 编译器小于 7；搭配 TypeScript 7.0.2 时可能输出空图并返回 0。覆盖脚本会拒绝环境警告与遗漏的源码。

目标项目采用 TypeScript 7 时，保留其编译器版本。选择已经验证的兼容检查器或独立的分析环境，并用目标语法的正反例验证解析范围；不要静默降级项目编译器，也不要直接把分析环境的样例成功描述为整个 TypeScript 7 项目通过。

## 直接依赖允许矩阵

```javascript
// .dependency-cruiser.cjs
module.exports = {
  allowedSeverity: "error",
  allowed: [
    { from: { path: "^src/l1/" }, to: { path: "^src/l1/" } },
    { from: { path: "^src/l2/" }, to: { path: "^src/l2/" } },
    { from: { path: "^src/l3/" }, to: { path: "^src/l3/" } },
    { from: { path: "^src/l2/" }, to: { path: "^src/l1/api\\.ts$" } },
    { from: { path: "^src/l3/" }, to: { path: "^src/l2/api\\.ts$" } },
    {
      from: { path: "^src/l1/" },
      to: { dependencyTypes: ["core", "npm", "npm-optional", "npm-peer"] },
    },
  ],
  forbidden: [
    {
      name: "no-file-cycles",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolved-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-folder-cycles",
      severity: "error",
      scope: "folder",
      from: { path: "^src/" },
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
  },
};
```

本例在层内部允许引用实现，因为每层只有一个模块。若一层有多个独立模块，拆分 `from` / `to` 范围，分别列出各公共入口；不要沿用整层内部互通的规则。样例同时检查文件循环与目录聚合循环；当真实模块边界与物理目录不同，还须按模块归属检查聚合图。

L1 的外部依赖还要受目标项目声明的依赖清单与访问范围约束。此例允许 L1 使用生产 npm 包与 Node 内建模块；它不代替 core 无 I/O 等职责规则。不要向所有层放行所有外部包，也不要用 `exclude: "node_modules"` 丢掉需检查的 L0 边。`doNotFollow` 保留目标节点但不遍历第三方内部。

## 例外与 L0 通用库

允许 `src/l3/read-only.ts` 直接引用 `src/l1/api.ts` 时，在 `allowed` 中添加精确边，并用 `comment` 记录理由：

```javascript
{
  from: { path: "^src/l3/read-only\\.ts$" },
  to: { path: "^src/l1/api\\.ts$" },
  comment: "只读场景复用基础契约，保留内部实现和无环限制",
}
```

通用库按消费者增加类似的精确允许项。外部节点路径要从实际报告中取得，不能假定 pnpm 的安装路径或直接把包名当正则。核对依赖类别，并确认开发依赖没有被生产代码消费。例外不会覆盖 `forbidden` 中的循环或其他禁止规则。

## 执行与范围覆盖

先用目标项目包管理器安装并锁定开发依赖，再添加命令。例如 pnpm 项目：

```sh
pnpm exec depcruise --config .dependency-cruiser.cjs --output-type err src
pnpm exec depcruise --config .dependency-cruiser.cjs --output-type json src
```

将同一配置用于正常检查与 CI，保留非零退出码。`err` reporter 在规则错误时返回非零；JSON reporter 可能在已有违规时仍返回 0，必须检查 `summary.error` / `summary.advisedExitCode`。覆盖脚本会拒绝含错误的报告。JSON 用于核对解析后的节点、边、例外及覆盖，不把报告生成成功当成规则通过。

`allowed` 只判断依赖边，无法单独发现没有任何边的未归层文件。接入时还须将**实际生产源码清单**与 JSON 中的节点核对，并检查每个源码文件恰好属于一个声明模块、每个必需模块非空。

本 skill 的 `scripts/check-layer-coverage.mjs` 完成这项核对。先确认 dependency-cruiser 退出成功，并将 JSON 报告保存到目标项目临时产物目录，再从项目根调用脚本。例如三个模块各自占一整层时：

```sh
node /path/to/skill/scripts/check-layer-coverage.mjs report.json src src/l1 src/l2 src/l3
```

真实项目传入全部**互不重叠的模块根目录**，不只传层目录；每个源码文件应属于且只属于一个模块。脚本检查 JS/TS 的 `.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` 文件，包括 `.d.ts`，拒绝环境警告、空源码、空模块、重复归属、未归层文件、图中遗漏的源码以及未明确处理的源码软链接。Vue/Svelte 等额外源码格式或单文件模块归属须适配后另验，不能直接声称已覆盖。

将脚本随项目采用的配置一起维护，或由复制的 skill 目录引用；不要提交本机绝对路径。CI 中先运行依赖规则，再运行覆盖检查，任一步失败均阻塞。用 C09 验证孤立新文件确实导致失败。

路径别名、NodeNext `.js` specifier 和静态动态导入都用真实源码 fixture 验证。不能静态解析的运行时加载单列缺口，不能靠宽泛 ignore 掩盖。参考配置不会自动对目标源码划层或启用检查命令。

官方依据：[规则与 allowed](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)、[TypeScript 与过滤选项](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md)。
