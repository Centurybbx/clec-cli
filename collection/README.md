# CLEC 资料收集记录

本目录是收集中的原始资料和文本，不代表全网资料已收齐。原有 `public-archivedwl-154` 与 PDF 保持不变。

- `text/local/`：从本地 PDF、PPTX、DOCX、EPUB、TXT 和 XLSX 提取的文本，清单位于 `manifest.json` 和 `spreadsheets-manifest.json`。PDF 使用换页符；幻灯片和表格保留内部文件名及单元格地址。自动提取未逐页人工核验，图片中的文字、图表及扫描页可能缺失。
- `sources/clec-md/`：公开仓库 https://github.com/fraserlai/clec-md ，采集时 commit 为 `e0f088797a74ab70a1761671dda7dc1c94db374f`。其中文章为整理资料；其原始转录稿没有包含在公开仓库中。
- `sources/podcast/`：三个播客的 RSS 原文与 Apple 节目资料。RSS 是节目和音频地址清单，不是音频或逐字稿；各节目源之间可能重复。
- `web/clec168/`：站点 sitemap、内容页 HTML 和从正文提取的文本。视频页可能只是介绍和评论，而不是逐字稿。`manifest.jsonl` 是逐次采集日志，可能包含重试和重复记录。
- `web/clectw/`：节目目录及部分节目原始 HTML 与文本。部分节目含机器生成的完整逐字稿，但并非人工校对；`discovered-episode-urls.txt` 是成功取得的目录页中发现的节目链接，不是全站完整清单。该站目录请求曾返回 HTTP 429，之后以更低频率恢复采集；日志保留失败记录。日志中的 mentions_transcript 标志不可靠，须以保存的页面正文为准。
- `tools/`：文本提取和公开网页采集脚本。它们是收集工具，不是问答系统。续采前应检查站点访问政策、错误状态和磁盘空间；遇到限流时停止并稍后再试。

已知缺口：未收齐所有来源；尚未对缺少文字稿的音视频进行语音转写；未系统获取 Bilibili、Odysee、社交平台及云盘全部资料；仍需按集号和内容去重，并核对逐字稿的完整性及正确性。站外列出的视频备份约 164 GB，采集开始时本机可用空间约 87 GiB，不能直接全部下载到本机。

## 逐字稿和缺口清单

`web/clectw/transcripts/` 存放从该站节目页面分离出的自动逐字稿原文，不含页面的 AI 摘要；`web/clectw/episode-inventory.jsonl` 按已发现的节目 URL 逐条记录页面状态、逐字稿状态、原始网页 SHA-256 与文本路径。`automatic_unverified` 表示页面提供了自动转写，不代表已核对、确认完整或带有时间戳；`not_found_on_downloaded_page` 仅表示已下载页面没有找到逐字稿，不能证明其他平台不存在。`download_failed` 和 `not_yet_downloaded` 都是未知状态。

采集期间，清单不是实时更新的。运行 `python3 collection/tools/inventory_clectw.py` 可根据已保存的页面重建清单并提取新增逐字稿；重复运行不会覆盖原始 HTML。音视频尚未系统转写。

## 目录交叉核对

`web/clec168/cross-source-unmatched.jsonl` 列出 CLEC168 长篇、短篇节目编号在 CLEC 台湾站没有找到完全相同编号的条目。仅按站内类别和文件名作精确比较；不同后缀、上下集、改版和不同平台编号可能指向同一节目，不能把这些条目直接视为缺少逐字稿。其他类别及站外资料仍需进一步核对。

## 2026-11-06 补充收集

- `sources/drive/transcripts.zip`：公开 Google Drive 备份中的字幕包，来源为 https://drive.google.com/file/d/1r0J4HJ0UlXbDEH8ABGkOVB4MLSS7wFYr/view 。经 ZIP 完整性检查后，提取了 1,426 个子压缩包中的 1,426 份 TXT、1,425 份 SRT、1,426 份 Markdown，以及 1 份扩展名为 `.str` 的字幕格式文件。原始文件放在 `sources/drive/archive-transcripts/`，原始名称、内部路径及 SHA-256 位于 `archive-transcripts-manifest.jsonl`。文件名含 large-v2，表明可能是自动转写，质量尚未系统核对。
- `sources/drive/text/`：来自公开 Drive 文档、历史讲义和帖子目录的文字提取，共 783 份；三个 `*text-manifest.json` 文件记录来源和状态。文件可能重叠，不能把数量当作独立内容数量。在线提取失败的两个文档已下载原件并分别用 DOCX XML、pdftotext 提取。
- `sources/drive/*folder-inventory.json`：已访问 Drive 文件夹的内容清单；短视频文件夹结果有 1000 项上限，未证明包含全部文件。
- `web/clec168/cross-source-assessments.json`：28 条跨站编号差异的候选对应、已有字幕线索及尚未解决项。按标题、时长或少量转写进行的对应仍需复核。
- `sources/drive/archive-timing-audit.jsonl`：已有字幕与网站节目编号候选的时长对比，仅为初筛，节目编号重复、版本不同或片尾静音均可导致差异，不等同于字幕完整性结论。
- `sources/podcast/episode-inventory.jsonl`、`unmatched-title-candidates.jsonl`：四个播客 RSS 的节目和可能的对应节目；候选未经过逐条人工确认，不能直接合并为同一内容。
- Bilibili 目录请求返回 HTTP 412；pCloud 的旧域名证书过期，未绕过限制或禁用证书校验。来源覆盖仍不完整。
- `transcripts/local-asr/`：对编号未匹配节目自行生成的机器转写，保留 TXT、SRT、JSON 和来源与音视频校验值；状态为 `machine_unverified`，不表示内容、数字或讲者已校对。
- `transcripts/quarantine/`：疑似幻觉的机器输出，不应用于回答。`ep-00176` 和 `ep-00260` 输出同一句话异常重复且时间戳超出片长，无法根据结果认定原视频是否有语音。此前脚本只检查了最短覆盖比例，错误地删除了临时视频；来源地址已保留并可重新下载。脚本已增加重复内容和超出片长检查。
- `web/cfnavi/`：乘豐領航站点地图中 `/cat-clec/` 目录下的 123 个公开页面原始 HTML 和正文；抽查发现包含课程摘要，不能当成讲者逐字稿。其他站点栏目及未收录于站点地图的页面尚未穷尽。
- `transcripts/podcast-asr/`：四个未自动匹配到已有资料的播客记录生成的机器转写（未经校对）。其中两条暂停公告内容相似；另一条开头与网站节目 `ep-00213` 相符，但版本时长不同，未逐字核对。
- `transcripts/ocr/ep-00176/`：对网页操作演示视频按约四秒抽样、OCR 获得的部分画面文字。未经校对，不是完整逐字稿，可能漏掉画面；个人识别码等已隐藏。音频识别失败，仍需核听。
