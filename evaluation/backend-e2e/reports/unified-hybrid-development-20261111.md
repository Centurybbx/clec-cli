# Unified hybrid development real E2E — 2026-11-11

**结果：全库 hybrid 构建 FAIL；依赖门禁未执行。** 冻结 CLI 的一次真实构建在 2 小时 1 分 35 秒后因 QMD embedding session 过期退出 1，未发布 READY/CURRENT。没有重试、替代语料或 lexical 降级。公开 SDK 对已关闭的失败状态的独立副本报告 `needsEmbedding: 26446`，因此不能接受该索引；具体耗时成因未定位。此轮 45 道开发题全部 NOT_EXERCISED，不是 45 个 QA 失败。没有读取 held-out，没有真实 provider 调用；费用估计为 $0（没有账单核验）。

## 证据与输入

独立运行根目录 `/tmp/clec-unified-e2e-20261111.TU9R3Q`：`state/` 是失败 staging，`pi/` 新建且未用于 QA，`evidence/` 含进程记录、stdout/stderr、系统采样、manifest/ledger 对照、公开健康结果、原文核对和诊断副本。完整 staging 保留在 `state/generations/a0159e4a2e7f3b7a34cdc2fe747aa89bc69c83cfb00ed22cce77f4594dbeb132/`，`BUILDING.json` 存在；没有 `READY` 或 `CURRENT`。它不是完整 generation，不可用于 serving。`evidence/diagnostic-copy/` 是进程退出后复制的 QMD SQLite 和配置，公开 SDK 检查在副本上进行，没有改写失败 staging。采样、缓存及诊断副本是运行证据，不是新代码字节。

- Node `/Users/century/.nvm/versions/node/v25.7.0/bin/node`；CLI `/Users/century/vibing/clec/backend/dist/cli.js`。未安装、重建或改动共享产品树。
- 完整副本 `/tmp/clec-full-corpus-20261110-r6jctg/workspace`；原 manifest `/tmp/clec-full-corpus-20261110-r6jctg/state/full-intake.json` SHA-256 `779d05849efd50d6974f3b60c19dc788fe8f4953221fa0f8b3af48dc3df2d59d`；原 ledger SHA-256 `a961c3718cb761a9bc614e22263c616682b2f1f8565c71a1de785687d11fe71b`。17,972 manifest 路径无重复，6,775 ready source 的完整 manifest 字段与 ledger 一致。构建前后均逐文件核对 6,775 个副本、204,686,007 字节、零哈希/长度错误（`copy-before.json`, `copy-after.json`, `evidence/manifest-ledger.json`）。未重新 catalogue。
- 本地 embedding 模型 639,150,592 字节，SHA-256 `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`；reranker 639,153,184 字节，SHA-256 `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`。结束时哈希见 `evidence/final-hashes.txt`。
- 冻结 JSON 自身 SHA-256 `163ad09f520704ccc34f5728511f49412433a1e331fc2a3be3130e36ed1dacf1`；逐项重生成的开始、构建结束和全部诊断结束三份清单分别为 `freeze-before.json`、`freeze-after.json`、`freeze-final.json`，各 21,463 项、inventory SHA-256 均为 `5cd0cbb4f2d21486cb2c3d28d1f487b6834cbafbb11a857f83ff6432f87ef75a`。冻结范围内没有新增缓存文件、删除或代码/依赖字节变化；操作系统及冻结范围外的运行缓存状态未清除且未全面盘点。

## 构建及完整性

2026-11-10 16:50:46 UTC 启动，18:52:21 UTC 结束（本地为 11 月 11 日）；shell PID 22596，实际 CLI PID 22599，已 wait、退出码 1。命令和配置如下，未向 build 注入提供商密钥：

```sh
CLEC_WORKSPACE=/tmp/clec-full-corpus-20261110-r6jctg/workspace
CLEC_STATE_DIR=/tmp/clec-unified-e2e-20261111.TU9R3Q/state
CLEC_PI_DIR=/tmp/clec-unified-e2e-20261111.TU9R3Q/pi
QMD_EMBED_MODEL=/Users/century/.cache/clec/models/Qwen3-Embedding-0.6B-Q8_0.gguf
QMD_RERANK_MODEL=/Users/century/.cache/clec/models/qwen3-reranker-0.6b-q8_0.gguf
/Users/century/.nvm/versions/node/v25.7.0/bin/node /Users/century/vibing/clec/backend/dist/cli.js build /tmp/clec-full-corpus-20261110-r6jctg/state/full-intake.json --hybrid
```

`evidence/build-process.txt`、`build.stdout`、`build.stderr` 保留原始退出和输出：stderr 明确报告 session expired、跳过 41 个剩余 chunks 和剩余 document batches；stdout 返回 `INVALID_INDEX: QMD embedding was incomplete; generation was not published.` 41 只是该批次报告的剩余 chunks，不是全部缺口。系统采样 `build-sample.txt` 捕获实际 PID 的 llama tokenizer 调用，进度观察 `build-observations.txt` 记录模型映射和数据库写入；超过历史 31 分 39 秒失败点仍继续执行，但这不证明覆盖完成。两小时限制是 embedding session 的有限策略，并非整个进程的硬停止时间；具体工作负载为何不能在该时间完成尚未查明。

`reconcile-staging.mjs` 用公开 EvidenceStore 只读核对，退出 0：6,775 sources、30,565 sections、204,686,007 原文字节与 ledger 的路径、哈希、长度、原文及元数据零不匹配（`evidence/staging-original-reconciliation.json`）。这是 staging 原文完整性，不是索引就绪。

`staging-health.mjs` 对独立副本调用公开 SDK，退出 1 表示其完整性断言失败；完整结果在 `evidence/staging-public-health.json`。唯一 collection 的活动文档为 30,565；typed `sourceId`、`sourceType`、`sourceVersion` 匹配 30,565/30,565，`pendingMetadata=0`，`hasVectorIndex=true`；status 和 health 的 `needsEmbedding` 均为 **26,446**，health 的 `totalDocs=30565`、`missingVectorPartitions=0`。`needsEmbedding` 是当前配置模型及 fingerprint 下的待嵌入 active hash 检查，不应简单解释为独立原文数；partition 仅是现有向量登记检查。公开结果未单独输出 fingerprint 字符串，不能声称另行验证了其具体值。指定模型路径记录在结果中；并无完整 embedding 或 READY/CURRENT。

## 开发题及剩余门禁

| 项目 | 本轮结果 |
| --- | --- |
| CLEC-001–045，逐题 rubric / claim / 条件 / 归因 / 引用语义 | 45 项全部 NOT_EXERCISED；0 提交、0 完成、0 失败，不作质量评分或 unsupported claim 判断 |
| 原有顺序前驱、009 数字污染、历史 12 失败、031 情境区分及 011/038 负面断言 | NOT_EXERCISED；旧报告不是本轮结果 |
| blocks、全文、search/read、原文版本/范围/quote、GET/live SSE/replay/history、diagnostics 与调用指标 | NOT_EXERCISED；`runtime/acceptance.ts` 和 `runtime/report.ts` 未运行 |
| unchanged rebuild / zero new embedding / 完整初始 generation 保存 | NOT_EXERCISED：不存在已发布完整 generation；失败 staging 已保留 |
| owned QMD/API、serving PID、真实 hybrid 查询 embedding/rerank 和 SDK explain | NOT_EXERCISED；构建期的 native tokenizer 采样不能证明搜索期推理 |
| 独立安装、其他 lifecycle / incremental 情景、held-out | NOT_EXERCISED；held-out 未打开 |

未启动 QMD/API 或读取私密密钥；无付费问答和 provider usage/cost 观测。构建 CLI 和诊断子进程均已退出并等待，没有终止其他进程。用户告知另一独立安装与小库 lexical 验收可能造成 CPU、网络、DeepSeek 并行负载；没有监控该任务状态，本轮构建耗时也不应作为隔离性能基准。正式冷/热测量及 45 题延迟均未执行。ASR 相关资料即使后续被引用，也只能证明资料中的说法，不能证明音频已听验。

本次将阻塞交回主审：需要处理完整语料在两小时 embedding session 内仍不完整的问题，并保持严格覆盖及发布语义。不得将 staging 或 `missingVectorPartitions=0` 视为通过。未对产品代码、依赖、冻结 artifacts 或历史报告作修复或覆盖。
