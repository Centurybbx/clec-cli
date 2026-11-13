# 全库 hybrid development 执行记录（2026-11-12）

结果：**未完成验收**。受控 QMD 中文混合请求重现 HTTP 502，按执行约束停止依赖检索的 QA；指定官方 DeepSeek 密钥文件也不存在。45 个 development 案例全部计入未执行，不能给出语义通过率。未读取 held-out，未修改产品、dist 或依赖，也未重建全库。

## 冻结与既有证据

前后 `artifact-manifest.ts` 均退出 0，21,487 项，inventory SHA-256 均为 `eac6ee9f96666b01cc109975ea69b3e8e2d7c881c572569943e9e06f1b99e0ad`；两次 `files` 与指定冻结逐项相等。记录为 `/tmp/clec-qa-preflight-20261112.json`、`/tmp/clec-qa-final-20261112.json`。全库 generation 为 `0d59d05ffa26096251db158ec8d49504eec0757aa33e4dfdf30a67350fe5193f`，未重新构建。

只读核对 `/tmp/clec-recovery-terra-20261111-fGSHES/logs/`：两次 unchanged 均有 exit 0。第一观察者 `unchanged-vectors-check.json` 记录前后各 160,948 行，新增或改变及移除或改变均为 0；第二观察者 `full-unchanged` 未独立记录前后向量数，不能为第二次补造该观察。先前一次 HTTP curl 结果保存为 `full-http-response.txt` 和 `full-http-result.json`，exit 0、约 30.12 秒、10 条结果；另一 observer 的 urllib 请求记录 HTTP 502，服务日志仅启动和 SIGINT。这是不同请求，两个结果均保留。

## 受控 readiness

用 SQLite read-only source 和 SQLite backup API 将已发布 QMD 数据库备份至 `/tmp/clec-qa-20261112-evidence/qmd.sqlite`，未在原 state 写入 session。使用原 generation collection 路径、现有本地模型配置和真实 QMD 服务，随机端口 58160，owned PID 81851。监听证据显示仅 `::1:58160`。中文 lex + vec，`rerank:true`，limit 10 的 urllib 请求在 2.70 秒返回 **502**，响应体为空；服务日志仅启动及 SIGINT，未记录成功查询；采样未观察到 embedding 或 reranker 模型文件打开。服务 SIGINT 后由启动者 wait，raw exit 0。完整脚本、结果、日志、备份、监听和文件描述符记录在 `/tmp/clec-qa-20261112-evidence/`。

本进程无 HTTP/HTTPS/ALL/NO_PROXY 环境变量；系统配置有本地代理及 localhost 例外，Python 报告 localhost bypass 为 true。该信息不能证明 502 的产生者；没有请求级网络追踪或响应来源证据。服务监听 IPv6 不等于证明代理或地址族是根因。QMD 源码显示成功查询日志在 search 完成后才写入，因此没有该日志也不能单独证明请求未进入服务。实际 vec 和 rerank 执行均为 **NOT_OBSERVED**，502 的准确边界和根因为 **未知**。未通过重试或改用 lexical 路径掩盖失败。

## 45 案例及限制

`development.jsonl` 共 45 行：CLEC-001 至 CLEC-045，**45 未执行，0 已执行，0 语义通过，0 可判定语义失败**。未执行不代表产品答案正确或错误。特别是 009 数字污染、031 历史情境混淆、038 来源负面断言以及 gap 额外 evidenceIds 五次历史失败均为 **NOT_OBSERVED**。未创建 ordered sessions，未产生 query/retrieved/read/answer 轨迹、UTF-16 quote/source version、GET/final SSE/replay/history 顺序或逐 claim 事实、条件、归因、负面断言及来源质量审查结果。`acceptance.ts` 和 `report.ts` 未运行：前置 readiness 已失败，且没有可供 report 的真实 recorder 输出。没有将产品 supported 状态视作语义通过。

授权密钥路径 `/Users/century/.t3/userdata/secrets/files/b95bc1b656616ef07438bdf9654a8b38` 不存在（可读性检查失败），未读取或替换密钥。provider admissions 为 0；provider 调用、可观察费用和账单均无记录，不能将无记录视为账单为零。8 小时、180 admissions 和每 run 600 秒上限未消耗于案例执行。无 API 服务或 Pi 会话被启动。

新 schema-3 session/Pi 的完整隔离部署及 generation 绝对路径/collection 身份一致性尚未通过真实 QA 验证；SQLite 备份上的直接 QMD 请求不证明复制 state 可通过 `INDEX_MISMATCH` 门禁。下一次须先解决 502 来源、恢复指定授权密钥，并在不改写原 published generation 的前提下证明隔离 state 的身份匹配，再按原顺序执行全部案例及人工审查。未运行 mock、unit、component 或 smoke 测试。
