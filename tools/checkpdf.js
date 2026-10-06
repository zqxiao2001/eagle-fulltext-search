#!/usr/bin/env node
/* =============================================================================
 * checkpdf.js —— 抽查 PDF 正文抽取质量（中文字符占比 / 乱码计数 / 正文预览）
 * 默认针对 testlib 里的中文 CMap 样本；也可以指定任意 PDF 文件或资源库目录。
 * 用法：
 *   node checkpdf.js                      # 用 testlib 的 cjk-sample.pdf
 *   node checkpdf.js <某个.pdf>            # 指定单个 PDF
 *   node checkpdf.js <资源库目录>           # 取该库里第一个 PDF
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path');
const P = path.resolve(__dirname, '..');
['config', 'util', 'zip', 'extract', 'tokenizer', 'indexer', 'search'].forEach(m =>
  require(path.join(P, 'js', m + '.js')));
FT.config.PLUGIN_DIR = P;

/** 找到要检查的 PDF：显式传入的文件 / 传入的资源库里的第一个 PDF / testlib 样本 */
function resolvePdf(arg) {
  if (arg && fs.existsSync(arg) && fs.statSync(arg).isFile()) return arg;
  const lib = arg || path.join(__dirname, 'testlib');
  const imagesDir = path.join(lib, 'images');
  if (!fs.existsSync(imagesDir)) return null;
  for (const n of fs.readdirSync(imagesDir)) {
    if (!/\.info$/.test(n)) continue;
    const dir = path.join(imagesDir, n);
    for (const f of fs.readdirSync(dir)) {
      if (/\.pdf$/i.test(f)) return path.join(dir, f);
    }
  }
  return null;
}

(async () => {
  const file = resolvePdf(process.argv[2]);
  if (!file) {
    console.error('找不到 PDF。请先运行 python make-fixtures.py && python make-cjk-pdf.py，或显式传入 PDF 路径。');
    process.exit(1);
  }
  console.log('PDF:', file, FT.util.formatBytes(fs.statSync(file).size));

  const t0 = Date.now();
  const r = await FT.extract.extract({
    buffer: fs.readFileSync(file), ext: 'pdf', filePath: file, opts: { maxChars: 200000 }
  });
  console.log('提取耗时', Date.now() - t0, 'ms  method=', r.method,
    ' warning=', r.warning || '(无)', ' 字符数=', r.text.length);

  console.log('--- 开头 300 字 ---');
  console.log(r.text.slice(0, 300));
  console.log('--- 中部 300 字 ---');
  const m = Math.floor(r.text.length / 2);
  console.log(r.text.slice(m, m + 300));

  const cjk = (r.text.match(/[\u4e00-\u9fff]/g) || []).length;
  const bad = (r.text.match(/\uFFFD/g) || []).length;
  console.log('--- 中文字符 ' + cjk + ' 个，乱码字符 ' + bad + ' 个，中文占比 ' +
    (100 * cjk / Math.max(1, r.text.length)).toFixed(1) + '% ---');
  if (bad > 0) {
    console.log('⚠️ 存在乱码字符：通常意味着 CMap 没加载成功（检查 libs/pdfjs/cmaps 是否完整）。');
    process.exitCode = 2;
  }
})();
