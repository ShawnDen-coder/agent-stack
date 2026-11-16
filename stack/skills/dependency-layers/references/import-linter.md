# Import Linter 映射

完整契约以 [共享规范](contract.md) 为准。以下配置对应可导入的 `example` package，直接子 package 为 `l1`、`l2`、`l3`；L1/L2 各有 `api.py` 和 `internal.py`。

## 相邻层与公共入口

```ini
[importlinter]
root_package = example
include_external_packages = True
exclude_type_checking_imports = False

[importlinter:contract:direction]
name = Downward dependencies
type = layers
containers = example
layers =
    l3
    l2
    l1
exhaustive = True

[importlinter:contract:l1-callers]
name = L1 direct callers
type = protected
protected_modules = example.l1
allowed_importers = example.l2

[importlinter:contract:l2-callers]
name = L2 direct callers
type = protected
protected_modules = example.l2
allowed_importers = example.l3

[importlinter:contract:l1-private]
name = L1 internals
type = protected
protected_modules = example.l1.internal
allowed_importers = example.l1

[importlinter:contract:l2-private]
name = L2 internals
type = protected
protected_modules = example.l2.internal
allowed_importers = example.l2

[importlinter:contract:cycles]
name = No sibling cycles
type = acyclic_siblings
ancestors =
    example.l1
    example.l2
    example.l3
```

`exhaustive` 确保该 container 的直接子模块都在层级中，层内后代继承归属。`layers` 不存在的模块会报错；不要把必需层写成可选的 `(l1)`。若真实项目有多个根、不同模块粒度或额外入口，分别配置范围与归属，不能用一个 container 声称覆盖所有代码。

此例的 `api.py` 是公共入口；`internal.py` 代表需保护的全部内部模块。真实项目必须列全内部范围，或采用明确的内部子 package；不要保护一个示例文件后声称其余私有文件已受保护。顶层和各层 `__init__.py` 保持无业务编排，并对其中的重导出运行边界案例。

`acyclic_siblings` 可以发现包聚合后的循环。还应使用 fixture 检查项目当前模块布局下文件循环是否都被覆盖，避免把父子模块关系误当作允许访问高层的理由。

## 精确例外

允许 `example.l3.read_only` 直接访问 `example.l1.api` 时，只在 `l1-callers` 中增加：

```ini
ignore_imports =
    example.l3.read_only -> example.l1.api
unmatched_ignore_imports_alerting = error
```

这条边仍受方向和内部入口规则检查。验证换成另一个 L3 文件或 L1 内部文件仍失败。例外未被使用时提示清理，不把相同 ignore 复制到所有 contract。

## L0

对实际使用的 SDK 另加 `protected`，例如目标项目使用 `external_client` 时：

```ini
[importlinter:contract:client-callers]
name = External client direct callers
type = protected
protected_modules = external_client
allowed_importers = example.l1
```

包名必须来自真实依赖和导入图。`include_external_packages = True` 使检查器包含外部 package。标准库、反射和运行时工具调用的覆盖需单独核实；不要把导入约束等同于运行时 I/O 隔离。

## 执行与范围

Import Linter 2.16 的此配置可能漏报源码中无法解析的内部导入：例如 `from example.missing import UNKNOWN` 仍可能使所有 contract 通过。C10 的 missing-layer 负例只证明配置声明的模块名存在性，不证明检查了源码 unresolved import。配合目标项目已有的导入解析或类型检查，在临时 fixture 中加入不存在的内部模块，确认该检查确实以非零退出阻塞；不能通过执行任意业务模块导入来验证，以免触发 I/O。若没有能覆盖该情况的检查，明确报告 DL-05 的缺口。

使用目标项目已锁定的开发依赖，从 package 可被发现的项目目录运行。例如 uv 项目：

```sh
uv run lint-imports --config .importlinter --no-cache
```

已有配置时在原位置合并，不同时创建会互相覆盖的 `.importlinter` 和 `pyproject.toml` 配置。配置完成后把同一命令接入目标项目的正常检查与 CI。不要忽略退出码，或把只检查一个 contract 的结果描述为全套通过。

官方依据：[Layers](https://import-linter.readthedocs.io/en/stable/contract_types/layers/)、[Protected](https://import-linter.readthedocs.io/en/stable/contract_types/protected/)、[Acyclic siblings](https://import-linter.readthedocs.io/en/stable/contract_types/acyclic_siblings/)。
