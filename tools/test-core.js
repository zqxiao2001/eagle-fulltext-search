#!/usr/bin/env node
/* =============================================================================
 * test-core.js —— 本地端到端测试（不依赖 Eagle GUI）
 * 目的：在真实资源库上验证「扫描 → 正文提取 → 分词 → 倒排 → 检索 → 片段」
 *      全链路，特别是 PDF/OOXML 提取与中文 bigram 校验是否正确。
 * 用法：node test-core.js [libraryPath] [indexDir]
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveFixtureLibrary } = require('./paths');

const PLUGIN_DIR = path.resolve(__dirname, '..');
/* 默认跑在自造样本库上（先 npm run fixtures）。
   要拿别的资源库跑：node test-core.js /path/to/xxx.library（或设 FT_LIBRARY）。
   没有可用库时由 resolveFixtureLibrary 给出生成指引，不使用任何隐式默认路径。 */
const LIB = resolveFixtureLibrary(process.argv[2] || process.env.FT_LIBRARY, 'test-core.js');
/* 索引目录默认落在工具目录的 test-index/，**不是**插件目录的 .index/ ——
   否则跑一次冒烟测试就会用样本库索引覆盖掉交付用的真实索引，
   下次在 Eagle 里打开插件会误判「换了资源库」。 */
const INDEX_DIR = process.argv[3] || process.env.FT_INDEX_DIR || path.join(__dirname, 'test-index');

// —— 按依赖顺序加载（同一套代码，Eagle 里走 <script>，这里走 require）——
['config', 'util', 'zip', 'extract', 'tokenizer', 'indexer', 'search'].forEach(m => {
  require(path.join(PLUGIN_DIR, 'js', m + '.js'));
});
FT.config.PLUGIN_DIR = PLUGIN_DIR;

(async () => {
  const t0 = Date.now();

  /* 断言助手。放在最前面：本次运行里「增量与全量等价」也要走断言，
     不能只靠肉眼看打印（早期版本用 console.log 的 %-30s 占位——Node 的
     console.log 只认 %s/%d/%i/%f/%j/%o/%O/%c，不认 printf 的左对齐宽度，
     于是整张表打印成字面量 "%-34s %-14s"，等于没对齐、也没人发现）。 */
  let bad = 0;
  const ok = (label, cond, extra) => {
    console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '   ' + extra : ''));
    if (!cond) bad++;
  };
  /* 中文按 2 列、其余按 1 列算宽度，保证表格在终端里真正对齐 */
  const pad = (s, n) => {
    s = String(s == null ? '' : s);
    let w = 0; for (const c of s) w += c.charCodeAt(0) > 127 ? 2 : 1;
    return s + ' '.repeat(Math.max(0, n - w));
  };

  const indexer = FT.indexer.makeIndexer({
    fs, path, libraryPath: LIB, indexDir: INDEX_DIR,
    opts: Object.assign({}, FT.config.DEFAULTS, { incremental: false }),
    onProgress: p => {
      if (p.phase === 'extract') {
        process.stdout.write('\r  ' + pad('提取 ' + p.done + '/' + p.total, 12) +
          pad((p.current || '').slice(0, 40), 42));
      } else if (p.message) console.log('  [' + p.phase + '] ' + p.message);
    },
    isCancelled: () => false
  });

  console.log('资源库: ' + LIB);
  console.log('索引目录: ' + INDEX_DIR);
  console.log('\n=== 建索引（全量）===');
  const { docs, postings, stats } = await indexer.build();
  console.log('\n  耗时 %dms（提取 %dms）  条目 %d  处理 %d  移除 %d  有正文 %d',
    stats.totalMs, stats.extractMs, stats.total, stats.processed, stats.removed, stats.withText);
  console.log('  提取方式分布:', JSON.stringify(stats.byMethod));
  console.log('  倒排词条数:', stats.terms);
  if (stats.warnings.length) {
    console.log('  警告 %d 条:', stats.warnings.length);
    stats.warnings.slice(0, 10).forEach(w => console.log('    -', w.name, '|', w.warning));
  }

  console.log('\n=== 每个条目的提取结果 ===');
  Object.keys(docs.docs).map(k => docs.docs[k]).sort((a, b) => a.idx - b.idx).forEach(d => {
    console.log('  [' + pad(d.idx, 3) + '] ' + pad((d.name || '').slice(0, 30), 34) +
      pad(d.ext, 6) + pad(d.cLen + ' 字符', 12) + (d.warn ? '⚠ ' + d.warn : (d.method || '')));
  });

  const engine = FT.search.makeEngine({
    docs: docs.docs, postings,
    readText: idx => indexer.readDocText(idx)
  });

  console.log('\n=== 检索测试 ===');
  const queries = process.argv.slice(4);
  const list = queries.length ? queries : ['示例文稿', '示例', 'SampleTerm', 'ext:docx 示例', '"示例页眉文字"'];
  for (const q of list) {
    const r = await engine.search(q, null, { limit: 6 });
    console.log('\n  ▶ 「' + q + '」  模式=' + r.mode + '  命中 ' + r.total + '  用时 ' + r.ms + 'ms  读盘 ' + (r.readCount || 0) + ' 次');
    r.hits.forEach((h, i) => {
      const snip = h.snip ? h.snip.text.replace(/\s+/g, ' ').slice(0, 90) : '(无片段)';
      console.log('    ' + pad((i + 1) + '.', 5) + pad((h.name || '').slice(0, 30), 32) +
        pad(h.ext, 7) + pad('score=' + h.score.toFixed(3), 15) + '[' + h.fields.join(',') + ']');
      console.log('       ' + (h.snip && h.snip.truncatedHead ? '…' : '') + snip);
    });
  }

  console.log('\n=== 增量更新测试（第二次 build 应几乎无操作）===');
  const inc = FT.indexer.makeIndexer({
    fs, path, libraryPath: LIB, indexDir: INDEX_DIR,
    opts: Object.assign({}, FT.config.DEFAULTS, { incremental: true }),
    onProgress: () => { }, isCancelled: () => false
  });
  const r2 = await inc.build();
  console.log('  变更 %d  移除 %d  用时 %dms  倒排词条 %d',
    r2.stats.changed, r2.stats.removed, r2.stats.totalMs, r2.stats.terms);
  /* 核心不变式：增量必须是「零变更 → 结果与全量逐位等价」。
     这里比对三样东西：文档集合（序号→id 映射）、正文长度、倒排词条数。
     任一项不等，说明增量路径漏算或多算 —— 这属于会静默给出错误结果的缺陷。 */
  ok('增量空转（changed=0）', r2.stats.changed === 0 && r2.stats.processed === 0,
    'changed=' + r2.stats.changed + ' processed=' + r2.stats.processed);
  ok('增量后倒排词条数与全量一致', r2.stats.terms === stats.terms,
    '全量=' + stats.terms + ' 增量=' + r2.stats.terms);
  const sig = d => Object.keys(d.docs).sort((a, b) => a - b)
    .map(k => k + ':' + d.docs[k].id + ':' + (d.docs[k].cLen || 0)).join('|');
  ok('增量后文档集合与全量一致（序号→id→正文长度）', sig(r2.docs) === sig(docs),
    '全量 ' + docs.count + ' 条 / 增量 ' + r2.docs.count + ' 条');

  console.log('\n=== 索引契约自检（loadIndex / buildSig）===');
  const normOpts = FT.config.applyProfile(Object.assign({}, FT.config.DEFAULTS), 'normal');
  const mk = (lib, dir, opts) => FT.indexer.makeIndexer({
    fs, path, libraryPath: lib, indexDir: dir, opts, onProgress: () => { }, isCancelled: () => false
  });

  // 不变式：DEFAULTS 必须就等于「默认档位应用后的结果」。
  // 否则「档位改了一个数、DEFAULTS 忘了改」会让预建索引（走 DEFAULTS）与插件启动
  // （走 profile 派生）指纹不一致，一开插件就提示重建——2026-10 首版就踩过这个坑。
  ok('DEFAULTS 与默认档位一致（单一真源）',
    FT.config.buildSignature(FT.config.DEFAULTS) === FT.config.buildSignature(normOpts),
    'DEFAULTS=' + FT.config.buildSignature(FT.config.DEFAULTS) + '  profile=' + FT.config.buildSignature(normOpts));

  // 两档必须真的不同，否则设置面板形同虚设
  ok('两个档位的容量确有区分',
    FT.config.PROFILES.long.maxCharsPerDoc > FT.config.PROFILES.normal.maxCharsPerDoc,
    'normal=' + FT.config.PROFILES.normal.maxCharsPerDoc + '  long=' + FT.config.PROFILES.long.maxCharsPerDoc);

  // 默认档必须能完整吃下本库最大的那篇文档，否则「默认档会在真实数据上截断」
  const probeNorm = mk(LIB, INDEX_DIR, normOpts);
  const r1 = probeNorm.loadIndex();
  ok('默认档位下索引可载入', !!r1.index, r1.reason ? 'reason=' + r1.reason : 'docs=' + r1.index.docs.count);
  ok('docs.buildSig 已落盘', !!r1.index && !!r1.index.docs.buildSig, r1.index ? String(r1.index.docs.buildSig) : '—');
  if (r1.index) {
    const maxCLen = Object.keys(r1.index.docs.docs)
      .reduce((m, k) => Math.max(m, r1.index.docs.docs[k].cLen || 0), 0);
    ok('默认档不截断本库最长文档', maxCLen <= FT.config.PROFILES.normal.maxCharsPerDoc,
      '最长正文 ' + maxCLen + ' 字符 / 上限 ' + FT.config.PROFILES.normal.maxCharsPerDoc);
  }

  // 换成 long 档 → 指纹不符 → 必须拒绝沿用旧索引并给出 settings 原因
  //（否则「按小范围建的索引」会被当成覆盖全库的索引，长文档搜不到会误判为数据问题）
  const r2b = mk(LIB, INDEX_DIR, FT.config.applyProfile(Object.assign({}, FT.config.DEFAULTS), 'long')).loadIndex();
  ok('切换档位后拒绝沿用旧索引', !r2b.index && r2b.reason === 'settings',
    'reason=' + r2b.reason + (r2b.detail ? '  旧指纹=' + r2b.detail : ''));

  // 资源库路径不同 → reason=library
  const r3 = mk(LIB + '-does-not-exist', INDEX_DIR, normOpts).loadIndex();
  ok('换了资源库 → reason=library', !r3.index && r3.reason === 'library', 'reason=' + r3.reason);

  // 空索引目录 → reason=no-index
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-idx-'));
  const r4 = mk(LIB, emptyDir, normOpts).loadIndex();
  ok('无索引 → reason=no-index', !r4.index && r4.reason === 'no-index', 'reason=' + r4.reason);
  fs.rmSync(emptyDir, { recursive: true, force: true });

  console.log('\n=== 索引体积 ===');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => {
    const p = path.join(d, e.name);
    return s + (e.isDirectory() ? walk(p) : fs.statSync(p).size);
  }, 0);
  console.log('  ' + INDEX_DIR + ' 合计 ' + FT.util.formatBytes(walk(INDEX_DIR)));
  console.log('\n' + (bad === 0 ? '🎉 全部检查通过（增量等价 3 项 + 索引契约 8 项）'
    : '⚠️  ' + bad + ' 项失败'));
  console.log('总用时 %dms', Date.now() - t0);
  process.exit(bad === 0 ? 0 : 2);
})().catch(e => { console.error('测试失败:', e); process.exit(1); });
