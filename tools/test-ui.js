#!/usr/bin/env node
/* =============================================================================
 * test-ui.js —— 界面集成测试（jsdom + 真实索引 + 桩 Eagle API）
 * 目的：在不开 Eagle 的情况下验证 app.js 的全部接线：
 *       boot 载入索引 → 渲染列表 → 输入检索 → 高亮 → 筛选 → 排序 → 键盘 → 定位
 *       以及「无控制台异常」这一条硬指标。
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { requireOptional, resolveFixtureLibrary } = require('./paths');
const { JSDOM, VirtualConsole } = requireOptional('jsdom');

const PLUGIN = path.resolve(__dirname, '..');
/* 默认跑在自造样本库上（先执行 python make-fixtures.py && python make-cjk-pdf.py）：
   · 测试不应依赖某台机器上的资源库，否则换台机器就红；
   · 断言必须能对照「已知内容」，跑在未知库上只能断言「有结果」，价值很低。
   想拿真实库跑一遍：node test-ui.js /path/to/xxx.library */
const LIB = resolveFixtureLibrary(process.argv[2], 'test-ui.js');
/* 沙箱：索引与设置全部落在 tools/test-index/，绝不碰插件目录下的真实索引与设置。
   否则跑一次测试就会让 Eagle 里的插件误判「换了资源库」。 */
const SANDBOX_INDEX = path.join(__dirname, 'test-index');
const SANDBOX_SETTINGS = path.join(SANDBOX_INDEX, 'settings.json');

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '   ' + extra : ''));
  cond ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, n) => { s = String(s == null ? '' : s); let w = 0; for (const c of s) w += c.charCodeAt(0) > 127 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };

async function main() {
  /* —— 前置：把磁盘状态确定化，否则上一次运行的残留会让断言飘 ——
     ① 清空沙箱索引目录 + 沙箱设置 → 起点与「全新安装」一致，档位必为默认「普通文件」
     ② 全量建一次索引 → 与默认档位指纹一致，boot 时才载得进来
     ③ 再增量建一次（本轮 processed 应为 0 的空转）→ 让第 1 节的「统计不被空转抹掉」
        这条断言真的落在空转路径上，而不是碰巧走了全量 */
  fs.rmSync(SANDBOX_INDEX, { recursive: true, force: true });
  ['config', 'util', 'zip', 'extract', 'tokenizer', 'indexer', 'search'].forEach(m =>
    require(path.join(PLUGIN, 'js', m + '.js')));
  FT.config.PLUGIN_DIR = PLUGIN;
  // 让插件把索引/设置写到沙箱目录（app.js boot 与 eagle-api.js 都会读这两个值）
  FT.config.SANDBOX.indexDir = SANDBOX_INDEX;
  FT.config.SANDBOX.settingsFile = SANDBOX_SETTINGS;

  let prepRes = null;
  {
    const prepOpts = FT.config.applyProfile(Object.assign({}, FT.config.DEFAULTS), FT.config.DEFAULTS.profile);
    const mk = (opts) => FT.indexer.makeIndexer({
      fs, path, libraryPath: LIB, indexDir: SANDBOX_INDEX,
      opts, onProgress() { }, isCancelled: () => false
    });
    const full = await mk(Object.assign({}, prepOpts, { incremental: false })).build();
    console.log('  [前置] 全量建索引：' + full.docs.count + ' 条目 / ' +
      full.docs.stats.withText + ' 篇含正文 / 档位 ' + prepOpts.profile + ' / ' + full.stats.totalMs + 'ms');
    prepRes = await mk(prepOpts).build();   // 第二遍：增量空转
    console.log('  [前置] 增量复核：' + prepRes.docs.count + ' 条目 / 本轮处理 ' +
      prepRes.stats.processed + ' 条 / ' + prepRes.stats.totalMs + 'ms');
  }

  const html = fs.readFileSync(path.join(PLUGIN, 'index.html'), 'utf8');
  const jsErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => jsErrors.push('jsdomError: ' + (e && e.stack ? e.stack : e)));
  vc.on('error', (...a) => jsErrors.push('console.error: ' + a.join(' ')));

  const calls = { select: [], open: [], openPath: [], hide: 0 };
  const dom = new JSDOM(html, {
    url: 'file://' + PLUGIN + '/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.require = require;
      window.process = process;
      window.__dirname = PLUGIN;
      /* Eagle 的渲染进程同时注入 Node 集成，因此 `Buffer` 是**全局**可用的
         （indexer 写索引、extract/zip 解码都用它）。jsdom 默认没有这个全局，
         不补上就会在「写正文」处抛 ReferenceError —— 后果是 jsdom 里的重建永远失败，
         而失败分支恰好会让进度面板保持可见，于是「重建」相关断言看起来是绿的、其实没跑过。 */
      window.Buffer = Buffer;
      window.confirm = () => true;
      /* 页面侧沙箱：config.js 在加载时会读这个全局，把 .index/ 与 settings.json
         重定向到 tools/test-index/ —— 跑的是真实代码路径，但绝不污染插件目录下
         交付用的真实索引（否则下次在 Eagle 里开插件会误判「换了资源库」）。 */
      window.__FT_SANDBOX__ = { indexDir: SANDBOX_INDEX, settingsFile: SANDBOX_SETTINGS };
      window.eagle = {
        onPluginCreate(cb) { cb({ manifest: { id: 'fulltext-search', name: '全文检索', version: '1.0.0' }, path: PLUGIN }); },
        onPluginRun(cb) { window.__onRun = cb; },
        onPluginShow(cb) { window.__onShow = cb; },
        onPluginHide() { }, onPluginBeforeExit() { },
        onThemeChanged(cb) { window.__onTheme = cb; },
        onLibraryChanged(cb) { window.__onLib = cb; },
        app: { version: '4.0.0', build: 30, locale: 'zh_CN', theme: 'LIGHT', isDarkColors: () => false },
        library: { path: LIB, name: 'eagle' },
        item: {
          select: async ids => { calls.select.push(ids); return true; },
          open: async id => { calls.open.push(id); return true; },
          getSelected: async () => []
        },
        window: { hide() { calls.hide++; }, minimize() { }, focus() { }, setBackgroundColor() { } },
        shell: { openPath: async p => { calls.openPath.push(p); return true; } }
      };
    }
  });
  const win = dom.window, doc = win.document;
  const $ = s => doc.querySelector(s);

  // 手动按顺序执行脚本（跳过 pdf.js：extract.js 会按需 require 它）
  const srcs = [...doc.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
  for (const src of srcs) {
    if (/pdf\.js$/.test(src)) continue;
    const code = fs.readFileSync(path.join(PLUGIN, src), 'utf8');
    try { win.eval(code); }
    catch (e) { jsErrors.push('执行 ' + src + ' 失败: ' + (e && e.stack ? e.stack : e)); }
  }
  await sleep(700);   // 等 boot() 的异步链（载入索引 → 首次检索）

  console.log('\n=== 1. 启动与索引载入 ===');
  check('无脚本异常', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  check('FT 命名空间就绪', !!win.FT && !!win.FT.eagle && !!win.FT.search);
  const rows0 = doc.querySelectorAll('#list .row').length;
  check('列表已渲染', rows0 > 0, '行数=' + rows0);
  check('空状态已隐藏', $('#emptyState').hidden === true);
  check('概览面板可见', $('#overview').hidden === false);
  check('标题栏副标题含条目数', /索引\s*\d+\s*条/.test($('#tbSub').textContent), $('#tbSub').textContent.trim());
  check('状态栏含倒排词条', /倒排\s*[\d,]+\s*词/.test($('#sbRight').textContent));
  check('左侧筛选已渲染类型', $('#typeList').children.length > 0,
    [...$('#typeList').children].map(c => c.textContent.trim()).join(' / '));
  // 回归守卫：docs.stats 必须描述「整个索引」而不是「本轮增量」。
  // 增量空转（processed=0）时若直接写本轮计数，会把统计抹成 0 → 概览面板「抽取方式」整行消失。
  check('docs.stats 反映整体（未被增量空转抹掉）',
    prepRes.docs.stats.withText > 0 && Object.keys(prepRes.docs.stats.byMethod).length > 0,
    'withText=' + prepRes.docs.stats.withText + ' byMethod=' + JSON.stringify(prepRes.docs.stats.byMethod));

  console.log('\n=== 2. 检索与高亮 ===');
  const q = $('#q');
  q.value = '示例文稿';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  const rows = [...doc.querySelectorAll('#list .row')];
  check('检索返回结果', rows.length > 0, '行数=' + rows.length);
  check('列表头显示命中数', /共\s*[\d,]+\s*条/.test($('#listHead').textContent), $('#listHead').textContent.trim());
  check('结果含高亮 <mark>', doc.querySelectorAll('#list mark').length > 0, 'mark 数=' + doc.querySelectorAll('#list mark').length);
  const markText = [...doc.querySelectorAll('#list mark')].slice(0, 3).map(m => m.textContent).join('|');
  check('高亮内容正确（含查询词片段）', /示例|文稿/.test(markText), markText);
  check('命中字段徽章存在', doc.querySelectorAll('#list .badge').length > 0);
  const firstRowText = rows[0] ? rows[0].textContent : '';
  check('首行展示了正文片段', firstRowText.length > 40, firstRowText.replace(/\s+/g, ' ').slice(0, 70));

  console.log('\n=== 3. 短语查询（逐字校验）===');
  q.value = '"示例文稿"';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  check('短语查询有结果', doc.querySelectorAll('#list .row').length > 0);
  q.value = '"这四个字连不起来"';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(500);
  check('不存在的短语 → 空结果提示', $('#noResult').hidden === false && doc.querySelectorAll('#list .row').length === 0);
  check('空结果文案含建议', /精确短语|逐字校验/.test($('#noResult').textContent));

  console.log('\n=== 4. 筛选与排序 ===');
  q.value = '示例';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(400);
  const before = doc.querySelectorAll('#list .row').length;
  const chipKey = ([...$('#typeList').children][0]).getAttribute('data-k');   // 频次最高的类型
  const getChip = k => doc.querySelector('#typeList .chip[data-k="' + k + '"]');
  getChip(chipKey).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  const after = doc.querySelectorAll('#list .row').length;
  check('点击类型筛选后重新检索', after <= before, `筛选前 ${before} → 筛选后 ${after}（筛选=${chipKey}）`);
  check('筛选按钮呈选中态（重新渲染后）', getChip(chipKey).classList.contains('on'));
  getChip(chipKey).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  check('再次点击取消筛选', !getChip(chipKey).classList.contains('on') && doc.querySelectorAll('#list .row').length === before,
    `恢复后 ${doc.querySelectorAll('#list .row').length} 行`);

  const sel = $('#sort');
  sel.value = 'name';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(400);
  check('切换排序为名称可用', doc.querySelectorAll('#list .row').length > 0);
  sel.value = 'relevance';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(300);

  console.log('\n=== 5. 键盘交互 ===');
  q.value = '示例';
  q.dispatchEvent(new win.Event('input', { bubbles: true }));
  await sleep(400);
  const sel0 = doc.querySelector('.row.sel') ? +doc.querySelector('.row.sel').getAttribute('data-i') : -1;
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await sleep(60);
  const sel1 = doc.querySelector('.row.sel') ? +doc.querySelector('.row.sel').getAttribute('data-i') : -1;
  check('↓ 移动选中行', sel1 === Math.min(sel0 + 1, doc.querySelectorAll('#list .row').length - 1), `${sel0} → ${sel1}`);
  const targetId = doc.querySelector('.row.sel').getAttribute('data-id');
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(80);
  check('↵ 触发在 Eagle 中定位', calls.select.length > 0 && calls.select[calls.select.length - 1][0] === targetId,
    'select=' + JSON.stringify(calls.select));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
  await sleep(120);
  check('⌥↵ 用系统应用打开文件', calls.openPath.length > 0 && /images[\\/]/.test(calls.openPath[0]),
    String(calls.openPath[0] || '').replace(LIB, '…'));

  console.log('\n=== 6. 主题与关闭 ===');
  win.__onTheme('DARK');
  await sleep(50);
  check('主题切换 → dark', doc.documentElement.getAttribute('data-theme') === 'dark');
  win.__onTheme('LIGHTGRAY');
  await sleep(50);
  check('主题切换 → light', doc.documentElement.getAttribute('data-theme') === 'light');
  $('#btnClose').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('关闭按钮触发隐藏窗口', calls.hide > 0);

  console.log('\n=== 8. 设置弹层（索引范围两档预设）===');
  // 8.0 静态守卫：author 样式里的 display:flex 会盖过 UA 的 [hidden]{display:none}，
  //     必须显式加 !important 才关得掉。这条规则缺失 = 弹层永远盖在窗口上（历史 bug）。
  const css = fs.readFileSync(path.join(PLUGIN, 'css', 'app.css'), 'utf8');
  check('app.css 含 [hidden] !important 守卫', /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css));

  const modal = $('#settingsModal');
  // 设置落盘位置 = 沙箱（与页面里 EA.saveSettings 的目标一致），不是插件目录
  const setPath = SANDBOX_SETTINGS;
  const readSettingsFile = () => { try { return JSON.parse(fs.readFileSync(setPath, 'utf8')); } catch (e) { return null; } };
  const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const presetEls = () => [...doc.querySelectorAll('#presetList .preset')];
  const onPreset = () => { const e = doc.querySelector('#presetList .preset.on'); return e ? e.getAttribute('data-k') : null; };
  const settingsBefore = readSettingsFile();

  check('弹层初始隐藏', modal.hidden === true);
  click($('#btnSettings'));
  await sleep(60);
  check('点「设置」后弹层打开', modal.hidden === false);
  check('渲染出两张预设卡片', presetEls().length === 2,
    presetEls().map(e => e.getAttribute('data-k')).join(' / '));
  const presetText = presetEls().map(e => e.textContent).join(' ');
  check('卡片含名称与容量说明', /普通文件/.test(presetText) && /长文本/.test(presetText) && /万字符/.test(presetText),
    presetText.replace(/\s+/g, ' ').slice(0, 64));
  const curKey = win.FT.config.DEFAULTS.profile;
  check('默认选中「普通文件」', onPreset() === curKey, 'on=' + onPreset());
  // 选中态必须一眼可辨（初版只靠背景差 5 个色阶，浅色主题下几乎看不出，用户会以为「点了没反应」）
  check('选中态有 DOM 层标记（圆点 + aria-checked）',
    !!doc.querySelector('#presetList .preset.on .p-dot') &&
    doc.querySelector('#presetList .preset[data-k="' + curKey + '"]').getAttribute('aria-checked') === 'true' &&
    presetEls().filter(e => e.getAttribute('aria-checked') === 'false').length === 1);
  check('选中态在 CSS 上另有边框/圆点区分（不只靠背景色阶）',
    /#?\.?preset\.on\s*\{[^}]*border-color/.test(css) && /\.preset\.on\s+\.p-dot\s*\{/.test(css));

  // 8.1 点选另一档 → 仅改 pending，不落盘
  const otherKey = presetEls().map(e => e.getAttribute('data-k')).find(k => k !== curKey);
  click(doc.querySelector('#presetList .preset[data-k="' + otherKey + '"]'));
  await sleep(40);
  check('点选另一档后选中态转移', onPreset() === otherKey, 'on=' + onPreset());
  check('此时并未写盘（仍是点击前的设置）',
    JSON.stringify(readSettingsFile()) === JSON.stringify(settingsBefore));

  // 8.2 「取消」必须能关掉弹层，且丢弃未保存的选择
  click($('#btnSettingsCancel'));
  await sleep(40);
  check('点「取消」关闭弹层', modal.hidden === true);
  click($('#btnSettings'));
  await sleep(40);
  check('取消后重开 → 回到已保存档位', onPreset() === curKey, 'on=' + onPreset());

  // 8.3 Esc 关闭
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  check('Esc 关闭弹层', modal.hidden === true);

  // 8.4 点遮罩空白处关闭
  click($('#btnSettings'));
  await sleep(40);
  click(modal);
  await sleep(40);
  check('点遮罩空白关闭弹层', modal.hidden === true);

  // 8.5 「保存并应用」：这是用户报的「点保存没反应」——必须真的关掉弹层并落盘
  click($('#btnSettings'));
  await sleep(40);
  click(doc.querySelector('#presetList .preset[data-k="' + otherKey + '"]'));
  await sleep(40);
  /* 弹层关闭是同步的（closeSettings() 在 buildIndex() 之前调用），所以立刻断言即可；
     但「重建中」这个状态在大库上只持续很短时间，固定 sleep 后单点采样会漏掉它
     —— 用固定 sleep 之所以「曾经能过」，只是因为当时手边那个库恰好耗时较长。
     所以这里改成轮询捕捉，不依赖任何特定库的耗时。 */
  click($('#btnSettingsSave'));
  const modalClosedOnSave = modal.hidden === true;
  let sawRebuild = false;
  for (let i = 0; i < 60; i++) {
    if ($('#progressPanel').hidden === false) { sawRebuild = true; break; }
    await sleep(20);
  }
  check('点「保存并应用」关闭弹层（回归守卫）', modalClosedOnSave);
  const saved = readSettingsFile();
  check('设置已落盘且档位正确', !!saved && saved.profile === otherKey,
    'profile=' + (saved && saved.profile));
  const expectP = win.FT.config.profileOf(otherKey);
  check('落盘数值与档位一致（maxCharsPerDoc / maxFileSize）',
    !!saved && saved.maxCharsPerDoc === expectP.maxCharsPerDoc && saved.maxFileSize === expectP.maxFileSize,
    saved ? saved.maxCharsPerDoc + ' 字符 / ' + win.FT.util.formatBytes(saved.maxFileSize) : '—');
  check('切换档位后自动触发重建（轮询捕捉，避免采样漏掉短重建）', sawRebuild,
    sawRebuild ? '进度面板已弹出' : '未弹出（sbLeft=' + $('#sbLeft').textContent.trim().slice(0, 30) + '）');
  await sleep(2500);   // 等这次重建收尾，避免影响后续断言
  click($('#btnSettings'));
  await sleep(40);
  check('重开后选中态为已保存档位', onPreset() === otherKey, 'on=' + onPreset());
  click($('#btnSettingsCancel'));

  console.log('\n=== 9. 重建索引：进度面板必须收尾隐藏（回归守卫）===');
  /* 用户报的「点击重建索引会卡住在这个界面」：
     updateVisibility() 里有 `$('progressPanel').hidden = !state.building`，但它此前只在
     「state.building 仍为 true」时被调用过（起始态 / runSearch→renderList / catch），
     finally 把 building 置 false 之后没人重新推导 → 面板永远留在页面上。
     索引其实写完了、结果也刷新了，纯粹是收尾位置问题。这条断言就是守它。 */
  const panel = $('#progressPanel');
  const waitPanelHidden = async (budgetMs) => {
    let w = 0;
    while (w < budgetMs) { await sleep(250); w += 250; if (panel.hidden === true) break; }
    return w;
  };
  // 先等上一节触发的重建彻底收尾，否则 state.building 仍为 true，点按钮会被早退忽略
  const w0 = await waitPanelHidden(20000);
  check('上一节触发的重建已收尾', panel.hidden === true, '等待 ' + w0 + 'ms');

  click($('#btnRebuild'));
  // 同 8.5：重建只持续约百毫秒，单点采样会漏 —— 轮询直到看见面板出现
  let sawRebuildPanel = false;
  for (let i = 0; i < 60; i++) {
    if (panel.hidden === false) { sawRebuildPanel = true; break; }
    await sleep(20);
  }
  check('重建期间进度面板可见', sawRebuildPanel);
  const w1 = await waitPanelHidden(30000);
  check('重建完成后进度面板自动隐藏（回归守卫）', panel.hidden === true,
    panel.hidden ? '用时 ' + w1 + 'ms' : '已等 ' + w1 + 'ms 仍未隐藏 —— 面板卡住了');
  check('重建完成后结果列表已刷新', doc.querySelectorAll('#list .row').length > 0,
    '行数=' + doc.querySelectorAll('#list .row').length);
  check('重建完成后标题栏恢复统计文案', /索引\s*[\d,]+\s*条/.test($('#tbSub').textContent),
    $('#tbSub').textContent.trim());
  check('重建完成后不再处于 building 态（概览可正常推导）',
    panel.hidden === true && $('#emptyState').hidden === true);

  console.log('\n=== 10. 转义安全（注入防护）===');
  const evil = '<img src=x onerror=alert(1)>';
  const escaped = win.FT.util.escapeHtml(evil);
  check('escapeHtml 转义标签', escaped.indexOf('<') === -1, escaped);
  const hl = win.FT.util.highlightHtml('a<b>&c 示例文本', [{ start: 7, end: 11 }]);
  check('highlightHtml 先切分后转义（无裸标签）', hl.indexOf('<b>') === -1 && hl.indexOf('&lt;b&gt;') >= 0, hl);

  console.log('\n' + (fail === 0 ? `🎉 界面测试全部通过（${pass} 项）` : `⚠️  ${fail} 项失败 / ${pass} 项通过`));
  if (jsErrors.length) { console.log('\n控制台异常：'); jsErrors.slice(0, 10).forEach(e => console.log('  - ' + e)); }
  dom.window.close();
  process.exit(fail === 0 ? 0 : 2);
}
main().catch(e => { console.error('测试异常:', e); process.exit(1); });
