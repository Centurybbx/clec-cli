# Model provisioning resume — 2026-11-10

**Outcome: reranker verified and ready; embedding incomplete.** One bounded resume per model ran in parallel against the pinned official Hugging Face repositories. Both owned downloader processes finished; no retries were started. The original provisioning report remains unchanged.

| Model | Outcome | Local path | Bytes | SHA-256 |
|---|---|---|---:|---|
| Reranker | Verified local content, promoted without clobbering | `/Users/century/.cache/clec/models/qwen3-reranker-0.6b-q8_0.gguf` | 639,153,184 | `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48` (computed locally; matches expected official hash) |
| Embedding | Incomplete; partial preserved | `/Users/century/.cache/clec/models/Qwen3-Embedding-0.6B-Q8_0.gguf.partial` | 491,836,501 of 639,150,592; 147,314,091 remaining | Expected official hash: `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`. No full local hash was verified. |

The reranker resumed from 350,836,630 bytes at 15:27:01 UTC, returned HTTP 206 and completed its transfer in 291.6 seconds. Its exact length and locally computed SHA-256 matched the expected values; it was promoted using an atomic, no-clobber hard link followed by removal of the partial name, with verification and promotion complete in 292.0 seconds. Its official source was `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` at revision `a02f48bb4f057028298c21fa033da2b30d7742d5`.

The embedding resumed from 460,346,471 bytes at 15:27:01 UTC and received HTTP 206. After 304.2 seconds, curl exited 92: `HTTP/2 stream 1 was not closed cleanly: CANCEL (err 8)`. The partial grew by 31,490,030 bytes and remains available for a future authorized resume. Its official source was `Qwen/Qwen3-Embedding-0.6B-GGUF` at revision `370f27d7550e0def9b39c1f16d3fbaa13aa67728`.

Both transfers had a 2,400-second maximum. All owned downloaders had exited by 15:32:05 UTC. No inference, product tests, server, build, dependency changes, or QMD generate-model download were performed.
