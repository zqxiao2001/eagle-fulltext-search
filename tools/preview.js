#!/usr/bin/env node
/* =============================================================================
 * preview.js —— 在真实 Chromium 里渲染插件界面并截图（无需打开 Eagle）
 * -----------------------------------------------------------------------------
 * 为什么需要它：test-ui.js 用 jsdom 只能验证「DOM 结构与逻辑」，验证不了视觉
 * （布局、间距、灰阶层级、弹层定位、中文字体渲染）。本脚本用 playwright 加载真实
 * index.html + 真实 app.css，并把磁盘上真实代码建出来的索引喂给页面，因此截图所见即 Eagle 里所见，
 * 差别只有：宿主 API 是桩、缩略图走 file:// 直接读。
 * 索引与样本库默认取 tools/test-index 与 tools/testlib，可用 FT_LIBRARY 换成别的资源库
 * （换成样本库之外的库时会打印警告，并在输出目录落一个提示文件）。
 *
 * 做法：注入一个 require 垫片，把 fs / zlib 替换成「内存虚拟文件系统」——
 *   · fs.readFileSync(索引文件)  → { toString: () => 已解压的 JSON 字符串 }
 *   · zlib.gunzipSync(x)         → 原样返回 x（identity，配合上面即可完成「读索引」）
 *   这样 loadIndex() 的整条路径都是真实代码，只是数据来自内存。
 *
 * 用法：node preview.js [输出目录]
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { requireOptional } = require('./paths');
const { chromium } = requireOptional('playwright');

const PLUGIN = path.resolve(__dirname, '..');
/* 默认跑在自造样本库 + 沙箱索引上：
   · 截图里必须是可公开的示例数据；
   · 不能覆盖插件目录下交付用的真实索引（否则下次开插件误判「换了资源库」）。
   要用别的资源库：FT_LIBRARY=/path/to/xxx.library node preview.js */
const SANDBOX_INDEX = path.join(__dirname, 'test-index');
const SANDBOX_SETTINGS = path.join(SANDBOX_INDEX, 'settings.json');
const INDEX_DIR = SANDBOX_INDEX;
const NEUTRAL_LIB = path.join(__dirname, 'testlib');
const LIB = process.env.FT_LIBRARY || NEUTRAL_LIB;
const IS_NEUTRAL = path.resolve(LIB) === path.resolve(NEUTRAL_LIB);
/* 输出目录默认放在仓库根下的 preview/（已被 .gitignore 忽略）。 */
const OUT = process.argv[2] || path.join(PLUGIN, 'preview');

/* 用样本库之外的资源库截图时出声提醒，并在输出目录落一个提示文件。 */
if (!IS_NEUTRAL) {
  const warn = [
    '⚠️  当前截图用的不是内置样本库，输出可能包含该资源库的真实素材信息。',
    '    这些 PNG 适合本地自查，不建议提交到仓库或对外发布。',
    '    要产出可公开的示例截图，请用默认样本库：python3 tools/make-fixtures.py',
    '    库路径：' + LIB
  ].join('\n');
  console.warn('\n' + warn + '\n');
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, '_WARNING-非样本库截图.txt'), warn + '\n');
  } catch (e) { /* 输出目录还没建出来也无妨，控制台已经提示过 */ }
}

/* ---- 1. 把真实索引读成内存虚拟文件系统（键 = 绝对路径） ---- */
function buildVfs() {
  const files = {};
  const unzip = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
  const docs = unzip(path.join(INDEX_DIR, 'docs.json.gz'));
  const post = unzip(path.join(INDEX_DIR, 'postings.json.gz'));
  files[path.join(INDEX_DIR, 'docs.json.gz')] = JSON.stringify(docs);
  files[path.join(INDEX_DIR, 'postings.json.gz')] = JSON.stringify(post);
  const textDir = path.join(INDEX_DIR, 'text');
  if (fs.existsSync(textDir)) {
    for (const n of fs.readdirSync(textDir)) {
      if (!/\.txt\.gz$/.test(n)) continue;
      files[path.join(textDir, n)] = zlib.gunzipSync(fs.readFileSync(path.join(textDir, n))).toString('utf8');
    }
  }
  return { files, docs };
}

/* ---- 2. 目录树快照：让页面里的 fs.existsSync / readdirSync / statSync 与真实磁盘一致，
        这样「重建索引」在预览里也能真跑（否则 scanLibrary 会报「images 目录不存在」） ---- */
function buildTree(roots) {
  const exists = new Set(), dirs = {}, stat = {};
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    exists.add(p);
    stat[p] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    if (!st.isDirectory()) return;
    const names = fs.readdirSync(p);
    dirs[p] = names;
    for (const n of names) walk(path.join(p, n));
  };
  roots.forEach(walk);
  return { exists: [...exists], dirs, stat };
}

(async () => {
  /* 前置：让磁盘状态与「全新安装」一致。
     索引的 buildSig 必须和 DEFAULTS 派生的默认档指纹相同，否则页面启动时
     loadIndex() 会判定「索引范围已更改」而拒绝加载 → 首屏只有一个空状态，截不到列表。
     （这本身是个好信号：说明指纹校验确实在生效。） */
  try { fs.unlinkSync(SANDBOX_SETTINGS); } catch (e) { }
  {
    const mods = ['config', 'util', 'zip', 'extract', 'tokenizer', 'indexer', 'search'];
    mods.forEach(m => require(path.join(PLUGIN, 'js', m + '.js')));
    FT.config.PLUGIN_DIR = PLUGIN;
    const prepOpts = FT.config.applyProfile(Object.assign({}, FT.config.DEFAULTS), FT.config.DEFAULTS.profile);
    const prep = FT.indexer.makeIndexer({
      fs, path, libraryPath: LIB, indexDir: SANDBOX_INDEX,
      opts: prepOpts, onProgress() { }, isCancelled: () => false
    });
    const r = await prep.build();
    console.log('前置：索引 %d 条目 / 档位 %s / 指纹 %s', r.docs.count, prepOpts.profile, r.docs.buildSig);
  }

  const { files, docs } = buildVfs();
  const tree = buildTree([path.join(LIB, 'images'), INDEX_DIR]);
  fs.mkdirSync(OUT, { recursive: true });
  console.log('索引：%d 条目，虚拟文件 %d 个（正文 %d 篇非空），目录树节点 %d 个',
    docs.count, Object.keys(files).length,
    Object.keys(files).filter(k => /text[\\/]/.test(k) && files[k]).length,
    tree.exists.length);

  const browser = await chromium.launch({
    args: ['--allow-file-access-from-files', '--force-device-scale-factor=2']
  });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 2 });

  // ---- 3. 注入宿主桩 + 虚拟文件系统 ----
  await page.addInitScript(({ files, pluginDir, libPath, tree, sandboxIndex, sandboxSettings }) => {
    const VFS = files;
    const EXIST = new Set(tree.exists);
    const DIRS = tree.dirs, STAT = tree.stat;
    window.__dirname = pluginDir;
    window.process = { type: 'renderer', platform: 'darwin' };
    /* 页面侧沙箱：config.js 加载时读这个全局，把 .index/ 与 settings.json 重定向到
       tools/test-index/，与 Node 侧的前置建索引保持同一个位置。 */
    window.__FT_SANDBOX__ = { indexDir: sandboxIndex, settingsFile: sandboxSettings };
    /* Eagle 渲染进程里 Buffer 是全局（jsdom / 纯浏览器里没有）。
       本脚本里 gzipSync 是恒等函数、writeFileSync 是空操作，所以 Buffer 只要「能被调用」即可。 */
    window.Buffer = { from: (s) => ({ __buf: s, toString: () => String(s) }) };

    window.require = function (name) {
      if (name === 'path') {
        return {
          sep: '/',
          join: function () { return Array.prototype.slice.call(arguments).filter(Boolean).join('/').replace(/\/+/g, '/'); },
          extname: function (p) { const m = /(\.[^./\\]+)$/.exec(String(p)); return m ? m[1] : ''; },
          basename: function (p) { return String(p).split('/').pop(); },
          dirname: function (p) { return String(p).split('/').slice(0, -1).join('/'); }
        };
      }
      if (name === 'fs') {
        return {
          existsSync: (p) => VFS[p] != null || EXIST.has(p),
          readdirSync: (p) => DIRS[p] || [],
          statSync: (p) => STAT[p] || { size: 0, mtimeMs: 0 },
          readFileSync: (p) => {
            /* 索引文件 → 返回「已解压字符串」的包装体；配合 zlib 恒等函数即可完成读取，
               不需要在浏览器里实现 gzip。
               素材文件不在这里虚拟：预览**不跑真正的重建流程**（writeFileSync 是空操作，
               重建出的引擎会是残缺的，状态栏会显示「0 篇含正文」，反而误导）。
               重建相关行为用 test-ui.js 第 9 节的断言 + 时间采样来验证。 */
            return { toString: () => (VFS[p] == null ? '' : VFS[p]) };
          },
          mkdirSync: () => { }, writeFileSync: () => { }, renameSync: () => { }, unlinkSync: () => { }
        };
      }
      if (name === 'zlib') {
        // identity：配合上面 readFileSync 返回的「已解压字符串」，gzipSync/gunzipSync 互相抵消
        return { gunzipSync: (x) => x, gzipSync: () => ({}) };
      }
      throw new Error('preview 垫片未实现模块: ' + name);
    };

    window.eagle = {
      onPluginCreate(cb) { cb({ manifest: { id: 'fulltext-search', name: '全文检索', version: '1.1.0' }, path: pluginDir }); },
      onPluginRun() { }, onPluginShow() { }, onPluginHide() { }, onPluginBeforeExit() { },
      onThemeChanged() { }, onLibraryChanged() { },
      app: { version: '4.0.0', build: 30, locale: 'zh_CN', theme: 'LIGHT', isDarkColors: () => false },
      library: { path: libPath, name: 'eagle' },
      item: { select: async () => true, open: async () => true, getSelected: async () => [] },
      window: { hide() { }, minimize() { }, focus() { }, setBackgroundColor() { } },
      shell: { openPath: async () => true, openExternal: async () => true }
    };
  }, { files, pluginDir: PLUGIN, libPath: LIB, tree, sandboxIndex: SANDBOX_INDEX, sandboxSettings: SANDBOX_SETTINGS });

  const errors = [];
  /* 中性样本库按设计不含缩略图 PNG（只有 metadata），页面为这些条目请求缩略图时必然
     ERR_FILE_NOT_FOUND。这属预期噪声，单独归类，免得真报错被它淹掉 —— 但也如实打印，
     不静默吞掉。 */
  const benign = [];
  const known = (t) => /ERR_FILE_NOT_FOUND|net::ERR_FILE_NOT_FOUND/.test(t);
  const push = (list, msg) => (known(msg) ? benign : errors).push(msg);
  page.on('pageerror', e => push(errors, String(e && e.message ? e.message : e)));
  page.on('console', m => { if (m.type() === 'error') push(errors, 'console: ' + m.text()); });

  await page.goto('file://' + PLUGIN + '/index.html');
  await page.waitForSelector('#list .row', { timeout: 15000 });
  await page.waitForTimeout(600);

  const shots = [];

  // ---- 3. 首屏（概览面板）----
  await page.screenshot({ path: path.join(OUT, 'screenshot-01-overview.png') });
  shots.push('screenshot-01-overview.png');

  // ---- 4. 检索结果（正文命中 + 高亮 + 片段）----
  await page.fill('#q', '示例文稿');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'screenshot-02-search.png') });
  shots.push('screenshot-02-search.png');

  // ---- 5. 长文档正文命中（验证正文抽取与片段定位）----
  await page.fill('#q', '"示例章节甲"');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'screenshot-03-phrase.png') });
  shots.push('screenshot-03-phrase.png');

  // ---- 6. 设置弹层（本次改版的重点）----
  await page.fill('#q', '');
  await page.waitForTimeout(400);
  await page.click('#btnSettings');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'screenshot-04-settings-normal.png') });
  shots.push('screenshot-04-settings-normal.png');

  // 点选「长文本」后的选中态
  await page.click('#presetList .preset[data-k="long"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'screenshot-05-settings-long.png') });
  shots.push('screenshot-05-settings-long.png');

  // 验证弹层真的关得掉（回归守卫的视觉版）
  await page.click('#btnSettingsCancel');
  await page.waitForTimeout(250);
  const modalHidden = await page.evaluate(() => document.getElementById('settingsModal').hidden);
  const modalDisplay = await page.evaluate(() =>
    getComputedStyle(document.getElementById('settingsModal')).display);
  console.log('取消后 settingsModal.hidden =', modalHidden, ' computed display =', modalDisplay);

  // ---- 7. 深色主题兜底（Eagle 切深色时不能是白底黑字）----
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.fill('#q', '示例');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'screenshot-06-dark.png') });
  shots.push('screenshot-06-dark.png');

  console.log('截图输出：');
  shots.forEach(s => console.log('  ' + path.join(OUT, s)));
  console.log(errors.length ? '⚠️ 页面报错：\n  ' + errors.slice(0, 5).join('\n  ') : '✅ 无页面报错');
  if (benign.length) console.log('    （另有 ' + benign.length + ' 条缩略图 ERR_FILE_NOT_FOUND，中性样本库不含缩略图，属预期）');
  await browser.close();
})().catch(e => { console.error('预览失败:', e); process.exit(1); });
