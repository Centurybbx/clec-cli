# 生命周期证据主审补充

本记录是对已完成真实验收的静态审阅，不是新增测试结果。原始报告及证据不修改。

审阅材料：

- `evaluation/backend-e2e/reports/unified-install-lifecycle-20261111.md`
- `/tmp/clec-unified-lifecycle-terra-20261111/audit.json`
- `/tmp/clec-unified-lifecycle-terra-20261111/audit.mjs`
- `backend/src/sessions/scheduler.ts`

## 可接受的证据范围

审计结果列出 14 个运行，9 个标记 `historyChecked:true`。脚本检查成功运行的 GET 与 SSE 最终文本、引用列表及块引用顺序，并对引用核对来源版本、generation 和原文件 UTF-16 切片；还独立推导非 no_hits 的 answerability。失败、取消、超时运行检查没有最终文本、引用及 result。

历史消息分支只检查 assistant 数量及文本；没有比较历史消息的 citations。因此 `issues:[]` 不证明 GET、SSE、history 的完整引用一致性。其余 5 个运行没有历史检查。no_hits 的零调用由其他运行证据支持，不由该脚本的 answerability 推导证明。上述机械检查均不证明语义支持或条件归因正确。

## 尚待补证

后续 Terra 应补齐历史引用与最终 GET/SSE 引用的完整字段及顺序一致性证据，并明确哪些运行实际有 history 观察；无需仅为缺少离线比较而重复付费问答，若保留记录完整可据既有真实 E2E 数据核对。

调度器源码在取消时先写 terminal 并发出 abort；active lease 仅在 executor 实际完成后的 finally 中移除。该设计需要分别证明终态已发布、执行已结束和排队请求获准开始，不能由 cancel HTTP 返回推定资源已经释放。饱和全局槽位、同会话后续请求、未结束时删除限制、queued cancel 后删除再执行无关请求仍应按原报告的未覆盖范围保留。

三个 ANSWER_PROTOCOL 失败已另派只读调查；本记录不猜测原因、不降低输出校验，也不把失败无最终输出等同于问答成功。全库 hybrid、语义评测、增量与独立保留集仍需各自证据。
