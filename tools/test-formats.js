#!/usr/bin/env node
/* =============================================================================
 * test-formats.js —— 各格式正文提取 + 检索正确性验证（针对自造测试库）
 * 覆盖：docx / pptx / xlsx / odt / epub / rtf(GBK) / csv(UTF8) / csv(GBK) /
 *       md / py / html —— 检查是否「该抽到的都抽到、不该抽的没抽到」
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveFixtureLibrary } = require('./paths');

const PLUGIN_DIR = path.resolve(__dirname, '..');
/* 中性样本库是生成物、未入库；缺库时给出可执行的指引而不是 ENOENT 堆栈 */
const LIB = resolveFixtureLibrary(process.env.FT_LIBRARY, 'test-formats.js');
const INDEX_DIR = path.join(__dirname, 'test-index');

['config', 'util', 'zip', 'extract', 'tokenizer', 'indexer', 'search'].forEach(m =>
  require(path.join(PLUGIN_DIR, 'js', m + '.js')));
FT.config.PLUGIN_DIR = PLUGIN_DIR;

const pad = (s, n) => { s = String(s == null ? '' : s); let w = 0; for (const c of s) w += c.charCodeAt(0) > 127 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };

(async () => {
  fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  const indexer = FT.indexer.makeIndexer({
    fs, path, libraryPath: LIB, indexDir: INDEX_DIR,
    opts: Object.assign({}, FT.config.DEFAULTS, { incremental: false }),
    onProgress: () => { }, isCancelled: () => false
  });
  const { docs, postings } = await indexer.build();

  let fail = 0;
  const check = (label, cond, extra) => {
    console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
    if (!cond) fail++;
  };

  console.log('\n=== 1. 正文提取结果 ===');
  const list = Object.keys(docs.docs).map(k => docs.docs[k]).sort((a, b) => a.idx - b.idx);
  for (const d of list) {
    const txt = indexer.readDocText(d.idx);
    const preview = txt.replace(/\s+/g, ' ').slice(0, 110);
    console.log(`\n  [${d.ext}] ${d.name}   ${d.cLen} 字符   method=${d.method}${d.warn ? '  ⚠ ' + d.warn : ''}`);
    console.log(`     ${preview || '(空)'}`);
  }

  console.log('\n=== 2. 关键内容断言 ===');
  const textOf = ext => list.filter(d => d.ext === ext).map(d => indexer.readDocText(d.idx)).join('\n');
  const docx = textOf('docx'), pptx = textOf('pptx'), xlsx = textOf('xlsx'), odt = textOf('odt'),
    epub = textOf('epub'), rtf = textOf('rtf'), html = textOf('html'), csv = textOf('csv');

  check('docx 正文（中文段落）', docx.includes('中文示例段落'), '');
  check('docx 正文（拉丁术语）', docx.includes('SampleTerm'), '');
  check('docx 页眉文字', docx.includes('示例页眉文字'), '');
  check('docx 文档属性 title', docx.includes('示例文稿标题'), '');
  check('docx 无 XML 残留标签', !/<w:|<\/w:/.test(docx), '');
  check('pptx 幻灯片文字', pptx.includes('示例演示文稿标题') && pptx.includes('幻灯片正文条目乙'), '');
  check('pptx 备注页文字', pptx.includes('讲稿备注'), '');
  check('xlsx 共享字符串还原', xlsx.includes('甲类条目') && xlsx.includes('丙类条目'), '');
  check('xlsx 数值单元格', xlsx.includes('128') && xlsx.includes('402'), '');
  check('xlsx 工作表名', xlsx.includes('示例工作表'), '');
  check('odt 正文', odt.includes('ODT 格式的示例段落'), '');
  check('odt 数值', odt.includes('3.14'), '');
  check('epub 章节', epub.includes('示例章节甲') && epub.includes('示例章节乙'), '');
  check('epub 无 style 污染', !epub.includes('color:red'), '');
  check('rtf GBK 中文还原', rtf.includes('示例中文内容测试'), '');
  check('rtf 拉丁内容', rtf.includes('sample rtf report'), '');
  check('rtf 无控制字残留', !/\\[a-z]+/.test(rtf), '');
  // {\fonttbl} 是普通组（不是 {\*\...} 目标组），只删后者会让字体名漏进正文污染检索结果；
  // 且整篇文档本身就是一个大组，摘除时必须递归。
  check('rtf 字体表未混入正文', !rtf.includes('SimSun') && !/fcharset|fonttbl/.test(rtf), '');
  check('csv UTF-8 中文', csv.includes('编号') && csv.includes('分组'), '');
  check('csv GBK 中文还原', csv.includes('名称') && csv.includes('示例甲'), '');
  check('csv GBK 数值', csv.includes('-1.8'), '');
  check('html 正文保留', html.includes('示例页面标题') && html.includes('示例正文段落'), '');
  check('html script 内容已剔除', !html.includes('不应被索引的脚本内容'), '');
  check('html style 内容已剔除', !html.includes('color:#111'), '');

  console.log('\n=== 3. 检索断言 ===');
  const engine = FT.search.makeEngine({
    docs: docs.docs, postings, readText: idx => indexer.readDocText(idx)
  });
  async function expectHits(q, shouldHitNames, opt) {
    const r = await engine.search(q, null, Object.assign({ limit: 10 }, opt || {}));
    const names = r.hits.map(h => h.name);
    console.log(`\n  ▶ 「${q}」 mode=${r.mode} 命中=${r.total} ${r.ms}ms`);
    r.hits.slice(0, 5).forEach((h, i) => {
      const s = h.snip ? h.snip.text.replace(/\s+/g, ' ').slice(0, 80) : '';
      console.log(`     ${i + 1}. ${pad(h.name, 30)} ${pad(h.ext, 6)} [${h.fields.join('/')}] score=${h.score.toFixed(2)}`);
      console.log(`        ${s}`);
    });
    for (const want of shouldHitNames) {
      check(`「${q}」应召回「${want}」`, names.some(n => n.includes(want)), '实际: ' + names.join(' | '));
    }
    return r;
  }
  await expectHits('示例文稿', ['示例文稿']);
  await expectHits('"中文示例段落"', ['示例文稿']);          // 短语在正文中连续出现
  await expectHits('SampleTerm', ['示例文稿']);
  await expectHits('甲类条目', ['示例计数表']);
  await expectHits('示例章节乙', ['示例电子书']);
  await expectHits('type:word 示例页眉文字', ['示例文稿']);
  await expectHits('tag:表格', ['示例计数表', 'GBK 编码表格']);
  await expectHits('讲稿备注', ['示例演示文稿']);
  await expectHits('"示例页面标题"', ['HTML 示例页']);
  await expectHits('示例中文内容测试', ['GBK 编码 RTF 报告']);

  // 负向断言：短语不存在时应为 0（验证逐字校验真的生效）
  const r1 = await engine.search('"示例页眉文字页码"', null, { limit: 10 });
  check('不存在的短语应 0 命中（逐字校验生效）', r1.total === 0 && r1.hits.length === 0,
    `total=${r1.total} hits=${r1.hits.length} 候选=${r1.candidateCount}`);
  const r3 = await engine.search('示例文稿', null, { limit: 10 });
  check('total 与 hits 数量一致（不误导）', r3.total === r3.hits.length, `total=${r3.total} hits=${r3.hits.length}`);
  const r2 = await engine.search('示例 -文稿', null, { limit: 10 });
  check('排除词生效', r2.hits.length > 0 && !r2.hits.some(h => h.name.includes('文稿')),
    '实际: ' + r2.hits.map(h => h.name).join('|'));

  console.log('\n=== 4. 统计 ===');
  console.log('  倒排词条 %d，索引体积 %s',
    Object.keys(postings).length,
    FT.util.formatBytes(fs.readdirSync(path.join(INDEX_DIR, 'text')).length * 100 +
      fs.statSync(path.join(INDEX_DIR, 'docs.json.gz')).size +
      fs.statSync(path.join(INDEX_DIR, 'postings.json.gz')).size));

  console.log('\n' + (fail === 0 ? '🎉 全部断言通过' : `⚠️  ${fail} 项断言失败`));
  process.exit(fail === 0 ? 0 : 2);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
