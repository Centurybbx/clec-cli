# 全库 hybrid development 真实 API 运行（2026-11-12）

结果：45 题全部提交、45 条终态；按逐题验收 **1 PASS、44 FAIL、0 未执行**。其中产品终态 9 completed、25 failed、11 timed_out；completed 并非语义通过。没有重试挑选。完整 JSONL 和诊断、session/Pi、QMD 数据库副本位于 /tmp/clec-direct-20261112-qa/。未执行 held-out 或 mock/unit/component/smoke。

运行器与服务使用冻结 Node 25.7.0、官方 DeepSeek deepseek-flash 和原 generation。独立 SQLite backup 保留原 collection 绝对路径；新 schema-3 数据库位于独立 sessions 目录，原 state 根临时链接指向它，结束后移除；Pi 与 diagnostics 独立。QMD 固定 IPv6 loopback，空闲 API readiness 200（此前启动期 503），经生产检查，不将历史 urllib 502 归为产品失败。未额外预热，缓存状态未知。仅题目送入服务。ordered 后继使用真实历史，包括失败前驱。

请求超时配置 600000 ms；实际多个超时从提交到 settlement 超过 600 秒（见逐题），因此不能声称硬墙钟界限得到保证。失败诊断的 SEARCH_UNAVAILABLE 仅表明有界元数据检查不可用，不能推断 INDEX_MISMATCH 或根因。超时不都证明 provider 被调用；具体事件及各次 metrics 见 JSONL。总运行约 3小时4分，服务退出后无 owned 进程。API、QMD、runner raw exit 均 0；前后冻结检查 raw exit 0，21487 项与指定冻结逐项一致，inventory eac6ee9f96666b01cc109975ea69b3e8e2d7c881c572569943e9e06f1b99e0ad。

可观察 metrics 汇总：modelCalls 13，modelRequestAttempts 13，searchAttempts 48，readAttempts 26；已报告估算 USD 0.049100627999999986，非账单，未报告/中断的用量未知。预算 45 题、180 admissions、8小时，未增加重试。

45 次 GET/terminal/live SSE/full replay/history 机械 reconciliation 均 PASS；completed 中非空引用逐项检查 source ID/version/path、原文 hash、UTF-16 span/quote、generation 和 block 引用顺序。机械 PASS 不等于语义支持。空引用独立显示；失败无最终答案，不把未生成答案判为事实错误。服务耗时为提交至 SSE settlement（含排队和清理）；审计耗时为之后 GET/history/replay/原文核对，不含下面人工审阅时间。检索结果数、read 次数为记录器 metrics，原始检索/read 事件与内容以 JSONL 为准；未知以 ? 标记。

| 案例 | 终态/验收 | 原因或语义 | 服务秒 | 机械审计秒 | 命中/read | 引用 |
|---|---|---|---:|---:|---:|---|
| CLEC-001 | timed_out / FAIL | TIMED_OUT | 963.72 | 0.01 | 0 / 0 | NO_CITATIONS |
| CLEC-002 | failed / FAIL | SEARCH_UNAVAILABLE | 2.38 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-003 | timed_out / FAIL | TIMED_OUT | 961.62 | 0.01 | 0 / 0 | NO_CITATIONS |
| CLEC-004 | failed / FAIL | SEARCH_UNAVAILABLE | 2.40 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-005 | timed_out / FAIL | TIMED_OUT | 1031.55 | 0.04 | 0 / 0 | NO_CITATIONS |
| CLEC-006 | failed / FAIL | SEARCH_UNAVAILABLE | 2.33 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-007 | timed_out / FAIL | TIMED_OUT | 1029.71 | 0.04 | 12 / 2 | NO_CITATIONS |
| CLEC-008 | failed / FAIL | SEARCH_UNAVAILABLE | 2.27 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-009 | timed_out / FAIL | TIMED_OUT | 954.53 | 0.04 | 0 / 0 | NO_CITATIONS |
| CLEC-010 | failed / FAIL | SEARCH_UNAVAILABLE | 2.38 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-011 | completed / FAIL | 见下方逐主张 | 44.82 | 1.55 | 12 / 2 | PASS |
| CLEC-012 | failed / FAIL | SEARCH_UNAVAILABLE | 2.13 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-013 | completed / FAIL | 见下方逐主张 | 40.94 | 1.36 | 12 / 2 | PASS |
| CLEC-014 | failed / FAIL | SEARCH_UNAVAILABLE | 2.12 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-015 | completed / FAIL | 见下方逐主张 | 56.68 | 1.44 | 12 / 2 | PASS |
| CLEC-016 | failed / FAIL | SEARCH_UNAVAILABLE | 2.12 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-017 | timed_out / FAIL | TIMED_OUT | 957.43 | 0.02 | 0 / 0 | NO_CITATIONS |
| CLEC-018 | failed / FAIL | SEARCH_UNAVAILABLE | 2.35 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-019 | completed / FAIL | 见下方逐主张 | 35.20 | 1.72 | 12 / 2 | PASS |
| CLEC-020 | failed / FAIL | SEARCH_UNAVAILABLE | 2.23 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-021 | timed_out / FAIL | TIMED_OUT | 959.58 | 0.02 | 0 / 0 | NO_CITATIONS |
| CLEC-022 | failed / FAIL | SEARCH_UNAVAILABLE | 2.37 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-023 | completed / FAIL | 见下方逐主张 | 41.62 | 0.01 | 12 / 2 | NO_CITATIONS |
| CLEC-024 | failed / FAIL | SEARCH_UNAVAILABLE | 2.18 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-025 | completed / FAIL | 见下方逐主张 | 145.24 | 1.01 | 12 / 2 | PASS |
| CLEC-026 | failed / FAIL | SEARCH_UNAVAILABLE | 2.13 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-027 | timed_out / FAIL | TIMED_OUT | 923.13 | 0.12 | 0 / 0 | NO_CITATIONS |
| CLEC-028 | failed / FAIL | SEARCH_UNAVAILABLE | 2.31 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-029 | failed / FAIL | SEARCH_UNAVAILABLE | 34.20 | 0.01 | 12 / 2 | NO_CITATIONS |
| CLEC-030 | timed_out / FAIL | TIMED_OUT | 992.32 | 0.11 | 0 / 0 | NO_CITATIONS |
| CLEC-031 | failed / FAIL | SEARCH_UNAVAILABLE | 2.34 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-032 | completed / FAIL | 见下方逐主张 | 38.12 | 1.13 | 12 / 2 | PASS |
| CLEC-033 | failed / FAIL | SEARCH_UNAVAILABLE | 2.14 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-034 | timed_out / FAIL | TIMED_OUT | 955.08 | 0.01 | 0 / 0 | NO_CITATIONS |
| CLEC-035 | failed / FAIL | SEARCH_UNAVAILABLE | 2.38 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-036 | failed / FAIL | SEARCH_UNAVAILABLE | 37.65 | 0.01 | 12 / 2 | NO_CITATIONS |
| CLEC-037 | timed_out / FAIL | TIMED_OUT | 638.04 | 0.02 | 0 / 0 | NO_CITATIONS |
| CLEC-038 | failed / FAIL | SEARCH_UNAVAILABLE | 2.46 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-039 | completed / PASS | 见下方逐主张 | 38.82 | 1.10 | 12 / 2 | PASS |
| CLEC-040 | failed / FAIL | SEARCH_UNAVAILABLE | 2.12 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-041 | completed / FAIL | 见下方逐主张 | 45.00 | 1.06 | 12 / 2 | PASS |
| CLEC-042 | failed / FAIL | SEARCH_UNAVAILABLE | 2.17 | 0.00 | 0 / 0 | NO_CITATIONS |
| CLEC-043 | failed / FAIL | SEARCH_UNAVAILABLE | 38.98 | 0.01 | 12 / 2 | NO_CITATIONS |
| CLEC-044 | failed / FAIL | SEARCH_UNAVAILABLE | 2.33 | 0.01 | 0 / 0 | NO_CITATIONS |
| CLEC-045 | failed / FAIL | SEARCH_UNAVAILABLE | 2.21 | 0.01 | 0 / 0 | NO_CITATIONS |

## 已生成答案的逐主张语义审阅

- **CLEC-011**：FAIL：C1 支持提问 59 岁及老师让自行 Google、未给规则；C2 支持另一转写中的同一问答和 RAV 字样。答案将它称为同集「较早的部分」并断言 ASR 误识 Roth，证据仅显示两个版本，不能确定时间先后或识别错误；有转录未核实 caveat。
- **CLEC-013**：FAIL：C1/C3 支持来信者质押、2.6%、贷 20% 买 00670L、每月 2 万买 00662，以及卖出 00878/00919；但把「緊急預備金」紧接的转写断句解释成 00670L 作紧急预备金，与指定文本中预留相等现金的语义不符。来源为未经核听转写。
- **CLEC-015**：FAIL：C1/C2 确实列 3086 港元、9086 美元、2834 港元并重复后者，且支持另一汇回场景的条件和 80/20；指定另一转写列 9834 美元，答案遗漏该项，版本差异不能当作事实已核定。
- **CLEC-019**：FAIL：C1/C2 支持初始千万×2%=20万、资产变 500/3000 万仍 20 万，以及年份和资金转换条件；不同版本 00864B/00865B 被并列。附加百万例逐项抄到原文，但原文「6万的30%是2万」算术不精确（实为1.8万），答案未标明近似或原文瑕疵，且额外细节扩大误导。
- **CLEC-023**：FAIL：仅 gap，无引用；前驱 022 失败，实际会话历史缺失该示例，故不得把 gap 当作无证据的全库否定；未给所需第二年 2 万及 34→32、28.8→30.8。gap 仅 kind/text，未观察到额外 evidenceIds。
- **CLEC-025**：FAIL：C4 这份派生书单确无 101 编号，局部否定有该引用支持；但指定原文抽取明确列 101 的 A Random Walk Down Wall Street、Burton G Malkiel、12版，答案未回答，引用来源为未经人工审核的派生整理，不能以它否定其他来源。gap 仅 kind/text。
- **CLEC-032**：FAIL：C1 支持先存钱、半年或一年约定、投资获利时奖金、不动本金和示例；答案遗漏鼓励部分奖金再投资，并把每半年或一年赚得越多的原文说法直接重复，未提示这不是获利保证；来源为未经核听转写。前驱 031 失败，历史情境混淆无法按成功前驱验证。
- **CLEC-039**：PASS：C2 支持控制权、未来子女行为不确定、保留名下、母亲过世后转父亲的例子，及该来信人情境；文本归属明确且带经验与非专业建议 caveat。仅评价文中主张。
- **CLEC-041**：FAIL：C4 支持 433 的 40/30/30 及表中例子，C3/C2 支持所引书中两条约束；但同时列 442（现金20%、杠杆40%）作为标准且未解释其违反所述杠杆不高于现金、现金至少30%的指定约束，未给出清晰场景边界；非风险保证。

所有失败/超时题没有最终主张或引用，因此逐 claim 审阅不适用；其问题、检索轨迹、GET、SSE、history 和原始错误保留在 JSONL。009 数字污染、031 场景混淆、038 来源负面断言因没有最终答案而未观察；本次不能声称已解决。未观察到 ANSWER_PROTOCOL 的 gap 多 evidenceIds 故障，不代表该分支已覆盖。服务端 metrics 和原始事件可能没有检索命中/阅读内容，缺失不推断为零。人工语义审阅耗时未单独计时，未知。完整生命周期、取消恢复和最终交付不在本次结果中。
