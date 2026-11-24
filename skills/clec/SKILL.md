---
name: clec
description: Research CLEC investing materials offline with clec. 检索 CLEC 投资资料，回查逐字稿与讲义并引用出处。
---

Set `CLEC_INDEX_DIR` or pass `--index <DIR>` (overrides env). The default is `~/.local/share/clec/index`. 非 TTY 默认输出紧凑 JSON。用 `--json` 强制 JSON，`--ids-only` 输出逐行 ID。

1. **宽召回 / Search.** Run `clec search <q1> [q2..q4]`. Quote each query separately. 把长问题拆成 1–4 路短关键词，CLI 并行检索并融合排序。繁简互通，扩展数据包配置的同义词。
2. **溯源 / Verify.** For `kind: "summary"`, inspect `other_kinds`. 核对原话、数字或严谨观点时，主动运行 `clec outline <work_id>`，选取 `transcript` 或 `doc`，再用 `clec read <doc_id> --context 1` 阅读原文与邻段。也可用 `clec read --work <work_id> --range 02:00-03:00`，或 `clec search <q> --kind transcript,doc --ids-only | clec read --stdin`。Use original evidence for precise claims. For `quality: 4` (suspect), check the video or another source before relying on it.
3. **边界 / Coverage.** If coverage is unclear, evidence seems missing, or a lookup exits 4, run `clec stats`. 核对 `known_gaps` 和 `disclaimer`，回答中注明相关缺口。
4. **引用 / Cite.** Cite the returned `doc_id` and `work_id`, plus `time_range` or `origin_url` when available. 只引用实际返回的 ID、时间或链接，绝不编造。

**Exit codes / 退出码.** `0` success (including empty hits), `2` invalid arguments/query, `3` missing or invalid index, `4` unknown work or passage ID.
