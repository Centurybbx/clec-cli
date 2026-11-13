# Unified backend freeze — 2026-11-11

本次统一集成 QA 契约和 QMD embedding 补丁，已完成安装、静态审阅、typecheck 和构建。**没有 runtime / E2E / 质量验收通过结论。** 实现者未委派、编写或执行测试、mock、smoke、产品 CLI/服务、QMD 推理或模型调用，未读取密钥文件或 held_out.jsonl，未提交或创建 PR。npm 安装生命周期执行了依赖准备/编译及原生依赖安装，这是安装证据，不是应用运行证据。

磁盘工作区没有 AGENTS.md，采用任务消息提供的模块化架构约束。本目录不是 Git checkout，因此不提供 Git diff/commit 身份；以新清单的逐文件 SHA256 为冻结身份。原始资料、历史状态、报告和旧 artifact inventories 均保留。此文接续而不修改 [QA handoff](qa-contract-handoff.md)、[embedding handoff](embedding-patch-handoff.md) 和 [hybrid execution evidence](hybrid-execution-evidence.md)。旧 embedding handoff 中的 `.cjs` 安装器路径现由 `.mts` 取代。

## 集成改动

1. `backend/scripts/apply-qmd-patch.cjs` 转为原生 Node 可执行的 `apply-qmd-patch.mts`；ESM、显式静态类型、仅可擦除类型语法，无新增运行框架。postinstall 不依赖 TypeScript 编译器或 devDependencies。保留固定官方 HTTPS commit、manifest/lock/installed version 校验、全部 before/after SHA 守卫、patch-package 严格失败标志及完全已补丁状态的幂等路径；另外要求 inventory 恰好列出四个预期文件且 hashes 是完整 SHA256。混合、缺失或修改过的文件不能通过安装。
2. 新增 `tsconfig.installer.json`，对安装器和现有 artifact 工具做独立 strict / noEmit / erasableSyntaxOnly 检查。`npm run typecheck` 顺序检查应用与脚本，`typecheck:installer` 可独立执行。应用 build 仍仅编译 `src`。
3. 静态发现 host quality-note 字典会命中继承的对象原型属性；`domain/answer.ts` 改为只接受自有映射，保证未知标签不产生推断性注释。这是唯一应用源码修正；没有增加预算、重试或修改输出修复策略。
4. `scripts/artifact-manifest.ts` 扩充为 schema 2 清单：完整 src/dist/scripts/patches/node_modules、manifest/lock 和两个 tsconfig；记录 symlink 目标而不遍历链接。输出用 `wx` 创建，避免覆盖旧清单。应用 session schema 仍为 **3**，与清单 schema 无关。
5. 重新生成 backend/dist。52 个实现源码文件对应 156 个 JS / declarations / maps；另有一个源声明文件，不生成输出。静态输出核对无缺失或额外旧文件。package-lock 字节未改变，QMD 四文件补丁及其 before/after 清单未改变。

## 静态审阅结论

- **分层与 DTO：** `domain/answer.ts` 只依赖域类型/错误，不导入 Pi、SQLite 或 reader。EvidenceContext 管理当前 run 的 R/E namespace，reader 保留原文 allowlist 与版本/范围权威。QA 将 E 转换为 reader 已发出的稳定 C IDs；session validator 使用同一块契约和 renderer，比较本次 read 的完整 citation 身份。HTTP GET/terminal SSE 显式包含 blocks；CLI complete 使用单一 answerability。`backend/src` 已无 `noEvidence` 或 `answerStatus` 消费者；历史报告不重写。`validated:true` 只表示结构和原始来源完整性，不证明语义蕴含。
- **原子 final publication：** Pi 的 abort/idle/dispose/key-removal 等 cleanup 由 QA 等待，evidence close 和 metrics cleanup 在 service finally 中完成后，executor 才 resolve。执行进度类型只含 search/read。scheduler 在返回后验证 result、active/deadline，再同步调用 store.complete；完整 assistant history、result、text、依次 citation、completed terminal 同属一个同步事务。`SessionStore.transaction` 的 `db.isTransaction` 使 terminal/event 的嵌套调用共享外层事务，不能误报 nested BEGIN。store 返回已提交 envelopes 后 scheduler 才通知；CLI 同样在成功返回和 abort 检查后发布 final。取消/拒绝/失败不应留下 final answer，但仍待真实 E2E 验证。Pi commit marker 不替代 host-completed membership；无跨数据库事务宣称。
- **partition-health 的准确语义：** 固定安装包 `dist/vec-layout.js:248` 的 `missingPartitionRows` 从 content_vectors 与活动 documents 的 distinct `(hash, collection)` 连接，经 collection ID / vector_rows 左连接，计数缺失的 `(hash, seq, collection)` 登记；不按当前模型过滤，也不逐行验证 vec0 物理向量存在或语义质量。`getIndexHealth` 补丁仅在 partitioned 布局且 `vecTableReadable` 成功时返回其数量；none/legacy/不可读为 null，metadata 查询失败则抛出而不是成功。`vecTableReadable` 是可准备的 `SELECT ... LIMIT 0` 探测，不是损坏取证。
- **互补完整性门禁：** `getHashesNeedingEmbedding`（store.js:2215）按配置当前模型及 `getEmbeddingFingerprint(model)` 筛选，检查 active hash 是否缺向量或 chunk_count 小于 expected_chunks。root SDK getStatus/getIndexHealth 使用 store 当前 embed model。CLEC 先要求唯一正确 collection/path、active/document 数、每个 passage 的 sourceId/sourceType/sourceVersion typed metadata 和 pendingMetadata=0；hybrid 再同时要求 hasVectorIndex、status/health needsEmbedding=0、health totalDocs 匹配以及 missingVectorPartitions **严格等于 0**。null/undefined 均不能通过。未以 docsProcessed 或 errors=0 取代完整性。generation seed 仍要求完整 settingsKey 相等；embedding revision 与已安装 index/store hashes 均参与身份，旧补丁前 generation 不能 seed 新构建。serve 的精确 QMD/runtime/model hash mismatch 守卫和每次 search 的 pinned generation metadata 检查保留。
- **时限与 cleanup：** 只有 embedding policy 改为有限正整数 7,200,000 ms，保留 32 docs / 1,000,000 bytes / regex；QA 限制和输出上限未扩张，无反复 embed 或 Promise.race。native batch 不保证即时中止。QMD close 成功后 builder 才写完成 metadata/READY，并在后续检查后原子移动 CURRENT；operation 主错误优先于次级 cleanup 错误。
- **Pi callbacks 与诊断：** public onResponse/onProviderStreamEvent wrapper 调用并 await 既有 callbacks，onPayload 原 callback 也保留。仅首次实际 provider event 记一条，无参数内容序列化。admission 是本地决策，HTTP_RESPONSE 是收到响应，FIRST_PROVIDER_EVENT 是解析事件观察，end/abort 是 Pi normalized message_end，LOCAL_SETTLED 是 SDK idle；均不能推出 remote-active、远端取消或完整计费。固定补丁不增加 inference instrumentation。diagnostics 注入组合、有限 code/count allowlist、4 KiB record、4 MiB active + 两份轮转、非抛出 drop 行为均保持；实际调用、时序、轮转/失败分支仍由 Terra 验收。

以上未发现需要大型结构重构的问题；这些是源码结论，不是运行结果。

## 安装与构建证据

工具链实际输出：Node **v25.7.0**、npm **11.10.1**，darwin arm64。使用 PATH 前缀 `/Users/century/.nvm/versions/node/v25.7.0/bin`。所有 npm 命令同时设 `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true HUSKY=0 CI=true`，禁用不必要 llama 下载；未使用 ignore-scripts。共享 node_modules 未删除，命令顺序执行，没有并发构建。

| 命令 | 位置 | 原始退出码 |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | 独立 normal 安装目录 | 0 |
| `npm ci --omit=dev --no-audit --no-fund` | 独立 production 安装目录 | 0 |
| `npm run postinstall` | normal / production / shared，各一次 | 0 / 0 / 0 |
| `npm run typecheck` | shared backend，含 installer strict check | 0 |
| `npm run build` | shared backend | 0 |
| `node scripts/artifact-manifest.ts ../docs/backend/unified-artifacts-20261111.json` | shared backend | 0 |

逐命令 cwd/argv/环境覆盖/elapsed/raw exit 在 [证据目录](unified-freeze-20261111/) 的同名 JSON；stdout/stderr 合并原文在同名 `.log`。`static-artifacts.json` 记录三个安装目录四个 patched 文件全部等于 reviewed after hashes、复制的 lock 未变及输出文件核对。normal 与 production 的安装目录保留，路径也在该目录的 `*-install-location.txt`。

两次正常 ci 实际 prepare/pack 固定 git 依赖并自动应用补丁；重复 postinstall 走 exact-already-patched 路径。npm 输出了 git SSH canonicalization / integrity-skip warning，但 manifest 与 lock 仍是指定 HTTPS resolved，四文件严格输入/输出校验通过。没有把警告掩盖为下载内容签名证明。

支持边界：声明 engines >=22.19.0，安装器使用该范围支持的原生 `.mts` type stripping；本轮只在 25.7.0/11.10.1、darwin arm64 实际安装，未实际验证最低 Node 或其它平台。production omit-dev 已验证安装/补丁，不意味着应用可在未构建时运行；部署需携带独立构建好的 dist。新鲜 git 安装必须允许 prepare/postinstall；ignore-scripts 不是支持的正常安装流程。现有模型缓存未删除；runtime native/GPU/model 可用性未验证。

## 冻结身份与复现边界

[完整 artifacts JSON](unified-artifacts-20261111.json) 含 **21,463 records = 21,439 regular files + 24 symlinks**。范围分布：src 53、dist 156、scripts 2、patches 3、node_modules 21,245，加 package/lock/two tsconfigs 4。symlink 的 bytes/hash 是 UTF-8 目标文本，不是目标内容；所指目录内 regular files 单独列出。清单不读取 state、凭据、原始资料、evaluation inputs 或 node_modules 外模型。

- `inventorySha256`（Node `JSON.stringify(files)` 的 SHA256）：`5cd0cbb4f2d21486cb2c3d28d1f487b6834cbafbb11a857f83ff6432f87ef75a`
- JSON 文件自身 SHA256：`163ad09f520704ccc34f5728511f49412433a1e331fc2a3be3130e36ed1dacf1`
- package-lock SHA256：`cff6e417898832bbcda1d0b9b4e8c0a9e6926a3780f07e01d7f7c56d2215b7b1`

清单工具/安装器/patch/hash inventory 自身均入冻结。保留旧 inventory 文件的当前 hash 见 static-artifacts.json；没有覆盖它们。构建工具相同且输入相同可复现 CLEC 的 dist；完整安装树是本机实际字节快照，不宣称跨平台或 fresh prepare 后每字节相同：上游 build-info 时间戳、npm 元数据和原生安装产物可能不同。Terra 应区分这类差异与受严格 guard 的四个 QMD 文件、源码及 CLEC dist 的差异；不得悄悄更新 guard 来放行。新建验收清单，不覆盖本冻结。

## Terra medium 可执行交接

仅交给 Terra medium 做真实 E2E，不委派给实现者做测试。先验证冻结 JSON 自身 SHA 和逐文件 SHA；若源码/输出/依赖出现未解释改变，先交回主审。适配旧 E2E harness 的 schema 3 / blocks / answerability 只能由 Terra 做，并保留旧 harness、原始报告和每次付费尝试。

以下是 **Terra 后续执行** 的正常 clean install/build 起点，本实现者没有运行其中产品命令。只复制显式构建输入，避免删除共享依赖或复制旧 session/密钥。凭据由主审按既有安全渠道注入；不要将其写入命令或报告。

```sh
set -e
export PATH=/Users/century/.nvm/versions/node/v25.7.0/bin:$PATH
export NODE_LLAMA_CPP_SKIP_DOWNLOAD=true HUSKY=0 CI=true
export CLEC_WORKSPACE=/Users/century/vibing/clec
terra_backend=$(mktemp -d /tmp/clec-terra-unified-backend.XXXXXX)
cp "$CLEC_WORKSPACE/backend/package.json" "$CLEC_WORKSPACE/backend/package-lock.json" "$terra_backend/"
cp "$CLEC_WORKSPACE/backend/tsconfig.json" "$CLEC_WORKSPACE/backend/tsconfig.installer.json" "$terra_backend/"
cp -R "$CLEC_WORKSPACE/backend/src" "$CLEC_WORKSPACE/backend/scripts" "$CLEC_WORKSPACE/backend/patches" "$terra_backend/"
cd "$terra_backend"
npm ci --no-audit --no-fund
npm run postinstall
npm run typecheck
npm run build
export CLEC_STATE_DIR=$(mktemp -d /tmp/clec-terra-unified-state.XXXXXX)
export CLEC_PI_DIR=$(mktemp -d /tmp/clec-terra-unified-pi.XXXXXX)
export CLEC_DIAGNOSTIC_PATH="$CLEC_STATE_DIR/diagnostics.jsonl"
node scripts/artifact-manifest.ts "$CLEC_STATE_DIR/acceptance-artifacts.json"
# 先核对原始来源选择和 manifest，再执行真实全库构建。
node dist/cli.js catalogue --root "$CLEC_WORKSPACE" --manifest "$CLEC_STATE_DIR/intake.json" --report "$CLEC_STATE_DIR/corpus.json"
node dist/cli.js build "$CLEC_STATE_DIR/intake.json" --hybrid
```

每条命令需独立保存实际 exit/stdout/stderr，失败停止；上面没有把失败隐藏为后续命令成功。保留已经批准的本地模型路径配置/模型缓存，不更换模型。**STATE 和 PI_DIR 必须同时全新**；schema 1/2 拒绝，无迁移，不重用旧 Pi 外部目录。全库基线先对照历史 6,775 sources 和各分类/版本/section 数，差异要解释；不能用部分库替代全库。

Terra 真实验收顺序及门禁：

1. clean install/production 安装、严格 guard 和 native/runtime 可用性；安装器在本轮已通过不代替 Terra 的真实启动。
2. 完整 hybrid 实际 embedding 超过 30 分钟，完成当前模型/fingerprint、document/typed metadata/partition 登记核对后才接受 READY/CURRENT。两小时是有限策略，不是任意语料完成保证。记录真实取消/timeout/coverage/cleanup 情况和 CURRENT/旧 generation 不变性；不可人为输出或 SDK 内部补丁制造证据。
3. unchanged 与 nonindexed-only intake reuse：真实向量复制及 zero new embeddings；真实 add/edit/remove/provenance-only 更新的来源版本、引用范围、删除来源不再检索和旧 generation 字节不变。补丁前 identity 不能 seed 补丁后；不降低 generation mismatch。
4. 完整 45 开发题和原有顺序前驱，特别 QA handoff 中 12 个历史失败、完整 009、小 031、033；逐 claim/条件/语义引用审阅，检查当前 R/E handle、C3-only、gap/context insufficient、host notes/no_hits。结构通过不代表语义通过。保留每次失败、insufficient、语义错误及 nondeterminism，不用重试后成功抹去首轮。
5. API/CLI、GET/SSE replay/restart 的 blocks/text/citations/history 一致；cleanup 后一次原子 final publication，真实失败/取消/超时无 final partial。覆盖真正观察到的 cancel/final races 和 commit-before-notify replay；未能观察的分支写 NOT_EXERCISED。
6. 结合 FIRST_PROVIDER_EVENT 的真实 cancel/crash、SDK settlement、session FIFO、并行隔离、饱和 slot 在 cleanup 后才释放、unsettled 删除/继续限制、shutdown/owned process reaping、Pi orphan/history 审计、scope/date/episode/restart、stale QMD 拒绝与恢复。不要将已结束流竞态说成 remote-active 证明。诊断回调/顺序/drop/轮转等按真实观察分级。
7. hybrid 证据按 hybrid-execution-evidence.md：CLEC HTTP 请求、实际 serving process/native 工作与独立 public SDK explain 区分；rerank cache hit、score 或模型映射不等于本次 fresh native inference。

**heldout12 不在此次授权内；只有主审另外明确授权后，独立 validator 才可打开。** 以上所有 runtime、质量及 lifecycle 验收在本次冻结时均为待 Terra 执行，不继承历史部分证据为通过。
