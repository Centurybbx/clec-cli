# 有界 embedding 首次真实运行验收（2026-11-11）

执行者：GPT-6.1 Terra medium，未委派。结论：**小语料真实 hybrid 构建和检索已观察成功；完整验收未完成**。取消时的 native 工作是否仍在途未证明，不判通过。没有修产品、mock、unit/component/smoke、DeepSeek 调用、密钥或 held-out 读取，也未下载模型。全库长构建和跨进程恢复未执行。原始日志、隔离安装、语料、状态和失败 staging 保存在 `/tmp/clec-bounded-terra-20261111/`；以下相对日志均位于其 `logs/`。这是临时路径，应在清理前归档。

## 冻结与安装

运行前后分别执行 `node backend/scripts/artifact-manifest.ts /tmp/clec-bounded-{before,after}-20261111.json`（分别运行，均 exit 0），均为 21,467 项，inventory SHA-256 `a4dff2a3fd1f9911e9180f1967229e99da71f1fd00d941e4fba82e8588fdb932`。原冻结 JSON 没有覆盖。独立目录从 backend 复制，排除 node_modules/dist；原产品源码、dist、依赖未修改。Node 25.7.0、npm 11.10.1、darwin arm64。

首次测试操作失误：在项目根目录误运行 `npm ci --no-audit --no-fund`，因无 package-lock 报 EUSAGE，exit 1，见 `npm-ci.log`；没有发生安装。随后在隔离 backend 中执行（PATH 指向 Node 25 的 bin）：

- `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true HUSKY=0 CI=true npm ci --no-audit --no-fund`：exit 0，45 秒，302 packages，真实 postinstall 应用 patch；`npm-ci-isolated.log`。npm 警告 git SSH integrity skip 和 node-domexception deprecated。
- `npm run postinstall`（重复 guard）、`npm run typecheck`、`npm run build`：各 exit 0，分别见 `guard.log`、`typecheck.log`、`build.log`。均在独立安装执行。production omit-dev 安装未执行。

## 语料与首次构建

沿用 `/tmp/clec-full-corpus-20261110-r6jctg/state/full-intake.json`（SHA-256 `779d05849efd50d6974f3b60c19dc788fe8f4953221fa0f8b3af48dc3df2d59d`）条目，按原顺序选前 24 个 ready、500–8000 bytes、不同 SHA-256 的 md/txt；逐文件从该目录的 workspace 原样复制，未 recatalogue 或 textcopy。子 manifest `state/intake.json` SHA-256 `5c940bb2c7f9f6bb0002b9d68a6037bd85f222585ee0c696f4cedd882fece1b4`；24 条路径、原文 hash 与字节数见 `source-hashes.json`，事后复制文件 24/24 与来源 hash 相等。来源为第三方整理材料，保留原 quality 和 provenance，不当作原始录音。额外 20 条也从同 manifest 原样选取，用于增量和取消。

配置 `CLEC_WORKSPACE=/tmp/clec-bounded-terra-20261111/workspace`、`CLEC_STATE_DIR=/tmp/clec-bounded-terra-20261111/state`、`CLEC_PI_DIR=/tmp/clec-bounded-terra-20261111/pi`，并设置 `QMD_EMBED_MODEL=/Users/century/.cache/clec/models/Qwen3-Embedding-0.6B-Q8_0.gguf`、`QMD_RERANK_MODEL=/Users/century/.cache/clec/models/qwen3-reranker-0.6b-q8_0.gguf`；显式移除 DEEPSEEK_API_KEY。模型 hash 分别为 `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`、`22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48`。

在隔离 backend 执行 `/usr/bin/time -p node dist/cli.js build ../state/intake.json --hybrid`：exit 0，wall 38.41 秒。完整 stdout/stderr 为 `hybrid-build.stdout` / `hybrid-build.stderr`。24 来源、54 sections，初始 54 distinct pending，85 chunks embedded，0 copied。工作账本 `state/generations/1eea3229342b501c515f3d67e43b5d6ee64286d2e3565a4baa2b8fecea9b8e87/embedding-work.json` 记录：

| 单元 | pending before → after | selected/completed | bytes | chunks | duration ms | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 54 → 46 | 8/8 | 24287 | 13 | 13548.16 | bounded |
| 2 | 46 → 38 | 8/8 | 17638 | 10 | 2928.46 | bounded |
| 3 | 38 → 30 | 8/8 | 29166 | 17 | 5135.00 | bounded |
| 4 | 30 → 22 | 8/8 | 12458 | 9 | 1997.49 | bounded |
| 5 | 22 → 14 | 8/8 | 24801 | 13 | 4171.51 | bounded |
| 6 | 14 → 6 | 8/8 | 16889 | 10 | 2644.77 | bounded |
| 7 | 6 → 0 | 6/6 | 23743 | 13 | 4192.92 | complete |

账本 elapsed 34741.16 ms，fingerprint `8659da`，model 为上述本地 embedding 文件。每单元数字是产品记录，不能单独证明任意物理损坏检测或向量语义质量。构建成功意味着产品自身最终完整性门禁通过；没有另行逐行审计 seq/partition。READY 与 CURRENT 均指向上述 generation。`node dist/cli.js status` exit 0，显示 24 sources / 54 sections；`node dist/cli.js source $(cat ../logs/source-id.txt)` exit 0，取回的原文 SHA-256 `85b35ffe3c981b2736c3e85c19572f7249bf9eed240eb8f29ba169203a544ef4` 与该 source 的 contentHash 和来源一致。原始响应为 `status.json`、`source.json`。

## 检索与增量

CLEC CLI 无独立 search 命令。以相同环境执行 `node dist/cli.js qmd-serve 18181`，然后真实 HTTP `POST /query`，body 为 `{"searches":[{"type":"lex","query":"investment"},{"type":"vec","query":"investment risk and allocation"}],"intent":"investment risk and allocation","limit":10,"rerank":true}`。curl exit 0，HTTP 200，10 hits；服务日志记录 14880 ms。`search.json`、`search.stderr`、`qmd-server.log` 保留结果。此为真实 QMD HTTP lex+vec+rerank，**不是 CLEC QA、其查询规划或答案语义验收**；不调用 query expansion 模型。服务以 SIGINT 停止，受控进程已退出；终端中断导致包装 shell 未写退出码，不能报告服务正常退出码。

保留 24 来源并新增一个真实 manifest 来源，以同环境运行 `node dist/cli.js build ../state/reuse.json --hybrid`：exit 0，wall 6.50 秒（`reuse.stdout`、`reuse.stderr`）。记录 reused 24、added 1、copiedMarkdown 54、generatedMarkdown 6；QMD update vectorsCopied 85、needsEmbedding 6，工作单元仅嵌入新增 6 chunks，remaining 0。新 generation `a493fb59bdb6540ea05be1d68a19ead8a0fad18177c470626a8efd20541771be` READY/CURRENT。此为新增来源时 unchanged 原文及向量复用的实际观测，不是全库增量结论。该 generation 的公开 `qmd status` exit 0，显示 60 indexed files、91 embedded vectors 和 60 metadata files（`qmd-status.txt`）；构建账本和产品最终门禁报告 pending 0。

## 取消及未观察项

使用 `python3 /tmp/clec-bounded-terra-20261111/cancel-run.py` 启动自有 CLI build，使用 `state/cancel.json`（原 24 加 20 个真实来源），在新账本初始 pending 81、units 空时执行 `sample <pid> 1 -file ...`，然后对该 CLI 发 SIGINT 并 wait。采样 exit 0，显示 llama-addon 的 `addonLoadBackends`、ggml/Metal 初始化栈；采样完成后才发送信号，**不能证明信号发生瞬间 native 工作仍在途，也不能证明 native inference 在途**。SIGINT 距启动 3.647 秒，settlement 0.071 秒，CLI exit 1，输出通用 `INTERNAL_ERROR`，见 `cancel-result.json`、`cancel.stdout`、`cancel.stderr`、`cancel-sample.txt`。失败 generation `6563c69163f105c592351ad0ac495801f0b91b661209d7e4816aef527813a01e` 原地保留，无 READY；前后 CURRENT 均为 `a493fb59bdb6540ea05be1d68a19ead8a0fad18177c470626a8efd20541771be`，取消后 CLI status exit 0、25 sources / 60 sections。没有重新启动该失败构建或声称跨进程恢复。所有自有进程已退出并等待；未检测到遗留相关进程。

未观察：native 工作确定在途时的取消与 settlement、超时、无进展、byte/chunk 超限、callback/DB/cleanup 故障；不构造模型/SDK 结果。未执行 production omit-dev、全 6,775 来源构建、全覆盖与冷/热性能、45 题/协议/语义回归、held-out、跨进程恢复。无其他 embedding 运行错误在本次成功构建中观察到；取消的通用错误不提供更细原因。不能把本小库结果外推为全库或最终验收通过。
