#!/usr/bin/env node
/* =============================================================================
 * selfcheck.js —— 静态自检（发布前必跑）
 * -----------------------------------------------------------------------------
 * 不做功能测试，只做「结构 / 一致性 / 卫生」检查，用来拦住那些靠肉眼容易漏、
 * 但上线后会直接翻车的问题：
 *   1. manifest.json 能否解析、必填字段是否有效、devTools 必须为 false
 *   2. 版本号三处一致（manifest.json / js/config.js / package.json）
 *   3. index.html 引用的本地资源是否都存在
 *   4. pdf.js 资产是否完整（含 CMap 数量）
 *   5. app.js 里 $('xxx') 引用的 DOM id 是否都存在于 index.html（防拼写错误）
 *   6. 源码里不得出现本机绝对路径
 *   7. 不得直接使用 Node 全局 Buffer（必须走 util.toBuffer，否则测试宿主会静默失败）
 *   8. 关键回归守卫是否还在（[hidden] !important 等）
 *   9. 运行时目录不得被误提交（.index/ settings.json）
 *
 * 用法：node tools/selfcheck.js [--release]   （--release 时额外检查 dist/）
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const CHECK_RELEASE = args.includes('--release');

let pass = 0, fail = 0, warn = 0;
const ok = (label, cond, extra) => {
  console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '   ' + extra : ''));
  cond ? pass++ : fail++;
};
const note = (label, extra) => { console.log('  ⚠️  ' + label + (extra ? '   ' + extra : '')); warn++; };
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

/* ---------------------------------------------------------------- 1. manifest */
console.log('\n=== 1. manifest.json ===');
let mf = null;
try { mf = JSON.parse(read('manifest.json')); ok('可解析为 JSON', true); }
catch (e) { ok('可解析为 JSON', false, e.message); }
if (mf) {
  ok('id 为非空字符串', typeof mf.id === 'string' && mf.id.trim().length > 0, mf.id);
  ok('name 为非空字符串', typeof mf.name === 'string' && mf.name.trim().length > 0, mf.name);
  ok('name 长度 ≤ 30 字符（插件中心上限）', [...String(mf.name)].length <= 30, `当前 ${[...String(mf.name)].length} 字符`);
  ok('version 为 x.y.z 形式', /^\d+\.\d+\.\d+$/.test(String(mf.version)), mf.version);
  ok('devTools === false（审核红线：true 会被直接驳回）', mf.devTools === false, String(mf.devTools));
  ok('logo 字段存在且文件存在', !!mf.logo && exists(mf.logo.replace(/^\.\//, '')), mf.logo);
  ok('main.url 指向的文件存在', !!(mf.main && mf.main.url) && exists(mf.main.url), mf.main && mf.main.url);
  ok('keywords 为非空数组', Array.isArray(mf.keywords) && mf.keywords.length > 0,
    Array.isArray(mf.keywords) ? mf.keywords.length + ' 个' : '—');
}

/* --------------------------------------------------------- 2. 版本号三处一致 */
console.log('\n=== 2. 版本号一致性 ===');
const cfgSrc = read('js/config.js');
const cfgVer = (cfgSrc.match(/VERSION:\s*'([^']+)'/) || [])[1];
const pkgVer = JSON.parse(read('package.json')).version;
ok('js/config.js 能取到 VERSION', !!cfgVer, cfgVer);
ok('manifest.json 与 js/config.js 一致', mf && mf.version === cfgVer, `${mf && mf.version} vs ${cfgVer}`);
ok('package.json 与 js/config.js 一致', pkgVer === cfgVer, `${pkgVer} vs ${cfgVer}`);

/* ------------------------------------------------- 3/4. index.html 资源与 pdf 资产 */
console.log('\n=== 3. index.html 引用的本地资源 ===');
const html = read('index.html');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
  .filter(u => !/^(https?:|data:|#)/.test(u));
const missing = refs.filter(u => !exists(u));
ok('全部本地资源存在', missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : refs.length + ' 个引用');

console.log('\n=== 4. pdf.js 资产完整性 ===');
ok('libs/pdfjs/pdf.js 存在', exists('libs/pdfjs/pdf.js'));
ok('libs/pdfjs/pdf.worker.js 存在', exists('libs/pdfjs/pdf.worker.js'));
const cmapDir = path.join(ROOT, 'libs/pdfjs/cmaps');
const cmaps = fs.existsSync(cmapDir) ? fs.readdirSync(cmapDir).filter(f => /\.bcmap$/.test(f)) : [];
ok('CJK CMap 文件充足（中文 PDF 依赖）', cmaps.length >= 100, cmaps.length + ' 个 .bcmap');

/* -------------------------------------------------- 5. app.js 的 DOM id 是否都存在 */
console.log('\n=== 5. DOM id 引用一致性 ===');
const appSrc = read('js/app.js');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const usedIds = new Set([...appSrc.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]));
const dangling = [...usedIds].filter(id => !htmlIds.has(id));
ok('app.js 引用的 id 全部存在于 index.html', dangling.length === 0,
  dangling.length ? '悬空 id: ' + dangling.join(', ') : usedIds.size + ' 个 id');
const unused = [...htmlIds].filter(id => !usedIds.has(id));
if (unused.length) note('index.html 中存在未被 app.js 引用的 id', unused.join(', '));

/* ------------------------------------------------------------ 6. 本机绝对路径 */
console.log('\n=== 6. 源码卫生 ===');
const codeFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'libs' || e.name === 'node_modules' || e.name === 'testlib' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|css|html|json|md|py)$/.test(e.name)) codeFiles.push(path.relative(ROOT, p));
  }
})(ROOT);
const absPathHits = codeFiles.filter(f => {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return /\/Users\/[A-Za-z]|[A-Z]:\\\\?Users|\/home\/[a-z]/.test(s);
});
ok('无本机绝对路径泄漏', absPathHits.length === 0, absPathHits.join('; '));

/* 测试脚本不得把「某台机器的资源库路径」当默认值。
   build-index.js 例外：它本来就是给真实资源库用的（且缺库时会给出指引）。 */
const localLibHits = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter(f => /^test-.*\.js$/.test(f))
  .filter(f => /eagle\.library/.test(fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8')));
ok('测试脚本未把本机资源库路径当默认值', localLibHits.length === 0, localLibHits.join(', '));
/* 缺样本库时要给指引，不能抛 ENOENT 堆栈 */
const guardHits = ['test-formats.js', 'test-core.js', 'test-ui.js', 'test-acceptance.js']
  .filter(f => !/resolveFixtureLibrary/.test(fs.readFileSync(path.join(ROOT, 'tools', f), 'utf8')));
ok('四个测试脚本都走 resolveFixtureLibrary（缺库时给指引而非堆栈）', guardHits.length === 0, guardHits.join(', '));

/* 仓库内不得出现凭据或私钥。模式用「片段拼接」构造，
   否则扫描器会命中写在同一文件里的自己的字面量。 */
const SECRET_FRAGMENTS = [
  ['gh', 'p_'], ['gh', 'o_'], ['gh', 'u_'], ['gh', 's_'], ['gh', 'r_'],
  ['github', '_pat_'], ['xox', 'b-'], ['AK', 'IA'],
  ['-----BEGIN ', 'PRIVATE KEY-----']
].map(a => a.join(''));
const secretHits = [];
for (const f of codeFiles) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const pat of SECRET_FRAGMENTS) if (s.includes(pat)) secretHits.push(f + ' ← ' + pat.slice(0, 4) + '…');
}
ok('仓库内无凭据/私钥字样（token、private key 等）', secretHits.length === 0, secretHits.slice(0, 5).join('; '));

/* -------------------------------------- 7. 不得直接使用 Node 全局 Buffer */
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
const bufHits = jsFiles.filter(f => {
  const s = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  return /\bBuffer\.(from|alloc|concat|byteLength)\b/.test(s);
});
ok('js/ 未直接使用全局 Buffer（统一走 util.toBuffer）', bufHits.length === 0, bufHits.join(', '));
ok('util.toBuffer 已导出', /toBuffer:\s*toBuffer/.test(read('js/util.js')));

/* ------------------------------------------------------ 8. 关键回归守卫仍在 */
console.log('\n=== 7. 关键回归守卫 ===');
const css = read('css/app.css');
ok('[hidden] { display:none !important } 守卫仍在',
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css));
ok('预设选中态有非颜色区分（border-color + p-dot）',
  /\.preset\.on\s*\{[^}]*border-color/.test(css) && /\.preset\.on\s+\.p-dot\s*\{/.test(css));
ok('buildIndex 的 finally 中调用 updateVisibility（进度面板收尾）',
  /finally\s*\{[\s\S]{0,400}updateVisibility\(\)/.test(appSrc));
ok('loadIndex 采用 {index}|{reason} 判别式',
  /reason:\s*'no-index'/.test(read('js/indexer.js')) && /docs\.buildSig/.test(read('js/indexer.js')));

/* 截图脚本的两条约定：产物必须落在仓库内（否则不受 .gitignore 保护），
   且换用样本库之外的资源库时要出声提醒。 */
const previewSrc = read('tools/preview.js');
ok('preview.js 默认输出落在仓库内且被 gitignore 覆盖',
  /process\.argv\[2\]\s*\|\|\s*path\.join\(PLUGIN,\s*'preview'\)/.test(previewSrc) &&
  /^preview\/$/m.test(read('.gitignore')));
ok('preview.js 用样本库之外的资源库时会警告',
  /IS_NEUTRAL/.test(previewSrc) && /_WARNING-非样本库截图/.test(previewSrc));

/* ------------------------------------------------- 9. 运行时目录不得在仓库里 */
console.log('\n=== 8. 仓库卫生 ===');
const gi = exists('.gitignore') ? read('.gitignore') : '';
ok('.gitignore 存在', exists('.gitignore'));
ok('.gitignore 忽略 .index/', /^\.index\/?$/m.test(gi));
ok('.gitignore 忽略 settings.json', /^settings\.json$/m.test(gi));
if (exists('.index')) note('.index/ 当前存在于工作目录（已被 gitignore，注意不要用 git add -f）');
if (exists('settings.json')) note('settings.json 当前存在于工作目录（已被 gitignore）');
ok('tools/ 未被 index.html 引用（保证打包时不必要依赖）', !/tools\//.test(html));

/* ------------------------------------------------- 9. 可选词表扫描（本地可配置）
 * 词表放在仓库外的本地文件里：自检脚本本身是要公开的，把词写死在源码里
 * 会让这条检查自己成为扫描命中的目标。约定 tools/.private-terms（已 gitignore，
 * 一行一个词），克隆者没有这个文件就自动跳过。
 * 用途：防止示例、脚本、注释里不小心把不该公开的素材名称带进提交。 */
console.log('\n=== 9. 可选词表扫描 ===');
const termFile = path.join(__dirname, '.private-terms');
if (!fs.existsSync(termFile)) {
  note('未找到 tools/.private-terms，跳过词表扫描', '（该文件不入库，公开克隆下属正常）');
} else {
  const terms = fs.readFileSync(termFile, 'utf8').split('\n')
    .map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const hits = [];
  for (const f of codeFiles) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const t of terms) if (s.includes(t)) hits.push(f + ' ← ' + t);
  }
  ok(`源码中无词表命中（检查 ${terms.length} 个词）`, hits.length === 0, hits.slice(0, 8).join('; '));
}

/* ------------------------------------------------------------- 10. dist 检查 */
if (CHECK_RELEASE) {
  console.log('\n=== 10. dist/ 发布包检查 ===');
  const dist = path.join(ROOT, 'dist', mf.id);
  if (!fs.existsSync(dist)) {
    ok('dist/' + mf.id + ' 存在', false, '请先运行 npm run build:release');
  } else {
    const forbidden = [];
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if (/^(tools|dist|\.git|\.index|node_modules|testlib|test-index)$/.test(e.name)) forbidden.push(r);
          walk(path.join(d, e.name), r);
        } else if (/^(settings\.json|package\.json|\.DS_Store)$/.test(e.name)) forbidden.push(r);
      }
    })(dist, '');
    ok('发布包内无开发产物（tools/ dist/ .git/ .index/ settings.json 等）',
      forbidden.length === 0, forbidden.join(', '));
    const dm = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
    ok('发布包 manifest 的 devTools === false', dm.devTools === false);
    ok('发布包 manifest 的版本与源码一致', dm.version === cfgVer, dm.version);
    ok('发布包含 index.html / css / js / libs / logo.png',
      ['index.html', 'css', 'js', 'libs', 'logo.png'].every(p => fs.existsSync(path.join(dist, p))));
    const size = (function walk(d) {
      return fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => {
        const p = path.join(d, e.name);
        return s + (e.isDirectory() ? walk(p) : fs.statSync(p).size);
      }, 0);
    })(dist);
    console.log('  发布包体积 %s', (size / 1024 / 1024).toFixed(2) + ' MB');
  }
}

console.log('\n' + (fail === 0
  ? `🎉 自检通过（${pass} 项${warn ? '，' + warn + ' 条提示' : ''}）`
  : `⚠️  ${fail} 项失败 / ${pass} 项通过${warn ? '，' + warn + ' 条提示' : ''}`));
process.exit(fail === 0 ? 0 : 2);
