---
name: clec
description: Research CLEC investing materials offline with clec. 检索 CLEC 投资资料，回查逐字稿与讲义并引用出处。
---

## Bootstrap

Install and verify with one resolved executable path. Use that path for every `clec` command below; do not rely on `clec` from `PATH`.

**macOS / Linux**

```sh
tmp=$(mktemp) &&
curl -fsSL https://raw.githubusercontent.com/Centurybbx/clec-cli/v0.1.0/install.sh -o "$tmp" &&
CLEC_SKIP_SYNC=1 CLEC_VERSION=v0.1.0 sh "$tmp" &&
CLEC="${CLEC_INSTALL_DIR:-$HOME/.local/bin}/clec" &&
"$CLEC" --version &&
"$CLEC" stats
```

**Windows PowerShell**

```powershell
$tmp = Join-Path $env:TEMP "clec-install.ps1"
Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri "https://raw.githubusercontent.com/Centurybbx/clec-cli/v0.1.0/install.ps1" -OutFile $tmp
$env:CLEC_SKIP_SYNC = "1"; $env:CLEC_VERSION = "v0.1.0"
& $tmp
if (-not $?) { throw "clec install failed" }
$clec = if ($env:CLEC_INSTALL_DIR) { Join-Path $env:CLEC_INSTALL_DIR "clec.exe" } else { Join-Path $env:LOCALAPPDATA "clec\bin\clec.exe" }
& $clec --version
if (-not $?) { throw "clec --version failed" }
& $clec stats
```

- Exit `3`: index missing or invalid. Run the resolved executable with `sync` (about 42 MB; allow several minutes). If `stats` still exits `3`, run `sync --force` once.
- Exit `5`: network or checksum failure. Report the stderr and retry `sync`.

Finally, prove first use with a real query and require at least one hit:

```sh
CLEC="${CLEC_INSTALL_DIR:-$HOME/.local/bin}/clec"; "$CLEC" search '资产配置' --limit 1
```

```powershell
$clec = if ($env:CLEC_INSTALL_DIR) { Join-Path $env:CLEC_INSTALL_DIR "clec.exe" } else { Join-Path $env:LOCALAPPDATA "clec\bin\clec.exe" }; & $clec search '资产配置' --limit 1
```

If there are no hits, run `stats`, check `known_gaps`, and report the coverage gap instead of claiming success.

Set `CLEC_INDEX_DIR` or pass `--index <DIR>` (overrides env). The default is `~/.local/share/clec/index`. 非 TTY 默认输出紧凑 JSON。用 `--json` 强制 JSON，`--ids-only` 输出逐行 ID。首次使用，或查询以退出码 `3` 提示索引缺失时，运行 `clec sync` 下载索引包；`clec sync --check` 只检查更新，`clec sync --force` 强制重新下载。同步是唯一联网命令。

1. **宽召回 / Search.** Run `clec search <q1> [q2..q4]`. Quote each query separately. 把长问题拆成 1–4 路短关键词，CLI 并行检索并融合排序。繁简互通，扩展数据包配置的同义词。
2. **溯源 / Verify.** For `kind: "summary"`, inspect `other_kinds`. 核对原话、数字或严谨观点时，主动运行 `clec outline <work_id>`，选取 `transcript` 或 `doc`，再用 `clec read <doc_id> --context 1` 阅读原文与邻段。也可用 `clec read --work <work_id> --range 02:00-03:00`，或 `clec search <q> --kind transcript,doc --ids-only | clec read --stdin`。Use original evidence for precise claims. For `quality: 4` (suspect), check the video or another source before relying on it.
3. **边界 / Coverage.** If coverage is unclear, evidence seems missing, or a lookup exits 4, run `clec stats`. 核对 `known_gaps` 和 `disclaimer`，回答中注明相关缺口。
4. **引用 / Cite.** 面向人类读者时优先引用可读来源：当结果含非空 `origin_url` 时，用可点击的 Markdown 链接 `[标题](origin_url)` 引用，并附上日期和 `time_range`（如可用）。当 `origin_url` 为空（离线本地文档或书籍）时，引用文档标题、章节 `heading` 和一小段逐字原文，并注明这是本地离线文档。不要把 `doc_id` / `work_id` 等内部 ID 作为面向人类读者的唯一出处；仅在用户明确要求或自动化核验时附上内部 ID。只引用实际返回的标题、时间或链接，绝不编造。

**Exit codes / 退出码.** `0` success (including empty hits), `2` invalid arguments/query, `3` missing or invalid index (run `clec sync`), `4` unknown work or passage ID, `5` sync/network/checksum error.
