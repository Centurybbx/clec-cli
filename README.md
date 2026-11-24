# clec

极简、极速、离线、通用的本地知识库检索 CLI（基于 Tantivy + 编译期 FST Jieba + `zhconv`），面向 AI Agent 一等公民设计。

## 安装

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Centurybbx/clec-cli/main/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Centurybbx/clec-cli/main/install.ps1 | iex
```

安装脚本会下载当前平台的二进制、校验 SHA-256，安装到 `~/.local/bin/clec`（macOS/Linux）或 `%LOCALAPPDATA%\clec\bin\clec.exe`（Windows），安装 Agent Skill，并自动运行 `clec sync` 准备索引。设置 `CLEC_SKIP_SYNC=1` 可跳过同步，`CLEC_INSTALL_DIR=/path` 可自定义安装目录，`CLEC_VERSION=v0.2.0` 可固定版本。

## 同步索引

```sh
clec sync           # 下载或更新到最新索引包
clec sync --check   # 只对比版本，不下载
clec sync --force   # 强制重新下载
```

`clec sync` 校验 SHA-256、安全解包并原子替换索引，支持多镜像回退与断点续传；`search`、`outline`、`read`、`stats` 始终离线只读，网络只用于 `sync`。同步失败退出码为 `5`。

## 特性

- **通用引擎**：不含任何特定语料硬编码，任何符合标准 JSONL 契约的数据包都可用 `clec build` 编译并检索。
- **极速离线只读**：编译期将 Jieba 词典预编译为 FST，单次外部进程查询（含冷启动、BM25、摘录与高亮）仅约 14–16 ms；自定义 `ReadOnlyDirectory` 确保只读并发零锁冲突。
- **繁简互通与精准摘录**：`cjk_norm` 分词器在词元级执行 NFKC、大小写折叠与 `zhconv` 繁简归一，并精确投影回原文 UTF-8 字节区间，高亮永不越界。
- **多路融合排序**：支持 1–4 路并行查询 + RRF 融合 + 同义词扩展 + 质量加权 + 按作品折叠。
- **Agent 一等公民**：非 TTY 自动输出紧凑 JSON、零 ANSI 颜色、确定性退出码（`0`/`2`/`3`/`4`/`5`）、支持 `--ids-only | clec read --stdin` 管道，附精简操作手册 [skills/clec/SKILL.md](skills/clec/SKILL.md)。

## 快速开始

```sh
# 构建与测试
cargo build --release
cargo test --release
cargo clippy --all-targets -- -D warnings

# 从标准语料包构建索引
./target/release/clec build \
  --input ../clec-corpus/dist/corpus.jsonl \
  --meta ../clec-corpus/dist/meta.json \
  --synonyms ../clec-corpus/config/synonyms.json \
  --output ~/.local/share/clec/index

# 检索、目录、精读与统计
./target/release/clec stats
./target/release/clec search '4%法则' '安全提領率' --limit 5
./target/release/clec outline ep-00123
./target/release/clec read --work ep-00123 --range 02:00-03:00 --context 1
```

更多本地测试示例见 [LOCAL_TESTING_GUIDE.md](LOCAL_TESTING_GUIDE.md)。
