# Hybrid 502 响应边界（2026-11-12）

结论：本次同一 owned QMD 服务上的三客户端对照中，Python urllib 默认请求走了系统发现的 HTTP 代理路径，返回空 body 502；curl 和 Node fetch 直连 IPv6 loopback 均返回 200。显式禁用 urllib 代理后，相同请求也直连 `::1` 并返回 200。Python 的代理请求行、系统代理发现、带端口的 bypass 结果共同定位到客户端代理选择；没有抓包直接记录默认 urllib 的 socket peer，因此不能声称实测了具体代理进程产生 502。历史两次失败是其他请求，不能反向补造其网络轨迹。未修改系统代理。

## 同服务客户端对照

原始证据在 `/tmp/clec-boundary-20261112/`：`run.py`、`request.json`、`result.json`、`curl.stderr`、`curl.headers`、`curl.stdout`、`curl.body`、`fetch.stdout`、`fetch.body`、`urllib.trace`、`urllib.body`、`samples.log`、`server.log`。对同一 PID 82485、端口 58489，顺序发送完全相同的 UTF-8 body：中文 lex「资产配置 风险」、vec「如何配置资产并控制风险」、`rerank:true`、limit 10。QMD 监听仅 `[::1]:58489`，数据库为前次 SQLite backup 副本；请求没有改为 lexical-only。

| 客户端 | 请求及连接 | 结果 |
| --- | --- | --- |
| curl | `--noproxy '*'`，`http://[::1]:58489/query`；curl 记录 local `::1:58491`、remote `::1:58489`、proxy_used 0 | HTTP 200，10 条，40.70 秒 |
| Node 25.7 原生 fetch | 相同 IPv6 URL，服务端采样记录 `::1` 到 `::1` 已建立连接 | HTTP 200，10 条，1.74 秒 |
| Python 3.14 urllib 默认 opener | `http://localhost:58489/query`；HTTP debug 显示请求行是代理形式 `POST http://localhost:58489/query HTTP/1.1` | HTTP 502，`Connection: close`、`Content-Length: 0`，2.83 秒 |

系统代理发现报告 HTTP 为 `http://127.0.0.1:7897`；本次进程没有设置代理环境变量。`proxy_bypass('localhost')` 为 true，但 `proxy_bypass('localhost:58489')` 为 false；`::1` 和带端口的 `[::1]` 也为 false。代理发现和完整绝对形式请求行说明默认 urllib 选择代理，不能仅用无端口 localhost bypass 结果判断请求直连。默认 urllib 的 socket peer 未采集，502 的具体代理进程或上游原因未独立观测。

随后用同 URL、同一备份数据库重启 owned 服务，`ProxyHandler({})` 仅对该 Python opener 禁用代理；真实 socket audit 记录 `('::1', 58489, 0, 0)`，origin-form `POST /query`，HTTP 200、10 条、2.17 秒。证据为 `urllib-direct.py`、`urllib-direct.trace`、`urllib-direct-result.json`、`urllib-direct.body` 和 `urllib-direct-server.log`。这次不更改系统配置。六次本地 query 总数为：三客户端对照 3、推理观察 2、Python 直连 1。

静态旁证：实际运行的 QMD `dist/mcp/server.js` 对 `/query` 输入错误返回 400，origin guard 返回 403，成功返回 200，外层异常返回 500；没有该路由生成空 502 的分支。成功查询日志在 `store.search` 返回之后输出。静态代码本身不能证明历史请求未到达 QMD，也不能单独确定 502 产生者。

## 真实模型执行

服务 PID 的 `samples.log` 在首次直连查询期间分别观察到本地 embedding 和 reranker GGUF 文件打开/映射，单凭文件句柄不能证明推理。为补足执行证据，从原 generation 数据库以 SQLite read-only source 和 backup API 创建另一个独立副本，在启动脚本中对真实 `LlamaCpp` 方法加透传计时记录：原方法照常执行、返回原值或抛出原异常，没有替换结果。相同中文请求返回 HTTP 200、10 条；`/tmp/clec-boundary-inference-20261112/inference-server.log` 记录 `embedBatch` 进入并正常返回（1279 ms），随后 `rerank` 进入并正常返回（36012 ms），服务记录两种查询完成。完整启动脚本、HTTP headers/body 和退出信息在该目录。前一次观察只包了 `embed` 和 `rerank`，记录了 rerank 返回；查看真实调用路径后补记 `embedBatch`。这些是该次真实本地方法执行的证据，不是对所有历史请求或答案质量的证明。

## CLEC 生产入口与限制

对同一 URL `http://[::1]:58489`、相同 QMD backup 和原 generation 路径，在服务空闲时调用实际构建的 CLEC `currentGeneration` 与生产 readiness 使用的 `assertQmdGeneration`，通过 MCP initialize、initialized 和 status，身份检查返回成功，耗时 1471 ms。证据为 `production.mjs`、`mcp-check.py`、`mcp-result.json` 和 `mcp-server.log`。第一次在 40 秒查询执行期间调用同一检查，1.5 秒界限内返回 `SEARCH_UNAVAILABLE`；服务稍后才记录 initialize，不能当作空闲 readiness 稳定失败。这里验证的是生产 readiness 的 QMD generation 检查入口，**未启动完整 CLEC HTTP readiness 或执行 CLEC 检索/QA**，不证明隔离 session/Pi 部署和完整 QA。无付费 provider 调用。

## 冻结、清理与后续 45 题

前后 artifact-manifest 均退出 0，21,487 项，inventory SHA-256 均为 `eac6ee9f96666b01cc109975ea69b3e8e2d7c881c572569943e9e06f1b99e0ad`；前后 `files` 与 `/tmp/clec-qa-preflight-20261112.json` 逐项相等。保存在 `before.json`、`after.json`。每个 owned QMD 进程由启动者发送 SIGINT 并 wait，raw exit 均 0，端口无剩余 listener。未重建全库、下载模型、读密钥或 held-out、调用 DeepSeek、修改产品，亦未更改旧失败报告。

后续 45 题建议固定 `CLEC_QMD_URL=http://[::1]:<owned-port>` 并先核实实际监听、生产 generation 身份与空闲 readiness；Python 诊断必须使用 `ProxyHandler({})`，curl 使用 `--noproxy '*'`，保留请求级 peer、状态和 headers。不要依赖无端口 `proxy_bypass('localhost')`。本次 Node fetch 和生产 MCP 检查验证了该 IPv6 URL，不保证其他 Node 代理配置自动直连。确保请求预算容纳冷模型加载，并避免在密集推理期间把 1.5 秒身份检查超时误记为索引不匹配。

为后续运行准备独立 session 数据库、Pi 目录和诊断输出；QMD 数据库使用 SQLite backup，避免向已发布数据库写缓存。generation metadata 中 collection 绝对路径仍指向原 generation Markdown；若复制 generation，必须让实际 QMD collection path 与 CLEC 所解析的 generation 路径一致，并通过真实 `assertQmdGeneration`，不能仅复制文件后假定身份匹配。确保隔离副本和源语料的生命周期覆盖运行，保留前后冻结及所有失败，避免并发观察互相污染。45 题、答案语义和原报告所列未观察门禁仍未执行。
