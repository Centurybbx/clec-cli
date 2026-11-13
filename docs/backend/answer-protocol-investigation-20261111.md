# ANSWER_PROTOCOL 只读证据调查 — 2026-11-11

调查者：GPT-6.1 Sol medium；供主代理最终审阅。本轮只读取已有文档、源码和真实运行证据，并新建本备忘录。未运行产品、模型、测试、构建、安装或产品解析器/验证器，未读凭据或 held_out.jsonl，未委派，未修改产品、冻结文件、原始日志或既有报告。读取 JSONL 时仅投影已有记录及计数，未据此执行产品验证逻辑。已先读 unified-freeze-20261111.md、qa-contract-handoff.md、qa-contract-decision.md 和 unified-install-lifecycle-20261111.md。

冻结 inventory：`5cd0cbb4f2d21486cb2c3d28d1f487b6834cbafbb11a857f83ff6432f87ef75a`。本轮不重新执行全清单核验；采用原报告 freeze-before/after 的身份结论，未触碰另一 Terra 正在验收的产品。以下源码位置均相对项目根目录；原始证据根目录记作 **D**：`/tmp/clec-unified-lifecycle-terra-20261111/`。JSONL 行号为物理行号。

## 已证明的直接原因

三个失败输出都是完整 JSON，顶层只有 `blocks`；共同问题是最后的 **gap 块含多余的 `evidenceIds`**。当前 gap 契约恰好只有 `kind,text`。静态逐条对照可定位最先失败处为 `backend/src/domain/answer.ts:21` 的精确字段集合校验，并非 JSON 解析、未知证据、预算或截断。最小结构示意（文本和句柄均省略，不是原始语料）：

```json
{"kind":"gap","text":"…","evidenceIds":["…"]}
```

| run | 原始 Pi 文件（D/pi/ 下）与位置 | 实际 blocks | 拒绝点 |
| --- | --- | --- | --- |
| 300e336a-cfa4-495d-a164-8f8bbf0a4e77 | `2026-11-10T16-53-11-814Z_01a1c660-c006-72f6-9791-462902334d4f.jsonl:12`；当前上下文 :11 | answer、answer、context、gap | 第 4 块 gap 的额外 evidenceIds |
| cfa313af-98fd-4573-9b44-a192f03293a0 | `2026-11-10T16-53-23-835Z_01a1c660-eefb-72f6-9791-462aa8c4274f.jsonl:7`；当前上下文 :6 | answer、context、gap | 第 3 块 gap 的额外 evidenceIds |
| 4a112c3c-2757-40db-96aa-c422882c3b2b | `2026-11-10T16-53-36-168Z_01a1c661-1f28-72f6-9791-46335ab5129c.jsonl:7`；当前上下文 :6 | answer、context、context、gap | 第 4 块 gap 的额外 evidenceIds |

这不是仅凭 ANSWER_PROTOCOL 猜测：三份 Pi assistant 原文均存在。D/pi-after-crash/ 中同名文件也保留相应记录；本轮主要引用 D/pi/，不把副本计作额外尝试。每个失败仍独立保留，后续成功不覆盖它们。

## finish、严格分支和预算的逐条静态对照

三个 assistant 记录的 `stopReason` 和 `rawStopReason` 都是 `stop`，各只有一个 text content；没有 fence 或 JSON 外说明，闭合完整。输出 usage 分别为 397、380、419 tokens，远小于 2048；原始 JSON 分别为 1224、1228、1413 UTF-8 bytes。SDK 在 `backend/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:360` 保存原始 finish reason，在 :1192 起将 length 映射为 length；产品 `qa/pi.ts:132` 在解析前要求 stop。**已有证据不支持长度截断**；这不保证模型语义完整或所有请求部分均覆盖。

静态路径如下，不是一次验证器重放：

1. `qa/pi.ts:127–133` 等待 idle、检查 abort/fatal、成功 settled 与 stop，才将最后 assistant text 交给 parseModelAnswer。SDK `agent-session.js:3698–3719` 拼接最后 assistant 的 text 并 trim；本次各一段，未见提取错消息的迹象。
2. `domain/answer.ts:37–41`：raw bytes 都低于 65536；三者都是对象且仅有 blocks，JSON 语法完整。
3. :15–22：blocks 分别为 4/3/4，低于 16；各块都是对象且 kind 属于允许值。此前 answer/context 的字段恰好为 evidenceIds,kind,text；各 text 非空，UTF-16 长度分别为 `[112,51,87,68]`、`[195,74,90]`、`[139,104,79,60]`，均低于 4096；此前 text 未见 :23 禁止的方括号引用标记。
4. :26–29：此前 answer/context 的引用均为非空、无重复的当前已发 E handle，与对应 context 的 issuedEvidenceIds 一致。没有使用历史 E 或 host C ID。gap 携带的 ID 也属于当前 run，但 gap 根本不允许该字段；合法 ID 不会使多余字段合法。
5. 遍历到最后 gap 时，:21 比较所得字段集合为 evidenceIds,kind,text，期望 kind,text，立即抛出 ANSWER_PROTOCOL。其后总文本/引用上限与 deriveAnswerability 不会执行；从记录规模静态看也没有接近这些上限，但不能把未执行的分支写成运行通过。
6. `qa/service.ts:118–122` 的 E→C normalize、reader 引用复核及 final render 尚未到达；`sessions/scheduler.ts:202` 的 result 校验也尚未到达。不是存储侧拒绝已产生的有效结果。`pi.ts:136`、`service.ts:125`、`scheduler.ts:209` 可重复记录同一异常传播，不能把多条 FAILURE 算成多次模型尝试。

预算与公开结果的独立佐证：

| run（前缀） | D/diagnostics.jsonl | 请求 admission units / context bytes | D/events.jsonl |
| --- | --- | --- | --- |
| 300e336a | :25–33（第一 qa failure :29） | 44606 / 42558 | 提交 :9、FIFO :11、SSE :14、settled GET :15、history :18 |
| cfa313af | :50、:52–61（第一 qa failure :57） | 22814 / 20766 | 提交 :21、SSE :23、settled GET :24、history :27 |
| 4a112c3c | :106–114（第一 qa failure :110） | 22814 / 20766 | 提交 :47、SSE :53、settled GET :54 |

三者都是 requestOrdinal=1、ADMITTED，limitUnits=240000、此前 reservedUnits=0；GET 均记 modelCalls=1、modelRequestAttempts=1、toolCalls=0、searchAttempts=1、readAttempts=2、readCharacters=3532、result=null。provider 顺序均为 HTTP_RESPONSE → FIRST_PROVIDER_EVENT → STREAM_END → qa FAILURE → provider LOCAL_SETTLED → 后续 qa/scheduler FAILURE/settlement，无 MODEL_BUDGET 拒绝。没有证据支持通过加预算修复这些失败。

## 当前提示、历史与恢复

`qa/resources.ts:7–13` 明确要求 exactly blocks JSON、无 fences/额外字段；列出 answer/context 有 evidenceIds、gap 只有 kind/text；无 answer 必须有 gap，gap 不可藏事实/全库缺失/虚构 provenance。:4–5 要求只有当前原文/当前句柄可支持事实，历史仅用于消解指代。`qa/pi.ts:123–126` 再注入当前 run 上下文和 exactly blocks 指令。

三个 Pi 文件的 **:5 system message** 都保留 2703 字符的 `sections.preamble`，内容包含该契约，并含 search_evidence/read_evidence 两个 toolsAdded。不能因 system message 的 `content` 是空串就认定系统提示缺失。安装 SDK `pi-agent-core/dist/types.d.ts:4–10` 明示系统提示/工具位于 transcript system messages，而非 context.systemPrompt/context.tools；`agent-loop.js:271–276` 传入 normalized messages。因此 diagnostics 的 systemBytes=0、toolBytes=0 是 `qa/budget.ts:15–20` 读取旧式顶层字段造成的组件度量不足，**不证明提示或工具未发送**。contextBytes 对完整 context 的序列化仍包含 messages；未发现因此漏计整体 admission 的证据。日志是本地 transcript，未保留逐字 HTTP payload，不能升级为远端实际接收字节证明。

300e336a 是同 session 第二轮：Pi :7 是成功前驱的 answer/context/context 输出，:8 committed，:9 begin、:10 当前 user、:11 当前 context、:12 失败 assistant。这个前驱没有 gap 字段模板可供直接复制。失败后后继 :13 的 parentId 指回 :8 committed marker，保留 :9–12 原始失败分支；与 `qa/conversation.ts:26–48` 按 host-completed membership 回退的静态设计一致。这支持本例排除了该失败 suffix，不能证明所有 crash/orphan 分支。

cfa313af 和 4a112c3c 的 Pi :2 都是 parentId=null 的首次 begin；:3 user，:5 system，:6 当前 context，:7 assistant，没有历史 assistant。故**历史污染、上下文恢复不是产生这三例共同结构错误的必要条件**。未证明模型为何违背规则；“模型倾向给所有块附证据/用 gap 写来源不足说明”只是与三份输出相符的推断。三份 gap 实际还混入来源未涉及/未提供某些内容的陈述，语义上亦需要审阅，不能简单删除 evidenceIds 后宣称答案正确。

## 报告中的 gap/context/publication 结论边界

原 lifecycle 报告已把结构/来源完整性与 entailment、观察到的发布与所有 race 区分，整体措辞有界：

- D/events.jsonl:37 的 796c0948 成功结果确为 gap-only、insufficient_evidence，gap 只有 kind/text；D/cli-ask.stdout:7 确为 answer/context/gap、partial。它们支持存在合法 gap/混合结构的真实观察，**没有完成 cited-context+gap 且无 answer 的 insufficient 回归**，亦不证明 gap 内容语义诚实。
- D/audit.json 记录三个目标 run 均 failed、issues=[]，前两者 historyChecked=true，4a112c3c=false。与 GET/SSE 的无 final result 一致。D/audit.mjs:4 检查 final text/citation 数量和相等性、终端唯一性、引用顺序及已获取 history 的文本；**它没有显式断言所有事件的先后顺序，也没有比较 assistant history 的 citations**。报告“history matched”应限于该脚本实际比较的文本/有无 assistant；严格 history citation 相等、完整事件顺序不能仅由 issues=[] 宣称已检验。
- 静态 `qa/service.ts:127–138` cleanup 在返回前执行，`sessions/scheduler.ts:200–207` 返回后验证再 complete/publish；`sessions/store.ts:269–282` 将 assistant/result/text/citations/terminal 放同一事务，:104–110 共用嵌套事务并先 COMMIT 后返回。已有诊断/输出支持观察到的完成与失败隔离；不能单凭 GET/SSE 相等证明数据库原子性，不能由 provider LOCAL_SETTLED 单独推出 evidence cleanup 已结束。原报告保留“not proof of all races/commit-before-notify”应继续保留。本轮无证据扩大到其它竞态调查。

## 最小建议（本次不实施）

1. **保留 domain 严格边界和现有 gap 语义。** 不放宽 gap 接受 evidenceIds、不丢弃字段、不把 gap 自动转 context、不清洗 JSON；否则把带来源事实的 gap 默默接纳，改变已决契约。当前拒绝本身正确。
2. **在 model-facing contract 投影层澄清易错点。** 最小候选是在 `qa/resources.ts` 的 gap 规则旁明确“gap MUST NOT contain evidenceIds；来源的正/负事实放入有证据的 context，纯未回答部分另写 gap”，给一个短的合法 context+gap 结构示例。`pi.ts` 保持 SDK 编排，domain 继续单独持有类型/严格校验，不在 orchestrator 加修复逻辑。现有 prompt 已有规则，因此这只是待真实回归验证的提示改进，不能预称根治。若需要 provider constrained schema，先核实官方支持及所有工具轮兼容性，另作设计，不在本次猜测可用或引入依赖。
3. **增加无内容的首个拒绝分支诊断。** 在 domain 校验抛出专用有限子原因（例如 GAP_EXTRA_FIELDS、INVALID_JSON、UNKNOWN_EVIDENCE、TEXT_BOUND 等），由 Pi 边界映射到注入 sink；不使 domain 依赖 sink/SDK/存储。只记 run/request、有限 detail、首个失败 blockIndex、kind 枚举、字段数、rawBytes/block/text/reference 数、issued/unknown ID 数，及规范化 finish 枚举；不记实际字段名、文本、ID、hash、异常原文、payload 或私有引用。现有 diagnostics/contracts.ts:1–23 需显式扩充有限 allowlist，local sink 保留 4 KiB/轮转/drop 策略；公共错误仍 RUN_FAILED。首个校验失败与传播/cleanup 分开，不用后者覆盖前者。这也适用于未来 Pi 日志缺失时，避免仅凭 ANSWER_PROTOCOL 推断。没有原始输出时必须直接标为原因未确定。
4. **修正组件度量名称/来源。** `qa/budget.ts` 可增加适配当前 TranscriptContext 的纯度量函数，从 system messages 的 sections/toolsAdded 提取数值；完整 contextBytes 和现有 admission 公式不变。字段不能误称 HTTP payload 字节。无需重构业务模块或扩张预算；本次不实施、不重新冻结。

不新增自动重试/模型验证器，不扩大 2048 输出或累计预算，不裁剪历史/原文。任何未来产品修正须等主代理结束当前冻结验收并重新冻结；失败记录与首轮成本始终保留。

## 可交给 Terra medium 的真实回归场景

仅由 Terra medium 编写/执行真实 E2E；以下不是本调查执行结果。无需开启 held-out。

1. 保留原问题、scope、模型和顺序：同 session 的 `17e9a2ee → 300e336a → 24c5f105` 三轮；再以原两种独立 session 调度情形提交 cfa313af/4a112c3c 所用拆股问题。按 events 中原请求与 runner 源码恢复 timeout/并发条件。每次新 run、独立保留 Pi/events/diagnostics，不让新成功替换旧失败。逐次看 gap keys、raw finish、调用数、当前 E 授权和语义；不得人为注入错误输出。
2. 真实问题自然形成 answer/context/gap、gap-only，以及 **context+gap 无 answer** 的 insufficient；从已有五来源相关但不能直接答的提问入手，若未自然形成则记 NOT_OBSERVED。核对 gap 无 evidenceIds/事实绕道，context 负面事实也需原文支持；CLI、API、GET、terminal SSE、replay/restart、history 文本与 citations 全部逐项比较。
3. 连续完成回合及真实 restart 后显式 follow-up：保留 completed history、发新 E namespace；失败 suffix 不进入后续 active branch，旧原始分支不删除。既有首次 session 失败证明不能只测历史恢复。Pi commit 无 host completion 若未自然出现，保持 NOT_EXERCISED。
4. 长上下文/033 和有序前驱继续遵守全部固定预算；记录真实 ADMITTED/REFUSED 和 finish reason，把 MODEL_BUDGET、MODEL_FAILED(length)、ANSWER_PROTOCOL 分开。不能为触发某分支修改产品限额或伪造 provider/tool 事件。
5. 对真实出现的非法 gap 持续 fail closed：一条失败结果、无 final text/citations/result/assistant，search/read 和 Pi 原始输出仍保留；发生取消/timeout 时核对 cleanup 后 lease 释放。合法结果需按事件 cursor 显式核对 text→ordered citation→completed，history citations 做完整相等比较。未观察到的 race 不报通过。

## 未确定事项

直接校验拒绝原因已确定；模型为何在三次独立生成中给 gap 附证据、提示澄清能否稳定降低失败、gap 内负面事实的逐 claim 蕴含、全部历史/崩溃分支与发布竞态仍未确定。没有本次新运行或验收通过结论；完整 hybrid+45题结果由正在进行的 Terra 验收提供。本调查不以这三个结构失败推断全库质量，也不以合法结构推断语义正确。

## 主审补充：生命周期补测中的两次复现

主审只读核对了 `lifecycle-gaps-20261111.md` 及 `/tmp/clec-lifecycle-gaps-20261111-O3UDQ4/pi/` 中的实际记录，未执行产品或测试。两个失败均再次出现 gap 的额外 `evidenceIds` 字段：

- `5f9e1772`：`2026-11-10T17-08-52-545Z_01a1c66f-1ac1-76ac-944e-463dea95e006.jsonl:7`，输出 369 tokens。
- `f84cb54a`：`2026-11-10T17-08-52-543Z_01a1c66f-1abf-76ac-944e-463bbcf80140.jsonl:7`，输出 380 tokens。

两条均为完整的 answer/context/gap JSON，`stopReason` 和 `rawStopReason` 均为 `stop`。这支持与前三例相同的精确字段拒绝原因，不支持截断解释。gap 还夹带“来源未提供具体步骤”等负面事实；修复仍须澄清事实与缺证表达的边界，不能简单删除字段后接受输出。两例继续保留 FAIL，纳入后续冻结版本的真实回归；本次没有新增模型调用。

补测证明了本次四槽饱和后的本地 settlement 与第五请求启动顺序、已知日期端点及 scoped 排队请求崩溃恢复。未 settled 删除限制、同会话等待窗口、未知日期排除仍未观察到。报告只复核 CLI、manifest 和来源身份，没有重算完整冻结清单；不能扩写成全部依赖字节重新验证通过。
