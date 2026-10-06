#!/usr/bin/env node
/* =============================================================================
 * build-index.js —— 用「出厂默认设置」为真实 Eagle 资源库预建索引
 * 说明：预建索引让用户点开插件即可检索（不必等首次建索引）。
 *      若资源库路径与索引记录不一致，插件启动时会自动丢弃并提示重建，因此
 *      预建索引在任何情况下都不会产生错误结果，只影响「是否开箱即用」。
 * 用法：node build-index.js [libraryPath] [normal|long]
 *   normal（默认）—— 单篇上限 10 万字符 / 64MB
 *   long          —— 单篇上限 400 万字符 / 256MB（书籍、长篇稿）
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const PLUGIN = path.resolve(__dirname, '..');
const LIB = process.argv[2] || path.join(os.homedir(), 'Pictures', 'eagle.library');
/* 这个工具是给「真实资源库」用的，默认值只是常见路径的猜测；猜错了要给指引，不要抛堆栈。 */
if (!fs.existsSync(path.join(LIB, 'images'))) {
  console.error('\n✗ 找不到 Eagle 资源库：' + LIB);
  console.error('  把资源库路径作为参数传进来：');
  console.error('      node tools/build-index.js /path/to/xxx.library\n');
  process.exit(3);
}

['config', 'util', 'zip', 'extract', 'tokenizer', 'indexer', 'search'].forEach(m =>
  require(path.join(PLUGIN, 'js', m + '.js')));
FT.config.PLUGIN_DIR = PLUGIN;

/* 用出厂默认档位（普通文件）预建索引。这里显式走 applyProfile 而不是直接吃 DEFAULTS，
   是为了保证预建索引的 buildSig 与插件首次启动时的 buildSig 完全一致 —— 否则插件
   会判定「索引范围不符」而要求重建，预建就白做了。 */
const PRESET = process.argv[3] || FT.config.DEFAULTS.profile;
const OPTS = FT.config.applyProfile(Object.assign({}, FT.config.DEFAULTS), PRESET);

(async () => {
  const indexer = FT.indexer.makeIndexer({
    fs, path, libraryPath: LIB, indexDir: path.join(PLUGIN, '.index'),
    opts: OPTS,
    onProgress: p => {
      if (p.phase === 'extract' && p.total) {
        process.stdout.write('\r  提取 ' + (p.done || 0) + '/' + p.total + '  ' + String(p.current || '').slice(0, 40).padEnd(42));
      } else if (p.message) process.stdout.write('\r  [' + p.phase + '] ' + p.message.padEnd(60) + '\n');
    },
    isCancelled: () => false
  });
  const res = await indexer.build();
  const s = res.stats, d = res.docs;
  console.log('\n  条目 %d｜本轮处理 %d｜本轮含正文 %d｜倒排 %d 词｜解析 %dms｜总 %dms',
    d.count, s.processed, s.withText, s.terms, s.extractMs, s.totalMs);
  console.log('  整索引：含正文 %d 篇｜档位 %s｜指纹 %s',
    d.stats.withText, PRESET, d.buildSig);
  console.log('  抽取方式:', JSON.stringify(d.stats.byMethod));
  if (s.warnings.length) {
    console.log('  提取提示:', s.warnings.length, '条');
    s.warnings.slice(0, 5).forEach(w => console.log('    -', w.name, '|', w.warning));
  }
  let bytes = 0;
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size;
  });
  walk(path.join(PLUGIN, '.index'));
  console.log('  索引体积: %s', FT.util.formatBytes(bytes));
})().catch(e => { console.error('建索引失败:', e); process.exit(1); });
