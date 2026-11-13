# CLEC TypeScript backend

后端将不可变原始证据、QMD 检索、一个通过官方 DeepSeek API 工作的 Pi Agent、持久会话和本地 HTTP 组合起来。无 Web UI；stateless CLI 与 durable sessions 共用 QA 服务。原始资料始终保留。

从 [operations：安装、配置与运行](../docs/backend/operations.md) 开始，依次完成完整 workspace 的 catalogue → manifest 审核 → hybrid build → 匹配的 QMD → API → session/CLI。`docs/backend/intake.example.json` **仅含三份材料，不是全库 intake**。

当前实现与依赖身份以 [2026-11-11 统一冻结](../docs/backend/unified-freeze-20261111.md) 及其 artifact 清单为准，接续 QA 与 embedding 补丁。`retrieval.md`、`integration.md` 和旧 handoff 保留各自历史语境，不再作为最新冻结入口。

证据边界：统一冻结完成安装、typecheck 和构建；随后 [五源 lexical 真实 E2E](../evaluation/backend-e2e/reports/unified-install-lifecycle-20261111.md) 完成部分 CLI/API、SSE、取消和恢复核对，整体 lifecycle 未通过，三次 `ANSWER_PROTOCOL` 失败仍未解决。完整 hybrid 全库及 45 题语义验收尚无完成结论，不能据此宣称生产就绪。所有测试仅由 Terra medium 做真实 E2E；本文整理未运行产品命令、安装、构建或测试。

接口与架构细节：

- [HTTP、取消 endpoint 与 SSE replay](../docs/backend/http.md)
- [会话 schema 3、调度与 settlement](../docs/backend/sessions.md)
- [共享 QA、预算与 Pi 恢复](../docs/backend/integration.md)
- [QA blocks、引用与诊断契约](../docs/backend/qa-contract-handoff.md)
- [embedding 生命周期与覆盖门禁](../docs/backend/embedding-patch-handoff.md)（安装器路径以统一冻结的 `.mts` 为准）

`validated:true` 只表示结构和原始来源完整性，不证明语义蕴含。SSE 提供持久进度与最终结果，不是模型 token streaming；断开客户端不等于取消执行。
