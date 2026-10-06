/* =============================================================================
 * indexer.js —— 索引构建引擎（扫描 / 增量 / 落盘）
 * -----------------------------------------------------------------------------
 * 数据来源决策：
 *   Eagle 官方 API（eagle.item.get 等）与直接读取资源库文件（images/<ID>.info/
 *   metadata.json）两条路都能拿到元数据。本插件默认走「直接读取」：
 *     · 20 万条目时官方 API 需要数万次 IPC 往返，插件窗口会长时间无响应；
 *     · 磁盘读取是一趟线性 IO，且能顺便拿到真实文件名（Eagle 的 name 字段与
 *       磁盘文件名可能不一致），正文提取本来就要读文件。
 *   官方文档只禁止「写入」资源库目录，读取是安全的；本插件对资源库
 *   严格只读（唯一写入位置是插件目录下的 .index/）。
 *
 * 索引落盘结构（.index/，全部 gzip）：
 *   docs.json.gz      文档元数据 + id→序号映射（序号在 postings 中代替字符串 id）
 *   postings.json.gz  倒排表 { term: [[docIdx, fieldMask, tf], ...] }
 *   text/<idx>.txt.gz 每篇正文（供片段生成与短语校验；按需读，不常驻内存）
 *   settings.json     用户设置
 *
 * 增量策略：
 *   Eagle 资源库自带 mtime.json（id → 最后修改时间）。用它对比 docs.json.gz 里
 *   记录的 mtime，只重新解析变化的条目；删除的条目连带其倒排项一起摘除。
 *   未变化条目的倒排项原样保留，因此增量更新与全量结果等价，但只做少量工作。
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});

  function makeIndexer(env) {
    var fs = env.fs, path = env.path;
    var libraryPath = env.libraryPath;
    var indexDir = env.indexDir;
    var textDir = path.join(indexDir, 'text');
    var opts = Object.assign({}, FT.config.DEFAULTS, env.opts || {});
    var C = FT.config;

    /* Buffer 统一从 util 取（Eagle 里是全局，测试宿主可能只有 require('buffer')）；
       取不到时 util.toBuffer 会显式抛错，绝不静默写出乱码索引。 */
    function toUtf8Buffer(str) { return FT.util.toBuffer(str, 'utf8'); }

    function ensureDirs() {
      [indexDir, textDir].forEach(function (d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    }
    function report(p) { if (env.onProgress) env.onProgress(p); }
    function cancelled() { return env.isCancelled && env.isCancelled(); }

    /* -------------------------------------------------------------------------
     * 1. 扫描资源库：返回 [{id, meta, filePath, relPath, mtime, ext, payloadSize}]
     * ---------------------------------------------------------------------- */
    function scanLibrary() {
      var imagesDir = path.join(libraryPath, 'images');
      if (!fs.existsSync(imagesDir)) throw new Error('资源库 images 目录不存在：' + imagesDir);
      var names = fs.readdirSync(imagesDir);
      var out = [];
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (!/\.info$/.test(n)) continue;
        var id = n.replace(/\.info$/, '');
        var dir = path.join(imagesDir, n);
        var metaFile = path.join(dir, 'metadata.json');
        if (!fs.existsSync(metaFile)) continue;
        var raw;
        try { raw = fs.readFileSync(metaFile, 'utf8'); } catch (e) { continue; }
        var meta;
        try { meta = JSON.parse(raw); } catch (e) { continue; }
        if (meta.isDeleted && !opts.includeTrashed) continue;

        // 真实载荷文件：排除 metadata.json 与缩略图
        var files = fs.readdirSync(dir);
        var payload = null;
        for (var j = 0; j < files.length; j++) {
          var f = files[j];
          if (f === 'metadata.json' || /_thumbnail\.[a-z0-9]+$/i.test(f)) continue;
          payload = f; break;
        }
        if (!payload) continue;
        var ext = (path.extname(payload).replace('.', '') || meta.ext || '').toLowerCase();
        var st = null;
        try { st = fs.statSync(path.join(dir, payload)); } catch (e) { st = null; }

        out.push({
          id: id,
          meta: meta,
          ext: ext,
          fileName: payload,
          relPath: path.join('images', n, payload),
          filePath: path.join(dir, payload),
          mtime: st ? Math.round(st.mtimeMs) : (meta.modificationTime || meta.mtime || 0),
          size: st ? st.size : (meta.size || 0)
        });
      }
      return out;
    }

    /* 文件夹 id → 名称（library/metadata.json），用于「文件夹」字段检索 */
    function readFolderMap() {
      var map = Object.create(null);
      try {
        var p = path.join(libraryPath, 'metadata.json');
        if (fs.existsSync(p)) {
          var d = JSON.parse(fs.readFileSync(p, 'utf8'));
          (d.folders || []).forEach(function (f) { map[f.id] = f.name; });
        }
      } catch (e) { /* 忽略：无文件夹信息不影响检索 */ }
      return map;
    }

    /* -------------------------------------------------------------------------
     * 2. 载入 / 保存索引
     * ---------------------------------------------------------------------- */
    function gzWrite(file, obj) {
      var zlib = require('zlib');
      var tmp = file + '.tmp';
      fs.writeFileSync(tmp, zlib.gzipSync(toUtf8Buffer(JSON.stringify(obj)), { level: 6 }));
      fs.renameSync(tmp, file);         // 原子替换，避免中途崩溃产生半截索引
    }
    function gzRead(file) {
      if (!fs.existsSync(file)) return null;
      try {
        var zlib = require('zlib');
        return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
      } catch (e) { return null; }
    }
    function writeDocText(idx, text) {
      var zlib = require('zlib');
      fs.writeFileSync(path.join(textDir, idx + '.txt.gz'),
        zlib.gzipSync(toUtf8Buffer(text), { level: 4 }));
    }
    function readDocText(idx) {
      var f = path.join(textDir, idx + '.txt.gz');
      if (!fs.existsSync(f)) return '';
      try {
        var zlib = require('zlib');
        return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');
      } catch (e) { return ''; }
    }

    /**
     * 载入磁盘索引并校验可用性
     * @returns {{index:{docs,post}}|{reason:string, detail?:string}}
     *   reason 取值：no-index（还没建过）/ version（索引结构版本不符）
     *                library（资源库路径变了）/ broken（索引文件损坏）
     *                settings（索引范围被改过，覆盖范围与当前设置不符）
     */
    function loadIndex() {
      var docs = gzRead(path.join(indexDir, 'docs.json.gz'));
      if (!docs) return { reason: 'no-index' };
      if (docs.version !== C.INDEX_VERSION) return { reason: 'version', detail: 'v' + docs.version + ' → v' + C.INDEX_VERSION };
      if (docs.libraryPath !== libraryPath) return { reason: 'library', detail: docs.libraryPath };
      var post = gzRead(path.join(indexDir, 'postings.json.gz'));
      if (!post) return { reason: 'broken' };
      if (docs.buildSig && docs.buildSig !== C.buildSignature(opts)) return { reason: 'settings', detail: docs.buildSig };
      return { index: { docs: docs, post: post } };
    }

    /* -------------------------------------------------------------------------
     * 3. 文档 → 倒排：分别对每个字段分词，合并为 {term: [mask, tf]}
     * ---------------------------------------------------------------------- */
    function buildDocTerms(item, folderMap, content) {
      var M = C.MASK, T = FT.tokenizer;
      var fields = {
        name: item.meta.name || '',
        annotation: item.meta.annotation || '',
        tags: (item.meta.tags || []).join(' '),
        folders: (item.meta.folders || []).map(function (f) { return folderMap[f] || f; }).join(' '),
        url: item.meta.url || '',
        content: content || ''
      };
      var agg = Object.create(null);
      var lens = {};
      for (var f in fields) {
        var r = T.tokenize(fields[f]);
        lens[f] = fields[f].length;
        r.terms.forEach(function (tf, term) {
          var e = agg[term];
          if (!e) { e = agg[term] = [0, 0]; }
          e[0] |= M[f];
          e[1] += tf;
        });
      }
      return { terms: agg, lens: lens };
    }

    /** 把某文档的倒排项加入 postings（docIdx 为单位） */
    function addToPostings(postings, docIdx, terms) {
      for (var term in terms) {
        var e = terms[term];
        var arr = postings[term];
        if (!arr) arr = postings[term] = [];
        arr.push([docIdx, e[0], e[1]]);
      }
    }
    /** 从 postings 中摘除某文档（增量更新 / 删除时使用） */
    function removeFromPostings(postings, docIdx, terms) {
      for (var term in terms) {
        var arr = postings[term];
        if (!arr) continue;
        var kept = [];
        for (var i = 0; i < arr.length; i++) if (arr[i][0] !== docIdx) kept.push(arr[i]);
        if (kept.length) postings[term] = kept; else delete postings[term];
      }
    }

    /* -------------------------------------------------------------------------
     * 4. 主流程
     * ---------------------------------------------------------------------- */
    async function build() {
      ensureDirs();
      var t0 = Date.now();
      report({ phase: 'scan', message: '扫描资源库…' });
      var items = scanLibrary();
      var folderMap = readFolderMap();
      report({ phase: 'scan', message: '资源库共 ' + items.length + ' 个条目', total: items.length });

      /* loadIndex() 返回 {index} 或 {reason}：只有拿到 index 才谈得上增量。
         没拿到（首次建 / 版本不符 / 换了库 / 索引损坏 / 索引范围被改过）一律从头建，
         这样「改了索引范围但重建中断」不会沿用覆盖范围不足的旧索引。 */
      var loadRes = (opts.incremental && !env.forceRebuild) ? loadIndex() : null;
      var prev = (loadRes && loadRes.index) ? loadRes.index : null;
      var docs, postings;

      if (prev) {
        docs = prev.docs;
        postings = prev.post.terms;
      } else {
        docs = { version: C.INDEX_VERSION, libraryPath: libraryPath, builtAt: Date.now(), nextIdx: 0, idMap: {}, docs: {} };
        postings = {};
      }
      /* ---- 找出变化项与删除项 ---- */
      var seen = Object.create(null);
      var toProcess = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        seen[it.id] = 1;
        var idx = docs.idMap[it.id];
        var old = idx != null ? docs.docs[idx] : null;
        // 判定变化：新条目 / mtime 变化 / 扩展名或大小变化
        if (!old || old.mtime !== it.mtime || old.ext !== it.ext || old.size !== it.size) {
          toProcess.push({ item: it, idx: idx });
        }
      }
      var toDelete = [];
      for (var id in docs.idMap) {
        if (!seen[id]) toDelete.push(docs.idMap[id]);
      }

      report({
        phase: 'plan',
        message: '需处理 ' + toProcess.length + ' 个新增/变更条目，' + toDelete.length + ' 个已移除',
        total: toProcess.length
      });

      /* ---- 删除项：先摘倒排（需要旧正文重算词表）再删文档 ---- */
      for (var d = 0; d < toDelete.length; d++) {
        var didx = toDelete[d];
        var dold = docs.docs[didx];
        if (dold) {
          var oldText = readDocText(didx);
          var oldTerms = buildDocTerms({ meta: dold }, folderMap, oldText);
          removeFromPostings(postings, didx, oldTerms.terms);
          try { fs.unlinkSync(path.join(textDir, didx + '.txt.gz')); } catch (e) { /* 忽略 */ }
        }
        delete docs.docs[didx];
        // idMap 由 id 反查，逐个删除
        for (var k in docs.idMap) if (docs.idMap[k] === didx) delete docs.idMap[k];
      }

      /* ---- 逐条处理：提取正文 → 分词 → 更新倒排 ---- */
      var stats = { total: items.length, processed: 0, changed: toProcess.length, removed: toDelete.length, withText: 0, byMethod: {}, warnings: [] };
      var t1 = Date.now();

      for (var p = 0; p < toProcess.length; p++) {
        if (cancelled()) { var err = new Error('已取消'); err.cancelled = true; throw err; }
        var task = toProcess[p], item = task.item, useIdx = task.idx;
        if (useIdx == null) { useIdx = docs.nextIdx++; docs.idMap[item.id] = useIdx; }

        // 旧版本先摘除（变更条目的倒排需要重算）
        var prevDoc = docs.docs[useIdx];
        if (prevDoc) {
          var pText = readDocText(useIdx);
          removeFromPostings(postings, useIdx, buildDocTerms({ meta: prevDoc }, folderMap, pText).terms);
        }

        var content = '', method = 'skip', warning = '';
        if (item.size <= opts.maxFileSize) {
          try {
            var buffer = fs.readFileSync(item.filePath);
            var r = await FT.extract.extract({
              buffer: buffer, ext: item.ext, filePath: item.filePath,
              opts: { maxChars: opts.maxCharsPerDoc }
            });
            content = r.text || '';
            method = r.method;
            warning = r.warning || '';
          } catch (e) {
            warning = '读取失败：' + (e && e.message ? e.message : e);
          }
        } else {
          warning = '文件超过 ' + FT.util.formatBytes(opts.maxFileSize) + '，仅索引元数据';
        }
        stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
        if (content) stats.withText++;
        if (warning) stats.warnings.push({ id: item.id, name: item.meta.name || item.fileName, warning: warning });

        writeDocText(useIdx, content);

        var docMeta = {
          id: item.id,
          idx: useIdx,
          name: item.meta.name || item.fileName,
          fileName: item.fileName,
          ext: item.ext,
          rel: item.relPath,
          tags: item.meta.tags || [],
          folders: (item.meta.folders || []).map(function (f) { return folderMap[f] || f; }),
          folderIds: item.meta.folders || [],
          star: item.meta.star || 0,
          url: item.meta.url || '',
          annotation: item.meta.annotation || '',
          mtime: item.mtime,
          addedAt: item.meta.btime || item.meta.mtime || 0,
          size: item.size,
          method: method,
          warn: warning,
          cLen: content.length
        };
        var built = buildDocTerms(item, folderMap, content);
        docMeta.len = built.lens;
        docs.docs[useIdx] = docMeta;
        addToPostings(postings, useIdx, built.terms);

        stats.processed++;
        if (p % 5 === 0 || p === toProcess.length - 1) {
          report({
            phase: 'extract', done: p + 1, total: toProcess.length,
            current: docMeta.name + '.' + docMeta.ext,
            withText: stats.withText, byMethod: stats.byMethod
          });
          await FT.util.tick();
        }
      }

      /* ---- 落盘 ---- */
      report({ phase: 'save', message: '写入索引…' });
      docs.builtAt = Date.now();
      docs.count = Object.keys(docs.docs).length;
      /* docs.stats 描述的是「整个索引」，不是「本轮增量」。
         早先直接写 stats.withText / stats.byMethod（本轮计数），增量空转时会把
         上次的统计抹成 0，导致概览面板的「抽取方式」整行消失。这里按最终文档集重算。 */
      var agg = { withText: 0, byMethod: {} };
      for (var dk in docs.docs) {
        var dd = docs.docs[dk];
        if (dd.cLen) agg.withText++;
        if (dd.method) agg.byMethod[dd.method] = (agg.byMethod[dd.method] || 0) + 1;
      }
      docs.stats = agg;
      // 记录本次索引所依据的范围参数；下次加载时比对，不一致就重建（见 loadIndex）
      docs.buildSig = C.buildSignature(opts);
      gzWrite(path.join(indexDir, 'docs.json.gz'), docs);
      gzWrite(path.join(indexDir, 'postings.json.gz'), { terms: postings });

      var summary = {
        total: stats.total, changed: stats.changed, removed: stats.removed,
        processed: stats.processed, withText: stats.withText,
        terms: Object.keys(postings).length,
        byMethod: stats.byMethod,
        extractMs: Date.now() - t1,
        totalMs: Date.now() - t0,
        warnings: stats.warnings.slice(0, 200)
      };
      report({ phase: 'done', summary: summary });
      return { docs: docs, postings: postings, stats: summary };
    }

    return {
      build: build,
      loadIndex: loadIndex,
      readDocText: readDocText,
      scanLibrary: scanLibrary,
      indexDir: indexDir
    };
  }

  FT.indexer = { makeIndexer: makeIndexer };
})(typeof window !== 'undefined' ? window : globalThis);
