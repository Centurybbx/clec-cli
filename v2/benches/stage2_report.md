# Stage 2 真实 CLEC 验收

`build`、`search`、`outline`、`read`、`stats` 已在 `refactor/v2-tantivy` 通过真实语料联调。Stage 1 修订 `075f410` 的 50,646 段、2,817 作品、5,359 来源和 60 组同义词全部用于本次建库。测试机为 Apple M1 Pro，macOS 26.4.1，Rust 1.93.0。MB 按 1,000,000 字节计算。

| 验收项 | 实测 | 门槛 |
| --- | ---: | ---: |
| `v2/src/` Rust 源码 | 2,365 行，不含单元测试。含单元测试共 2,461 行 | ≤ 2,500 行 |
| Release 测试 | 12/12 通过 | 全绿 |
| Clippy `-D warnings` | 0 警告 | 0 |
| 引擎 CLEC 专属词或路径 grep | 0 命中 | 0 |
| Release 二进制 | 10,545,616 B | ≤ 20 MB |
| 完整归档 | 42,378,462 B | ≤ 90 MB |
| 外部查询进程 p50 / p95 | 16.045 / 19.081 ms | ≤ 30 / 60 ms |
| 独立分词词面命中 | 749/750（99.87%） | ≥ 90% |
| 模板污染 | 0/750（0%） | < 0.5% |
| `0555` 解包索引并发 | 8/8 退出 0 且 JSON 可解析，索引文件 SHA-256 一致 | 8/8 |
| 检索 ID 管道精读 | 15/15，输入次序一致 | 两端退出 0 |
| 真实边界回归 | 20/20 通过 | 20/20 |
| `cli-agent-lint` 0.3.5 | A（90.16%），28 项通过，6 项信息级建议 | A |

## 构建与检索

全语料建库、强制单段合并和归档共 5.76 秒。归档通过 `zstd -t`，解包后的 Tantivy 元数据确认一个包含 50,646 段的 segment。快照根目录保存语料 `meta.json` 和 `synonyms.json`，Tantivy 文件位于 `index/` 子目录。这个布局区分了语料元数据与 Tantivy 同名元数据。旧版平铺 Tantivy 索引仍可查询，`stats` 需要新版语料元数据。Stage 0 的 DuRetrieval 构建输入含空标题，复跑其完整建库基准应使用 Stage 0 提交 `b3b3094`。

复用预编译 FST Jieba、zhconv、`WithFreqs`、DocStore Zstd 9 / 64 KB 和归档 Zstd 9。每路保持 BM25 全 OR 与查询词频加权。同义词归一后在匹配的词元组内以 0.5 倍权重展开，多词等价项要求各词元出现。并行取每路 Top 100，以一基排名做 RRF，再乘质量系数并将每个作品的超额命中移至队尾。`total` 为融合候选的去重总量，最多 400。以 `--brief` 或 `--ids-only` 可取得相同的逐行 ID 输出。

真实语料的 `ep-00123` 摘要段落将 `summary` 列在自身的 `other_kinds` 中。检索结果透传该值，`outline` 根据实际索引记录列出逐字稿与摘要两个来源。`snippet_only` 段落在 `read` 中返回最多 550 字节的纯文本预览，对目标和相邻段落一致生效。

## 摘录与延迟测法

[Stage 2 基准脚本](stage2.py) 固定 25 个短关键词和 25 条无空格长问句，每条新建一个外部进程，以默认上限返回 15 条。正式计时前运行 10 次热身。wall time 覆盖进程启动、索引打开、查询、摘录、序列化和 stdout 收完。p50 取中位数，p95 取最近秩。

| 查询形态 | 样本 | 最小（ms） | p50（ms） | p95（ms） | 最大（ms） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 短关键词 | 25 | 10.048 | 12.874 | 19.081 | 22.975 |
| 无空格长问句 | 25 | 13.223 | 16.713 | 18.887 | 25.508 |
| 合计 | 50 | 10.048 | 16.045 | 19.081 | 25.508 |

独立评分使用 Python Jieba 0.42.1 与 OpenCC `t2s`，对查询和实际摘录做 NFKC、大小写折叠、繁简和词元归一，并检查来自查询或同义项的词元是否出现在摘录中。`highlights` 单独核查，750/750 条均含原文高亮，且每个高亮都在对应摘录内。750 条均为最多 550 UTF-8 字节的纯文本。651 条取自正文，88 条取自标题，11 条取自小节标题。正文没有命中词元时，依次尝试小节标题和标题，`snippet_field` 标注来源。全量测试使用 Stage 1 的网页模板正则，零命中。

完整短语和人工主题词采用更严格的额外统计。短查询要求完整关键词或等价项，长问句要求至少一个预先列出的主题词。该口径为 **586/750（78.13%）**，低于 90%。全 OR 允许复合查询仅命中其中的一个词元，尤其常见于「最大回撤」和「资产质押」。这项统计保留在逐条结果的 `topical` 字段中。

## 复现

从仓库根目录运行。使用新的临时目录可以在复跑时保留原始产物。

```sh
set -e
set -o pipefail
mkdir -p /tmp/clec-v2-real
root=$(mktemp -d /tmp/clec-v2-real/recheck.XXXXXX)
corpus=/Users/century/Vibing/clec-corpus
bin=v2/target/release/clec

cargo build --release --manifest-path v2/Cargo.toml
cargo test --release --manifest-path v2/Cargo.toml
cargo clippy --all-targets --manifest-path v2/Cargo.toml -- -D warnings
cargo fmt --manifest-path v2/Cargo.toml -- --check
awk 'FNR == 1 { testing = 0 } /^#\[cfg\(test\)\]/ { testing = 1 } !testing { count++ } END { print count }' v2/src/*.rs
if grep -iErn 'clectw|clec168|cfnavi|james' v2/src; then exit 1; fi

/usr/bin/time -p "$bin" build \
  --input "$corpus/dist/corpus.jsonl" --meta "$corpus/dist/meta.json" \
  --synonyms "$corpus/config/synonyms.json" --output "$root/index" \
  --pack-zst "$root/corpus.tar.zst"
wc -c "$bin" "$root/corpus.tar.zst"
zstd -t "$root/corpus.tar.zst"
mkdir "$root/readonly"
tar -xf "$root/corpus.tar.zst" -C "$root/readonly"
chmod -R a-w "$root/readonly/index"
chmod 0555 "$root/readonly/index" "$root/readonly/index/index"

export CLEC_INDEX_DIR="$root/index"
"$bin" search "退休 提领" --ids-only | "$bin" read --stdin --context 1 > "$root/pipeline.json"
jq '.passages | length' "$root/pipeline.json"
python3 v2/tests/clec_regression.py --binary "$bin" --index "$root/index" \
  --corpus "$corpus/dist/corpus.jsonl"
UV_CACHE_DIR="$root/uv-cache" uv run --no-project --python 3.12 \
  --with jieba==0.42.1 --with opencc-python-reimplemented==0.1.7 \
  python v2/benches/stage2.py --binary "$bin" --root "$root" --corpus-repo "$corpus" \
  > "$root/benchmark.json"
jq .summary "$root/benchmark.json"

GOBIN="$root/tools" go install github.com/Camil-H/cli-agent-lint@d0d9e326e350dab007dd8d4cde04edeafcc6ca66
"$root/tools/cli-agent-lint" check "$bin" --output json > "$root/cli-agent-lint.json"
jq '.score' "$root/cli-agent-lint.json"
```

本次实测的索引、归档、逐条基准结果和 linter 原始报告保存在 `/tmp/clec-v2-real/`。另用真实伪终端验证 `search` 和 `read --range` 的人类可读格式，并用缺失路径和损坏的语料元数据验证退出码 3 与 stderr JSON。
