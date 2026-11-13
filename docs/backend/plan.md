# Implementation plan

1. Verify/install pinned official Pi/QMD releases and inspect published declarations. Document differences from online main.
2. Implement explicit intake, immutable original evidence SQLite, contiguous sections, normalized Markdown and generation publication.
3. Implement QMD public HTTP retrieval, original read service and citation scope tracking.
4. Embed Pi with API key explicitly supplied, empty resource loader, two evidence tools and host budgets; expose CLI composition.
5. Compile only. Hand off commands, real-source intake example, limits and unexecuted scenarios to Terra. No tests, mocks, smoke checks or live QA performed by implementation worker.
6. After independent validation/review: add manifest-specific importers, corpus reconciliation and verified duplicate relationships; improve boundary parsing and CJK retrieval based on development cases only; incremental per-source reuse; durable sessions and local HTTP API; measured budgets and recovery. Held-out cases remain isolated.

No mass deletion or legacy migration until replacement acceptance. Stop for architectural blockers rather than bolt on a second runtime.
