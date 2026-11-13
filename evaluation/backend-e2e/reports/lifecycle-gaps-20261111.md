# 真实 lexical 生命周期补测 — 2026-11-11

**结论：部分通过，仍有未观察窗口；两次 ANSWER_PROTOCOL 为 FAIL。** 此次仅用原五源 manifest 和副本建立独立 lexical generation，真实官方 DeepSeek，无 mock、注入、GPU embedding、rerank、heldout 或全库质量/性能结论。原始证据可能含私人问题和资料。

主要证据 D = `/tmp/clec-lifecycle-gaps-20261111-O3UDQ4`：`events.jsonl` 保留请求、GET、history、live 与 full replay，`diagnostics.jsonl` 保留本地阶段，`audit.ts` / `audit.json` 是独立比较器与结果，`state`、`pi`、进程输出及 build 输出保留。首次运行 H = `/tmp/clec-lifecycle-gaps-20261111-KOxV0f` 也保留；不得将它当成完整运行（见下）。运行器 [lifecycle-gaps-20261111.ts](../runtime/lifecycle-gaps-20261111.ts)。

- **PASS，真实饱和槽位释放（本次观察）：** 四个独立 session 已启动时，第五 `63e7d3c0` GET 为 queued。`22f7fe6e` 的 FIRST_PROVIDER_EVENT 后取消；diagnostics 按顺序为 scheduler CANCELLED → provider ABORT_REQUESTED → STREAM_ABORT → provider LOCAL_SETTLED → scheduler LOCAL_SETTLED（17:08:52.966Z）→ 第五 scheduler BEGIN（.971Z）。第五 GET 的 startedAt 为 .967Z，晚于取消者 settledAt .966Z；它最终 completed。时间精度和本地事件顺序只支持这次观察。
- **NOT_OBSERVED，同会话未 settled 后继限制：** 本轮后继 `2755ff83` 提交时取消者已经 settled；后继后来开始，不能证明未 settled 窗口内被阻塞。首次尝试取消后 DELETE 即返回 204，说明该次请求到达时已可删除；没有捕获 terminal-but-unsettled 删除限制。
- **PASS，queued cancel / 删除 / 后续工作：** `340cfb1c` 未启动即取消，GET settledAt 非空、完整回放及 history 已保存；同会话的活动 run `b9f69a4b` 真实完成并 settled 后，DELETE 返回 204。随后无关 session `5eb41f84` 完成 no_hits（零模型调用）。这一后继验证 scheduler/检索继续工作，不证明删除之后再次调用 provider。
- **PASS，已知日期和 source 切换（本次数据）：** 单独 scope 的 `6b514052` 在 00400 的 2025-03-07 含端点范围内返回该来源；接着 `96a34d9b` 以 00014 和 2023-07-12 范围返回该来源；00400 的 dateTo 2025-03-06 返回 no_hits。相同 requestId、问题而不同 scope 返回 409。切换判断使用当次 citations 与来源 ID，不把历史跨 scope 的引用视作当前证据。五个来源日期均已知，**未知日期排除 NOT_OBSERVED**，未改元数据。
- **PASS，scoped queued crash（本次观察）：** 活动 `764cd150` 观察 FIRST_PROVIDER_EVENT 后，排队的 `f39a320d` 使用 00400 的精确日期 scope，随后 SIGKILL 自有 API；重启后两个均为 `INTERRUPTED`，后者 startedAt 为 null，diagnostics 无其 provider admission。显式新请求 `e856262c` 同 scope 完成并引用 00400。crash 时两个 live 流分别 terminated/fetch failed，完整 replay 在重启后保存；不可称 crash 前 live 流完整。
- **PASS，观察到的正常关闭与本地 cleanup：** `950b10a8` FIRST_PROVIDER_EVENT 后 SIGTERM 自有 API；诊断依次记录 CANCELLED、ABORT_REQUESTED、STREAM_ABORT、provider LOCAL_SETTLED、scheduler LOCAL_SETTLED，进程随后 exit 0 并被 runner 等待，重启后 GET/replay/history 为 cancelled、无最终回答。QMD 也 exit 0 并等待。首次 event 不能证明关闭时远端仍在处理；本地事件不证明远端取消或停止计费。
- **FAIL，真实协议错误：** `5f9e1772`、`f84cb54a` 诊断为 ANSWER_PROTOCOL，公开 RUN_FAILED，未替换或重试掩盖；完整 GET、replay、history 显示无 result、final text/citation 或 assistant。原始 Pi 文件保留。旧调查已定位自然出现的 gap 附带 evidenceIds 问题；本次仅凭诊断不额外断言这两次的具体字段原因。
- **PASS，当前 16 个已完成观察的持久化一致性（有界）：** `audit.json` 逐次检查 GET、完整 replay 的 cursor/身份、terminal 完整 result、text 和完整 citation 对象及顺序、history 的 assistant 文本和引用，失败/取消无 final/assistant；引用的 generation、source version、UTF-16 原文切片匹配。13 条标为 live 的完整流与对应 full replay 字节相同；shutdown 前 live 流另存，未纳入该字节比较；两个 crash live 流中断，replay 另存。queued cancel 和 queued interrupted 无独立 settled SSE，符合本次记录，不能称观察到了该事件。没有执行中间 cursor replay；没有本轮 timeout 场景。
- **人工核对范围：** 00400 精确 scope 的 `6b514052`、崩溃后 `e856262c` 将 2013 股价除以 5，归因于原文 513100 一拆五；00014 的 `96a34d9b` 将储蓄比例、一年条件和先储蓄后投资归于该文，所述条件与引用相符。自动转录标记保留。这只是对上述回答的局部核对，不是全库语义验收。
- **NOT_OBSERVED：** Pi commit-without-host-completion、commit-before-notify、真实 terminal 未 settled 时 DELETE 的拒绝以及其间同会话排队；未通过延迟 executor 或故障注入制造。

## 身份、成本和局限

实际复用程序路径由既有安装报告及 runner 确认：`/tmp/clec-unified-lifecycle-terra-20261111/backend/dist/cli.js`。未重新安装或构建程序；新 state 从原 intake 做 lexical build。intake SHA-256 前后均 `8c44aedac85cd12314b2bfa786731df478abbe70531dc81d8dc096f06a18ff26`；CLI 文件前后均 `b6a30a3f50645151455a8a007a933e71668ef680a90f706f0478782c246f2a0d`，五份来源 hash 前后一致，逐项见 D `identity_before/after`。共享冻结身份为 21,463 条、inventory digest `5cd0cbb4f2d21486cb2c3d28d1f487b6834cbafbb11a857f83ff6432f87ef75a`；本轮没有逐项重算完整程序/依赖清单，因此不能声称全部程序字节前后已重新核验。已知端口通过绑定 127.0.0.1:0 后释放选择；只停止自有进程。D 的全部子进程均记录 exit 并等待。

两次尝试共 **16 次 provider admission**（H 5、D 11），低于 35 次上限；HTTP admission 不是 provider 计数。D 中有可得 estimate 的 settled 结果合计约 **$0.013091664**，不是账单；H 的中断、D 的 crash/cancel/失败及缺失 usage 的实际费用未知，不能将该数字当总费用。

H 中测试编排在快速取消后删除了 session，随即错误地向已删除 session 提交后继并陷入无效 GET；为阻止继续无意义轮询，人工中断 runner、向该轮自有 API/QMD 发 TERM。之后检查这些 PID 均不存在，但 runner 未记录完整退出和 wait，**不能声称该轮由 runner 完成 reap**。H 五个请求及诊断保留，其中被删除 session 的后续 GET/history 与完整 replay 不可补回，不能用 D 的新运行冒充 H 的证据。修正后的 D 是独立新状态、新请求；上述结论均明确限定于 D。未修改产品源码、dist、依赖、冻结清单、原始资料或旧日志。
