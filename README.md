# CLEC 本地证据工具

CLEC 为能执行本地命令的 Agent 提供资料搜索、原文读取和来源导航。使用者下载发布者预先构建的数据包，无需启动 MCP/HTTP 服务、配置模型密钥或在本地建立索引。

当前可安装的 CLI 位于 `cli/`，公开仓库和下载地址尚未配置。本地安装包及完整数据包已经过真实验证。旧后端保留用于迁移对照，尚未完成检索质量验收；不要把本轮实现理解为所有旧能力已被替代。

## 安装和使用

需要 Node.js 22.19.0 或更新版本。已在 macOS arm64 的 Node 22.19.0 和 25.7.0 验证。Windows 和 Linux 尚未实机验证。

发布后使用发布者提供的实际安装包与数据清单地址。以下路径是占位示例，不是已经存在的公开服务。

```sh
npm install --global /path/to/clec-cli-0.1.0.tgz
clec sync --manifest /path/to/release/manifest.json
clec search '退休 提領' --limit 8
clec read '搜索返回的ref'
clec source '搜索返回的sourceRef' --offset 0 --limit 20
clec status
```

也可向 `sync --manifest` 提供 HTTPS 清单地址。默认数据目录是 `~/.local/share/clec`；每个命令都支持 `--data-dir 路径`，也可设置 `CLEC_DATA_DIR`。成功和失败均输出 JSON，失败退出码非零。查询和读取不访问网络。

`read` 返回逐字原文、UTF-16 范围、原始文件哈希、版本、日期依据和质量标签。`previous`、`next` 是相邻章节引用。`source` 分页列出同一资料的章节，不会一次输出整篇长文。

更新先下载并校验候选数据，再切换当前版本。更新前的引用在切换后返回 `VERSION_UNAVAILABLE`，不会偷偷引用新文本。重复同步相同版本校验本地文件后复用，不重新下载数据文件。校验通过只表示数据与所选发布者的清单一致，不证明发布者内容真实。

## Agent 使用约定

先检索，再读取相关结果及上下文，最后自行组织答案。搜索是词法匹配，支持繁简归一化；它不会自动理解所有改写、回答问题或判断论点成立。默认 `--match any` 查找任意查询词；用 `--match all` 要求所有生成的词在同一章节的标题或正文索引中出现，以便缩小关键词检索范围。它不代表完整短语匹配，也不会跨章节拼接条件。

问题给出节目编号时，先单独搜索编号，确认标题和来源，再用 `--source 来源id` 缩小范围。改写查询时保留编号、基金代码、人物和日期。可用 `--date-from YYYY-MM-DD`、`--date-to YYYY-MM-DD` 筛选日期；未知日期不会通过日期筛选。检索结果少时应调整词语，不能据此断言全库没有相关观点。

搜索预览仅用于导航。最终引用以 `read` 原文为准，并核对说话人、时间、条件及例外。不同来源格式可能描述同一期内容，但不能仅凭相似标题认定同文。第三方整理、网页介绍和机器转写须按各自质量标签使用。

## 发布者构建

构建只在发布端执行。使用明确的 intake 清单和原始资料目录，输出目录必须不存在。

```sh
cd cli
npm ci
npm run build
npm run build:corpus -- --workspace /path/workspace --intake /path/intake.json --output /path/new-release
npm pack --pack-destination /path/artifacts
```

产物为一个 `corpus.sqlite` 和一个 `manifest.json`。发布者上传这两个文件及 CLI 安装包，再把安装说明链接交给 Agent。普通重定向按最终清单地址定位相邻数据文件；GitHub Release 等会转到签名下载地址的托管方式，应在构建时增加 `--artifact-url`，填写数据文件的公开 HTTPS 地址。

当前完整包保留 6,775 份可检索资料、30,565 个章节，以及 17,972 项 intake 状态。实测数据库为 527,507,456 字节，约 503 MiB。正常安装保留一份当前数据，更新期间另有一份候选；按当前包大小计算，两份约 1 GiB。程序拒绝超过 2 GiB 的单包，并在写入前要求候选空间之外仍有 5 GiB 可用空间。原始资料、旧索引和本机开发依赖不包含在这项消费端估算内。

## 验证和迁移边界

可复跑的真实进程验证脚本位于 `evaluation/portable-cli/`。架构约定见 [portable-cli.md](docs/portable-cli.md)，磁盘管理见 [storage.md](docs/operations/storage.md)。数据等价性、安装、搬移、损坏及中断更新已经验证；检索质量仍有明确局限，不能把命令通过率当成答案准确率。

旧 Python 工具还具备网页介绍与评论检索、字幕时间定位，新 CLI 尚未迁移这两项能力。原始资料和旧索引均保留。旧操作说明位于 [legacy-python.md](docs/legacy-python.md)，原后端文档和评估是历史记录。新 CLI 不依赖这些旧运行时。
