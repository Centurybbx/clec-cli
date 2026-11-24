# CLEC 本地实测指南

## 一分钟上手

从 `clec-cli` 仓库根目录运行。二进制位于 `target/release/clec`（可通过 `cargo build --release` 构建），索引目录通过 `CLEC_INDEX_DIR` 指定（默认 `~/.local/share/clec/index`）。以下命令需要 `jq`。

```sh
clec="$PWD/target/release/clec"
export CLEC_INDEX_DIR=/tmp/clec-real/index

"$clec" stats | jq '{counts, known_gaps, disclaimer}'
"$clec" search '退休 提領' '退休 提领' '4% 法則' '現金流' --limit 5 |
  jq '.hits[] | {doc_id, work_id, kind, quality, title, origin_url, snippet}'
"$clec" search 'QQQ' --kind transcript,doc --from 2024-01-01 --exclude-suspect --limit 5 |
  jq '.hits[] | {title, highlights, date, kind, quality, origin_url}'
"$clec" search '定期定額' '定投' 'DCA' --limit 3 | jq '.hits[] | {title, highlights, origin_url}'
```

第一条检索混用繁简关键词并融合四路结果。第二条可从 `highlights` 检查 QQQ 的配置同义词（如「納指 100」），并按类型、日期和质量过滤。管道下默认输出紧凑 JSON。直接在终端运行可看人类可读格式，或加 `--json` 强制 JSON。

`--index <目录>` 会覆盖 `CLEC_INDEX_DIR`。如需安装到默认路径，以下命令只在目标尚不存在时复制整个索引。复制后执行 `unset CLEC_INDEX_DIR`。

```sh
test ! -e "$HOME/.local/share/clec/index" && mkdir -p "$HOME/.local/share/clec" && cp -R /tmp/clec-real/index "$HOME/.local/share/clec/index"
```

## 从检索进入原文

```sh
work=ep-00123
"$clec" outline "$work" |
  jq '{sources: [.sources[] | {source_id, kind, passages, origin_url}], first_passages: .passages[:3]}'
doc=$("$clec" outline "$work" --kind transcript | jq -er '.passages[0].doc_id')
"$clec" read "$doc" --context 1 |
  jq '.passages[] | {passage: (.passage | {doc_id, heading, origin_url, body}), before, after}'
"$clec" read --work "$work" --range 02:00-03:00 --context 0 |
  jq '.passages[].passage | {doc_id, kind, time_range, origin_url, body}'
(
  set -o pipefail
  "$clec" search '定期定額' --kind transcript,doc --limit 2 --ids-only |
    "$clec" read --stdin --context 0 |
    jq '.passages[].passage | {doc_id, work_id, kind, origin_url}'
)
```

`read --range` 返回与所给时间窗口重叠的完整段落，`time_range` 显示段落时间。`sources[].origin_url` 与段落级 `origin_url` 可直接回查原始网页；为空表示离线本地文档或书籍。发现 `summary` 时先看 `other_kinds`，再用 `outline` 找逐字稿或讲义。看到 `quality: 4` 时回看原片或另找来源核对。

## 验证退出码

```sh
"$clec" search 'qxzvkjwpy' --json && printf 'exit=%s\n' "$?"  # 0，hits: []
"$clec" search 'ETF' --limit 0 --json || printf 'exit=%s\n' "$?"  # 2，参数错误
"$clec" --index /tmp/clec-real/index/.no-such-index stats --json || printf 'exit=%s\n' "$?"  # 3，索引缺失
"$clec" outline ep-00176 --json || printf 'exit=%s\n' "$?"  # 4，作品缺失
"$clec" stats | jq -r '.known_gaps[] | select(contains("ep-00176"))'
```

## 独立盲测记录与回查

向盲测 Agent 提供 CLI、可用索引、[SKILL.md](skills/clec/SKILL.md) 和各题的 `question`。协调者保留完整命令记录和回答，按题号汇总成 JSON 数组。每个对象使用以下字段。

- `id` 对应 [15 道题](benches/agent_e2e_questions.json)，`answer` 保留最终回答全文。
- `commands` 按实际执行顺序记录每个 CLEC 进程。每项含 `argv`（从子命令开始，保留实际参数，把前置全局参数移至子命令后）、`exit_code`（整数）、`timed_out`（布尔值）、`stdout` 和 `stderr`（原始字符串）。用非 TTY 捕获。管道两端分别记录，保留成功、失败、重试和超时。超时可将 `exit_code` 设为 `null`。若进程未能启动或记录方遇到解析异常，分别使用可选布尔值 `execution_error` 或 `parse_error`，并保留当时的输出。
- `citations` 列出回答实际引用的每组 `doc_id`、`work_id`，有明确引用时可附 `time_range`（含 `start_sec`、`end_sec`）或 `origin_url`。隔离题可用空数组，`known_gap` 保留从 `stats` 获取的原始条目全文，回答注明 `stats.known_gaps` 的隔离证据。

```sh
python3 benches/verify_agent_e2e.py --results /tmp/clec-real/blind_agent_results.json
```

脚本默认从 `../clec-corpus/dist/corpus.jsonl` 回查。可用 `--corpus` 更换同一索引对应的语料文件。脚本生成 [agent-e2e-report.md](benches/agent-e2e-report.md)，含 15 题总表与预选的 5 份完整问答。退出码 0 表示通过，1 表示验收失败，2 表示无法读取或处理输入。用 `--report <路径>` 可另存报告，用 `--template` 可生成待测框架。
