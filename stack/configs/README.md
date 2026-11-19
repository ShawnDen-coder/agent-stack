# 原生共享配置

这里按工具建立子目录，保存需要通过 Git 同步的原生配置，例如 `pi/settings.json`、`herdr/config.toml`。coding setup 写入三个 checkout skill 的路径、Herdr 的更新配置和官方 Pi 状态扩展。

- 来源与共享默认值保存在 Git；设备覆盖和应用状态留在本机。
- token、OAuth、会话、缓存与带凭证的 registry 配置不进入此目录。
- 部件来源、平台、版本选择和集成关系分别放在 `stack/components/`、`stack/profiles/`、`stack/integrations/`。
- 预览、字段归属与旧版配置迁移见 [Quickstart](../../docs/quickstart.md)。
