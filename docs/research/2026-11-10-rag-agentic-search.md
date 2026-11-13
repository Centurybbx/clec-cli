**CLEC：RAG 与 Agentic Search 选型调研**

调研截止：2026-11-10。结论与适配判断由本次研究给出，项目能力声明、维护状态和外部实验分别注明来源。

**结论：CLEC 应以“混合索引支撑的 Agentic Search”处理主题研究与跨期综合。**

如果必须在“一次取 Top-K 的 RAG”与“Agent 自主补搜”之间选择主流程，CLEC 的主题研究应选后者；检索工具继续使用 BM25、向量检索与排名融合。这通常也被称为 Agentic RAG。明确节目或单条事实可以走短路径，读到完整证据后直接回答。

这是一项架构选择建议。尚未在 CLEC 上运行同模型、同预算的多方案对照，不能据此宣布某个产品、模型或参数已取得本库最高准确率。

本次完成 35 个项目的 GitHub 元数据与官方 README 核对，并对关键项目追加官方文档或源码阅读；另核对 2026 年论文、工程文章及一份播客的官方文字稿。没有安装、运行或逐行审计这 35 个项目。GitHub stars 是 2026-11-10 查询快照，样本范围约 4 千至 16 万星；这是目的性抽样，不是全网排名、市场占有率统计或投票评选。14 个应用、6 个框架、3 个研究 Agent、6 个专用检索项目和6个检索底层项目处在不同层次，不应彼此当作同类产品比较。Quivr 的旧仓库发生重定向，本次未核对其当前 README，不计入 35 个。

**为什么适合 CLEC。**

本地只读检查显示，现有索引记录 10,233 条来源、66,777 个 chunk，正文片段合计 56,750,508 个 Unicode 字符；语义索引元数据记录 331,953 个窗口。来源包含同文多格式和跨站版本，不能当作独立节目数；字符数也不能直接换算成模型 token 数。索引修订时间为 2026-11-07，本次没有重新构建或逐个验证所有原文件。

用户目标是“尽可能多地收集相关信息，再综合输出”，同时需要跨期比较、区分老师与来信者、保留建议的前提并引用原文。这包含三个不同任务：

| 用户任务 | 建议流程 | 成功标准 |
|---|---|---|
| 指定节目、引文、编号或单个明确事实 | 关键词/混合搜索，展开原文后回答 | 原文定位准确、主张有证据、前提齐全 |
| 跨节目主题问答、解释不同说法 | 有预算的 Agentic Search，以混合索引发现来源 | 多表达检索、补读上下文、覆盖不同对象/时间/条件 |
| 全库主要主题、主题发展史、系统整理 | 主题/时间分组的覆盖式研究与分批综合 | 有资料覆盖记录、缺口和原文回链；不能只汇总初始 Top-K |

选择 Agent 并不会自动获得完整覆盖。现有 [端到端记录](../../evaluation/end-to-end.md) 已经出现需要读相邻片段才能正确归因的例子；[模型摘要试验](../../evaluation/model-safety.md) 显示，引文存在也可能伴随条件遗漏。这些是本地已有记录，本次没有重做实验。

**最影响结论的外部证据。**

| 日期 | 一手资料 | 本次核对到的内容 | 对 CLEC 的含义与限制 |
|---|---|---|---|
| 2026-10-25 | [Michał Wojdylak：同一搜索引擎上的多种 RAG 实验](https://michalwojdylak.com/blog/rag-2026-benchmark-agentic-graph-metarag) | 固定主要搜索环境，比较多种实现；推理模型配置改变后，方法表现明显变化，简单混合检索加重排仍是有力基线。 | 实验作者的一手工程报告；单一模型族、部分方法为改编实现、预算和模型调用不完全一致，不能当作普适排行榜。 |
| 2026-10-04 | [Agentic RAG Evaluation](https://arxiv.org/abs/2610.05034) | 专门研究问题数量、搜索轨迹和重复阅读之间的评测预算分配。 | 应扩大真实问题覆盖并审计重复运行；这是预印本，不提供 CLEC 的产品胜者。 |
| 2026-08-25 | [Agents and Engineers：Search is Eating AI](https://agentsandengineers.com/episodes/0013-search-is-eating-ai/) | 已阅读官方 show notes 与文字稿。02:09 起区分增强 harness、搜索后端和训练模型；11:04 起强调先建立检索评测基线。 | 这是专家实践观点，不是受控实验。说明“Agent 与检索器”是两个可共同改进的层次。未宣称听过原始音频。 |
| 2026-08-20 | [Mistral：Introducing Agentic Search](https://mistral.ai/news/agentic-search/) | 在现有索引上提供 search/open/navigate/read/grep，并报告在文档问答基准上的提升。 | 与 CLEC 的读原文和跨源核对接近；数字是厂商自报，不可直接移植到中文转写库。 |
| 2026-07-31 v3 | [BM25 Wins at Scale](https://arxiv.org/html/2607.26497v3) | 在嵌套扩大企业语料的设置中，纯文件系统探索随规模扩大表现变差；受控实验中为 Agent 加入排序检索，比纯文件探索更有利。 | 支持“先排序发现，再自主阅读”。使用一个读者模型、合成企业基准和特定预算；其规模交叉点不是 CLEC 的硬阈值，论文也不证明所有向量模型不如 BM25。 |
| 2026-05-14 | [Is Grep All You Need?](https://arxiv.org/html/2605.15184v1) | grep 在长对话记忆任务中有竞争力；框架和结果交付方式会改变比较。 | 作者明确限制外推，不能据此删除 CLEC 语义召回。 |
| 2026-05-07 | [AgenticRAG：Enterprise Knowledge Bases](https://arxiv.org/html/2605.05538v1) | 在搜索基础设施上加轻量搜索/查找/打开/总结循环，获得提升；失败分析承认广泛多证据检索仍是弱项。 | 最贴近 CLEC 的重要限制：Agent 可能深读少数来源，却没有找全不同证据。需显式加入宽搜与覆盖追踪。 |
| 2026-05-03 | [PageIndex File System](https://pageindex.ai/blog/pageindex-filesystem) | 目录树推理检索已扩展至跨文档层次；文中区分企业版和云发布安排。 | 不能把 PageIndex 错写成只支持单篇；它仍构建树索引。对重复多版本、弱章节结构的逐字稿需单独验证，不能用营销承诺证明无遗漏。 |
| 2026-03-24 | [Mintlify：虚拟文件系统](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant) | grep/cat/ls 接口翻译为 Chroma 数据库查询，grep 先粗筛再缓存和精筛。 | 文件系统工具外观与检索底层独立，“用 grep”不能推导为“取消索引”。 |
| 2026-04-28 v3 | [Agentic Search in the Wild](https://arxiv.org/abs/2601.17617) | 真实搜索日志中存在重复搜索和按意图变化的探索行为，提出停止与预算的候选信号。 | 支持按任务给预算和记录跨轮上下文；日志分析不证明某种停止规则能保证找全。 |
| 2025-09-29 | [Anthropic：Effective Context Engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 按需探索、渐进阅读和混合策略；同时承认运行时探索有速度代价。 | 是理解 grep 路线的原始背景，非 2026 最新性能结论，也没有普遍废除索引。 |

上述来源的受控程度和适用语料不同。不能把某篇 FinanceBench 的答案分数、另一篇企业综合分数和 CLEC 的五题命中结果放在一张“准确率排行”里。

**35 个项目的逐项核对清单。**

以下“适配”是针对 CLEC 的工程判断，不是实测评分。最近 push 只是仓库活动信号，既不等于最近稳定版本发布日期，也不能独立证明持续维护；归档标记与 README 明确维护模式单独列出。

| # | 项目及官方 README | Stars 快照 | 层次 | 核对到的路线 | 状态快照 | 对 CLEC 的判断 |
|---|---|---:|---|---|---|---|
| 1 | [RAGFlow](https://github.com/infiniflow/ragflow/blob/main/README.md) | 93,918 | 应用 | 文档解析、RAG 与 Agent 能力融合 | 未归档；最近 push 2026-11-10 | 优先考察：可借鉴复杂资料入库与检索测试；是否迁移需评估现有来源定位能否保留。 |
| 2 | [Onyx](https://github.com/onyx-dot-app/onyx/blob/main/README.md) | 33,310 | 应用 | 混合索引＋Agentic RAG＋多步研究 | 未归档；最近 push 2026-11-10 | 重点架构参考：与跨来源查证接近；连接器、权限等能力增加部署范围。 |
| 3 | [Dify](https://github.com/langgenius/dify/blob/main/README.md) | 160,783 | 应用 | 知识库 RAG＋可视化 Agent 工作流 | 未归档；最近 push 2026-11-10 | 平台候选：适合需要可视化编排时采用；README 不等于默认检索配置或性能保证。 |
| 4 | [FastGPT](https://github.com/labring/FastGPT/blob/main/README.md) | 30,016 | 应用 | 中文知识库、混合检索与重排、工作流 | 未归档；最近 push 2026-11-09 | 中文平台候选：可参考中文检索与调试界面；还需定制来源质量及条件保留。 |
| 5 | [MaxKB](https://github.com/1Panel-dev/MaxKB/blob/v2/README.md) | 23,132 | 应用 | RAG＋Agent 工作流＋MCP 工具 | 未归档；最近 push 2026-11-10 | 平台候选：适合现成企业知识库界面；没有验证在 CLEC 上的召回。 |
| 6 | [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm/blob/master/README.md) | 68,120 | 应用 | 本地文档向量检索＋Agent＋引用 | 未归档；最近 push 2026-11-09 | 桌面体验候选：适合快速交互；大量文献覆盖与精确证据追踪仍需定制。 |
| 7 | [Open WebUI](https://github.com/open-webui/open-webui/blob/main/README.md) | 158,242 | 应用 | 文档检索＋原生知识工具＋可选 shell 风格导航 | 未归档；最近 push 2026-11-10 | 交互入口候选：官方文档同时保留语义查询与 grep/read；混合检索开关和 kb_exec 并非默认开启。 |
| 8 | [Khoj](https://github.com/khoj-ai/khoj/blob/master/README.md) | 38,093 | 应用 | 个人资料语义搜索＋自定义 Agent | 未归档；最近 push 2026-08-02 | 个人助理参考：可参考个人知识探索；需评估 CLEC 的日期、归因和覆盖约束。 |
| 9 | [PrivateGPT](https://github.com/zylon-ai/private-gpt/blob/main/README.md) | 57,631 | 应用 | 私有 API：入库、带引用检索与 Agentic RAG | 未归档；最近 push 2026-11-03 | API 路线候选：README 当前已覆盖 Agentic RAG；不要沿用早期仅静态本地聊天的印象。 |
| 10 | [GPT4All](https://github.com/nomic-ai/gpt4all/blob/main/README.md) | 77,353 | 应用 | 本地模型桌面生态 | 未归档；最近 push 2025-05-27 | 历史参考：本次元数据显示最后 push 为 2025-05-27；不据此断言停止维护，也不作为首选新架构。 |
| 11 | [DocsGPT](https://github.com/arc53/DocsGPT/blob/main/README.md) | 18,367 | 应用 | 文档分析、知识连接、Agent 与多步研究 | 未归档；最近 push 2026-11-09 | 平台候选：覆盖入库至研究；精确原文哈希与字幕版本仍需项目适配。 |
| 12 | [Verba](https://github.com/weaviate/Verba/blob/main/README.md) | 7,691 | 应用 | 混合 RAG；README 将 Agentic RAG 标为范围外 | 已归档；最近 push 2026-06-08 | 历史对照：GitHub 已归档；重排在 README 中仍标计划，不能当作现成功能。 |
| 13 | [R2R](https://github.com/SciPhi-AI/R2R/blob/main/py/README.md) | 8,077 | 应用 | 混合搜索＋RRF＋知识图谱＋研究 Agent | 未归档；最近 push 2025-11-07 | 历史架构参考：最后 push 为 2025-11-07；参考设计前核查维护和迁移成本。 |
| 14 | [Kotaemon](https://github.com/Cinnamon/kotaemon/blob/main/README.md) | 25,898 | 应用 | 默认混合检索与重排＋可选问题分解 Agent | 未归档；最近 push 2026-07-14 | 文档体验参考：有详细引用和文档预览，可参考如何呈现证据。 |
| 15 | [LlamaIndex](https://github.com/run-llama/llama_index/blob/main/README.md) | 52,862 | 框架 | 文档索引、检索器、查询引擎与 Agent 框架 | 未归档；最近 push 2026-11-08 | 框架候选：组件丰富；采用框架并不自动解决覆盖和归因。 |
| 16 | [Haystack](https://github.com/deepset-ai/haystack/blob/main/README.md) | 26,968 | 框架 | 显式检索、过滤、路由与 Agent 流水线 | 未归档；最近 push 2026-11-10 | 框架候选：适合需要可观察流程时使用；本地 CLI 小规模改造未必需要。 |
| 17 | [LangChain](https://github.com/langchain-ai/langchain/blob/master/README.md) | 149,284 | 框架 | 模型、工具、检索器与 Agent 集成 | 未归档；最近 push 2026-11-10 | 组件参考：集成框架，不能与成品知识库按准确率直接比较。 |
| 18 | [LangGraph](https://github.com/langchain-ai/langgraph/blob/main/README.md) | 44,717 | 框架 | 有状态工作流、循环与持久执行 | 未归档；最近 push 2026-11-09 | 后续编排候选：当研究任务需要恢复、状态追踪时有价值；首版可先用小控制循环。 |
| 19 | [Deep Agents](https://github.com/langchain-ai/deepagents/blob/main/README.md) | 31,157 | 框架 | 规划、文件系统、上下文管理与可插拔工具 | 未归档；最近 push 2026-11-10 | Agent 编排参考：文件系统接口不限定检索只能用 grep，也可挂混合检索工具。 |
| 20 | [smolagents](https://github.com/huggingface/smolagents/blob/main/README.md) | 30,289 | 框架 | 用代码调用工具的轻量 Agent | 未归档；最近 push 2026-11-03 | 轻量编排参考：需要自行提供知识检索与证据工具，不附送 CLEC 级资料治理。 |
| 21 | [GPT Researcher](https://github.com/assafelovic/gpt-researcher/blob/main/README.md) | 30,605 | 研究Agent | 研究问题拆解＋本地/网络研究＋带引用报告 | 未归档；最近 push 2026-11-09 | 研究流程参考：可借鉴宽搜索和报告结构；仍需绑定本地原始证据。 |
| 22 | [Open Deep Research](https://github.com/langchain-ai/open_deep_research/blob/main/README.md) | 12,677 | 研究Agent | 多步研究 Agent，支持搜索工具与 MCP | 已归档；最近 push 2026-08-10 | 历史研究参考：GitHub 已归档；不作为当前优先新依赖。 |
| 23 | [STORM](https://github.com/stanford-oval/storm/blob/main/README.md) | 31,846 | 研究Agent | 多视角提问、检索和带引用长文生成 | 未归档；最近 push 2025-09-30 | 全局综合参考：提供用户文档检索接口；最后 push 为 2025-09-30，需核查维护。 |
| 24 | [GraphRAG](https://github.com/microsoft/graphrag/blob/main/README.md) | 36,614 | 专用检索 | 实体关系抽取、图组织与主题综合 | README 明确维护模式；最近 push 2026-11-09 | 条件性扩展：README 明确维护模式且索引成本可能较高；未证实 CLEC 需要先建全图。 |
| 25 | [LightRAG](https://github.com/HKUDS/LightRAG/blob/main/README.md) | 40,628 | 专用检索 | 图与向量双层检索、重排、来源引用 | 未归档；最近 push 2026-11-09 | 条件性扩展：实体关系任务值得试验；抽取图谱可能丢失讲话条件，需保留原文。 |
| 26 | [PageIndex](https://github.com/VectifyAI/PageIndex/blob/main/README.md) | 40,322 | 专用检索 | 目录树索引＋LLM 推理导航，无需向量检索 | 未归档；最近 push 2026-11-09 | 局部试验候选：并非无索引；有跨文档文件树扩展，不宜把其能力误写成仅限单篇。对散乱逐字稿需验证。 |
| 27 | [QMD](https://github.com/tobi/qmd/blob/main/README.md) | 31,013 | 专用检索 | 本地 BM25＋向量＋查询扩展＋RRF＋重排 | 未归档；最近 push 2026-10-15 | 最接近的轻量检索参考：源码有 CJK 归一化处理；仍需用 CLEC 测繁简、节目号与转写噪声，不能直接认定中文最好。 |
| 28 | [Qdrant](https://github.com/qdrant/qdrant/blob/master/README.md) | 35,489 | 检索底层 | 向量检索、过滤与可选本地 Edge | 未归档；最近 push 2026-11-10 | 底层备选：解决存储与检索，不代替问题规划和证据综合。 |
| 29 | [Weaviate](https://github.com/weaviate/weaviate/blob/main/README.md) | 16,944 | 检索底层 | 向量、关键词相关能力与重排集成 | 未归档；最近 push 2026-11-09 | 底层备选：适合统一检索服务；不等于需要迁移现有 SQLite。 |
| 30 | [Milvus](https://github.com/milvus-io/milvus/blob/master/README.md) | 46,621 | 检索底层 | 大规模向量 ANN 与混合检索 | 未归档；最近 push 2026-11-10 | 扩容备选：用于吞吐、规模和部署需求；并非增加覆盖策略的替代品。 |
| 31 | [Vespa](https://github.com/vespa-engine/vespa/blob/master/README.md) | 7,167 | 检索底层 | 文本、向量、张量与排序平台 | 未归档；最近 push 2026-11-10 | 服务化备选：检索与排序基础设施；Mistral 的 starter 使用它，不证明 CLEC 必须采用。 |
| 32 | [Elasticsearch](https://github.com/elastic/elasticsearch/blob/main/README.asciidoc) | 78,549 | 检索底层 | 全文、向量与生产检索平台 | 未归档；最近 push 2026-11-10 | 服务化备选：需要可运维搜索服务时再比较；本次不做迁移建议。 |
| 33 | [Chroma](https://github.com/chroma-core/chroma/blob/main/README.md) | 29,665 | 检索底层 | 向量资料存储和检索；Cloud 提供混合与全文搜索 | 未归档；最近 push 2026-11-07 | 底层备选：必须区分开源和 Cloud 能力；文件系统接口也可建立在数据库上。 |
| 34 | [RAGatouille](https://github.com/AnswerDotAI/RAGatouille/blob/main/README.md) | 3,974 | 专用检索 | ColBERT late-interaction 检索 | 未归档；最近 push 2025-05-17 | 模型层对照：提供另一类检索模型；最后 push 为 2025-05-17，非默认新依赖。 |
| 35 | [txtai](https://github.com/neuml/txtai/blob/master/README.md) | 13,248 | 专用检索 | 稀疏/稠密向量、图与 SQL＋工作流/Agent | 未归档；最近 push 2026-11-10 | 组件参考：可提供检索与编排组合；同样需要本地证据和中文评测。 |

元数据与文件 blob SHA 保存在 [JSON 清单](2026-11-10-project-inventory.json)。官方 README 支持的是“功能声明存在”，不证明该功能是默认配置或在本库有效。

**几个值得纠正的选型印象。**

- QMD 是最接近 CLEC 本地 CLI 检索定位的参考之一，已有混合检索、RRF、重排和 Agent 输出接口。追加阅读的 [src/store.ts](https://github.com/tobi/qmd/blob/main/src/store.ts) 中有 normalizeCjkForFTS，处理中文等字符的匹配；不能简单断言它只适用于英文，也不能凭这个函数认定其繁简与转写表现优于 CLEC。
- [Open WebUI 官方文档](https://docs.openwebui.com/features/workspace/knowledge/) 把篇内 grep/读取与语义查询同时暴露；shell 风格 kb_exec 仍标为实验、默认关闭。[配置文档](https://docs.openwebui.com/reference/env-configuration/) 也表明混合检索不是默认开启。安装产品不等于启用全部最佳候选配置。
- [Kotaemon](https://github.com/Cinnamon/kotaemon) 同时提供混合检索重排和问题分解/Agent；它说明“普通 RAG 产品”与“Agent 产品”的边界并不排斥。
- GraphRAG 当前 README 明确进入维护模式；Verba 和 Open Deep Research 的 API 元数据为已归档。它们仍有设计参考价值，但本次不作为 CLEC 新依赖的优先项。
- PageIndex 的“不用向量”不等于不建索引；图谱与目录树都是派生结构，构建错误和剪枝遗漏同样需要评测。

**建议实施路线。**

首选继续扩展现有 CLEC，把它做成由单个研究 Agent 驱动、可检查覆盖的搜索工具集。复杂问题的默认路径如下：

1. 识别问题需要的对象、时间和证据范围，生成若干子问题及同义表达。保持用户原问题，避免模型改写漂移。
2. 先在全库使用关键词与向量检索进行来源发现，并保留两路贡献。采用多个较宽查询，避免只有一次 AND 关键词查询。
3. 累积证据池，按来源与实际证据片段分别去重；保留同篇不同位置、不同前提的论述。研究模式要支持读取同一来源的更多命中。
4. 对已经定位的来源，篇内精确搜索并展开上下文；补齐讲者、日期、来信与回复边界。来源质量标记和文件哈希继续随证据返回。
5. 在研究状态中记录“子问题→已读证据→条件/分歧→缺口”。有缺口时重新搜索，排除已读片段；对日期未知材料单独审阅，避免日期过滤静默遗漏。
6. 设置时间、token、工具次数预算。无新增独立信息可作为停止信号；达到预算时把未解决问题带入输出，不表述成已穷尽。
7. 根据原文生成带证据 ID 的答案，分别陈述不同时间、对象及条件。模型生成的摘要仅是导航和工作笔记，不替代原始证据。

[Mistral 的工具文档](https://docs.mistral.ai/studio/search/agentic-search) 是这组导航工具的直接参考，包含 exclude_ids、相邻阅读和循环上限；[Onyx](https://github.com/onyx-dot-app/onyx) 是“混合索引＋研究 harness”的产品参考。只借鉴职责划分，不要求引入对应云服务或整套部署。

这条路线不是让 Agent 无限制多搜。对 CLEC 更重要的是“先宽搜，再深读，再对缺口补搜”，防止把少数高相关来源误认为主题全貌。全库综合可在之后增加带原文回链的节目/主题导航结构，暂不先为全部语料抽取知识图谱。

**现有代码应优先补哪些能力。**

| 当前观察 | 优先调整方向 | 原因 |
|---|---|---|
| research 自动关键词来自小领域词表 | 多表达/多子问题查询，保留手工关键词入口 | 词表外表达会影响关键词召回 |
| 关键词 AND 匹配 | 宽查与精查分别调用或明确配置 | 过多条件同时要求匹配，可能漏掉分散表达 |
| 语义检索及默认关键词展示按来源折叠 | 研究模式允许同源多个证据，先记录再折叠展示 | 一篇里可能有多段不同前提与回复 |
| research 是一次两路检索与融合 | 外部 Agent 增加状态、补搜、已读排除和预算 | 有工具并不等于有受测的完整研究流程 |
| 未接入独立重排 | 先作为对照实验加入，不直接裁剪所有研究证据 | 重排可改善前排精度，也可能过早丢掉罕见例外 |
| 当前五题自然问题检查 | 扩大真实中文问题和多证据标注 | 找到一个预选来源不等于覆盖主题 |
| 本地向量线性扫描 | 先测冷/热启动及端到端延迟，再决定缓存或向量服务 | 未发现需要先更换数据库的性能证据 |

**怎样确认“最好用”。**

建议用 60～100 道真实 CLEC 问题作第一轮对照。数量是本次工程建议，不是文献给出的普适标准。覆盖节目号、短中文关键词、换一种说法、多节目综合、时间比较、前提与归因、反例和无证据问题；主题研究题必须标注多条必要证据或必要论点，不能只标一个正确节目。

比较三条主线：现有一次混合检索、纯文件 grep/read Agent、混合索引＋受预算控制的 Agent。重排作为可选开关，再比较对答案与覆盖的净贡献。保持回答模型、提示约束及答案格式尽量相同，分别报告固定预算下的质量和达到同等质量的成本；保存完整轨迹。

分别检查候选召回、必要证据/论点覆盖、引用是否支持主张、条件与说话人是否保留、无证据时是否正确说明缺证，以及端到端时间和 token。广泛收集多条证据时，不应只用第一条命中的准确率或 Recall@1 选型。

参考 [RAGFlow 官方检索测试](https://ragflow.io/docs/retrieval_testing) 区分“资料没召回”与“召回但回答错误”。对未标注的真实全库，不承诺精确测得绝对召回率；可通过多方法候选池、人工审核和新发现证据持续补充评测集。

**最终建议。**

CLEC 主流程采用混合索引支撑的 Agentic Search。明确查找走短路径，主题研究走有覆盖记录的多轮路径。当前最合适的工作是扩展既有工具与评测，参考 QMD 的本地检索组合、Onyx/Mistral 的检索阅读循环，以及 GPT Researcher/STORM 的问题拆解与综合。若未来需要现成 UI，再比较 RAGFlow、FastGPT、Open WebUI 等平台；现有证据不足以宣布其中任何一个在 CLEC 上实测最好。

