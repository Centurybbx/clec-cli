# Backend operations

本文是 [backend README](../../backend/README.md) 的操作说明，静态对照当前源码整理。以下命令是待执行步骤，本次文档整理没有执行安装、构建、产品 CLI 或测试。实现/依赖身份见 [统一冻结](unified-freeze-20261111.md)；不要在 Terra 使用冻结 artifact 期间重新安装或构建共享 backend。

## 1. 安装与构建

`backend/package.json` 声明 Node `>=22.19.0`、npm `11.10.1`。实际已有安装/构建证据仅覆盖 Node **25.7.0 / npm 11.10.1 / macOS arm64**；最低 Node 和其它平台未实测。原生依赖仍需相应平台的 prebuild 或编译工具链。

以下从完整项目根目录开始，使用选定的 Node/npm 工具链：

```sh
set -e
cd backend
NODE_LLAMA_CPP_SKIP_DOWNLOAD=true HUSKY=0 CI=true npm ci --no-audit --no-fund
npm run typecheck
npm run build
```

必须允许正常 npm scripts：固定 HTTPS git QMD 依赖的 `prepare` 先编译依赖产物，根 `postinstall` 再通过原生 TypeScript 安装器 `scripts/apply-qmd-patch.mts` 验证 pin/lock/version 和四个文件的 before/after SHA，并严格应用补丁。它不依赖 devDependencies 或应用 dist；重复安装只接受完全一致的已补丁文件。`--ignore-scripts` 不是支持的 fresh-install 流程，随后单跑根 postinstall 不能补回缺失的上游 prepare 产物。不要放宽 hash guard 或只修改 node_modules。

统一冻结已记录 normal 和 `npm ci --omit=dev --no-audit --no-fund` 安装证据；production omit-dev 安装本身不生成应用 dist，部署需携带独立构建好的 dist。`npm run typecheck` 包含应用与 installer strict noEmit 检查，`npm run build` 只编译应用 src。安装/编译成功不证明 native 推理或产品链路通过。

## 2. 固定 workspace、state 和模型

下文均从 `backend/` 执行。先将路径占位替换为实际位置。所有终端使用**同一组** workspace、state、Pi、QMD URL、端口和模型设置；只创建一次 fresh state/Pi，再将相同值传给其它终端，不要各自重新 mktemp。

```sh
export CLEC_WORKSPACE='/absolute/path/to/complete-clec-workspace'
export CLEC_STATE_DIR="$(mktemp -d /tmp/clec-state-schema3.XXXXXX)"
export CLEC_PI_DIR="$(mktemp -d /tmp/clec-pi-schema3.XXXXXX)"
export CLEC_QMD_URL='http://localhost:8181'
export CLEC_PORT=3000
export QMD_EMBED_MODEL='/absolute/path/to/Qwen3-Embedding-0.6B-Q8_0.gguf'
export QMD_RERANK_MODEL='/absolute/path/to/qwen3-reranker-0.6b-q8_0.gguf'
```

采用此前 Terra 已验证的本地模型字节；不在本文绑定用户私有路径或另启下载。已有 [hybrid/incremental 报告](../../evaluation/backend-e2e/reports/hybrid-incremental-20261110.md) 记录：

| 模型 | 字节数 | SHA-256 |
| --- | --- | --- |
| Qwen3-Embedding-0.6B Q8_0 | 639150592 | `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` |
| Qwen3-Reranker-0.6B Q8_0 | 639153184 | `22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48` |

本地文件路径与内容 hash 进入 generation settings；QMD 启动核验冻结 runtime 和模型字节。generation 的配置优先于后来 shell 中的模型覆盖；改变模型需重新 build。默认 HF URI 不等同于不可变远端字节证明。`QMD_GENERATE_MODEL` 是可选配置；当前结构化检索不调用 query expansion 模型，如显式配置也应在各阶段保持一致。

state 保存派生 generations、CURRENT、`sessions.sqlite` 和默认诊断日志；Pi 目录保存真实 SDK JSONL。新会话 schema 是 **3**，旧 schema 1/2 拒绝打开且无迁移。保留旧 state/Pi、原始资料和历史报告，升级时同时选用全新 `CLEC_STATE_DIR` 与 `CLEC_PI_DIR`。不要删除或覆盖原始材料，也不要把 state 放进原始 collection 或让它包含整个 workspace。

配置来自 `process.env`，应用不自行读取凭据文件。安装、catalogue、build、QMD 和 session HTTP 客户端不应获得 DeepSeek key；只给 API `serve` 与直接执行 QA 的 stateless `ask` 进程私密注入。不要打印 key、写入示例或在命令参数中填入真实 key。下文用 Node `--env-file` 仅表示由操作者提供的私有环境文件（只含所需 DeepSeek 变量），本次没有读取或创建该文件；也可通过既有私密环境注入渠道配置 process.env。

| 配置 | 默认 / 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | QA 与 readiness 要求非空；仅 API/ask 环境 |
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com`；仅官方 origin，可带 `/v1` |
| `CLEC_DEADLINE_MS` | `600000`，范围 1000–600000；API composition 用它配置 scheduler |
| `CLEC_MODEL_ADMISSION_UNITS` | `240000`；累计完整序列化上下文 UTF-8 bytes + 每请求 2048 reserve，非精确 tokens |
| `CLEC_DIAGNOSTIC_PATH` | `$CLEC_STATE_DIR/diagnostics.jsonl`；有限 code/count 诊断，不记录原文或密钥 |

## 3. Catalogue 与 manifest 审核

`CLEC_WORKSPACE` 必须指向**完整、保留 metadata 的真实 workspace**（或保留同样目录结构、manifests、inventories、sidecars 和原文的完整副本）。catalogue 按显式来源适配器读取 metadata，并非任意递归扫描 TXT。不能对只复制 ready 文本的验收 copy 重新 catalogue；那会丢失来源发现与 provenance。已有文本 copy 的 metadata-bearing intake 应保留其映射，不能用缺少 metadata 的新 catalogue 替代全库。

```sh
node dist/cli.js catalogue --root "$CLEC_WORKSPACE" \
  --manifest "$CLEC_STATE_DIR/intake.json" \
  --report "$CLEC_STATE_DIR/corpus.json"
```

三个命名参数均必填，两个输出路径必须不同且位于 state 内。先审核 `corpus.json` 中 families、coverage、issues、来源选择、版本与日期依据、quarantined/unsupported/metadata-only/missing，再接受 intake。历史全库基线为 6,775 ready sources；当前数量变化必须解释，不能以部分库替代。catalogue 固定返回 `complete:false`，表示只覆盖显式采集范围，不能当作全网/全部资产完整性认证。只有可用 UTF-8 TXT/MD 进入可检索证据；metadata 和二进制资产仍保留。

`docs/backend/intake.example.json` 仅选两份 transcript 和一份 curated QA，合计三份。它可以表达 intake 格式，但不是全库 manifest，也不能代替以上审核或全库验收。

## 4. Hybrid build 与匹配 QMD

```sh
node dist/cli.js build "$CLEC_STATE_DIR/intake.json" --hybrid
node dist/cli.js status
# 可选：已知实际 source ID 时查看原文（例如后续 QA 引用中的 sourceId），不能用集数代替 SHA ID：
node dist/cli.js source '<actual-source-id>'
node dist/cli.js qmd-serve 8181
```

`build <intake.json>` 默认 hybrid，显式 `--hybrid` 等价；`--lexical` 仅用于另一个 state 的降级诊断，不证明语义召回。build 生成原文 evidence、分段 Markdown、typed metadata 和 QMD index；hybrid 还要求当前模型/fingerprint embedding 完整与 partition 登记覆盖。两小时 embedding policy 是有限上限，不能保证任意语料完成，native batch 也不保证即时取消。

只有 QMD 工作与 cleanup 成功、完整性检查完成后才写完成 metadata/READY，最终原子切换 CURRENT。失败或取消的 build 不发布部分 generation，已有 CURRENT 保留；初次失败则没有可服务的 CURRENT。保留失败目录用于检查；不要手工写 READY/CURRENT，也不要在仍有 owner 时清理 BUILD.lock。

`qmd-serve [port]` 的端口是位置参数，范围 1024–65535；它打开 CURRENT 对应的隔离 QMD DB/config，启动固定依赖的公开 CLI。CLI 不会启动 API。QMD 子进程会移除 DeepSeek key，但上游 QMD 与 build 环境仍应从一开始就不注入 key。

## 5. API、readiness 与客户端

另一终端保持第 2 步相同的非凭据设置。`DEEPSEEK_ENV_FILE` 表示私有环境文件的绝对路径，不是 key 本身；不要将该文件内容打印或加入仓库。

```sh
node --env-file="${DEEPSEEK_ENV_FILE:?set private env file path}" dist/cli.js serve
```

API 只绑定 `127.0.0.1`，端口由 `CLEC_PORT` 配置，`serve` 不接受端口参数。第三终端可探测：

```sh
curl --fail-with-body "http://127.0.0.1:$CLEC_PORT/health"
curl --fail-with-body "http://127.0.0.1:$CLEC_PORT/health?check=ready"
node dist/cli.js session create 'My CLEC session'
node dist/cli.js session list
```

live 只证明 HTTP 存活。ready 检查 key 存在、已完成 generation、可达且匹配的 QMD metadata，不调用模型，也不验证 key 有效性、额度或远端可用性。QA 每次 search 仍独立检查 pinned generation/QMD，不以曾经 ready 替代。API 可能先接受 run 再返回失败；不能把 stale/unavailable 当作 no_hits。

用 create 返回的真实 session ID 替换下列占位：

```sh
node dist/cli.js session ask '<actual-session-id>' '資料中如何描述退休所需的年開銷倍數？'
node dist/cli.js session history '<actual-session-id>'
node dist/cli.js session ask '<actual-session-id>' --scope '{"types":["transcript"],"dateFrom":"2024-01-01"}' '原文有哪些條件？'
# Stateless QA 直接调用共享服务，需要单独私密注入 key：
node --env-file="${DEEPSEEK_ENV_FILE:?set private env file path}" dist/cli.js ask '資料中如何描述退休所需的年開銷倍數？'
```

session CLI 是 HTTP 客户端，不打开第二个 session store，也不需要 key；stateless ask 不经 API，输出 NDJSON。两者 `--scope '<JSON>'` 必须位于问题之前（session ID 之后）。支持 `sourceIds/types/dateFrom/dateTo`；日期含端点，日期未知的来源不满足日期边界，空列表选中零项。完整字段与幂等 requestId 契约见 [HTTP](http.md)。

SSE 是持久事件流：执行期间只有 search/read 进度，最终 text/citations/result 在 cleanup 和校验后随 assistant history、completed terminal 同一事务提交，再通知客户端。它不是模型 token streaming。`session ask` 的 Ctrl-C 或 SSE 断开仅停止观察；不要重新提交 ask 来充当 replay（每次 CLI ask 都产生新 requestId）。真正取消使用 `POST /v1/sessions/:id/runs/:runId/cancel`，JSON body 为 `{}`；按 [HTTP 取消路由](http.md#routes-and-request-schemas) 与 [replay 说明](http.md#replay-progress-and-settlement) 使用 GET run、events 的 `after` 或 `Last-Event-ID` 恢复观察。terminal 不等于 settled：取消/超时后底层 cleanup 可继续，占用 session/global slot；run-specific SSE 等到 settlement 才关闭。

## 6. 增量、重启与恢复

原始来源/metadata 更新后，仍对完整 workspace catalogue，先审核新 manifest，再用**相同 state 和模型设置**执行第 4 步 build，以便比较旧 generation 和复用符合身份的内容/向量。不要删除旧 generation 或改写其 DB；只有完整 settings 相同才允许向量 seed，实际 reuse 以真实指标为准。补丁前 generation 不能 seed 新补丁构建。

新 CURRENT 发布后，旧 QMD 仍绑定旧 generation。停止并等待自己启动的旧 QMD，再以同一配置重新执行 `node dist/cli.js qmd-serve 8181`，然后重新探测 API ready。不要通过修改 mismatch guard 绕过重启。已有 run 固定自己的 generation，保留所有仍有 reader 使用的目录；没有自动 generation GC。

API 正常停机请求取消并等待实际 executor settlement；只有旧 owner 退出后才重启 `serve`。同一 state 仅允许一个本机 store owner，不手工清除存活 owner。崩溃后重启把旧 queued/running 标记为 INTERRUPTED，保留已完成历史及 Pi 文件。没有自动付费 replay/retry/compaction；新尝试需显式新请求。Pi committed marker 本身不能推断 host 完成，下次显式请求通过 SDK 分支恢复并保留旧分支。旧 schema/损坏 generation/模型或 runtime 不匹配均保留并拒绝使用，不存在自动迁移或兼容旁路。具体权威边界见 [sessions](sessions.md) 与 [integration](integration.md)。

问题上限 2000 UTF-16 units；固定预算为两次搜索、八次 read attempts / 40000 原文 units、四次 admitted model requests、每次 2048 输出 tokens。持续会话可能耗尽累计 admission，不能自动付费压缩历史。usage 可能缺失，catalog pricing 的费用只是估算而非账单；未知价格不报告零成本，取消/崩溃也不证明远端停止或不计费。

## 验收边界与历史说明

[统一冻结](unified-freeze-20261111.md) 记录静态审阅、正常/production 安装、typecheck/build；后续 [五源 lexical lifecycle 报告](../../evaluation/backend-e2e/reports/unified-install-lifecycle-20261111.md) 记录部分真实 CLI/API、SSE replay、取消、crash 和 stale-generation 恢复观察，整体结论仍为 partial。三次真实 `ANSWER_PROTOCOL` 失败未解决，完整 orphan/竞态/饱和 slot 等门禁也未完成。完整 hybrid 全库与 45 题语义验收尚无完成结论；正在进行的运行不预先记为通过。`validated:true` 只证明结构/原始来源完整性，不证明 entailment 或质量。所有测试仅由 Terra medium 执行真实 E2E，禁止 mock/unit/component/smoke；本文不新增验收结果。

历史文档保持原样：embedding handoff 的 `.cjs` 安装器已被统一冻结的 `.mts` 取代；retrieval 的 schema 2 已被 QA/session schema 3 取代；sessions/HTTP 中独立 scheduler 的 90 秒默认值不等于当前 API composition 的 600 秒默认值。命令以本文静态核对的 `src/cli.ts`、`src/config.ts`、`src/app/session-cli.ts`、`src/io/scoped-question.ts` 和 package scripts 为依据，历史步骤不自动成为当前操作指令。
