# Embedding 恢复与全库真实运行（2026-11-11 至 2026-11-12）

执行者为 GPT-6.1 Terra medium，未委派。全库 hybrid 构建退出 0，最终公开健康检查显示 pending 为 0，READY 和 CURRENT 指向同一 generation。6,775 条 EvidenceStore 原文与对应来源的 SHA-256 全部一致。unchanged build 保留该 generation，向量记录没有新增或变化。全库中文混合 HTTP 查询返回 200 和 10 条结果。这些结果不构成 45 题或 QA 质量验收。

本次没有修改产品、使用 mock、伪造 SDK 或模型结果、调用 DeepSeek、读取密钥或 held-out，也没有下载模型。证据根目录是 `/tmp/clec-recovery-terra-20261111-fGSHES/`。以下 `logs/` 路径相对此目录。原来源、历史 staging 和报告未覆盖。

## 冻结与安装

前置和最终 artifact-manifest 均退出 0。两次均为 21,487 项，逐项与冻结零差异，inventory SHA-256 均为 `eac6ee9f96666b01cc109975ea69b3e8e2d7c881c572569943e9e06f1b99e0ad`。记录为 `/tmp/clec-recovery-terra-preflight-20261111.json` 和 `/tmp/clec-recovery-terra-final-20261112.json`。源码与重建 dist 的 checksum 比较均无差异。独立安装的 node_modules metadata 不声称逐字节一致。

首次 `npm ci` 退出 1。PATH 混入旧 npm 和 node-gyp，Python 缺少 distutils，原日志保存在 `logs/install.log`。使用 Node 25.7.0 的 bin 路径和 npm 11.10.1 后，正常 `npm ci`、重复 postinstall guard、typecheck、build 均退出 0。日志和原始退出码保存在 `logs/install-retry.*`、`logs/guard.*`、`logs/typecheck.*` 和 `logs/build.*`。production omit-dev 未执行。

## 小库构建与 SIGINT 恢复

24 来源的真实 hybrid 构建退出 0，耗时 35.83 秒。54 个初始 pending 经 7 个单元降至 0，嵌入 85 chunks，生成 READY 和 CURRENT。`logs/small.stdout` 包含每单元记录。真实 QMD HTTP 中文 lex、vec 和 rerank 查询返回 HTTP 200、10 条结果。curl 和服务器均退出 0，证据为 `logs/http-retry-*`。首次客户端请求使用 127.0.0.1，而服务监听 localhost，导致连接失败；该次服务退出 0，日志保留在 `logs/http-server.log`。

增加 20 个真实来源后，在至少一个单元成功且下一次 reservation 已记录时发送 SIGINT。进程实际退出 1，输出 `CANCELLED`，等待退出耗时 0.251 秒。旧 CURRENT 保持不变，失败 generation 没有 READY。取消前 pending 从 87 降至 79，successfulUnits 为 1，attempts 为 3。取消后 active 已结算，chargedMs 为 4407.84。证据为 `logs/interrupt-*`。

信号发生瞬间 native inference 是否在途为 **NOT_OBSERVED**。本次不将精确 native 在途取消判为通过。

使用相同输入重启后，构建退出 0。公开 update 报告恢复时 pending 为 79，最终 pending 为 0，checkpoint 为 closed，并发布 READY 和 CURRENT。attempts 从 3 继续到 15。原 donor 的目录和 qmd.sqlite inode 均保留，取消前的全部文件 hash 与保留 donor 一致。donor 的 93 条 content_vectors 元数据在最终库逐字段保留，最终库为 180 条。证据为 `logs/donor-before.sha256`、`logs/donor-before-inodes.txt`、`logs/resume.stdout` 和 `logs/resume.stderr`。这些数据证明本次数据库记录复用与 pending 下降，不证明信号时 native 在途。

## 身份拒绝与 SIGKILL

在隔离 state 副本中改写一个真实 Markdown 文件后，同输入恢复退出 1，输出 `RECOVERY_REFUSED: Markdown evidence bytes changed`。证据为 `logs/identity.*` 和 `logs/identity-modified-file.txt`。在另一隔离 workspace 中修改一个真实来源文件后，构建退出 0 并产生新 generation `de1ebfafee1fda260397fea8a22c9cc7d971fd4c026a5bae2548e300740b2c4c`。旧未完成 donor 的文件 hash 全部不变，且没有 READY。证据为 `logs/source-identity-*`。模型字节和 policy 变化未逐项验证。

另一个隔离构建在 active reservation 后收到 SIGKILL。自有 PID 12610 经 wait 得到 raw exit -9。相同输入重试退出 1，输出 `BUILD_LOCKED`。确认 lock 内容与杀前一致且确切 owner 已不存在后，人工将该锁移至 `logs/confirmed-stale-BUILD.lock` 保存。没有增加自动删除 stale lock 的产品逻辑。

处理锁后恢复退出 0，最终 pending 为 0。SIGKILL 前 attempts 为 3、chargedMs 为 4535.21，active reservation 为 7200000 ms。最终 attempts 为 15、chargedMs 为 7230122.35，超过原 charge 加完整 unknown reservation。证据为 `logs/kill-*` 和 `logs/locked.*`。

## 全库构建

构建使用现有完整副本 `/tmp/clec-full-corpus-20261110-r6jctg/workspace`，以及原 manifest `/tmp/clec-full-corpus-20261110-r6jctg/state/full-intake.json`。manifest SHA-256 为 `779d05849efd50d6974f3b60c19dc788fe8f4953221fa0f8b3af48dc3df2d59d`。没有重新 catalog、textcopy 或迁移历史无 checkpoint 状态。新隔离 state 为 `full-state`。

构建前逐文件记录 6,775 个 ready 来源、204,686,007 bytes，零缺失。构建后重新计算全部来源 hash，零差异。随后将 EvidenceStore 的 6,775 条原文、记录中的 contentHash 与来源清单逐项比较，零缺失、零差异。证据为 `logs/full-source-before.json`、`logs/full-source-after-check.json` 和 `logs/full-evidence-hash-check.json`。

全库命令于 2026-11-11 15:10:30 UTC 开始，2026-11-12 09:29:57 UTC 结束。raw exit 为 0，wall time 为 65967.19 秒，产品记录的 embedding/SDK 预算为 65901.57 秒，低于 24 小时预算。外层允许 27 小时。构建过程没有重新启动或使用 lexical 替代。原始 stdout、stderr、退出码和开始结束时间在 `logs/full.*` 与 `logs/full-*-utc.txt`。构建包装进程记录了退出码，原构建 PID 已不存在。

初始 pending 为 30,565，3,821 个单元最终降至 0，共嵌入 160,948 chunks。每单元的 pending、文档数、字节数、chunk 数和耗时保存在 `logs/full-units.tsv`，原始账本为 `full-state/generations/0d59d05ffa26096251db158ec8d49504eec0757aa33e4dfdf30a67350fe5193f/embedding-work.json`。generation 为 `0d59d05ffa26096251db158ec8d49504eec0757aa33e4dfdf30a67350fe5193f`，checkpoint 的 phase 为 closed，READY 和 CURRENT 均指向该 generation。

在通过 SQLite backup 得到的独立副本上调用真实 QMD 公开 SDK。该检查退出 0，报告一个 active collection、30,565 文档、pending 0、pendingMetadata 0、vector index 存在、missingVectorPartitions 0。30,565 条文档均有 string 类型的 sourceId、sourceType 和 sourceVersion。原始输出为 `logs/full-health.json` 和 `logs/full-health.exit`。

## Unchanged 构建与全库 HTTP

使用完全相同的输入和模型运行 unchanged build，退出 0，耗时 10.54 秒。CURRENT 保持原 generation，返回内容与首次构建一致。比较 unchanged 前的数据库备份与运行后的数据库，160,948 条 content_vectors 记录均一致，新增或变化为 0。证据为 `logs/unchanged.*`、`logs/unchanged-current-*` 和 `logs/unchanged-vectors-check.json`。

对全库运行真实 QMD HTTP 中文 lex、vec 和 rerank 查询。curl 退出 0，HTTP 200，返回 10 条结果，客户端耗时约 30.12 秒。服务器收到 SIGINT 后退出 0，已等待退出。请求结果和服务日志保存在 `logs/full-http-*`。这项检查证明查询链路有响应，不评价答案质量或 45 题结果。

## 未观察项

交换 rename 的各中断窗口、精确 native 在途取消、超时、无进展、byte 或 chunk 超限、callback、数据库、cleanup 和 close 故障均为 NOT_OBSERVED。没有构造账本、SDK 返回或产品 fault injection。小库恢复结果不能外推为全库故障恢复覆盖。45 题、held-out、QA 质量以及增删改和协议回归未执行。

## 全库终态与接管后核验（2026-11-12）

原 CLI PID 12817 的 kqueue 退出事件已观察；原 `/usr/bin/time` PID 12816 与 zsh wrapper PID 12812 随后均不在进程表。原 wrapper 在其子进程返回后写入 `logs/full.exit` 为 **0**、`full-end-utc.txt` 为 `2026-11-12T09:29:57Z`；`full.stderr` 的 time 记录为 real 65967.19 秒。观察者不是其父进程，无法亲自 wait，也不声称自己回收了原进程；wrapper 写出的退出码与进程消失是可见证据。未重置预算或另起全库构建。

原构建 checkpoint `closed`、remaining 0、active null，3,821 成功单元，chargedMs 65901569.767，embedding-work 记录 160,948 chunks；`CURRENT` 和 `READY` 均为 `0d59d05ffa26096251db158ec8d49504eec0757aa33e4dfdf30a67350fe5193f`。独立 CLI status raw exit 0（`logs/full-status.*`）。独立公开 QMD SDK check raw exit 0（`logs/full-public-check.*`）：唯一 collection，30,565 active 文档，status needsEmbedding 0、pendingMetadata 0、hasVectorIndex true；health needsEmbedding 0、totalDocs 30,565、missingVectorPartitions 0；sourceId/sourceType/sourceVersion 三个 string 类型过滤覆盖 30,565。实际集合路径与 generation Markdown 目录一致。

逐项复核 6,775 个原始文件及隔离 workspace，共 204,686,007 字节；原始文件、copy ledger 的 originalSha256/copySha256/catalogueContentHash、预检清单和 evidence.sqlite 的原文及 contentHash 均匹配；intake ready 来源集合和 source metadata 一致（`logs/full-original-after.json`、`logs/full-sources-after.json`，各 raw exit 0）。manifest SHA-256 仍为 `779d05849efd50d6974f3b60c19dc788fe8f4953221fa0f8b3af48dc3df2d59d`。

同输入 unchanged CLI build raw exit 0，11.07 秒，返回同一既有 generation（`logs/full-unchanged.*`）；该 READY generation 的已存在分支跳过 QMD build，返回的是原 generation 的历史 embedding 指标，不能把其中 160,948 当成此命令新嵌入。未在命令前后记录独立向量计数或推理调用观测，因此“本次零新增 embedding”作为动态门禁仍未独立证明。

全库中文 lex+vec、`rerank:true` HTTP 尝试失败：observer raw exit 1，Python urllib 收到 **HTTP 502 Bad Gateway**，QMD 服务日志仅见启动与 SIGINT，未见请求执行日志；不能判断准确故障归因，不能声称 lex、vec 或 rerank 已执行（`logs/full-http-observer.stderr`、`full-http-server.log`）。服务 PID 由本次 observer 创建，SIGINT 后其真实 `wait` raw exit 0，进程已消失。没有 lexical 替代或重启全库 build；HTTP 检索及实际模型执行证据仍待完成。

最终共享 artifact-manifest raw exit 0，21,487 项 `files` 与冻结逐项相等，inventory SHA-256 `eac6ee9f96666b01cc109975ea69b3e8e2d7c881c572569943e9e06f1b99e0ad`（`logs/shared-final-20261112.*`；整份 JSON 的 createdAt 自然不同）。原先未自然观察的门禁仍保持 NOT_OBSERVED；此结果不代表 QA 质量或完整验收。
