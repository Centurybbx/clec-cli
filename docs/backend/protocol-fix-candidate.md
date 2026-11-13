# 协议修复候选补丁 — 2026-11-11

状态：仅供主审审阅的未应用候选。实现者 GPT-6.1 Sol / medium；未委派、未查询或等待另一任务。本轮只写 `docs/backend/protocol-fix-candidate.patch` 与本文。没有修改冻结产品，未运行产品、模型、安装、typecheck、build 或任何测试；未打开凭据、密钥或 held-out。源码候选只存在于 unified diff 和内存文本中，未另建 checkout、临时源码树或复制项目。

用户本轮“候选补丁”边界优先于执行契约中实施后构建的要求：本轮不应用、不构建、不重新冻结。下述应用与验证步骤全部属于后续主审委派，尚未执行。另一 Terra 正在全库 hybrid 验收，其运行及写入范围未查询；本轮仅确认六个目标文件在读取和最终静态核对时均与旧冻结清单相同，不能据此宣称其他代理没有写入或整个产品树未变。

## 依据与身份

已读 `protocol-fix-execution.md`、`answer-protocol-investigation-20261111.md`、`unified-freeze-20261111.md`，只读核对 domain → Pi → QA service → session validation/scheduler/store 调用链及 diagnostics。五次历史失败均保留 FAIL：gap 多带 evidenceIds、完整 JSON、finish=stop；不支持截断解释。最新两次还出现不必要的来源缺失/步骤不足说法。本补丁不把删除字段后的输出视为有效答案，也不预称提示能修复五例。

冻结 inventory 身份沿用 `5cd0cbb4f2d21486cb2c3d28d1f487b6834cbafbb11a857f83ff6432f87ef75a`。仅比较本补丁六个源码文件与四个锁定输入的清单 hash，没有重新验证整个 inventory 或当前 dist。

补丁 SHA256：`ec9470deb67e34ad001e21024a3671bf540dfe603a4b80c2debc5f0632c59c3d`。路径均相对 `/Users/century/vibing/clec`；当前文件系统返回的 `Vibing` 大小写拼写指向本工作目录。

| 目标文件 | 原始 SHA256（应用前必须相同） | 候选应用后预期 SHA256 |
| --- | --- | --- |
| `backend/src/qa/resources.ts` | `a028288fdb86425b28da362618cd912f4c99c143c931a9be8d4e57f4218b0ed0` | `2d1a30acc8c5deec6c90c586e02bd05ad4eaa50dd0c18ef1078ab07b8cc5b212` |
| `backend/src/domain/answer.ts` | `b21def4d25525c467daef845278c369844afadda978c286b9d1459030be5706e` | `176215fb8e0b022f577621050f904778ee2ad1993f2a7aff977c505bf5fc0caa` |
| `backend/src/qa/pi.ts` | `5c050cf38496dbdc1d707e0a7a2d496b0749e12438d9edd182896c771bb0c141` | `8aff98727290bd4eb7ac10320d2fbf022616cd828874bd9c9c5175771b341570` |
| `backend/src/diagnostics/contracts.ts` | `2a80c6a216bb0d1f75ebdf52139b79791dee61b1fcf2b85f251cf58f2d6f9b20` | `a1b174cc360091fcda691d1d64ed4292b9984c293f9707a5474bfca8a7e443f1` |
| `backend/src/diagnostics/local.ts` | `9514907a68a1b42a49bc8aa4919867282cfe73143500b14b0ff993ff2184fa2e` | `78dfd905f9dcad5875710207ee34484feff51b7b23ee4499c176f7920d204338` |
| `backend/src/qa/budget.ts` | `c69244e1d9cca900d380d58853696c03344230786bf2666dfe15dbabc0326332` | `c55ce1a6df69839782d98caab833eb67b7a9dfa52ad0022800b5701103b78ed8` |

本轮只做了 unified diff 文本静态核对：六个文件的 hunk 行数、旧行内容及候选重建 hash；未调用产品解析器、编译器或测试框架，也没有执行 patch 应用。此核对不证明 TypeScript 可编译或运行正确。

## 五点契约对应与模块接口

1. **`qa/resources.ts` — 提示投影。** gap 明确只许 kind/text，禁止 evidenceIds，即便句柄有效也不例外。仅针对用户实际未答部分或必要澄清生成 gap；全部已答则省略，不为未问的工具、步骤等制造缺口。正面和负面事实都要由当前原文或显式 metadata 支持；禁止把无依据的“来源没有……”搬进 context。增加一个短的 context+gap JSON 形状例子，`PLACEHOLDER_CURRENT_RUN_HANDLE` 明说不是授权句柄、不可复制；事实和问题均为假设，必须由真实请求及当前证据替代。`evidenceResources()` 接口不变。
2. **`domain/answer.ts` — 纯严格校验。** 局部 `AnswerProtocolError extends ClecError` 只携带有限 `AnswerProtocolReason`，无 sink、SDK、I/O 或通用校验框架。仍逐次 fail closed，JSON.parse 一次，无修复、字段删除、类型转换接纳或重试；合法结果仍使用原有 AnswerBlock。kind 改为三种字面量直接比较，避免 String 强制转换；不会扩大接受集合。公开 code 仍 ANSWER_PROTOCOL，原两种固定 message 保留。所有字段、数量、文本、引用和 answer/gap 要求继续严格执行。
3. **`qa/pi.ts` + `diagnostics/contracts.ts` + `diagnostics/local.ts` — 固定诊断映射。** Pi catch 只认本地 typed error，通过显式 switch 映射字面量；任意其它异常不产生子原因。新增可选 `DiagnosticRecord.answerProtocolReason`，独立的诊断白名单类型；磁盘 sink 再检查值属于白名单，且只在 stage=qa/code=FAILURE/reason=ANSWER_PROTOCOL 时序列化。未知值或不匹配组合不输出该字段。不 spread 异常对象，不记模型文本、字段原值、动态键名、证据 ID、stack 或摘要，也不新增哈希/内容计数。原 counts 白名单、4 KiB 单条、4 MiB + 两份轮转、drop 和不抛异常策略不变。新增字段属于内部诊断，不进入 API DTO、会话 schema 或最终结果。
4. **`qa/budget.ts` — 实际 transcript 计量。** `ModelBudget.admit` 参数从 unknown 收窄为锁定 Pi 的 `TranscriptContext`，唯一调用方就是 typed streamFunction context。局部纯 helper 从 messages 内 role=system 读取 content、sections（包括 preamble）、toolsAdded/toolsRemoved。完整 context UTF-8 JSON bytes + 2048 reserve、最多 4 次、累计 maxUnits、usage/cost 策略不变。只改组件观察来源，不 replay SDK prompt 状态、不修改 context。
5. **边界保持。** 无 session schema、API、证据授权、检索、QMD、依赖、安装器、scripts、patches 或预算常量改动；diff 恰好六个既有源码文件，没有新增模块树或框架。局部修复可以自然置于既有职责内，无需扩大重构。

## 有限拒绝原因和失败语义

| 内部/诊断值 | 首个到达的拒绝条件 |
| --- | --- |
| INVALID_JSON | 原始字节未超限但 JSON.parse 失败 |
| STRUCTURE | 顶层形状、blocks 非空/数量、块对象/kind 或精确字段错误；不含其它已单列原因 |
| GAP_EXTRA_FIELDS | kind=gap 的精确字段失败，且存在 kind/text 之外的自有 key；仅缺字段仍为 STRUCTURE |
| TEXT_BOUND | raw UTF-8 上限、text 非字符串/空白/单块长度或累计长度失败 |
| UNKNOWN_EVIDENCE | 非空引用数组内元素均为字符串，但有不在当前 allowed set 的 ID |
| REFERENCE_STRUCTURE | 文内引用标记、引用非数组/空数组/非字符串/重复或累计引用上限失败 |
| MISSING_ANSWER_OR_GAP | 其它结构均合法，但仅有 context，没有 answer 或 gap |

保留校验顺序，只记录首次抛出的原因，不遍历收集全部错误。raw 过长优先于 JSON.parse；块数量错误优先于内部块；gap 字段错误优先于其文本。域函数仍能被 session validator 调用，后者原有 catch 继续映射 INVALID_ANSWER，不扩展公开错误。Pi 的子原因只表示该次本地结构拒绝，不证明语义蕴含；没有此字段不能反推具体失败原因。

Pi waitForIdle/stop 检查仍先于 parse。catch 记录后重抛，finally 继续 await abort/idle/dispose/key-removal 和 metrics，主错误不被 cleanup 次错覆盖。service 成功路径才 normalize E→C、reader 引用复核和 render；scheduler 等 executor settle 后再验证，成功后才进入 store.complete 的单事务。拒绝不会返回 ModelAnswer，更不会因补丁生成 final answer；GET/SSE/history 的实际无结果原子性仍须 Terra 真实验证。上层 service/scheduler 传播日志仍可能重复同一错误，不能按 FAILURE 条数计算模型尝试数；子原因只由 Pi 边界附加。

## 锁定 Pi 结构与组件解释

package-lock 和安装类型均为 Pi 1.5.2。已读 `pi-ai/dist/types.d.ts:360` 的 SystemMessage、`:572` 的 TranscriptContext，以及 `pi-agent-core/dist/types.d.ts:4` 的 StreamFn 说明；`agent-loop.js:271–276` 确认 normalized messages 传到 streamFunction。SystemMessage.content 为 string/TextContent[]，sections 为 Record<string,string|null>，toolsAdded 为 Tool[]，toolsRemoved 为 ToolReference[]；没有依赖旧的顶层 context.systemPrompt/context.tools。

只读投影调查已命名的既有 transcript：`/tmp/clec-unified-lifecycle-terra-20261111/pi/2026-11-10T16-53-23-835Z_01a1c660-eefb-72f6-9791-462aa8c4274f.jsonl:5`。role=system，content 为空字符串，sections 有 preamble（2703 UTF-8 bytes）和 cwd（65 UTF-8 bytes），toolsAdded 有 2 项，toolsRemoved 不存在。未输出原始提示、路径内容、工具参数或模型文本。这是旧冻结的本地记录，不是本候选运行结果或 HTTP payload。

- `contextBytes`：完整 context 的 JSON.stringify UTF-8 bytes，仍为唯一输入准入主体。提示加长会自然增加此数，不抵扣输出 reserve。
- `messageBytes`：完整 messages 数组的序列化 bytes，包含 system 消息。
- `systemBytes`：逐个 system 消息，累加 content 的 JSON 序列化 bytes，加存在的 sections 对象序列化 bytes；包括所有命名 section、替换和 null 删除标记，不是只计 preamble，也不是最终 active prompt 长度。
- `toolBytes`：逐个 system 消息，累加实际存在的 toolsAdded 数组与 toolsRemoved 数组的序列化 bytes；重复声明重复计入，不构造推测的 active tool set。
- 缺少 messages 数组则省略三个组件字段；有 messages 但没有 system 则省略 systemBytes，没有任何工具变更数组则省略 toolBytes。显式空数组仍按观察到的 JSON `[]` 计字节。锁定正常类型要求的 content 为空字符串也有 JSON 引号的序列化开销，不表示真实 instruction 字符数。组件彼此重叠，且不含所有 message 包装开销，不能求和当作 contextBytes，更不能称为远端请求字节。

锁定输入读取时 SHA256（也与历史清单相同；应用前应再次核对）：

- `backend/package-lock.json`：`cff6e417898832bbcda1d0b9b4e8c0a9e6926a3780f07e01d7f7c56d2215b7b1`。
- `backend/node_modules/@earendil-works/pi-ai/dist/types.d.ts`：`c0ecd26c0170c7d6016c734ec38b551c7d8c7d8e6573f82f7f6a3818df84acd8`。
- `backend/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`：`dbdda5a3f7d873b07c9aa0502ab165672d898c9114767a95c28e987daab0075d`。
- `backend/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`：`22ee81f9977e211044c1ad41a763876c793ca7fc1c5b39b9fa7f76f3cb281129`。

## 风险与未验证项

- 提示不能保证模型遵守规则；五例修复率、负面事实诚实度、context+gap 自然出现情况均未验证。示例也可能被复制，严格授权边界仍会拒绝占位句柄。
- 更长 system prompt 占用固定总预算；长上下文可能更早拒绝，这不允许通过加预算、裁剪原文或加重试消除。所有调用/累计限制不变不等于对同一请求实际 admission 数值不变。
- TEXT_BOUND/REFERENCE_STRUCTURE 是有限类别，不包含精确字段名、blockIndex 或原值；不能仅凭类别判定模型具体输出。白名单故意在 domain 类型、Pi 映射、diagnostic 类型/磁盘检查之间分层，未来加原因须同步审阅，不能直接序列化异常属性。
- 组件字段语义发生修正，旧值 0 与新观察值不宜直接比较；它们计量本地 transcript 声明，未验证 provider 转换或网络接收情况。
- 本轮未编译、未构建、未执行 E2E 或任何其它测试，未做补丁实际应用/撤销演练，也未重算完整冻结清单。只读静态审阅不能替代这些步骤。

## 后续应用前门禁（主审委派 Sol medium，当前禁止执行）

必须先由主审结束/释放当前冻结验收写入窗口；不要边跑 Terra 边应用，不要等本候选自行探测其它任务。后续应用者仍只能是 GPT-6.1 Sol medium；所有测试仅 GPT-6.1 Terra medium 真实 E2E，禁止 mock/unit/component/smoke。

1. 复核补丁自身 SHA 和下方六个原始 SHA，并重新验证当前完整冻结身份及锁定 Pi/package-lock 输入。任一不匹配立即停止并交回主审，不能 fuzz、自动三方合并或覆盖另一代理修改。下方 Python 仅是未来的哈希门禁，不执行产品：

```sh
cd /Users/century/vibing/clec
python3 - <<'PY_GATE'
from pathlib import Path
import hashlib
expected = {
    "backend/src/qa/resources.ts": "a028288fdb86425b28da362618cd912f4c99c143c931a9be8d4e57f4218b0ed0",
    "backend/src/domain/answer.ts": "b21def4d25525c467daef845278c369844afadda978c286b9d1459030be5706e",
    "backend/src/qa/pi.ts": "5c050cf38496dbdc1d707e0a7a2d496b0749e12438d9edd182896c771bb0c141",
    "backend/src/diagnostics/contracts.ts": "2a80c6a216bb0d1f75ebdf52139b79791dee61b1fcf2b85f251cf58f2d6f9b20",
    "backend/src/diagnostics/local.ts": "9514907a68a1b42a49bc8aa4919867282cfe73143500b14b0ff993ff2184fa2e",
    "backend/src/qa/budget.ts": "c69244e1d9cca900d380d58853696c03344230786bf2666dfe15dbabc0326332"
}
expected['docs/backend/protocol-fix-candidate.patch'] = 'ec9470deb67e34ad001e21024a3671bf540dfe603a4b80c2debc5f0632c59c3d'
for relative, wanted in expected.items():
    actual = hashlib.sha256(Path(relative).read_bytes()).hexdigest()
    if actual != wanted:
        raise SystemExit('HASH_MISMATCH: ' + relative)
print('Candidate and six original hashes match; full freeze review still required.')
PY_GATE
```

2. 仅在门禁与主审审阅完成后，从根目录运行 `patch --dry-run --batch --fuzz=0 -p1 < docs/backend/protocol-fix-candidate.patch`，成功后再 `patch --batch --fuzz=0 -p1 < docs/backend/protocol-fix-candidate.patch`。本目录不是 Git repository，不使用 git 身份代替 hash。核对六个应用后 SHA，范围超出六文件立即停止。逐命令保存实际退出码，不能把管道、后续成功或历史日志当作该次成功。
3. Sol medium 在 backend 使用既定 Node v25.7.0 / npm 11.10.1，PATH 前缀 `/Users/century/.nvm/versions/node/v25.7.0/bin`，`NODE_LLAMA_CPP_SKIP_DOWNLOAD=true HUSKY=0 CI=true`。先单独运行 `npm run typecheck`（包含 installer strict check），记录 stdout/stderr 和原始 exit code；仅成功后单独运行 `npm run build` 并记录同样证据。不运行产品、模型、安装或测试。失败停止，修复后重新审阅候选身份，不伪报成功。
4. Sol medium 构建成功后，运行现有 `node scripts/artifact-manifest.ts ../docs/backend/protocol-fix-artifacts-<唯一时间戳>.json` 生成新的独立 inventory（工具 wx，不覆盖历史），记录 JSON 自身 SHA、inventorySha256、全部源码/dist/依赖身份及原始命令/环境/退出码；另建新 freeze 交接，说明仅静态验证，不称验收通过。确认 schema=3 和依赖/QMD guard 未变。不能继承旧 dist/hash，也不能更新历史统一冻结清单来隐藏差异。

## 后续 Terra medium 真实回归（未执行）

主审指定新冻结产物后，Terra 先核对其完整身份；使用隔离 schema-3 状态与 Pi 目录，真实 QMD、官方 DeepSeek 和既定模型/来源，不读取 held-out。运行前从既有记录恢复五例的原问题、scope 和顺序，包括同 session 前后继；保留五次旧失败及每次新失败、首次成本，不靠重试挑成功。凭据继续由主审既定安全渠道注入，不写报告。

1. 对五例逐次核对原始输出、finish/raw finish、gap 精确字段、当前 E 授权、事实及条件蕴含；特别核对“不必要的来源缺步骤”等负面断言是否消失，不能只看结构合法。自然覆盖 answer/context/gap、gap-only、context+gap 无 answer；未自然出现写 NOT_OBSERVED，不伪造模型输出/SDK/tool 事件。
2. 对真实非法输出验证 run failed 且无 final text/citations/result/assistant；Pi 首条协议拒绝含固定白名单 answerProtocolReason，磁盘无文本、字段值、动态 key、ID、stack 或摘要泄漏。没有非法输出则运行时拒绝分支 NOT_EXERCISED；不为覆盖白名单分支写单测或合成输入。日志重复不算额外尝试。
3. 对正常请求保存的真实 normalized context 核对 system content/sections.preamble/其它 sections/tool deltas 与组件数字；按本文 JSON 字节定义比较，注明非 HTTP payload。核对完整 contextBytes+2048、4 次及累计预算，长上下文沿用原限额；未出现的移除/空结构/诊断轮转/drop 分支如实标记未观察。
4. 逐项比较 GET、最终 SSE、完整 replay、restart 后 replay、history 的 blocks/text/answerability/citations 及顺序；显式核对 text→ordered citation→completed。连续追问、重启、失败 suffix 隔离和 cleanup settlement 沿用既有契约，未观察的竞态不报通过。
5. 局部五例不替代全库中文 hybrid、45 题开发集、增量、性能及 lifecycle 验收。held-out 保持封存，待主审另行指定最终独立版本及授权后才由独立 validator 验收。本补丁没有获得任何编译、测试或质量通过结论。
