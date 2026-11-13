# 有界嵌入工作实施与冻结交接

2026-11-11，实施身份 gpt-6.1-sol，medium；未委派。已实施 QMD 公开 embedWork 与 CLEC 单进程有界调度，**真实运行验收未执行**。generation 跨进程 checkpoint、donor clone、恢复交换状态机留下一步，不能由本交接或 embedding-work.json 授权恢复。

## 冻结入口与范围

[最终独立 inventory](embedding-bounded-artifacts-20261111.json)：21,467 项，inventory SHA-256 `a4dff2a3fd1f9911e9180f1967229e99da71f1fd00d941e4fba82e8588fdb932`，JSON 文件 SHA-256 `1872f59633aa49b88cd7e730edcc3276704b5327a71ad7e54e1ee9349e08d7db`。生成命令 `node backend/scripts/artifact-manifest.ts docs/backend/embedding-bounded-artifacts-20261111.json`，raw exit 0。Node 25.7.0、npm 11.10.1、darwin arm64。

输入 [协议补丁基线](protocol-fix-artifacts-20261111T132248684975Z.json) inventory `ba30696d7107236d55bb33f447bc2d87d5b0a79b485e6b02326ef9e31b3c08e2` 的 21,463 项逐项匹配，零 mismatch；没有 Git 元数据，故用完整冻结清单及实施前独立副本保护已有修改。[基线核对记录](embedding-bounded-baseline-check.json) 保存副本位置。[新旧差异](embedding-bounded-validation/inventory-comparison.json) 明列全部变动：新增 embedding-work.ts 及三个编译产物；修改 embedding-policy/settings/qmd-build 及其编译产物、QMD 四个分发文件、可重复 patch、hash inventory、安装器。无删除；package/lock、QA/session/API、generation.ts 与其他依赖均未改变。

原失败 staging、原文、历史 inventory 与历史报告保留，未打开或改写 staging。未运行产品、QMD CLI、模型、服务或任何测试；未下载模型、读取密钥或 held-out。独立 npm 安装的依赖生命周期允许执行，显式禁用 llama 下载；不等于 native runtime 已验收。

## 实施契约

QMD root 导出 EmbedWorkOptions/Progress/Result/Error，QMDStore.embedWork(options)。旧 embed 签名/返回格式保留，共享处理引擎避免复制嵌入算法。pending 选择/公开计数共用严格谓词：全部 hash 行必须属于当前 model/fingerprint，expected 一致且正数，seq 为整数、从 0 连续至 n−1，并具有活动 collection 的 partition 登记。每个选中 hash 再与实际 chunk 数核对；partition 检查是登记/可读性检查，不是任意物理损坏或向量语义质量鉴证。

按 MIN(path)、hash 稳定排序，SQL LIMIT maxDocuments+1；只累计有界 metadata 前缀及所选 body 的 UTF-8 bytes，不读取全库 body，无 OFFSET/应用游标。缺失 body、空白/无 chunk、单文档超限失败。下一个文档装不下时停止当前前缀，下一单元仍面对它，不跳过。选中前清除其 partial/错身份 content 与 partition，按 hash 事务提交；失败后保留严格完整文档，其余按 hash 事务清理；cleanupError 附于主错误，仍拒绝整个调用。未选中 hash 不做局部清理。

字符切块核心提取为共享惰性迭代器，公开数组入口保留；有界路径及递归子块按需消费，在追加第 maxChunks+1 个输出前抛 DOCUMENT_LIMIT。原切点、overlap、surrogate 防护、tokenizer、递归缩小与 fallback 算法/模型保持。限制前还有输入字节门禁；不声称 SQL 聚合扫描或 native tokenizer 的硬 CPU/内存/耗时上界。

每个非空工作单元独立 withLLMSessionForLlm，复用同一 store/llm；外部 signal 通过单元 relay 链接，在 finally 移除具名 listener 并 abort relay，使成功单元不积累 caller listeners。选择、加载、分词、native batch/retry、提交与返回边界协作检查；取消/过期不被 broad catch 转成 chunk retry。已有有限 native chunk fallback/retry 保留；DB/工作错误不进入该 fallback。await tokenizer/native settle 后再清理与释放，无 Promise.race 或硬中断承诺。complete 仅 remaining=0；bounded 必须选集全完成且选集外仍有 pending；错误绝不返回 bounded。

CLEC embedding-policy 负责正 safe integer、timer 范围及相互约束。默认每单元 8 pending distinct hashes、总输入 1,000,000 bytes；单文档 1,000,000 bytes / 2,048 chunks；单元 7,200,000 ms，总调度 86,400,000 ms（24h）。生产无 QA/env 预算改动。完整 policy 与 revision `qmd-regex-bounded-work-strict-document-v3` 绑定 settings key，installed JS hash 继续绑定依赖实现。

qmd-build 在 update/retire/vector-copy 后核对唯一 collection/path、文档数及 typed metadata，再取得初始 P。runEmbeddingWork 最多 P 个非空成功单元；核对 model、稳定 fingerprint、pendingBefore=上轮 remaining、selected/completed/remaining 差值、字节/数量界限及 outcome 一致。NO_PROGRESS、预算耗尽或任何错误立即停止，单元间没有错误重试。update.vectorsCopied 与工作 chunksEmbedded/chunksCopied 分列；embedWork 自身不做隐藏复制，避免 pending 基线漂移。

每成功单元的 sequence、identity、耗时、selected/completed/remaining 和独立 chunk 计数以同目录唯一 tmp→fsync→rename→目录 fsync 写入 embedding-work.json；schemaVersion=1、resumable=false。该账本仅记录本次进程成功单元及累计时间，不含跨进程可信身份/attempt 预算，**不是 checkpoint**；失败单元的部分成果不授权继续本次循环。总时限包括该调度的公开 status/账本操作，调用前后检查，native 期间可能超出；不包含前面的 evidence/update 等阶段。

最终仍要求 public status/health needsEmbedding=0、hasVectorIndex、totalDocs、missingVectorPartitions=0 及唯一 collection/path/metadata 约束。await qmd.close 成功后 buildQmd 才返回，原 generation 流程随后检查并写 READY/CURRENT。失败/取消/close 失败不能由本实现批准发布。

## 安装 guard 与原始退出

QMD 2.8.3，commit `86d2365d17fc682e491c2c53d1e4a884aee8682a`。最终 patch SHA-256 `8e8db70e197033a74f89f0fcd44f275fd9db7f219d080514b356e56bd7e6c21e`，安装器在任何 already-patched 快路前校验该 SHA；精确 pin/version、四文件 pristine/after 全集检查和 patch-package --error-on-fail --error-on-warn 保留。混合/未知字节拒绝，无模糊匹配。

| guarded 文件 | 最终 SHA-256 |
| --- | --- |
| `dist/index.js` | `2c69ee0f98e4b39d8178658ba52ae8e33ee7e107e6d92afea6fa55f4ee72f5d8` |
| `dist/index.d.ts` | `d04c2aaef075c8b4758070dd2460a6171d54e9fb8966104519dff35c860e1fc4` |
| `dist/store.js` | `ea25bfaf10709a6703c6648739a3e2927c267c676a95b0116b2bec858452e0b9` |
| `dist/store.d.ts` | `63c68c4a01a3ddda0f8283f4166368042dcae6a34b2fe6229202e99a8138b488` |

[完整 before/after hashes 与材料化位置](embedding-bounded-materialization.json)。最终 [raw exit](embedding-bounded-validation/sealed-rawexit.json) 和同目录 stdout/stderr：独立 pristine→最终 patch、独立重复 guard、共享 guard、npm run typecheck（含 installer）、npm run build、node --check store.js 全为 0。这是安装和静态编译，不是验收通过。

独立目录见 [安装位置](embedding-bounded-install-location.json)。先以 `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true HUSKY=0 CI=true` 和 Node 25.7.0 PATH 执行 `npm ci --no-audit --no-fund`，raw exit 0（302 packages）；随后 postinstall raw exit 0。[原始记录](embedding-bounded-validation/install-rawexit.json) 属于收尾前候选 patch（SHA `51fab9cd8647c27747bf62e10839a185fe740b532be7e988c8e30fcc448c42e8`）。最终源码复核加强 seq 类型检查与事务清理后，在**同一独立安装**中仅将四文件恢复为已核验 pristine，再复制最终 patch/installer、应用并重复验证，均 raw exit 0；没有再次声称最终完整 fresh npm ci 已运行。npm 发出 git SSH integrity-skip 与 node-domexception deprecated 警告；artifact guard 仍通过。共享 node_modules 未删除。production omit-dev/native availability 未运行。

早期有一次编辑脚本从 backend cwd 使用 backend/... 相对路径而 FileNotFoundError（Python exit 1，组合 shell 因随后 typecheck 成功返回 0）；当时未产生编辑，随后在正确 cwd 修正。该次 typecheck 与后续候选静态日志不是最终冻结依据；最终以上 sealed rawexit 为准。

## 未执行的 Terra medium 门禁

所有测试由 Terra medium 亲自执行，必须真实 E2E，无 mock/unit/component/smoke，本实施未写或运行任何测试，也未委派：

1. 对最终冻结独立正常 npm ci（含 production 方式）验证精确 guards、公开 API 与真实 native availability。开始运行前重算全 inventory；本冻结与协议补丁已经统一，协议入口见 [protocol-fix-handoff.md](protocol-fix-handoff.md)。
2. 真实小库跨多个工作单元；核对 pending distinct hashes/字节/seq/expected/model/fingerprint/partition、unit sequence 和 session 生命周期。真实取消、超时、无进展、超 byte/chunk 限额、回调/DB/cleanup 失败只在自然可观察条件下记录；不可伪造分支，未观察项如实标记。保留原始失败与 cancellation settlement 时延。
3. 当前仅单进程调度：取消后停止、无 READY/CURRENT、先前 generation 可读。跨进程 checkpoint/clone 恢复与身份变动拒绝误复用须待下一步实现并重新冻结，**本版不能把“取消后恢复”判通过**。旧 20261111 staging 无 checkpoint、身份也变，不自动导入或抢救。
4. 完整 6,775 来源/30,565 文档真实 hybrid 构建与全覆盖、unchanged 零新增向量、增删改/provenance、原生命周期与冷/热性能门禁；实际阶段数据才可报告，不能推断 SQL/tokenizer/native 耗时。
5. 统一协议修复真实回归、45 题开发集与原全部目标；当前仍 NOT_EXERCISED。held-out 继续封存，待主审指定最终版本和授权。任何编译或小库结果不能代替全库与语义验收。
