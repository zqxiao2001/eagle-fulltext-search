#!/usr/bin/env node
/* =============================================================================
 * build-release.js —— 组装可直接交给 Eagle「打包插件」的干净发布目录
 * -----------------------------------------------------------------------------
 * 用**白名单**而不是黑名单：只复制明确要发布的文件。因此开发目录里的
 * tools/、dist/、.index/、settings.json、testlib/ 等不会被误带进安装包，
 * 以后新增的开发文件也不会因为「忘记加进忽略列表」而混入。
 *
 * 用法：node tools/build-release.js
 * 产物：dist/fulltext-search/   ← 用 Eagle 的「插件面板 → 右键 → 打包插件」指向它
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 白名单：只有这些会进入发布包 */
const ALLOW = [
  'manifest.json',
  'index.html',
  'logo.png',
  'css',
  'js',
  'libs',
  'LICENSE',
  'README.md',
  'CHANGELOG.md'
];

/** 明确禁止出现在发布包里的名字（保险丝：白名单漏配时也能拦住） */
const FORBIDDEN = /^(tools|dist|docs|node_modules|testlib|test-index|\.git|\.index|settings\.json|package\.json|package-lock\.json|\.DS_Store|make-logo\.py)$/;

const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OUT = path.join(ROOT, 'dist', mf.id);

/* ---- 前置校验：发布包不能带开发开关 ---- */
let fail = 0;
const pre = (label, cond, extra) => {
  console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '   ' + extra : ''));
  if (!cond) fail++;
};
console.log('=== 发布前置校验 ===');
pre('manifest.devTools === false', mf.devTools === false, String(mf.devTools));
pre('manifest.id 非空', typeof mf.id === 'string' && mf.id.length > 0, mf.id);
pre('manifest.version 非空', /^\d+\.\d+\.\d+$/.test(String(mf.version)), mf.version);
const cfgVer = (fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8').match(/VERSION:\s*'([^']+)'/) || [])[1];
pre('版本号与 js/config.js 一致', mf.version === cfgVer, `${mf.version} vs ${cfgVer}`);
if (fail) {
  console.error('\n前置校验未通过，已中止。请修正后重试（可先跑 node tools/selfcheck.js 定位）。');
  process.exit(2);
}

/* ---- 清理并复制 ---- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let bytes = 0, files = 0;
function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (FORBIDDEN.test(name)) { console.log('  · 跳过 ' + name); continue; }
      copy(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.copyFileSync(src, dst);
    bytes += st.size; files++;
  }
}

console.log('\n=== 组装发布目录 ===');
for (const rel of ALLOW) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) { console.log('  · 缺失（跳过）: ' + rel); continue; }
  copy(src, path.join(OUT, path.basename(rel)));
  console.log('  ✓ ' + rel);
}

/* ---- 二次校验：确实没有开发产物溜进去 ---- */
console.log('\n=== 发布包复检 ===');
const leaked = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (FORBIDDEN.test(e.name)) leaked.push(r);
    if (e.isDirectory()) walk(path.join(d, e.name), r);
  }
})(OUT, '');
pre('无开发产物泄漏', leaked.length === 0, leaked.join(', '));
pre('manifest.json 在包根目录', fs.existsSync(path.join(OUT, 'manifest.json')));
pre('index.html 存在', fs.existsSync(path.join(OUT, 'index.html')));
pre('logo.png 存在', fs.existsSync(path.join(OUT, 'logo.png')));
pre('libs/pdfjs/cmaps 完整', fs.existsSync(path.join(OUT, 'libs/pdfjs/cmaps')));
pre('js/ 已包含全部 9 个模块',
  fs.readdirSync(path.join(OUT, 'js')).filter(f => f.endsWith('.js')).length === 9,
  fs.readdirSync(path.join(OUT, 'js')).join(', '));
pre('.index/ 未被带入', !fs.existsSync(path.join(OUT, '.index')));
pre('settings.json 未被带入', !fs.existsSync(path.join(OUT, 'settings.json')));

console.log('\n=== 结果 ===');
console.log('  目录：%s', OUT);
console.log('  文件：%d 个，合计 %s', files, (bytes / 1024 / 1024).toFixed(2) + ' MB');
console.log('\n下一步：把干净副本装进 Eagle 验证');
console.log('  0. ⚠️ Eagle 的「打包插件」打包的是【已安装的那一份】');
console.log('     （~/Library/Application Support/Eagle/Plugins/<id>/），不是本目录。');
console.log('     所以先用干净副本把它替换掉：');
console.log('       ⌘Q 退出 Eagle');
console.log('       P=~/Library/Application\\ Support/Eagle/Plugins/' + mf.id);
console.log('       mv "$P" "$P.old"');
console.log('       cp -R dist/' + mf.id + ' "$P"');
console.log('     再打开 Eagle，确认插件可正常建立索引与检索。');
console.log('  1. 要打包成 .eagleplugin：插件面板（快捷键 P）→ 右键本插件 → 打包插件');
console.log('  2. 打包后解开一份副本核对内容（Eagle 官方建议）：');
console.log('       mkdir _check && cd _check && unzip -q ../<name>.eagleplugin');
console.log('     应只有 manifest.json / index.html / css/ / js/ / libs/ / logo.png（+ LICENSE/README/CHANGELOG）。');
console.log('     官方检查清单：「使用 Eagle 正常打包最终发布版本，不要直接上传开发目录或其他压缩格式。」');

process.exit(fail === 0 ? 0 : 2);
