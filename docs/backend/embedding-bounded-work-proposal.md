# 嵌入有界工作、会话轮换与恢复提案

2026-11-11，Sol medium，仅调查设计，未实施或测试。依据 `embedding-bounded-work-design.md`、`embedding-patch-handoff.md`、`unified-hybrid-development-20261111.md` 和本机锁定源码。未运行 QMD、产品、模型、测试或数据库诊断；未打开模型文件、凭据、held-out，未改写或打开原失败 staging 数据库。失败状态事实沿用既有报告：6,775 来源、30,565 索引文档，2h1m35 后失败，needsEmbedding=26,446，无 READY/CURRENT，45 题全部 NOT_EXERCISED。这些数字不等同于待处理独立 content hash 数或吞吐基准。

## 定位与结论

锁定 QMD 2.8.3，commit `86d2365d17fc682e491c2c53d1e4a884aee8682a`。本轮完整旧 inventory 核验已确认依赖字节未变；对应精确 hash 见新的 protocol-fix inventory，它只改变回答协议六文件及其 dist。

- `dist/index.d.ts:227` / `index.js:251`：公开 embed 只有 collection、内部批大小、寿命、chunkStrategy、progress 等参数，没有单次总文档/字节上限或 signal。现接口不能自然完成要求；按 collection 临时拆分、应用侧 SQL 或重复运行旧 embed 均不推荐。
- `store.js:1715–1745`：待处理选择按当前 model/fingerprint，活动 documents 按 hash 去重、按 MIN(path) 排序。当前 iterate 最后仍收集全部 metadata。工作单位应称“待处理 content hash”，不能把它和活动文档或来源混称。
- `store.js:1746–1765,1792–1814,1894`：maxDocsPerBatch/maxBatchBytes 只控制内部加载；首个超大文档可单独超出字节限额。全部待处理文档共用一次 withLLMSessionForLlm。
- `store.js:1907–1925,1944–2039`：分词和 chunk 数生成发生在会话内；失效后可以 break 并跳过批次，docsProcessed 却是初始 totalDocs。chunk 写入事务不等于完整文档提交；正常返回不等于覆盖完整。
- `store.js:4132–4163`：insertEmbedding 登记当前 fingerprint；removeIncompleteEmbeddings 只按 hash/model 查行数，且不是异常路径 finally。取消/崩溃时不能假定 partial 已被清理，也不能仅以行数相等证明 seq 连续完整。
- `store.js:112–123`：fingerprint 是模型名、格式探针及 chunk 参数的 SHA256 前六位；它不绑定本地 GGUF 字节，也不包含全部 chunkStrategy/运行环境。checkpoint 必须另外绑定完整身份，不能只保存这个短串。
- `llm.js:1508–1660`：每次 withLLMSessionForLlm 都创建/释放 session，复用传入 llm；release 不主动 dispose 模型。会话轮换可复用一个公开 store，避免每单元 close/createStore。原生操作只在入口检查，不能保证即时中断。
- CLEC `generation.ts:110–139`：只有 BUILDING.id 的目录被隔离为 .failed-*，没有恢复协议；`qmd-build.ts:59–97` 的公开完整性门禁及 close-before-success 必须保留。

结论：可以通过小范围、明确的公开补丁能力限定一次选中的待处理 hash；需要新增工作选择/结果契约和异常安全收尾，不能只把现 embed 套循环。建议三个职责模块，保持现分词/向量算法和 published generation 格式。以下为待主审批准的接口设计，不是当前可调用 API。

## QMD：新增公开 embedWork，不改变旧 embed 契约

建议在 root SDK 新增 `embedWork(options): Promise<EmbedWorkResult>`，types/wrapper/store 四个分发文件同步修改。将旧 generateEmbeddings 的共享处理段提取成内部函数；旧 embed 保持兼容，新入口显式启用有界选择与严格结果。不要复制整套 embedding 算法。新增类型从 root 导出，CLEC 不 deep import。

```ts
interface EmbedWorkOptions {
  collection: string;
  chunkStrategy: 'regex';
  maxDocuments: number;       // distinct pending content hashes
  maxInputBytes: number;     // 选中 body 的 UTF-8 bytes 总和
  maxDocumentBytes: number;  // <= maxInputBytes
  maxChunksPerDocument: number;
  maxDurationMs: number;     // 单单元有限寿命
  signal?: AbortSignal;
  onProgress?: (progress: EmbedWorkProgress) => void;
}
interface EmbedWorkResult {
  outcome: 'complete' | 'bounded';
  identity: { model: string; fingerprint: string; chunkStrategy: 'regex' };
  pendingBefore: number;
  selectedDocuments: number;
  selectedBytes: number;
  completedDocuments: number;
  remainingDocuments: number;
  chunksEmbedded: number;
  chunksCopied: number;
  durationMs: number;
}
```

没有 force 或 model override：取 store 配置的当前模型，避免每轮清空以及计数模型不一致。现内部 32 docs/1,000,000 bytes 加载界限继续作为内存策略；新总工作上限独立于它。初始建议每单元最多 8 hashes / 1,000,000 输入 bytes，每文档最多 1,000,000 bytes / 2,048 chunks，单元寿命先保留现有限 7,200,000ms、不延长。数值是待真实 E2E 评估的保守初值，不能保证 8 文档能在时限内完成；任何失败停止，不自动调限重试。字节/chunk/计时策略及算法 revision 纳入 settings。若合法语料超限，交回主审调整有版本的分段或策略，不能静默跳过。

选择阶段在 QMD 内复用 pending 谓词，稳定排序增加 hash tie-breaker；SQL LIMIT maxDocuments+1，迭代 metadata 时累积字节，达到任一界限即停止，不读取整个语料 body、不使用 OFFSET 或应用持有游标。remaining 每轮由数据库事实重算。选中前遇到超 maxDocumentBytes 的首文档立即抛固定 DOCUMENT_LIMIT；选中前缀后遇到下一个装不下的文档则返回 bounded，下一轮仍面对同一文档，不能跳过它。数值必须 positive safe integer，duration 遵守 Node timer 上限；缺失 collection/非法大小/丢失 body/空白无 chunk 均失败。输入字节限制不限制 SQL 聚合扫描时间，也不是整个调用的硬 CPU/内存保证。

仅选定有界前缀后才开一次 session。每文档按原算法分词，在产生超过 maxChunksPerDocument 的下一 chunk 时停止并报 DOCUMENT_LIMIT；不先把无界 chunk 列表全部物化再检查。字节上限先于分词，任何 native/tokenizer 操作仍为协作式。保留既有有上限的 chunk retry/fallback；新的单元间调度不重试错误，也不把会话过期转换成 bounded。

`complete` 当且仅当当前 collection/model/fingerprint 的 remaining=0；`bounded` 仅表示选定文档全部完成、无错误、会话有效而选集之外还有 pending。超时、取消、模型/DB/回调失败或任一选中文档不完整均抛出 typed work error，可携带固定 code 和数字计数，不能返回 bounded。错误中的部分成果仅供下一次显式恢复，不授权继续当前循环。

完成计量要验证每个选中 hash 的 expected chunk 数、seq=0..n-1、model/fingerprint 及对应 partition 登记，再计 completedDocuments；不能复制 docsProcessed。QMD 内扩展局部完整性 helper，与 pending/count 共用谓词。部分文档重做之前，在事务中清理该 hash 不完整/错 fingerprint 的 content/partition 登记并按整文档重嵌；完整文档不重做，不尝试跨崩溃拼接部分 chunks。这是对所选 hash 的局部恢复，不清空整个索引，不改变向量算法。清理失败本身必须拒绝，不掩盖原错误。

取消在选择、加载、每文档分词前后、每个 native batch/retry 前后、提交后和返回前检查；取消/expiry 不可被现有 broad catch 当成普通 chunk 失败继续重试。通过 withLLMSessionForLlm 的 options.signal 链接外部 signal；用每单元中转 AbortController 和显式具名 listener，在 finally remove 外部 listener，避免连续成功单元累积现有 LLMSession 的匿名 listener。chunker 使用 session.signal；尚不支持信号的 native embed 必须 await settle 后再释放，不使用 Promise.race 伪装结束。即使最后一次写完时过期，仍按 timeout 失败保留成果。保留主错误优先及 release 的 finally，不声称 hard deadline。

## CLEC：单独的 embedding-work.ts 调度策略

`qmd-build.ts` 继续拥有 store/update/retire/health/close，仅将原一次 embed 调用替换为 `runEmbeddingWork(store, policy, identity, signal, checkpoint)`；新模块只使用 root SDK，没有 SQLite 私表查询。embedding-policy.ts 持有并验证所有工作上限；settings 中 bump embeddingRevision 并绑定这些值，补丁和 installed hashes 同步更新严格 guard。

在 sole collection/update/typed metadata 已核对且不再修改文档的独占窗口中，先取当前模型 pending=P。最多执行 P 个非空成功单元（P=0 时仍做最终 health 门禁），每次要求 identity 相同、pendingBefore 等于上轮 remaining、selected 在策略界限内、completed=selected>0、remaining 严格下降且差值等于 completed。缺失/非法/增长/不一致计数、bounded 且 remaining=0、complete 且 remaining>0 均拒绝。remaining>0 而 completed=0 为 NO_PROGRESS，立即失败；不能靠无限循环或重试同一失败单元。内部向新 collection 的已有向量复制需在初始 pending 快照之前完成，复制与新 embedding 计数分列，避免差值被复制混淆。

每单元成功后持久化序号、耗时、selected/completed/remaining 和 identity；chunksCopied/chunksEmbedded 保持分列，不把返回量当作覆盖证明。总预算有限：maxWorkUnits=P，累计已耗单元/时间跨恢复保留，并建议另设显式有限总耗时预算（初值待主审，不能借恢复重置预算）。时限检查在调用前后，原生期间不能硬停；预算耗尽即保存并退出，不自动重启。若无可信起始 P/累计账本则拒绝恢复。日志只报实际观察的阶段时间；无分段 instrumentation 时不推断 tokenizer/native/SQL 各自耗时。

结束仍逐项执行现有唯一 collection/path、active count、typed sourceId/sourceType/sourceVersion、pendingMetadata=0、hasVectorIndex、status/health needsEmbedding=0、totalDocs、missingVectorPartitions===0。计数相等不证明向量语义质量。await qmd.close 成功后 generation 才能写 READY，再走现 CURRENT 原子切换；失败/取消/清理失败均无 READY/CURRENT。

## generation：显式 checkpoint 与只读 donor 恢复

新增 `embedding-checkpoint.ts`，只负责 checkpoint 严格解码、身份比较、原子写入及恢复计划；generation.ts 保有 BUILD.lock、目录生命周期和发布职责。接口建议为 `loadCheckpoint(directory, expectedIdentity)`、`writeCheckpoint(directory, checkpoint)`、`planResume(checkpoint, observedArtifacts)`；qmd-build 不决定 published generation 复用规则。

checkpoint v1 包含：schemaVersion、phase、generation id、canonical manifestHash 与 intakeFileHash、全部 admitted source(id/version/contentHash) 摘要、EvidenceStore bundle/section 清单摘要、排序的生成 Markdown(path/bytes/SHA256) 清单摘要、期望 source/section/document 数、完整 build settingsKey、embedding policy/revision、QMD commit/version/四个 guarded artifact hashes 和 patch inventory hash、Node/platform/arch/llama 版本、模型 URI/实际本地模型 SHA256、实际 QMD fingerprint，以及初始 P、已成功单元/尝试/累计时间/剩余计数。HF URI 也必须解析到可校验的实际模型制品身份；未获得字节 hash 或稳定已核实的制品身份则不授权恢复，不能仅靠路径。不得在 checkpoint 保存密钥或模型文本。

在 evidence/markdown 完整生成并校验后写 phase=prepared；QMD update/retire 和目的 collection 门禁完成后写 phase=embedding；每个成功单元后用同目录唯一 tmp、fsync、rename、目录 fsync 更新。崩溃后 checkpoint 可能落后于数据库事务；它是身份和累计预算下界，剩余量仍由 SDK 重算。尝试开始前先持久化 attempt 和已分配最大单元时长，完成后结算实际时间；未知中断按已分配额度扣除，防止反复崩溃重置预算。预算账本不与 SQLite 声称跨库原子。

恢复只接受完整身份匹配、无 READY、不是 CURRENT、phase=embedding 的新协议目录，并在持有 BUILD.lock 后重新验证 manifest 实际来源字节、证据与 Markdown 清单。未知/损坏/mismatch checkpoint 隔离保留并明确失败交回，不自动当作新空白构建覆盖。prepared 阶段失败沿用明确重建策略，不贸然复用半个 update。STALE BUILD.lock 不自动删除。

推荐以失败目录作只读 donor，新建 attempt：通过 Node SQLite 官方 readOnly+backup API 取 coherent qmd DB（含 WAL 提交），复制并重新 hash evidence/Markdown；不得只 copy 主 sqlite、hardlink、打开 donor 的 QMD store 或在 CLEC 执行 QMD 私表 SQL。生成新 checkpoint 后，在锁内把 donor 改名隔离、将 clone 移到原 deterministic final 路径，然后才打开 clone 的公开 QMD SDK。这使现 index.yml 的 canonical collection/path 不漂移；不用扩大到任意路径搬迁或去改 published 目录。保留小型恢复意图文件（原/clone/隔离路径、身份和阶段），覆盖两个 rename 之间的崩溃：下一次只按严格匹配的意图恢复交换，歧义则失败；不丢弃任何 donor。所有 QMD update/cleanup 均在 clone 上进行。

公开 update 重新核对生成文档/metadata，再取 pending；对未完整 hash 按上节整文档重做，完整文档向量保留。checkpoint 序号不作为跳过工作的游标。close 前/后崩溃、generation.json 已写但无 READY 等阶段须由明确状态机识别；仅当 identity 和全部门禁重新满足且 close 成功才补完发布，否则拒绝。CURRENT 指向损坏 generation 的现有拒绝策略不放宽。

**既有 20261111 失败 staging 没有 v1 checkpoint，且新补丁会改变 settings/hash：不允许自动导入或续做。** 本轮完全保留它。本方案的跨重启恢复从新版构建开始生效；若主审希望抢救旧 4,119 左右已覆盖 hash 的工作，必须另审一次性只读迁移/兼容证明，不能由 30,565-26,446 推出可复用数量或修改 identity 放行。

## 范围、交回主审与后续门禁

当前不修改任何 embedding、generation、依赖、patch 或安装器。建议后续范围为公开 QMD 四文件补丁及 guard inventory、CLEC embedding-policy/settings/qmd-build/generation、新 embedding-work/checkpoint 两模块；无需通用任务系统、会话持久化框架、chunk 级续传或更换模型。恢复交换日志是必须明确实现的持久化职责，不能在现 BUILDING.id 上拼接 while 循环。若实现发现必须改全局向量布局、跨库事务或分词算法才能保证文档级完整性，应停止并交回主审做较大设计；本提案不授权此类重构。

主审需先决定工作/文档/chunk/总时间上限、是否接受超大文档明确失败、donor clone 恢复状态机，以及不自动抢救旧 staging 的边界；批准后由 Sol medium 实施和静态构建、新冻结。Terra medium 独占所有真实 E2E：小真实库跨单元、取消/重启恢复、模型字节/策略/Markdown 身份变动拒绝、实际无进展/超限/超时和 cleanup 行为（未自然观察则如实标记）；随后完整 6,775 来源/30,565 文档覆盖、unchanged 零新增向量、增删改/provenance、45 题及原生命周期/性能门禁。不能伪造输出或写 mock/unit/component/smoke。held-out 仍封存，待主审另行指定最终版本和授权。此提案没有真实验收通过结论。
