# CLEC 本地证据工具（Native CLI）

CLEC 为能执行本地命令的 Agent 提供 `clec-native-v2` 资料检索、原文逐字节读取与来源导航。消费者使用原生二进制执行离线检索，无需模型密钥、向量模型、本地服务或运行时 Node.js / Python。

当前本地开发版本为 `1.0.0-dev.0`（对应原生包 `clec-native` 与 `@clec/cli`）。原 TypeScript Node CLI 源码已由 `native/` 原生二进制与 `cli/` 原生打包体系替代；历史发布记录（`0.2.0`、`0.3.0`）、旧后端与原始语料仍保留在仓库中。仓库记录的 `Centurybbx/clec-cli` 元数据与公开发布许可尚未完成当前权限与法务核验，当前未配置默认公开清单地址（`defaultConfigured: false`，`providerVerified: false`）。

## 安装与使用

本地测试可使用 `cli/scripts/stage.mjs` 生成的本地 npm 安装包或对应平台直出归档：

```sh
npm install --global /path/to/staged/clec-cli-1.0.0-dev.0.tgz
clec --version
clec schema
clec sync --manifest /absolute/path/to/release/manifest.json
clec search '退休 提領' --offline
clec sources '退休' --canonical-only
clec read '<PassageId>' --context 1
clec read '<SourceId>' --original --find '每年提領'
```

默认数据目录为 `~/.local/share/clec/native-v2`（Unix）或 `%LOCALAPPDATA%\clec\native-v2`（Windows，备选 `%USERPROFILE%\AppData\Local\clec\native-v2`）。可通过 `--data-dir` 或非空 `CLEC_DATA_DIR` 覆盖。含旧版 `current` 标记的目录会被明确拒绝以防误删旧缓存。禁止在禁用 lifecycle scripts（`--ignore-scripts`）的情况下依赖 npm 占位入口，请改用对应平台直出归档。

Agent 检索规范见分发 Skill [cli/skills/clec/SKILL.md](cli/skills/clec/SKILL.md) 与指针说明 [cli/docs/agent-guide.md](cli/docs/agent-guide.md)，完整安装及边界见 [CLI README](cli/README.md)。

## 构建与打包（维护者）

```sh
cargo build --manifest-path native/Cargo.toml --locked --release --bins
cargo test --manifest-path native/Cargo.toml --locked
npm test --prefix cli
```

维护者打包工具 `clec-publish` 与 `clec-validate` 生成独立维护者归档，不进入消费者安装包。阶段门禁与核验记录见 `docs/agent-work/clec-native/`。
