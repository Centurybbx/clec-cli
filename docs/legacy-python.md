# CLEC 本地资料库

为 Agent 提供可重建的本地索引与可核对的证据。保留原始资料，使用 Python、SQLite 和繁简归一化；无需启动服务器或配置模型 API。可选本地语义模型用于自然语言检索。项目设计见 [docs/clec-knowledge-design.md](docs/clec-knowledge-design.md)。

## 启动

需要 Python 3.10+ 和 [uv](https://docs.astral.sh/uv/)：

```sh
uv sync
uv run clec build
uv run clec status
uv run clec search '退休 现金' --limit 5
uv run clec timeline '退休 现金' --after 2025-01-01 --before 2026-12-31
uv run clec read 证据ID --context 1
uv run clec source 来源ID
uv run clec digest 来源ID
```

命令均输出 JSON。`build` 根据现有 `collection/` 中清单重建 `index/clec.sqlite3`；创建完成后才替换旧索引。使用 `--root` 或 `--db` 时需放在子命令前。原资料若有变更，先重新 `build`；`read` 会核对文件哈希并拒绝引用已改变或丢失的文件。索引本身可删除重建，原文件不能删除。

## Agent 使用方式

1. 先用多个同义词、繁简用词、相关基金代码与节目编号检索。查询中的空格表示所有词必须匹配；短于 3 字的词使用子串扫描，3 字及以上通常使用 SQLite trigram。数字和中文单位的组合会容忍中间空格，例如 `54岁` 可以匹配 `54 歲`。`search` 默认返回每个来源一个片段；`--all-passages` 保留所有匹配片段，`--source 来源ID` 限定资料，`--offset 数字` 用返回的 `next_offset` 翻页。每页会重新折叠，跨页可能再次出现同一来源。长词按 BM25 排序，纯短词按词频排序；`timeline` 按来源日期排序。日期筛选会排除未知日期资料，并返回排除数量。
2. 查看 `matching_chunks`、`next_offset`、未知日期数量和质量字段。应更换关键词并翻页；即使使用语义检索也不能声称穷尽。时间线是匹配片段列表，不是自动判定的观点演变。
3. 对有关结论逐一调用 `read 证据ID`，查看相邻上下文、来源文件、哈希、行号或字幕段及质量状态；`source` 可查看同一字幕包中已确认的其他格式，以及已有的跨站候选关系。字幕时间仅属于该字幕版本，不能直接假定与其他平台媒体同步。
4. 回答时区分原始对话、自动转写、第三方摘要和文档提取；区分讲者、提问者与来信。保留日期、条件和例外；不同说法可能针对不同对象，不要自动判定为观点反转。每个实质结论都应回链具体证据；如果结论来自相邻片段，引用该相邻片段自己的 ID。证据不足就说明不足。数字和疑似听错的术语须核听原音。

生成候选摘要后，可使用 `uv run clec check-claim 证据ID --quote '逐字引文' --claim '候选主张'` 检查引文是否存在，以及部分数字、条件和限定词是否可能遗漏。出现提示时需要复核；即使没有提示，也不能证明主张被原文支持，更不能证明转写或讲话人正确。

源文件和检索正文分开：索引中只有检索副本会做繁简归一化，展示和证据保持原文字。字幕包的 SRT、TXT、Markdown 正文核对一致后只为字幕建立检索片段，但三个来源记录均保留。不同节目和不同版本不会因为标题相近被自动合并；跨站候选仅供核对。空文件、仅标题文件、缺失网页和隔离的异常转写均保留状态，不进入普通检索。`status` 按文件来源计数，不代表独立节目数或全网覆盖。

## 摘要

`uv run clec digest-build` 为每个正文片段建立原文导航摘录；`uv run clec digest 来源ID` 可以分页查看。摘录是逐字选取的局部原文，并非对所有观点的完整摘要，也没有判断讲者。索引变化后需要重建摘录。

试运行的 [退休现金时间线](summaries/retirement-cash.md)、[整篇摘要](summaries/episodes/short-00575.md)和[其他片段样本](summaries/episodes/retirement-cash-samples.md)展示 Agent 整理和证据记录的方式。全库的观点级摘要尚未生成：本地模型测试中即使引用真实，也会漏掉税务等重要前提。不要把机器抽取的局部摘录当作完整总结。

## 本地语义检索

下列安装命令适用于 Apple Silicon、Python 3.13；本机现有 `collection/.transcribe-venv/bin/python` 已安装所需依赖：

```sh
uv venv --python 3.13 .ai-venv
uv pip install --python .ai-venv/bin/python -r requirements-local-ai.txt
uv run python tools/download_semantic_model.py
.ai-venv/bin/python -m clec_kb semantic-build
.ai-venv/bin/python -m clec_kb semantic-search '退休以后借钱生活，为什么要留现金？' --limit 10
.ai-venv/bin/python -m clec_kb research '打算退休的54岁来信者，资金汇回台湾的前提是什么？' --limit 10
```

使用本机现有环境时将 `.ai-venv/bin/python` 换成 `collection/.transcribe-venv/bin/python`。语义索引使用 `bge-small-zh-v1.5` 本地模型，对每段正文建立重叠窗口；处理被打断可重跑相同命令续传。源码索引版本或模型文件变更后必须重新建立语义索引。`research` 将自然语言语义检索与自动提取的关键词检索合并，也可用 `--terms '自选 关键词'` 覆盖自动词语；它返回候选证据而非自动生成的答案。语义分数仅是相似度，可能找出与问题相近但无法回答问题的材料；应与关键词检索交叉使用，并用 `read` 验证。

## 测试

```sh
uv run python -m unittest discover -s tests -v
uv run python evaluation/e2e_check.py
collection/.transcribe-venv/bin/python evaluation/semantic_e2e.py
```

覆盖繁简及短词检索、代码、同文多格式、同名不同正文、空文件、隔离稿、日期筛选、字幕定位和源文件变更。真实资料的 [端到端检查](evaluation/end-to-end.md) 和 [两期独立机器转写对照](evaluation/audio-check/README.md) 记录了具体证据及局限。测试不能证明全库召回率或转写准确率。
