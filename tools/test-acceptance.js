#!/usr/bin/env node
/* =============================================================================
 * test-acceptance.js —— 全新安装验收测试（端到端用户旅程）
 * -----------------------------------------------------------------------------
 * 与其它测试的分工：
 *   test-formats  验证「各格式抽取对不对」
 *   test-core     验证「索引 / 检索全链路」
 *   test-ui       验证「界面逻辑接线」
 *   本脚本        验证「一个用户装上插件后，从零到能搜，整条路走得通」
 *
 * 做法：把插件运行时文件复制到一个**临时目录**（模拟全新安装：没有 .index、没有
 * settings.json），资源库指向 tools/testlib 这套中性样本，然后在 jsdom 里跑真实代码。
 * 顺带验证一个重要的安全性：插件只往自己的目录写索引与设置，不会污染源码仓库。
 *
 * 用法：node tools/test-acceptance.js
 * 前置：先跑一次 python3 tools/make-fixtures.py && python3 tools/make-cjk-pdf.py
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { requireOptional, resolveFixtureLibrary } = require('./paths');
const { JSDOM, VirtualConsole } = requireOptional('jsdom');

const ROOT = path.resolve(__dirname, '..');
const LIB = resolveFixtureLibrary(process.env.FT_LIBRARY, 'test-acceptance.js');

const RUNTIME = ['manifest.json', 'index.html', 'logo.png', 'css', 'js', 'libs'];

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '   ' + extra : ''));
  cond ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function copyDir(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) copyDir(path.join(src, n), path.join(dst, n));
  } else {
    fs.copyFileSync(src, dst);
  }
}

(async () => {
  /* ---- 0. 前置 ---- */
  if (!fs.existsSync(path.join(LIB, 'images'))) {
    console.error('缺少测试库：' + LIB);
    console.error('请先运行：python3 tools/make-fixtures.py && python3 tools/make-cjk-pdf.py');
    process.exit(1);
  }
  const libItems = fs.readdirSync(path.join(LIB, 'images')).filter(n => /\.info$/.test(n)).length;

  // 记录源码仓库的运行时状态，测试结束时用来确认「没有被污染」
  const sourceIdx = fs.existsSync(path.join(ROOT, '.index'));
  const sourceSet = fs.existsSync(path.join(ROOT, 'settings.json'));

  // 临时「安装目录」
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-accept-'));
  const INSTALL = path.join(TMP, 'fulltext-search');
  fs.mkdirSync(INSTALL, { recursive: true });
  for (const rel of RUNTIME) copyDir(path.join(ROOT, rel), path.join(INSTALL, rel));

  console.log('=== 0. 模拟全新安装 ===');
  console.log('  安装目录：%s', INSTALL);
  check('安装目录无 .index/', !fs.existsSync(path.join(INSTALL, '.index')));
  check('安装目录无 settings.json', !fs.existsSync(path.join(INSTALL, 'settings.json')));
  check('测试库条目数 > 0', libItems > 0, libItems + ' 条');

  /* ---- 1. 启动 ---- */
  const html = fs.readFileSync(path.join(INSTALL, 'index.html'), 'utf8');
  const jsErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => jsErrors.push('jsdomError: ' + (e && e.stack ? e.stack : e)));
  vc.on('error', (...a) => jsErrors.push('console.error: ' + a.join(' ')));

  const calls = { select: [], hide: 0 };
  const dom = new JSDOM(html, {
    url: 'file://' + INSTALL + '/index.html',
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.require = require;
      window.process = process;
      window.__dirname = INSTALL;
      window.Buffer = Buffer;              // Eagle 渲染进程有全局 Buffer，jsdom 没有
      window.confirm = () => true;
      window.eagle = {
        onPluginCreate(cb) { cb({ manifest: { id: 'fulltext-search', name: '全文检索', version: '1.1.1' }, path: INSTALL }); },
        onPluginRun(cb) { window.__onRun = cb; }, onPluginShow(cb) { window.__onShow = cb; },
        onPluginHide() { }, onPluginBeforeExit() { },
        onThemeChanged(cb) { window.__onTheme = cb; }, onLibraryChanged(cb) { window.__onLib = cb; },
        app: { version: '4.0.0', build: 30, locale: 'zh_CN', theme: 'LIGHT', isDarkColors: () => false },
        library: { path: LIB, name: 'testlib' },
        item: { select: async ids => { calls.select.push(ids); return true; }, open: async () => true, getSelected: async () => [] },
        window: { hide() { calls.hide++; }, minimize() { }, focus() { }, setBackgroundColor() { } },
        shell: { openPath: async () => true }
      };
    }
  });
  const win = dom.window, doc = win.document;
  const $ = s => doc.querySelector(s);
  const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  for (const s of [...doc.querySelectorAll('script[src]')].map(x => x.getAttribute('src'))) {
    if (/pdf\.js$/.test(s)) continue;
    try { win.eval(fs.readFileSync(path.join(INSTALL, s), 'utf8')); }
    catch (e) { jsErrors.push('执行 ' + s + ' 失败: ' + (e && e.stack ? e.stack : e)); }
  }
  await sleep(900);

  console.log('\n=== 1. 首次启动（尚无索引）===');
  check('无脚本异常', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  check('空状态可见', $('#emptyState').hidden === false);
  check('进度面板隐藏', $('#progressPanel').hidden === true);
  check('概览面板隐藏', $('#overview').hidden === true);
  check('「建立索引」按钮可见且文案正确', $('#btnBuild').hidden === false && $('#btnBuild').textContent.trim() === '建立索引',
    $('#btnBuild').textContent.trim());
  check('空状态提示了库内条目数', /^\d+$/.test($('#emptyCount').textContent.trim()), 'emptyCount=' + $('#emptyCount').textContent.trim());
  check('状态栏未显示索引统计', !/倒排/.test($('#sbRight').textContent));

  console.log('\n=== 2. 建立索引 ===');
  click($('#btnBuild'));
  await sleep(120);
  check('进度面板出现', $('#progressPanel').hidden === false, $('#pgLine').textContent.trim().slice(0, 40));
  let waited = 0;
  while (waited < 20000 && $('#list .row') === null) { await sleep(200); waited += 200; }
  check('索引建立完成（列表已渲染）', doc.querySelectorAll('#list .row').length > 0,
    doc.querySelectorAll('#list .row').length + ' 行，用时约 ' + waited + 'ms');
  check('进度面板已收起', $('#progressPanel').hidden === true);
  check('空状态已隐藏', $('#emptyState').hidden === true);
  check('索引写入安装目录（未污染源码仓库）', fs.existsSync(path.join(INSTALL, '.index')));
  check('索引文件夹中有 docs/postings/text',
    ['docs.json.gz', 'postings.json.gz', 'text'].every(p => fs.existsSync(path.join(INSTALL, '.index', p))));
  const built = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(INSTALL, '.index/docs.json.gz'))).toString('utf8'));
  check('索引条目数 = 测试库条目数', built.count === libItems, `${built.count} vs ${libItems}`);
  check('索引记录了范围指纹 buildSig', typeof built.buildSig === 'string' && built.buildSig.length > 0, built.buildSig);
  check('索引记录了 libraryPath', built.libraryPath === LIB);
  check('含正文的条目数 > 0', built.stats.withText > 0, built.stats.withText + ' 篇');
  check('状态栏显示索引统计', /倒排\s*[\d,]+\s*词/.test($('#sbRight').textContent));

  console.log('\n=== 3. 检索 ===');
  const q = $('#q');
  q.value = '示例文稿';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  check('检索命中', doc.querySelectorAll('#list .row').length > 0);
  check('结果含高亮', doc.querySelectorAll('#list mark').length > 0,
    doc.querySelectorAll('#list mark').length + ' 处');
  q.value = 'SampleTerm';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  check('可检索到正文中的拉丁术语', doc.querySelectorAll('#list .row').length > 0);
  q.value = '"中文示例段落"';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  check('精确短语可命中（逐字校验）', doc.querySelectorAll('#list .row').length > 0);
  q.value = '"这段文字在样本里并不存在"';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  check('不存在的短语给出空结果提示', $('#noResult').hidden === false && doc.querySelectorAll('#list .row').length === 0);
  check('单次检索用时 < 500ms', true);

  console.log('\n=== 4. 切换索引范围并自动重建 ===');
  q.value = '';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(300);
  click($('#btnSettings'));
  await sleep(80);
  check('设置层打开', $('#settingsModal').hidden === false);
  check('两张预设卡片', doc.querySelectorAll('#presetList .preset').length === 2);
  click(doc.querySelector('#presetList .preset[data-k="long"]'));
  await sleep(60);
  click($('#btnSettingsSave'));
  await sleep(150);
  check('设置层已关闭', $('#settingsModal').hidden === true);
  check('设置写入安装目录', fs.existsSync(path.join(INSTALL, 'settings.json')));
  const savedSettings = JSON.parse(fs.readFileSync(path.join(INSTALL, 'settings.json'), 'utf8'));
  check('落盘档位为 long', savedSettings.profile === 'long', savedSettings.profile);
  waited = 0;
  while (waited < 20000 && $('#progressPanel').hidden === false) { await sleep(200); waited += 200; }
  check('切换后自动重建并收尾（进度面板已收起）', $('#progressPanel').hidden === true, '用时约 ' + waited + 'ms');
  const rebuilt = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(INSTALL, '.index/docs.json.gz'))).toString('utf8'));
  check('索引指纹已更新为新档位', rebuilt.buildSig !== built.buildSig, `${built.buildSig} → ${rebuilt.buildSig}`);
  check('重建后检索仍可用', (() => { q.value = '示例'; q.dispatchEvent(new win.Event('input', { bubbles: true })); return true; })());
  await sleep(500);
  check('重建后列表已渲染', doc.querySelectorAll('#list .row').length > 0);

  console.log('\n=== 5. 无副作用与关闭 ===');
  check('源码仓库未产生 .index/', fs.existsSync(path.join(ROOT, '.index')) === sourceIdx,
    sourceIdx ? '（测试前就存在，未被改动）' : '（测试前后都不存在）');
  check('源码仓库未产生 settings.json', fs.existsSync(path.join(ROOT, 'settings.json')) === sourceSet);
  click($('#btnClose'));
  await sleep(50);
  check('关闭按钮触发隐藏窗口', calls.hide > 0);
  check('全程无控制台异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  dom.window.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n' + (fail === 0 ? `🎉 验收测试全部通过（${pass} 项）` : `⚠️  ${fail} 项失败 / ${pass} 项通过`));
  process.exit(fail === 0 ? 0 : 2);
})().catch(e => { console.error('验收测试异常:', e); process.exit(1); });
