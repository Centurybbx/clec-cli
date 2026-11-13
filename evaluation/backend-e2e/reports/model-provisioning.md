# Hybrid model provisioning — 2026-11-10

**Blocked: neither model is complete or verified.** Official HTTPS transfers made progress but exceeded both bounded attempts on a slow connection. No local model path is ready to export, and no inference, product build, server, retrieval, quality, or citation test was run. No package was installed. The QMD generate/query-expansion model is not needed for the typed search variants and was not downloaded.

Official Hugging Face model API metadata (`?blobs=true`) resolved these revisions, sizes and LFS SHA-256 values. These hashes are expected hashes, not hashes verified against completed local artifacts.

| Model | Resolved revision | Expected bytes | Expected LFS SHA-256 | Preserved partial bytes |
|---|---|---:|---|---:|
| [Qwen3 embedding Q8](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/blob/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf) | `370f27d7550e0def9b39c1f16d3fbaa13aa67728` | 639,150,592 | `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` | 460,346,471 |
| [Qwen3 reranker Q8](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/blob/a02f48bb4f057028298c21fa033da2b30d7742d5/qwen3-reranker-0.6b-q8_0.gguf) | `a02f48bb4f057028298c21fa033da2b30d7742d5` | 639,153,184 | `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48` | 350,836,630 |

Partial files are in `/Users/century/.cache/clec/models/`, named as their official files with `.partial` appended. Existing shared QMD cache was not modified. An initial cache search found no matching files. No full-file checksum comparison or final rename was possible.

The initial attempts started at 14:59:52 and 15:00:00 UTC and timed out after 300 seconds with HTTP 200 at `us.aws.cdn.hf.co`, having received 122,624,276 and 118,498,048 bytes. Resumed attempts ended around 15:25 UTC after 1,200 seconds with HTTP 206 at the same CDN; curl reported timeout 28 after receiving another 337,722,195 and 232,338,582 bytes. Thus range resume worked and the network was slow rather than entirely unreachable. Progress logs are in the model directory; signed redirect URLs are omitted. No additional retries were started.

## Smallest remaining action

Resume each file from its existing offset on a sufficiently fast connection, then check the exact size and SHA-256 before atomic rename. The commands below are bounded and preserve partials on failure; rerun individually if needed. They use only the original official repositories and pinned revisions.

```sh
cd /Users/century/.cache/clec/models
curl -fL -C - --connect-timeout 20 --max-time 1200 --speed-limit 1024 --speed-time 45 --progress-bar -o Qwen3-Embedding-0.6B-Q8_0.gguf.partial 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf'
curl -fL -C - --connect-timeout 20 --max-time 1200 --speed-limit 1024 --speed-time 45 --progress-bar -o qwen3-reranker-0.6b-q8_0.gguf.partial 'https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/a02f48bb4f057028298c21fa033da2b30d7742d5/qwen3-reranker-0.6b-q8_0.gguf'
```

After both complete, individually verify and rename only on both checks passing:

```sh
[ "$(stat -f %z Qwen3-Embedding-0.6B-Q8_0.gguf.partial)" = 639150592 ] && [ "$(shasum -a 256 Qwen3-Embedding-0.6B-Q8_0.gguf.partial | cut -d ' ' -f 1)" = 06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439 ] && mv -n Qwen3-Embedding-0.6B-Q8_0.gguf.partial Qwen3-Embedding-0.6B-Q8_0.gguf
[ "$(stat -f %z qwen3-reranker-0.6b-q8_0.gguf.partial)" = 639153184 ] && [ "$(shasum -a 256 qwen3-reranker-0.6b-q8_0.gguf.partial | cut -d ' ' -f 1)" = 22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48 ] && mv -n qwen3-reranker-0.6b-q8_0.gguf.partial qwen3-reranker-0.6b-q8_0.gguf
```

Only after verification and rename, future build/serve processes can use:

```sh
export QMD_EMBED_MODEL=/Users/century/.cache/clec/models/Qwen3-Embedding-0.6B-Q8_0.gguf
export QMD_RERANK_MODEL=/Users/century/.cache/clec/models/qwen3-reranker-0.6b-q8_0.gguf
```
