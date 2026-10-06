# 全文检索 · Eagle 插件

给 [Eagle](https://eagle.cool) 素材库加一层**正文级全文检索**：不只搜文件名，而是把 **PDF / Word / Excel / PPT / ePub / RTF / Markdown / 纯文本 / 代码文件** 的正文内容，与标题、注释、标签、文件夹一起统一召回、统一排序，并在结果里高亮命中片段。

Eagle 自带搜索覆盖名称 / 注释 / 标签 / 链接 / 文件夹；官方「AI 搜索」是语义向量检索。**本插件补的是「正文文字精确检索 + 命中片段高亮」这一块** —— 例如你记得某篇 PDF 里写过某个专有名词，但忘了是哪一篇。

> **English**: A full-text search plugin for the Eagle asset manager. It extracts text from PDF / Office / ePub / RTF / Markdown / code files and indexes it together with titles, annotations, tags and folders — with BM25 ranking, phrase verification, and highlighted snippets. Zero external dependencies. Author: 肖至勍 (Xiao Zhiqing), MIT licensed.

**开发工具**：WorkBuddy + DeepSeek V4.1 Flash。

---

## 一、它能做什么

**检索范围**（同一次查询下统一召回与排序）

| 字段 | 来源 | 权重 |
|---|---|---|
| 标题 / 文件名 | Eagle 条目名称 | 6 |
| 标签 | Eagle 标签 | 4.5 |
| 注释 | Eagle 注释（支持多行） | 3.5 |
| 文件夹 | 所属文件夹名 | 2 |
| **正文** | 文件内容抽取 | 1 |
| 来源链接 | URL | 0.8 |

**正文抽取覆盖的格式**

| 类型 | 扩展名 | 抽取方式 |
|---|---|---|
| PDF | `pdf` | 内置 pdf.js 3.11.174，含 168 个 CJK CMap —— 中文 PDF 不乱码 |
| Word | `docx` `doc` `rtf` `odt` `wps` | OOXML / ODF 解析（含页眉页脚、脚注、批注、文档属性）；旧版 `.doc` 为近似提取 |
| Excel | `xlsx` `xls` `csv` `tsv` `ods` | `sharedStrings` 还原 + 数值单元格 + 工作表名 |
| PPT | `pptx` `ppt` `odp` | 幻灯片正文 + 讲稿备注 |
| 电子书 | `epub` | 全部 xhtml 章节 |
| 文本 / 代码 | `txt` `md` `csv` `json` `xml` `yaml` `log` `tex` `bib` `py` `js` `ts` `R` `sh` `sql` … | 纯文本，UTF-8 / GBK 自动识别 |
| 其他 | 任意扩展名 | 若内容「像文本」则按文本索引 |
| 图片 / 音视频 / 字体 | — | 不抽取正文（仍参与标题、注释、标签检索） |

**查询语法**（直接在搜索框里输入）

```
深度学习 综述            两个词都必须命中（AND）
"exact phrase"           引号 = 精确短语，会对正文逐字校验
神经网络 -入门            - 前缀 = 排除
ext:pdf                   限定扩展名
type:word                 限定类型组（image/pdf/word/excel/ppt/text/ebook/media/design/archive）
tag:教材                  限定标签（子串匹配）
folder:示例文件夹           限定文件夹名
star:>=4                  限定评分
```

**排序**：相关度（BM25F 变体）/ 最近修改 / 名称。
**筛选**：左侧栏可叠加类型、标签、文件夹、评分。
**结果**：缩略图、标题高亮、命中字段标记（标题 / 注释 / 标签 / 文件夹 / 正文）、带高亮的正文片段、所属文件夹、标签、正文规模、修改时间。

---

## 二、安装

> **本插件没有上架 Eagle 插件中心**，请从本仓库安装（下面二选一）。
> 装好后**完全退出 Eagle 再重新打开**（`⌘Q`，不是关窗口），在插件面板（快捷键 `P`）里
> 就能看到 **全文检索**。

### 方式 A：下载 ZIP（推荐，不需要会 git）

1. 打开 <https://github.com/zqxiao2001/eagle-fulltext-search> → 绿色 **Code** 按钮 → **Download ZIP**
2. 解压得到 `eagle-fulltext-search-main` 文件夹
3. **把文件夹改名为 `fulltext-search`** —— 必须与 `manifest.json` 里的 `id` 一致，这是 Eagle 的约定
4. 把它整个放进 Eagle 的插件目录：

| 系统 | 插件目录 |
|---|---|
| macOS | `~/Library/Application Support/Eagle/Plugins/` |
| Windows | `%APPDATA%\Eagle\Plugins\` |

macOS 上第 2～4 步的命令行等价写法：

```bash
unzip -q ~/Downloads/eagle-fulltext-search-main.zip -d /tmp/fts
mv /tmp/fts/eagle-fulltext-search-main \
   ~/Library/Application\ Support/Eagle/Plugins/fulltext-search
```

### 方式 B：git clone（需要 git）

```bash
git clone https://github.com/zqxiao2001/eagle-fulltext-search.git /tmp/fts
cp -R /tmp/fts ~/Library/Application\ Support/Eagle/Plugins/fulltext-search
```

> 方式 B 会把 `tools/`、`.git/` 一起拷进去。它们不参与运行
> （`index.html` 不引用其中任何文件），只是占点地方；想干净就用方式 A。

### 若已拿到 `.eagleplugin` 打包文件

双击即可安装，不必手动放目录。想自己打一个：`npm run build:release` 生成
`dist/fulltext-search/`，再用 Eagle 的「插件面板 → 右键插件 → 打包插件」。

**首次打开需要建立索引**（在库内点一次「建立索引」）。实测含 30 MB 级中文 PDF 的素材库首次全量建索引约 **0.6 秒**；之后每次打开都是毫秒级的增量刷新。

---

## 三、快捷键

| 按键 | 作用 |
|---|---|
| `⌘K` | 聚焦搜索框 |
| `↑` `↓` | 上下选择结果 |
| `↵` | 在 Eagle 中选中并定位该条目 |
| `⌥↵` | 用系统默认应用打开该文件 |
| `⌘R` | 增量刷新索引 |
| `⌘W` | 关闭插件窗口 |
| `Esc` | 关闭设置层 / 清空搜索词 |
| `F12` | 打开 DevTools（排查用） |

设置层里可点击卡片选择索引范围，`Esc` / 点「取消」/ 点遮罩空白处均可关闭。

---

## 四、索引范围与性能

**索引范围只有两档**（标题栏「设置」）：

| 档位 | 适用 | 单篇正文上限 | 单文件体积上限 |
|---|---|---|---|
| **普通文件**（默认） | 论文、图片注释、表格、代码、普通文档、报告 | 100 万字符（约 600 页中文 / 200 页英文） | 200 MB |
| **长文本** | 书籍、长篇报告、访谈逐字稿、超长网页存档 | 2000 万字符（一本 1000 页的书约 70~300 万字符，留 6 倍以上余量） | 256 MB |

上限的作用是「超长文档截断 / 超大文件只索引元数据」，防止单篇文档撑爆索引。默认档取 100 万字符的依据：初版默认值为 10 万字符，实测会截断一篇约 13 万字符的长文档，故上调至 100 万（约 7 倍余量），确保默认档不误伤任何单篇文档；长文本档只服务于整本书级别的素材。

切换档位后会**自动重建索引**（只重新解析正文，标题、注释、标签随时可查）。

**实测数据**（真实素材库，含 1 篇 30 MB 级中文 PDF）

| 指标 | 数值 |
|---|---|
| 首次全量建索引 | 约 0.6 s，耗时几乎全在正文抽取 |
| 增量更新（无变更） | 约 0.01 s |
| 单篇最长正文 | 约 13 万字符（即上述 PDF） |
| 倒排词条 | 7,000 个以上 |
| 索引体积 | 约 100 KB |

**可达规模**：索引为 JSON + gzip 落盘、全量常驻内存。十万字符级正文的论文库（数百到数千篇）毫无压力；若正文总量达到 GB 级，建议同时使用官方 AI 搜索做粗筛。

---

## 五、隐私与安全边界

- **对 Eagle 资源库严格只读**：不修改、不移动、不删除资源库内任何文件。Eagle 官方文档明确禁止插件写入资源库目录；本插件唯一的写入位置是**自己的目录**（`.index/` 与 `settings.json`）。
- **零网络请求**：不联网、不上传、无外部接口、无遥测。PDF 解析库与 168 个 CMap 全部内置在插件目录里。
- **索引只在本机**：`.index/` 记录的是本机资源库路径与你自己的素材信息，**属于你的私人数据**，不要分享或提交到版本库（本仓库的 `.gitignore` 已忽略它）。
- **渲染安全**：所有来自文件名 / 注释 / 正文的文本都先转义再拼接；片段高亮采用「先按匹配区间切分、再逐段转义」，不存在注入路径。
- **无破坏性操作**：插件不会删除、覆盖或重命名你的任何文件。

---

## 六、已知限制（如实说明）

1. **扫描版 PDF 无正文**：纯图片 PDF 没有文字层，未接入 OCR，只参与标题 / 注释检索。
2. **旧版 `.doc` / `.xls` / `.ppt`**：不做完整 OLE 结构解析，采用 UTF-16LE + GBK 双通道近似提取，结果会标注「近似提取」，可能混入少量噪声。
3. **加密 PDF**：无法抽取，会记入「提取提示」。
4. **`.odp` 只读 `content.xml`**：不含备注页。
5. **中文分词为「一元 + 二元」切分**，无词典、无词干化。多字词靠二元召回 + 正文逐字校验保证精度；这换来了术语（`卷积神经网络`、`scRNA-seq`、`IL-1β`）的 100% 可召回。
6. **短语查询严格**：`"深度学习方法"` 只命中正文中真的连续出现该串的条目。若结果偏少，去掉引号改用关键词组合。
7. **`AND` 无结果时自动放宽为部分匹配**，并在结果上标注「部分匹配」徽章，不做静默降级。
8. **需要在 Eagle 内运行**：界面依赖 Eagle 提供的 Node 集成（读素材文件、解析正文），直接双击 `index.html` 打开只会看到说明页。

---

## 七、目录结构

```
eagle-fulltext-search/            ← 仓库根目录 = 插件目录
├── manifest.json                 插件清单（id: fulltext-search，无边框窗口）
├── logo.png                      128×128 图标
├── index.html                    界面骨架
├── css/app.css                   四级灰阶主题（浅色 / 深色随 Eagle 主题切换）
├── js/
│   ├── config.js                 常量、字段权重、扩展名分组、索引范围预设、索引结构版本
│   ├── util.js                   编码探测(UTF-8/GBK)、文本清洗、转义、高亮、Buffer 收口
│   ├── zip.js                    纯 Node 原生 ZIP 读取器（支持 ZIP64，零依赖）
│   ├── extract.js                正文抽取分派（PDF / OOXML / ODF / ePub / RTF / 旧二进制）
│   ├── tokenizer.js              中英混排分词（CJK 一元+二元，拉丁词保留连接符）
│   ├── indexer.js                扫描 / 增量 / 倒排 / 落盘
│   ├── search.js                 查询解析、BM25F 打分、逐字校验、片段生成
│   ├── eagle-api.js              Eagle 宿主桥接（资源库、选中定位、主题、设置）
│   └── app.js                    界面控制器（渲染、筛选、键盘、进度）
├── libs/pdfjs/                   pdf.js 3.11.174 legacy + pdf.worker.js + 168 个 CJK CMap
├── tools/                        开发与测试工具（不进入发布包）
├── CHANGELOG.md / LICENSE        变更日志 / MIT 许可
└── make-logo.py                  图标生成脚本
```

**外部依赖：零**。运行时不用任何 npm 包；ZIP / OOXML 自研，PDF 用内置 pdf.js，其余全走 Node 原生模块（`fs` / `path` / `zlib`）。

---

## 八、开发与测试

> **全新克隆后先跑一次 `npm run fixtures`**：测试跑的是一套**中性样本库**
> （`tools/testlib/`，内容全是「示例文稿 / 示例计数表 / SampleTerm」这类可公开的假数据），
> 它是生成物、没有入库。缺了它，各测试脚本会告诉你该怎么生成（需要 Python 3 与 `reportlab`），
> 而不是抛一堆看不懂的 `ENOENT`。

```bash
# 静态自检（manifest 合法性 / 版本号一致性 / DOM id 引用 / 源码卫生 / 回归守卫）
npm run selfcheck

# 生成中性测试样本（需要 Python 3 + reportlab；全新克隆后必须先跑这个）
npm run fixtures

# 各格式正文提取 + 检索正确性（38 项断言）
npm run test:formats

# 全链路冒烟 + 索引契约自检（11 项：增量与全量等价 3 项 + 契约 8 项）
npm run test:core

# 界面逻辑（需要 jsdom；55 项断言）
npm run test:ui

# 全新安装端到端验收（40 项断言）
npm run test:acceptance

# 全部跑一遍
npm test

# 用真实浏览器渲染界面并截图（需要 playwright；输出到仓库内 preview/）
npm run preview

# 组装发布目录
npm run build:release
```

| 脚本 | 作用 |
|---|---|
| `tools/selfcheck.js` | 静态自检：结构、一致性、源码卫生、回归守卫 |
| `tools/test-formats.js` | 各格式正文提取与检索正确性（含 GBK、CMap 中文 PDF） |
| `tools/test-core.js` | 真实库全链路 + 索引契约 |
| `tools/test-ui.js` | jsdom 里跑真实界面逻辑 |
| `tools/test-acceptance.js` | 临时目录模拟全新安装，跑完整用户旅程 |
| `tools/preview.js` | 真实 Chromium 渲染 + 截图（视觉验收），输出到仓库内 `preview/`（已 gitignore） |
| `tools/make-fixtures.py` / `make-cjk-pdf.py` | 生成中性测试样本与仿资源库 |
| `tools/checkpdf.js` | 抽查 PDF 抽取质量（中文占比、乱码计数） |
| `tools/build-index.js` | 为真实资源库预建索引（交付 / 排障用） |
| `tools/build-release.js` | 白名单方式组装干净的发布目录 |

**测试设计上的一个坑，值得记下来**：Eagle 的渲染进程同时注入 Node 集成，`Buffer` 是全局可用；jsdom 没有这个全局。漏掉它的后果**不是测试报错**，而是重建流程在「写正文」处抛异常 → 走进 catch → 而失败分支恰好会让某个断言为真 —— 结果就是**测试假绿**。所以测试宿主必须补齐宿主环境的全部全局（见 `tools/paths.js` 与各测试脚本里的 `window.Buffer = Buffer`）。

改动 `js/` 下任何影响索引结构的逻辑后，请把 `config.js` 的 `INDEX_VERSION` 加 1，插件会自动重建旧索引（`selfcheck` 不校验这个，属人工判断）。

---

## 九、索引结构（便于二次开发）

```
.index/docs.json.gz
  { version, libraryPath, builtAt, buildSig, count, nextIdx, idMap:{id→序号},
    docs:{ 序号 → { id, name, fileName, ext, rel, tags, folders, star, url,
                    annotation, mtime, size, method, warn, cLen, len:{各字段字符数} } },
    stats:{ withText, byMethod } }

.index/postings.json.gz
  { terms: { 词 → [[序号, 命中的字段位掩码, 该文档内词频], ...] } }
  字段位掩码：name=1 annotation=2 tags=4 folders=8 content=16 url=32

.index/text/<序号>.txt.gz    该文档正文（供片段生成与短语逐字校验，按需读取、不常驻内存）
```

**增量更新**：以 Eagle 资源库自带的 `mtime.json` 为准，只重新解析新增 / 变更条目；被删除的条目连同其倒排项一起摘除；未变更条目的倒排项原样保留，因此增量结果与全量等价。

**索引有效性判定**：加载时依次校验 `version`（索引结构版本）、`libraryPath`（资源库路径）、倒排文件是否可读、`buildSig`（范围指纹 `单篇字符上限|文件体积上限|是否含回收站`）。任一不符即拒绝加载，并在首屏给出**针对性原因**（结构升级 / 换了资源库 / 文件损坏 / 范围已改），而不是笼统提示「尚未建立索引」。`buildSig` 的意义在于：改了索引范围但重建中断时，不会让「按小范围建成的索引」被当成覆盖全库的索引，从而误判「长文档搜不到」为数据问题。

> 注意 `docs.stats` 描述的是**整个索引**的统计，而非「本轮增量」—— 增量空转（本轮处理 0 条）时它仍反映全量。

---

## 十、开发与许可

| 项目 | 内容 |
|---|---|
| 源码仓库 | <https://github.com/zqxiao2001/eagle-fulltext-search> |
| 开发工具 | WorkBuddy + DeepSeek V4.1 Flash |
| 作者 | 肖至勍 |
| 许可 | [MIT](LICENSE) © 2026 肖至勍 |

内置的 pdf.js 3.11.174 遵循 Apache License 2.0。
