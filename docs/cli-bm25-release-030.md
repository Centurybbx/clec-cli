# CLI 0.3.0 BM25 发布记录

本次按用户决定将产品收敛为 BM25 词法检索，并发布新的小版本。公开源码提交为 `1bea988fa30e0fd42609ab47f8f02ca98a181390`，[0.3.0 发布](https://github.com/Centurybbx/clec-cli/releases/tag/v0.3.0)是正式 release，不是草稿或 prerelease。

## 产品范围

保留扩展的来源覆盖、原文读取、UTF-16 精确范围、字幕定位、来源质量、coverage、find、read-range 和研究指南。搜索沿用 0.2 的 BM25 排序，先在全部匹配章节中应用每来源限额，再分页。删除混合检索模式、向量模型、模型下载脚本、嵌入缓存与 Hugging Face 运行依赖。安装包唯一运行依赖是 opencc-js，开发目录额外44个无用依赖也已清理。

新发布者输出格式3，包含词法索引、原文、来源元数据和字幕 cue，不含模型或向量表。旧格式1兼容。试验格式2在同步和已安装读取处均明确拒绝；拒绝新包不会覆盖现有活动语料。同哈希重用也核对清单与数据库格式。

A/B 实验实现和相关未提交研究文档已移至 `.cache/bm25-release-030/retired/`。清理前的475个文件另存 `pre-cleanup.tar.gz`，路径清单保存于同目录。已有 `.cache` 原始运行、模型和语料证据未销毁。归档不是运行依赖，也不是完整封装环境，复跑历史实验需恢复代码与对应依赖。公开仓库只包含 CLI 产品源码，没有旧后端、实验、密钥或语料。

## 产物与实际核验

安装包 `clec-cli-0.3.0.tgz` 为29,466字节，16个文件。SHA-256 为 `0b0fa547f363e7ec718f2dc95b9331e24fb44eaa124f1d8bfd60ad9285c6b584`。公开下载文件、发布的 SHA256SUMS、本地最终验证包三者一致。包内 JavaScript 与最终构建逐文件相同。

完整本地数据包为1,363,570,688字节，格式3，SHA-256 为 `085476ed9fdd04d8b98624831e5c7eec3ef4f94275e980b447fece1d2240898e`。保留12,532个来源表示、51,420个章节、17,972项 intake 记录。这些不是独立节目或独立事件数。数据包保留在 `.cache/bm25-release-030/release/`，没有公开上传。

独立审查逐一核对12,532份原文与实际源文件字节和哈希。1,448个字幕来源、1,321,134个 cue 的原文范围和时间边界通过。完整语料安装后，search、read、find、coverage、字幕 read-range、重复 sync 和旧格式1实际检索均通过。hybrid 参数明确失败。

独立断网行为检查覆盖真实安装包的构建小型语料、同步、检索、读取、查找、范围读取、覆盖和指南；CRLF、emoji、字幕原文与 cue 均核对。格式2拒绝后保留旧版本。超过100个高排名章节来自同一文档时，其他文档仍可检索和翻页。

本地类型检查、CLI五组行为测试及目录准入三组测试通过。[公开 CI](https://github.com/Centurybbx/clec-cli/actions/runs/43608270360)的 Linux、macOS、Windows × Node 22.19.0、24 六组全部通过，包含打包安装。CI使用自建小型语料，完整语料验证在本机 macOS arm64 上执行，不推断完整库在所有平台已验证。

独立审查结论为 PASS + NOTES，证据保留于 `.audit/bm25-release-030/review.md`。本地运行记录、清理清单、打包与公网下载产物位于 `.cache/bm25-release-030/`。commit-checker 仅提示了本次有意提交的文档和测试，没有发现私有数据或密钥类高风险项。

## 使用与限制

```sh
npm install --global https://github.com/Centurybbx/clec-cli/releases/download/v0.3.0/clec-cli-0.3.0.tgz
clec --version
clec sync --manifest /path/to/publisher/manifest.json
clec guide research
```

本次没有发布 npm registry 包，也没有提供公开语料 manifest。用户需要另行取得发布者的数据清单。安装与远程同步可能需要网络，完成后搜索和读取不调用模型或外部 API。

此次发布没有重新进行答案质量对照实验。研究答案由宿主 Agent 组织，BM25 不保证同义召回或内容完整。旧三路开发分数不作为此版本准确率；最终发布恢复了稳定版的完整匹配分页，不能把旧试验配置与新产品混为一谈。
