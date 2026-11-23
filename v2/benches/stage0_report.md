# Stage 0 技术验证

**Go。** DuRetrieval 全量相关性超过 Jieba BM25 基线，2,000 条查询均有命中。200 个独立进程各返回 15 条摘录，热态 p50 为 13.972 ms。60,000 段、平均 600 字的归档外推为 77.033 MB。体积结论使用 DuRetrieval 实测密度，真实 CLEC 语料的归档体积留待 Stage 2 验证。

| 验收项 | 首轮 | 修订后 | 门槛 |
| --- | ---: | ---: | --- |
| Jieba 首次初始化 p50 | 112.009 ms | 0.001125 ms | ≤ 5 ms |
| 热态独立进程 p50 | 133.031 ms | 13.972 ms | ≤ 35 ms |
| 全量零命中 | 1/2,000 | 0/2,000 | < 1% |
| 全量 NDCG@10 | 0.5797701945 | 0.5950204280 | ≥ 0.5938015876 |
| 全量 Recall@100 | 0.7343905740 | 0.7799985469 | ≥ 0.7777173891 |
| 原文偏移与高亮 | 50/50 | 50/50，0 panic | 50/50 |
| Release 二进制 | 9.402 MB | 10.041 MB | ≤ 20 MB |
| 60,000 段、平均 600 字的归档外推 | 113.534 MB | 77.033 MB | ≤ 90 MB |

## 环境与数据

Apple M1 Pro（6 个性能核、2 个效率核），16 GB RAM，macOS 26.4.1（25E253），Rust/Cargo 1.93.0，Apple Clang 21.0.0，Python 3.12.12。MB 按 1,000,000 字节计算。首轮和复验使用同一台机器。

三份 Parquet 均通过 LFS SHA-256 校验。使用原始 dev split 的 100,001 个唯一段落、2,000 个唯一查询及 9,839 条正相关标注。原始标题全部为空，正文与查询均原样保留。每个段落分配唯一的作品和来源，质量统一为 1。查询长度按 Unicode 码点计数，包含原有标点和空白。查询最短 3、最长 55、均值 9.289、中位数 9。有 1,892 条无 Unicode 空白，108 条带空白，118 条长度 ≥ 15。 [DuRetrieval 固定 revision 8d9b3d6](https://huggingface.co/datasets/mteb/DuRetrieval/tree/8d9b3d6a6a62b7fd2d4df0821d612366dc52d14e)

## 检索相关性

基线重跑使用 Python Jieba 0.42.1 精确模式（HMM 开启）和 BM25S 0.2.14 的 Lucene BM25（\(k_1=1.2, b=0.75\)）。它先做 NFKC 与 Unicode 大小写折叠，过滤不含任何字母或数字的词元。重跑的完整基线排序和首轮逐字节一致。两个系统使用同一套 qrels 和评估函数，按查询宏平均，未标注文档的相关性记为 0。零命中指没有返回匹配候选。

修订后的 Tantivy 使用 Jieba 精确模式与 HMM 对连续 Han 片段分词，保留 ZhHans 归一、字段权重 3/2/1，并按查询出现次数为词元加权。所有词元在一次 BM25 全 OR 检索中评分，最少匹配 1 项。此前两轮硬阈值分别限制 60% 和 35% 的词元匹配比例（短查询另有首轮门槛）。Stage 0 使用单路查询，语料无业务同义词。

| 范围 | 检索方案 | NDCG@10 | Recall@100 | 零命中 |
| --- | --- | ---: | ---: | ---: |
| 全量 2,000 条 | Python Jieba BM25 基线 | 0.5938015876 | 0.7777173891 | 0 |
| 全量 2,000 条 | 首轮 Charabia + 两轮硬阈值 | 0.5797701945 | 0.7343905740 | 1 |
| 全量 2,000 条 | 全 OR + 精简停用词（默认） | **0.5950204280** | **0.7799985469** | **0** |
| 全量 2,000 条 | 全 OR + 扩充疑问词 | 0.6033743342 | 0.7865845554 | 2 |
| 全量 2,000 条 | 全 OR + 无停用词 | 0.5936546554 | 0.7781039346 | 0 |
| 长度 ≥ 15，118 条 | Python Jieba BM25 基线 | 0.6102375675 | 0.8325409054 | 0 |
| 长度 ≥ 15，118 条 | 首轮 Charabia + 两轮硬阈值 | 0.5626687493 | 0.7423102086 | 0 |
| 长度 ≥ 15，118 条 | 全 OR + 精简停用词（默认） | **0.6132434990** | **0.8387555947** | **0** |
| 长度 ≥ 15，118 条 | 全 OR + 扩充疑问词 | 0.6121134212 | 0.8463221806 | 0 |
| 长度 ≥ 15，118 条 | 全 OR + 无停用词 | 0.6054927931 | 0.8268911879 | 0 |

精简停用词在全量和长查询上都超过两项基线，且符合零空结果目标。扩充表额外过滤「什么」「怎么」「怎样」「如何」「多少」等 15 个疑问词，取得最高全量均分，但「如何进猫」「什么叫路床」返回空结果，长查询 NDCG 也略低于精简表。无停用词的全量 NDCG 和长查询两项均低于基线。最终保留精简停用词。若精简停用词会滤掉整条查询，则保留原词元。不同四线程构建中同分项的先后可随段内文档顺序轻微浮动，表内各配置使用同一个最终单段索引。

## 外部进程延迟

使用 Python `perf_counter_ns()` 计时，从启动新进程至收完 stdout 并回收进程。每组先运行 10 个热身进程。查询按数据顺序等距选取，均使用 `search --limit 15`，含 BM25、DocStore 读取与摘录生成。p50 使用中位数，p95 使用最近秩。

| 查询方式 | 样本 | 最小（ms） | p50（ms） | p95（ms） | 最大（ms） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 首轮外部进程，最多 15 条摘录 | 200 | 119.040 | 133.031 | 163.560 | 233.749 |
| 修订后外部进程，同一组等距样本 | 200 | 7.995 | 9.778 | 14.106 | 16.333 |
| 修订后外部进程，每次正好 15 条摘录 | 200 | 9.857 | **13.972** | **20.564** | 32.634 |
| 首轮单进程，跳过 10 条热身 | 200 | 0.735 | 4.306 | 28.932 | 67.608 |
| 修订后单进程，每次 15 条，跳过 10 条热身 | 200 | 1.580 | 2.303 | 4.372 | 9.511 |

等距样本中，199 次返回 15 条，「陆子艺多少岁」返回 11 条。严格样本按原始顺序用首条未入选且含 15 个命中的查询补足，额外记录跳过的查询。两组的首次进程都查询「国家法定节假日共多少天」并返回 15 条。等距组首测 12.540 ms，严格组首测 80.495 ms。首测均在当组热身之前，系统页缓存未清空。严格组单进程整批含启动、热身、序列化和结束，共 586.558 ms。

严格组另以 `search --timings` 测 40 个独立进程，每 5 条抽 1 条。各阶段分位数分别计算。

| 外部诊断阶段 | 首轮 p50 / p95（ms） | 修订后 p50 / p95（ms） |
| --- | ---: | ---: |
| 外部总耗时 | 130.054 / 156.279 | 10.685 / 13.718 |
| 开始前与进程退出、序列化 I/O（外部耗时减去 `main` 已计时区间） | 7.498 / 8.876 | 4.380 / 6.615 |
| 参数解析等，至打开索引 | 0.083 / 0.102 | 0.079 / 0.091 |
| Tantivy 打开索引和 reader | 0.383 / 0.449 | 0.358 / 0.465 |
| Jieba 字典首次初始化 | 112.009 / 129.555 | 0.001125 / 0.001375 |
| zhconv 首次初始化 | 1.576 / 1.940 | 1.603 / 1.882 |
| 查询分词与停用词 | 1.231 / 1.552 | 0.049 / 0.199 |
| BM25 查询构造与检索 | 0.759 / 1.975 | 0.330 / 1.860 |
| DocStore 读取 | 0.463 / 1.186 | 1.087 / 2.570 |
| `SnippetGenerator` 初始化与生成 | 3.237 / 28.673 | 2.024 / 3.100 |

Jieba FST 首次打开的最大耗时为 0.001750 ms，首次词典查找计入查询分词。将字典初始化、zhconv 初始化和实际查询分词逐样本相加，p50/p95 为 1.687/2.278 ms，最大值 2.822 ms。扩大 DocStore 块后读取 p95 上升，摘录 p95 仍从 28.673 ms 降到 3.100 ms。

## 分词、偏移与工程回归

- 构建将 Jieba 0.42.1 默认词典的整数词频写入 3,200,052 B 的 FST，并生成总词频常量和四状态 HMM 发射概率表。运行期以 `include_bytes!` 借用 FST，不读取外部词典、不解压旧文本词典。DAG 路径通过倒序动态规划求解，连续单字候选按 Jieba 精确模式交由 Viterbi。词典、概率输入和许可可在源码中核对。 [数据版本与哈希](../jieba/README.md)
- 原文先按 Han 与非 Han 片段分词。词元做 NFKC、Unicode 大小写折叠，Han 词元用 ZhHans 归一。未变化的内容使用借用路径；连续 Han 片段发生变化时重新切分，等字符数转换按字符边界投影回原文，长度变化夹具按最小可知原文覆盖区间投影。传统字词「那斯達克」拆为两个规范词元时，两段高亮仍分别指向各自原始字节。
- `WithFreqs` 索引验证 50/50 条 UTF-8 冲击用例全部精确高亮原文，0 panic。繁简双向检索命中同两段；「繁。體」、空格、Emoji、字母或数字分隔均不会误拼。数字测试覆盖 `0.03`、`3.5`、`1.25`、全角小数百分比、`0050` 和 `00864B`，句点留在词元外。Tantivy 的 `set_max_num_chars(550)` 使用 UTF-8 字节偏移，纯中文约对应 183 字。
- `cargo test --release --manifest-path v2/Cargo.toml` 共 10 个测试通过，其中只读测试在 `0555` 索引目录并发启动 8 个外部进程，全部正常退出，索引文件内容和列表逐字节一致。新增回归同时验证全 OR 的部分命中、查询词频权重、合法闰日、非法日期报错及失败清理、归档路径别名和已有文件防覆盖。`cargo clippy --all-targets --manifest-path v2/Cargo.toml -- -D warnings` 无警告。
- 建库在输出同级的临时目录完成单段合并后原子发布。归档限制到索引外的全新文件，临时文件落盘后再发布，现有源文件受保护。空日期存为 0，带值日期要求严格 `YYYY-MM-DD` 且通过日历校验。索引缺失已存储的 `doc_id` 时，查询返回错误。

## 构建与依赖审计

`audit-native.sh` 在全新 Cargo target 中编译一次通过，release 构建耗时 50.53 秒。剥离后的可执行文件为 **10,040,528 B**，与默认 target 产物逐字节一致，SHA-256 为 `f23df995b15be4562e4ebd87f0b7a59c0dd72178d9c244293b5f9fca9d42cd72`。引擎 `src/` 约 1,037 行非测试 Rust 源码，另有 49 行构建脚本。首轮原型为 701 行，两版均超出约 300 行的原型目标，并低于 2,500 行引擎上限。

- Cargo 锁文件与 feature 树中已移除 Charabia 和 `jieba-rs`。Tantivy 0.25.0 的 mmap、Zstd 与归档使用 Zstd，zhconv 0.4.2 的 OpenCC 构建路径也汇入同一 crate。编译器记录捕获 61 次 vendored Zstd 源文件编译（36 个路径），余下 6 次为 `zstd-sys` 编译器探测记录。唯一静态 C 依赖是获批的 `zstd-sys 2.1.3+zstd.1.5.7`。
- `otool -L` 仅列出 macOS 系统库 `/usr/lib/libiconv.2.dylib` 和 `/usr/lib/libSystem.B.dylib`。审计日志在 `/tmp/clec-stage0-bench/recheck/audit.PcYm4D/`。

## 单段索引与归档体积

4 个索引线程完成建库、强制单段合并与归档的总耗时为 **7.41 秒**，首轮为 14.38 秒。DocStore 从 Zstd level 3 改为 level 9 / 65,536 B，归档使用 level 9。三个全文字段使用 `WithFreqs`，Tantivy 仍生成 140 B 的空位置容器，位置数据由 22.839 MB 降到 0。移除 `doc_id` 的 FAST 后，`.fast` 由 10.136 MB 降到 6.757 MB。

| 项目 | 首轮（B） | 修订后（B） |
| --- | ---: | ---: |
| 正文 UTF-8 总量 | 87,213,242 | 87,213,242 |
| 构建 JSONL | 106,858,487 | 106,858,487 |
| 单段索引，排除锁文件 | 120,687,002 | 90,884,133 |
| 解压后的 tar | 120,694,272 | 90,891,776 |
| `tar.zst` | 104,490,636 | **70,897,021** |
| 归档 / 未压缩 tar | 86.57% | 78.00% |
| 60,000 段等密度外推 | 62,693,755 | **42,537,787** |

归档比首轮缩小 32.15%。`zstd -t` 通过，tar 解出一个含 100,001 段的 Tantivy segment。用解包索引独立查询，返回 15 个含高亮的摘录。

| 60,000 段平均段长 | 首轮归档外推（MB） | 修订后归档外推（MB） |
| --- | ---: | ---: |
| 331.32 字，与实测语料等密度 | 62.694 | 42.538 |
| 400 字 | 75.689 | 51.355 |
| 500 字 | 94.612 | 64.194 |
| 600 字 | 113.534 | 77.033 |

外推按归档字节数与总码点数同比例计算。DuRetrieval 正文合计 33,132,524 个码点。600 字情景距 90 MB 还有 12.97 MB 裕量。实际压缩率也受词汇、正文重复率和元数据分布影响。

## 复现

在仓库根目录运行。保持旧索引和归档，使用新的输出路径。严格延迟运行直接复用正式索引，用独立目录保存采样文件。

```sh
base=/tmp/clec-stage0-bench
mkdir -p "$base"
work=$(mktemp -d "$base/replicate.XXXXXX")
uv venv --python 3.12 "$work/python"
uv pip install --python "$work/python/bin/python" \
  pyarrow==19.0.1 jieba==0.42.1 bm25s==0.2.14 scipy==1.15.3 numpy==2.2.6
py="$work/python/bin/python"

cargo build --release --manifest-path v2/Cargo.toml
cargo test --release --manifest-path v2/Cargo.toml
cargo clippy --all-targets --manifest-path v2/Cargo.toml -- -D warnings
sh v2/benches/audit-native.sh "$work"

"$py" v2/benches/stage0.py prepare --root "$work" > "$work/prepare.json"
TMPDIR="$work" "$py" v2/benches/stage0.py baseline --root "$work"
/usr/bin/time -p v2/target/release/clec build \
  --input "$work/corpus.jsonl" --output "$work/index" \
  --threads 4 --pack-zst "$work/corpus.tar.zst"
"$py" v2/benches/stage0.py evaluate --root "$work" > "$work/retrieval.json"
for mode in expanded none; do
  "$py" v2/benches/stage0.py evaluate --root "$work" --stopwords "$mode" \
    > "$work/retrieval-$mode.json"
done
"$py" v2/benches/stage0.py latency --root "$work" --samples 200 > "$work/latency.json"

strict="$work/latency-strict"
mkdir "$strict"
ln -s ../index ../queries.jsonl "$strict/"
"$py" v2/benches/stage0.py latency --root "$strict" --samples 200 \
  --require-full-limit > "$strict/latency.json"

zstd -t "$work/corpus.tar.zst"
tar -tf "$work/corpus.tar.zst"
wc -c "$work/corpus.tar.zst"
mkdir "$work/unpacked"
tar -xf "$work/corpus.tar.zst" -C "$work/unpacked"
v2/target/release/clec search --index "$work/unpacked/index" '国家法定节假日共多少天'
```

本次全量评分、构建、归档和等距延迟数据保留在 `/tmp/clec-stage0-bench/recheck/final/`。严格延迟样本和 40 次分阶段记录在 `/tmp/clec-stage0-bench/recheck/latency-strict/`，原始首轮数据仍在 `/tmp/clec-stage0-bench/`。
