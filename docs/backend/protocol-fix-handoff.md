# 协议修复冻结交接入口

2026-11-11。协议候选已在此前应用，本轮未改 QA/session/API。此前静态产物入口为 [protocol-fix-artifacts-20261111T132248684975Z.json](protocol-fix-artifacts-20261111T132248684975Z.json)，inventory SHA-256 `ba30696d7107236d55bb33f447bc2d87d5b0a79b485e6b02326ef9e31b3c08e2`；[原 typecheck](protocol-fix-static-20261111T132248684975Z/typecheck.json) 与 [原 build](protocol-fix-static-20261111T132248684975Z/build.json) rawExitCode 均为 0。静态审阅见 [candidate review](protocol-fix-candidate-review.md)，执行和 Terra 回归约束见 [protocol-fix-execution.md](protocol-fix-execution.md)；其“尚未实现”是此前历史状态，不是当前冻结状态。

六个协议源文件为 diagnostics/contracts.ts、diagnostics/local.ts、domain/answer.ts、qa/budget.ts、qa/pi.ts、qa/resources.ts。本轮以此前完整 inventory 核对输入、零 mismatch；新旧 [inventory 对照](embedding-bounded-validation/inventory-comparison.json) 确认六文件及其 dist 没有变化。当前统一冻结已包含协议修复和有界嵌入，后续运行必须使用 [embedding-bounded-work-handoff-20261111.md](embedding-bounded-work-handoff-20261111.md) 指向的新 inventory，不能混用旧 dependency 字节。

真实协议验收仍未执行。仅 Terra medium 使用最终冻结、隔离状态和真实官方 provider，保留五次失败的原问题/scope/顺序、首次失败和费用；核对合法与非法输出边界、白名单 diagnostics、当前 evidence 授权、事实/条件/负面断言，以及 GET/SSE/replay/history 的结果和引用顺序。自然未出现的分支标明未观察，不造模型输出。组件计量不是 HTTP payload 测量。五例局部回归不代替完整 45 题和全库门禁；held-out 未授权仍封存。本入口不宣称运行验收通过。
