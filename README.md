# CLEC 本地证据工具

CLEC 为能执行本地命令的 Agent 提供资料搜索、原文读取和来源导航。使用者同步发布者预先构建的数据包，无需配置模型密钥、下载向量模型、启动服务或自行建立索引。

当前产品收敛为 **0.3.0 BM25 词法检索版**。公开仓库为 [Centurybbx/clec-cli](https://github.com/Centurybbx/clec-cli)，本仓库的 `cli/` 保存对应源码。A 本地混合与 B SAG2+Jev 实验代码已退出活动开发目录，历史实验和原始评估保留在本机归档中，不随产品发布。旧后端仍是历史迁移代码，并非 CLI 运行依赖。

## 安装与使用

需要 Node.js 22.19.0 或更新版本。

```sh
npm install --global https://github.com/Centurybbx/clec-cli/releases/download/v0.3.0/clec-cli-0.3.0.tgz
clec sync --manifest /path/to/release/manifest.json
clec guide research
clec coverage --format json
clec search '退休 提領' --limit 8 --format json
clec sources '退休'
clec read '搜索返回的ref'
clec source '搜索返回的sourceRef' --offset 0 --limit 20
```

公开发布提供 CLI 安装包，尚未提供公开语料或公共 manifest 地址，也没有发布 npm registry 包。需要向资料发布者取得清单。查询和原文读取离线运行；首次安装和远程同步需要网络。

默认数据目录为 `~/.local/share/clec`。可以使用 `--data-dir` 或 `CLEC_DATA_DIR` 选择目录。成功 JSON 写 stdout，失败写 stderr 并使用分类退出码。完整命令约定见 [CLI README](cli/README.md) 与 [Agent 指南](cli/docs/agent-guide.md)。

## 证据与边界

搜索采用 BM25、繁简归一化和按来源限额的分页，不做向量检索，不生成答案。Agent 应多轮检索同义表达，读取原问题、回复、追问、反例与不同日期材料，再组织结论。更多命中不等于覆盖完整；不得把整理、转述或自动字幕当作已验证的讲者事实。

新版保留扩展的字幕与混合页面覆盖、字幕时间定位、来源质量和覆盖说明。引文以原文读取结果为准，保留 UTF-16 范围、来源哈希与版本。相似标题或不同格式不证明它们是独立事件。来源日期不等于事件日期。

发布者默认生成格式3的词法数据包，包含原文、章节、索引、来源元数据和字幕定位，不包含模型或向量表。CLI 仍读取旧格式1；混合试验格式2不受支持，需要用新清单同步。候选包验证失败时保留原活动版本，数据更新后旧引用不能冒用新文本。

## 发布者构建

```sh
cd cli
npm ci
npm run build:corpus -- --workspace /path/workspace --intake /path/intake.json --output /path/new-release
npm pack --pack-destination /path/artifacts
```

产物为一个 `corpus.sqlite` 和一个 `manifest.json`。清单的来源身份与质量标记由发布者提供，校验完整性不等于验证内容真实。数据包与 CLI 分开发放。本轮具体产物、语料数量与安装验证见 [0.3.0 发布记录](docs/cli-bm25-release-030.md)。
