# tools/ —— 开发与测试工具

这些脚本用于**开发 / 排障 / 回归**，**不属于插件运行时**，也不会进入发布包
（`build-release.js` 用白名单组装发布目录，`tools/` 不在白名单里）。

运行环境：Node ≥ 16（插件本身要求 Node 16+，与 Eagle 渲染进程一致）。
`test-ui.js` 需要 jsdom，`preview.js` 需要 playwright —— 它们是可选依赖，
用 `tools/paths.js` 按 `WB_NODE_MODULES` → `tools/node_modules` → `<repo>/node_modules`
→ `NODE_PATH` → 常见 managed 目录的顺序探测，找不到会给出明确的安装指引。

## 脚本一览

| 脚本 | 作用 | 用法 |
|---|---|---|
| `selfcheck.js` | **静态自检**：manifest 合法性、版本号三处一致、index.html 资源与 DOM id 引用、pdf.js 资产、源码卫生、回归守卫 | `node tools/selfcheck.js [--release]` |
| `test-formats.js` | 38 项断言：各格式正文提取 + 检索正确性（含 GBK、CMap 中文 PDF） | `node tools/test-formats.js` |
| `test-core.js` | 真实资源库全链路冒烟 + 索引契约自检 8 项 | `node tools/test-core.js [库路径] [索引目录] [查询…]` |
| `test-ui.js` | 55 项断言：jsdom 中跑真实界面逻辑 | `node tools/test-ui.js [库路径]` |
| `test-acceptance.js` | 40 项断言：**临时目录模拟全新安装**，跑完整用户旅程 | `node tools/test-acceptance.js` |
| `preview.js` | 真实 Chromium 渲染界面并截图（jsdom 验证不了视觉）。输出到仓库内 `preview/` | `node tools/preview.js [输出目录]` |
| `build-index.js` | 为真实资源库预建索引（交付 / 排障用） | `node tools/build-index.js [库路径] [normal\|long]` |
| `build-release.js` | 白名单组装干净的发布目录 | `node tools/build-release.js` |
| `checkpdf.js` | 抽查 PDF 抽取质量（中文占比、乱码计数） | `node tools/checkpdf.js [pdf 或库目录]` |
| `make-fixtures.py` | 生成中性测试样本 + 仿 Eagle 资源库 → `tools/testlib/` | `python3 tools/make-fixtures.py` |
| `make-cjk-pdf.py` | 生成**必须依赖 CMap** 的中文 PDF（验证中文链路的关键样本） | `python3 tools/make-cjk-pdf.py` |
| `paths.js` | 可选依赖解析（jsdom / playwright）+ 素材库解析与缺库指引（内部模块，被上面脚本 require） | — |

## 标准回归流程

> **全新克隆（或删过 `tools/testlib/`）时，第 2 步必须先做**：样本库是生成物、未入库。
> 缺库时各脚本会打印「怎么生成」的指引并以退出码 3 结束，而不是抛 `ENOENT` 堆栈 ——
> 也**不会**回退去扫其它资源库目录。

```bash
cd <repo>

# 1) 静态自检（最快，先跑这个）
node tools/selfcheck.js

# 2) 重建中性测试样本（会清空并重写 tools/testlib/）—— 全新克隆后必做
python3 tools/make-fixtures.py && python3 tools/make-cjk-pdf.py

# 3) 各格式抽取 + 检索正确性
node tools/test-formats.js

# 4) 真实资源库全链路 + 索引契约
node tools/test-core.js                 # 默认库可省略；也可传入自己的库路径

# 5) 界面逻辑
node tools/test-ui.js

# 6) 全新安装端到端验收
node tools/test-acceptance.js

# 7) 视觉验收（改过 css/ 或 DOM 结构后必跑）
node tools/preview.js                   # → ./preview/*.png

# 8) 组装发布目录
node tools/build-release.js
```

等价的 npm 快捷方式见根目录 `package.json`（`npm test` 会跑 1/3/4/5/6）。

## 注意

- **测试宿主必须补齐 Eagle 的全局 `Buffer`**（jsdom 没有）。各测试脚本里都写了
  `window.Buffer = Buffer`。漏了它的后果不是「测试报错」而是**测试假绿**：
  重建会在写正文处抛 `ReferenceError`，而失败分支恰好让某些断言为真。
- **测试默认只跑 `tools/testlib/` 这套中性样本。** `test-core.js` / `test-ui.js` 可用参数或
  `FT_LIBRARY` 指向真实资源库，但对该库**只读**。
- **测试全程沙箱化，不会污染交付状态**：索引写到 `tools/test-index/`、设置写到
  `tools/test-index/settings.json`（页面侧由 `window.__FT_SANDBOX__` 注入，`config.js` 加载时读取），
  因此**不会创建或覆盖插件目录下的 `.index/` 与 `settings.json`**。
  唯一写插件目录的是 `build-index.js`（按需手动执行）。
- `preview.js` 用真实浏览器渲染**真实代码**，但只虚拟了文件系统，因此
  **不跑真正的重建流程**（`writeFileSync` 是空操作，重建出的引擎残缺、状态栏会显示
  「0 篇含正文」，反而误导）。重建行为改用 `test-acceptance.js` 与 `test-ui.js` 第 9 节验证。
- `preview.js` 默认输出到仓库内的 `preview/`（已 gitignore）。若用 `FT_LIBRARY` 指向
  样本库之外的资源库，脚本会打印警告并在输出目录留一个提示文件 —— 那类截图含该库的
  真实素材内容，只适合本地自查。
- 页面里的 `console: ERR_FILE_NOT_FOUND` 是**预期噪声**：中性样本库按设计不含缩略图 PNG。
  `preview.js` 已把这类错误单独归类打印，真报错不会被它淹掉。
- 诊断「界面卡住」的采样手法：终态提示可能**存活不到一个 tick**，低频轮询会全部漏掉。
  按 40ms 间隔持续采样状态栏 / 进度行文本并记录**变化轨迹**，比盯最终状态有效得多。
- 改动 `js/` 下影响索引结构的代码后，务必把 `js/config.js` 的 `INDEX_VERSION` 加 1。
