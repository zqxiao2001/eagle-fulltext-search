/* =============================================================================
 * app.js —— 界面控制器
 * -----------------------------------------------------------------------------
 * 结构：
 *   状态 → boot() → {载入索引 | 空状态} → 检索/浏览 → 渲染
 * 关键设计：
 *   1. 检索带「请求序号」防竞态：快速输入时旧结果不会覆盖新结果。
 *   2. 结果行用 innerHTML 批量渲染 + content-visibility 跳绘；所有文本经
 *      FT.util.escapeHtml / highlightHtml 处理，片段高亮先切分后转义，避免注入与错位。
 *   3. 任何一步失败都不让窗口「死」掉：捕获异常 → 状态栏提示，并保证标题栏
 *      的关闭按钮始终可用。
 * ========================================================================== */
(function () {
  'use strict';
  var FT = root0();
  function root0() { return (typeof window !== 'undefined' ? window : globalThis).FT; }
  var U = FT.util, C = FT.config, EA = FT.eagle;

  // Node 集成在 Eagle 渲染进程中必然存在；此处仍做存在性判断，避免有人把
  // index.html 直接丢进普通浏览器打开时因 require 未定义而整页脚本崩掉（此时
  // 至少保留静态外壳与说明，而不是白屏）。
  var hasNode = (typeof require === 'function');
  var path = hasNode ? require('path') : null;
  var fs = hasNode ? require('fs') : null;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    pluginPath: null,
    libraryPath: null,
    indexDir: null,
    settings: Object.assign({}, C.DEFAULTS),
    indexer: null,
    engine: null,
    stats: null,
    builtAt: 0,
    indexBytes: 0,
    warnings: [],
    hits: [],
    total: 0,
    sel: -1,
    query: '',
    filters: { groups: [], tags: [], folders: [], starMin: 0 },
    sort: 'relevance',
    searchSeq: 0,
    searching: false,
    building: false,
    cancelFlag: false,
    lastMeta: null,
    docIndex: null,
    indexerStats: null,
    // 磁盘索引不可用的原因（no-index / version / library / broken / settings），用于首屏给出针对性提示
    indexMismatch: null
  };

  /* 设置弹层里「已点选、尚未保存」的索引范围预设。 */
  var pendingProfile = null;

  /* ==========================================================================
   * 工具
   * ======================================================================== */
  function fileUrl(p) {
    return 'file://' + encodeURI(String(p)).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }
  function num(n) { return (n == null ? 0 : n).toLocaleString('zh-CN'); }
  function pct(a, b) { return b ? Math.round(100 * a / b) + '%' : '0%'; }
  function toast(msg) { $('sbLeft').innerHTML = msg; }

  /** 缩略图路径：Eagle 会为条目生成 <原名>_thumbnail.png（个别为 .jpg） */
  function thumbPaths(doc) {
    var base = path.join(state.libraryPath, 'images', doc.id + '.info',
      doc.fileName.replace(/\.[^.]+$/, '') + '_thumbnail');
    return [fileUrl(base + '.png'), fileUrl(base + '.jpg')];
  }

  /* ==========================================================================
   * 主题
   * ======================================================================== */
  function applyTheme(theme) {
    var mode = EA.themeMode(theme);
    document.documentElement.setAttribute('data-theme', mode);
    EA.setBackgroundColor(mode === 'dark' ? '#1B1B1D' : '#F7F7F5');
  }

  /* ==========================================================================
   * 索引：载入 / 构建
   * ======================================================================== */
  function makeIndexer(force) {
    return FT.indexer.makeIndexer({
      fs: fs, path: path,
      libraryPath: state.libraryPath,
      indexDir: state.indexDir,
      opts: Object.assign({}, state.settings, { incremental: state.settings.incremental && !force }),
      onProgress: onProgress,
      isCancelled: function () { return state.cancelFlag; }
    });
  }

  function computeIndexBytes() {
    var total = 0;
    try {
      ['docs.json.gz', 'postings.json.gz'].forEach(function (f) {
        var p = path.join(state.indexDir, f);
        if (fs.existsSync(p)) total += fs.statSync(p).size;
      });
      var textDir = path.join(state.indexDir, 'text');
      if (fs.existsSync(textDir)) {
        var names = fs.readdirSync(textDir);
        for (var i = 0; i < names.length; i++) total += fs.statSync(path.join(textDir, names[i])).size;
      }
    } catch (e) { }
    return total;
  }

  function loadIndex() {
    state.indexer = makeIndexer(false);
    var res = state.indexer.loadIndex();          // {index:{docs,post}} | {reason,detail}
    if (!res || !res.index) {
      state.indexMismatch = res || { reason: 'no-index' };
      return false;
    }
    state.indexMismatch = null;
    var docs = res.index.docs, post = res.index.post;
    state.docIndex = docs;
    state.builtAt = docs.builtAt || 0;
    state.indexerStats = docs.stats || null;

    state.engine = FT.search.makeEngine({
      docs: docs.docs,
      postings: post.terms,
      readText: function (idx) { return state.indexer.readDocText(idx); }
    });
    state.stats = state.engine.stats();
    state.indexBytes = computeIndexBytes();

    // 汇总「提取提示」，供概览面板展开查看
    state.warnings = [];
    for (var k in docs.docs) {
      var d = docs.docs[k];
      if (d.warn) state.warnings.push({ name: d.name + '.' + d.ext, warn: d.warn });
    }
    state.warnings.sort(function (a, b) { return a.warn.localeCompare(b.warn); });
    return true;
  }

  function onProgress(p) {
    if (p.phase === 'extract') {
      if (p.total) {
        $('pgFill').style.width = Math.round(100 * (p.done || 0) / p.total) + '%';
        $('pgLine').innerHTML = '正在提取正文 <b>' + (p.done || 0) + ' / ' + p.total + '</b>' +
          (p.withText ? ' · 已有正文 ' + p.withText + ' 篇' : '');
      } else {
        $('pgFill').style.width = '100%';
        $('pgLine').innerHTML = '没有需要更新的条目（增量索引已是最新）';
      }
      $('pgCurrent').textContent = p.current
        ? p.current + (p.byMethod ? '    [' + methodLine(p.byMethod) + ']' : '')
        : '';
    } else if (p.phase === 'done' && p.summary) {
      // 落盘完成。给一句终态文案，否则面板上会一直停在「写入索引…」，
      // 即使面板随后被隐藏，用户回头看日志也会以为卡住了。
      $('pgFill').style.width = '100%';
      $('pgLine').innerHTML = '索引写入完成：更新 <b>' + num(p.summary.changed) + '</b> 条' +
        (p.summary.removed ? '，移除 ' + num(p.summary.removed) + ' 条' : '') +
        '，倒排 ' + num(p.summary.terms) + ' 词';
      $('pgCurrent').textContent = '';
    } else if (p.message) {
      $('pgLine').innerHTML = U.escapeHtml(p.message);
      $('pgCurrent').textContent = '';
    }
  }
  function methodLine(byMethod) {
    var label = { pdf: 'PDF', ooxml: 'Office', odf: 'ODF', epub: 'ePub', rtf: 'RTF', utf8: '文本', 'legacy-binary': '旧版Office', skip: '仅元数据' };
    return Object.keys(byMethod).map(function (k) { return (label[k] || k) + ' ' + byMethod[k]; }).join(' · ');
  }

  async function buildIndex(force) {
    if (state.building) return;
    state.building = true;
    state.cancelFlag = false;
    $('list').innerHTML = ''; $('listHead').hidden = true; $('noResult').hidden = true;
    updateVisibility();
    $('pgTitle').textContent = force ? '正在重建索引' : '正在建立索引';
    $('pgFill').style.width = '0%';
    $('pgLine').textContent = '扫描资源库…';
    $('pgCurrent').textContent = '';
    $('tbSub').textContent = '正在建立索引…';
    var t0 = Date.now();
    /* 终态提示不能直接 toast()：finally 里的 renderStatus() 会在同一个 tick 把它盖掉
       （renderStatus 会重写状态栏左半区），用户永远看不到「完成 / 失败 / 已取消」。
       所以先记下来，等收尾逻辑全部跑完再发。 */
    var finalMsg = null;
    try {
      state.indexer = makeIndexer(!!force);
      var res = await state.indexer.build();
      state.docIndex = res.docs;
      state.engine = FT.search.makeEngine({
        docs: res.docs.docs,
        postings: res.postings,
        readText: function (idx) { return state.indexer.readDocText(idx); }
      });
      state.stats = state.engine.stats();
      state.builtAt = res.docs.builtAt;
      state.indexBytes = computeIndexBytes();
      state.warnings = (res.stats.warnings || []).map(function (w) { return { name: w.name + '.' + (w.ext || ''), warn: w.warning }; });
      renderRail();
      renderOverview(res.stats);
      await runSearch();
      finalMsg = '索引完成：处理 <b>' + num(res.stats.processed) + '</b> 条，用时 <b>' + ((Date.now() - t0) / 1000).toFixed(1) + 's</b>';
    } catch (e) {
      if (e && e.cancelled) {
        finalMsg = '已取消索引构建（索引保持为上一次的完整状态）';
      } else {
        // 必须落控制台：toast 只出现在状态栏，很容易被后续刷新覆盖，而且用户不会截全屏截图。
        try { console.error('[全文检索] 建立索引失败：', e && e.stack ? e.stack : e); } catch (e3) { }
        finalMsg = '索引失败：' + U.escapeHtml(e && e.message ? e.message : String(e));
      }
      /* 列表在开头被清空过，而落盘只发生在构建末尾 —— 取消/失败时磁盘索引仍是旧的那份，
         state.engine 依然有效。按现有索引重绘一次，否则会留下「列表头写着共 N 条、
         下面一行都没有」的残局。 */
      try { await runSearch(); } catch (e2) { /* 收尾逻辑不能把原始异常顶掉 */ }
    } finally {
      state.building = false;
      renderStatus();
      $('tbSub').textContent = tbSubText();
      /* 【关键】必须在 state.building = false **之后**再推导一次面板显隐。
         面板显隐由 updateVisibility() 里的 `$('progressPanel').hidden = !state.building`
         决定，而它此前只在「building 仍为 true」时被调用过（起始/mid-search/catch），
         于是索引写完后进度面板永远不会消失 —— 表现就是「点重建索引卡在这个界面」。
         这是收尾位置问题，不是索引逻辑问题（索引与结果其实都已更新完毕）。 */
      updateVisibility();
      if (finalMsg) toast(finalMsg);      // 放在收尾之后，确保不被 renderStatus 覆盖
    }
  }

  /* ==========================================================================
   * 检索
   * ======================================================================== */
  async function runSearch() {
    if (!state.engine) { updateVisibility(); return; }
    var seq = ++state.searchSeq;
    state.searching = true;
    var r;
    try {
      r = await state.engine.search(state.query, buildUiFilters(), { limit: 200, sort: state.sort });
    } catch (e) {
      toast('检索出错：' + U.escapeHtml(e && e.message ? e.message : String(e)));
      state.searching = false;
      return;
    }
    if (seq !== state.searchSeq) return;                   // 已有更新的检索请求，丢弃本次
    state.searching = false;
    state.hits = r.hits;
    state.total = r.total;
    state.lastMeta = r;
    state.sel = r.hits.length ? 0 : -1;
    renderList(r);
    renderStatus();
  }

  function buildUiFilters() {
    return {
      groups: state.filters.groups,
      tags: state.filters.tags,
      folders: state.filters.folders,
      starMin: state.filters.starMin
    };
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ==========================================================================
   * 渲染：结果列表
   * ======================================================================== */
  function rowHtml(h, i) {
    var nameHtml = U.highlightHtml(h.name, h.nameRanges);
    var badges = (h.fields || []).map(function (f) { return '<span class="badge">' + f + '</span>'; }).join('');
    if (h.partial) badges += '<span class="badge partial">部分匹配</span>';
    if (h.warn) badges += '<span class="badge partial" title="' + U.escapeHtml(h.warn) + '">近似提取</span>';

    var snip = '';
    if (h.snip && h.snip.text) {
      var lead = h.snip.truncatedHead ? '<span class="lead">⋯ </span>' : '';
      var tail = h.snip.truncatedTail ? '<span class="lead"> ⋯</span>' : '';
      snip = '<div class="snip">' + lead + U.highlightHtml(h.snip.text, h.snip.ranges) + tail + '</div>';
    } else if (h.annotation) {
      snip = '<div class="snip ann">' + U.escapeHtml(h.annotation.slice(0, 160)) + '</div>';
    }

    var metaBits = [h.ext ? h.ext.toUpperCase() : '', FT.util.formatBytes(h.size), FT.util.formatTime(h.mtime)];
    if (h.cLen) metaBits.push('正文 ' + (h.cLen >= 10000 ? (h.cLen / 10000).toFixed(1) + ' 万字符' : h.cLen + ' 字符'));
    if (h.star) metaBits.push('★'.repeat(h.star));
    var meta = metaBits.filter(Boolean).join(' · ');
    var tags = (h.tags || []).slice(0, 6).map(function (t) { return '#' + t; }).join(' ');
    var folder = (h.folders || []).length ? h.folders.join(' › ') : '';

    var thumbs = thumbPaths(h);
    return '<div class="row" data-i="' + i + '" data-id="' + U.escapeHtml(h.id) + '">' +
      '<div class="thumb">' +
      '<img alt="" data-fallback="' + U.escapeHtml(thumbs[1]) + '" src="' + U.escapeHtml(thumbs[0]) + '">' +
      '<span class="ext">' + U.escapeHtml(h.ext || '?') + '</span>' +
      '</div>' +
      '<div class="body">' +
      '<div class="line1"><span class="rname">' + nameHtml + '</span>' + badges + '</div>' +
      snip +
      '<div class="line3">' +
      '<span class="meta">' + U.escapeHtml(meta) + '</span>' +
      (folder ? '<span class="meta">' + U.escapeHtml(folder) + '</span>' : '') +
      (tags ? '<span class="taglist">' + U.escapeHtml(tags) + '</span>' : '') +
      '</div></div></div>';
  }

  function renderList(r) {
    var noRes = $('noResult');
    if (!r.hits.length) {
      $('list').innerHTML = '';
      $('listHead').hidden = true;
      noRes.hidden = false;
      var extra = '';
      if (r.verified && r.candidateCount) {
        extra = '<br>有 <b>' + num(r.candidateCount) + '</b> 个条目包含相关字符，但不含你要求的完整词组（已做逐字校验）。' +
          '<br>建议：去掉引号改用关键词组合，或精简为 2~3 个字的核心术语。';
      } else if (r.parsed && (r.parsed.filters.exts.length || r.parsed.filters.groups.length)) {
        extra = '<br>当前查询带有格式限定，可能过滤掉了结果。';
      }
      noRes.innerHTML = '未找到匹配 <b>' + U.escapeHtml(state.query) + '</b> 的条目。' + extra +
        '<br><br>可通过左侧筛选缩小范围，或使用 <code>"精确短语"</code> 做整串匹配。';
      updateVisibility();
      return;
    }
    noRes.hidden = true;

    // 列表头：命中数 / 用时 / 模式说明
    var modeNote = '';
    if (r.mode === 'or' && r.partialCount) {
      modeNote = '未找到同时包含全部关键词的条目，以下为部分匹配';
    } else if (r.mode === 'browse') {
      modeNote = '未输入关键词，按' + (state.sort === 'name' ? '名称' : '修改时间') + '列出';
    }
    $('listHead').hidden = false;
    $('listHead').innerHTML =
      '<span>共 <b>' + num(r.total) + '</b> 条' + (r.total > r.hits.length ? '（显示前 ' + r.hits.length + ' 条）' : '') + '</span>' +
      '<span class="sb-dot">·</span><span>' + r.ms + ' ms</span>' +
      (r.verified ? '<span class="sb-dot">·</span><span>已逐字校验</span>' : '') +
      (modeNote ? '<span class="sb-dot">·</span><span class="mode-note">' + modeNote + '</span>' : '');

    // 一次性拼接 + content-visibility 跳绘（视口外的行不参与布局与绘制）
    var html = '';
    for (var i = 0; i < r.hits.length; i++) html += rowHtml(r.hits[i], i);
    $('list').innerHTML = html;
    markSelected();
    updateVisibility();
  }

  function markSelected() {
    var nodes = $('list').children;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('sel', i === state.sel);
    }
  }

  function scrollToSel() {
    var node = $('list').children[state.sel];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  /* ==========================================================================
   * 渲染：筛选栏 / 概览 / 状态栏
   * ======================================================================== */
  function chip(key, label, count, on, title) {
    return '<button class="chip' + (on ? ' on' : '') + '" data-k="' + U.escapeHtml(key) + '"' +
      (title ? ' title="' + U.escapeHtml(title) + '"' : '') + '>' +
      '<span class="t">' + U.escapeHtml(label) + '</span>' +
      (count != null ? '<span class="n">' + num(count) + '</span>' : '') + '</button>';
  }

  function renderRail() {
    if (!state.stats) return;
    var byGroup = state.stats.byGroup;

    // 类型
    var groups = Object.keys(byGroup).sort(function (a, b) { return byGroup[b] - byGroup[a]; });
    $('typeList').innerHTML = groups.map(function (g) {
      return chip(g, C.GROUP_LABEL[g] || g, byGroup[g], state.filters.groups.indexOf(g) >= 0);
    }).join('') || '<div class="chip"><span class="t">—</span></div>';

    // 标签（按出现频次取前 18）
    var tagCount = {}, docs = state.engine ? state.engine.docs : {};
    for (var k in docs) {
      (docs[k].tags || []).forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; });
    }
    var tags = Object.keys(tagCount).sort(function (a, b) { return tagCount[b] - tagCount[a]; }).slice(0, 18);
    $('tagList').innerHTML = tags.map(function (t) {
      return chip(t, t, tagCount[t], state.filters.tags.indexOf(t) >= 0);
    }).join('') || '<div class="chip"><span class="t">—</span></div>';

    // 文件夹
    var folCount = {};
    for (var k2 in docs) {
      (docs[k2].folders || []).forEach(function (f) { folCount[f] = (folCount[f] || 0) + 1; });
    }
    var fols = Object.keys(folCount).sort(function (a, b) { return folCount[b] - folCount[a]; }).slice(0, 14);
    $('folderList').innerHTML = fols.map(function (f) {
      return chip(f, f, folCount[f], state.filters.folders.indexOf(f) >= 0);
    }).join('') || '<div class="chip"><span class="t">—</span></div>';

    // 评分
    $('starList').innerHTML = [5, 4, 3].map(function (s) {
      return chip('star' + s, '★'.repeat(s) + ' 及以上', null, state.filters.starMin === s);
    }).join('');

    $('grpTag').hidden = !tags.length;
    $('grpFolder').hidden = !fols.length;
  }

  function renderOverview(buildStats) {
    if (!state.stats) { $('overview').hidden = true; return; }
    var s = state.stats;
    $('overview').hidden = false;
    var when = state.builtAt ? new Date(state.builtAt) : null;
    $('ovTitle').textContent = '索引概览';
    $('ovSub').textContent = when
      ? '更新于 ' + when.toLocaleString('zh-CN', { hour12: false })
      : '';
    var cells = [
      ['条目总数', num(s.docs), '', '资源库中被索引的条目数'],
      ['含正文条目', num(s.withText), '篇', '成功抽取到可检索正文的文件'],
      ['正文覆盖率', pct(s.withText, s.docs), '', '含正文条目 / 条目总数'],
      ['倒排词条', num(s.terms), '个', '中英文索引词总数'],
      ['索引体积', FT.util.formatBytes(state.indexBytes), '', '插件目录 .index/ 占用'],
      ['原始素材体积', FT.util.formatBytes(s.bytes), '', '被索引条目的文件总大小']
    ];
    if (buildStats && buildStats.extractMs != null) {
      cells.push(['本次解析耗时', (buildStats.extractMs / 1000).toFixed(1), 's', '本轮新增/变更条目的正文提取时间']);
    }
    $('ovGrid').innerHTML = cells.map(function (c) {
      return '<div class="ov-cell" title="' + U.escapeHtml(c[3]) + '">' +
        '<div class="ov-k">' + c[0] + '</div>' +
        '<div class="ov-v">' + c[1] + (c[2] ? '<small>' + c[2] + '</small>' : '') + '</div></div>';
    }).join('');

    var byMethod = (buildStats && buildStats.byMethod) || (state.indexerStats && state.indexerStats.byMethod) || {};
    var line = methodLine(byMethod);
    var warns = state.warnings || [];
    if (warns.length) {
      $('ovWarn').hidden = false;
      $('ovWarnSummary').textContent = '提取提示（' + warns.length + ' 条）';
      var seen = {}, items = [];
      warns.forEach(function (w) {
        var key = w.warn.replace(/\d+/g, 'N');
        if (seen[key]) { seen[key].n++; return; }
        seen[key] = { n: 1, warn: w.warn, example: w.name };
        items.push(seen[key]);
      });
      $('ovWarnList').innerHTML = items.slice(0, 40).map(function (it) {
        return '<li>' + U.escapeHtml(it.warn) + ' — 例如「' + U.escapeHtml(it.example) + '」' +
          (it.n > 1 ? '（同类 ' + it.n + ' 条）' : '') + '</li>';
      }).join('');
    } else {
      $('ovWarn').hidden = true;
      $('ovWarnSummary').textContent = '';
    }
    $('ovSub').textContent = (when ? '更新于 ' + when.toLocaleString('zh-CN', { hour12: false }) : '') +
      (line ? ' · 抽取方式：' + line : '');
  }

  function tbSubText() {
    if (!state.stats) return state.libraryPath ? '资源库：' + state.libraryPath : '';
    return '索引 ' + num(state.stats.docs) + ' 条 · ' + num(state.stats.withText) + ' 篇含正文 · ' +
      FT.util.formatBytes(state.indexBytes);
  }

  function renderStatus() {
    $('tbSub').textContent = tbSubText();
    if (state.sel >= 0 && state.hits[state.sel]) {
      $('sbLeft').innerHTML = '已选第 <b>' + (state.sel + 1) + ' / ' + num(state.hits.length) + '</b> 条' +
        '<span class="sb-dot">·</span>↵ 在 Eagle 中定位<span class="sb-dot">·</span>⌥↵ 打开文件';
    } else if (state.searching) {
      $('sbLeft').innerHTML = '检索中…';
    } else if (state.hits.length) {
      $('sbLeft').innerHTML = '共 <b>' + num(state.total) + '</b> 条结果';
    } else if (state.engine) {
      $('sbLeft').innerHTML = '就绪';
    }
    if (!state.stats) { $('sbRight').innerHTML = ''; return; }
    var when = state.builtAt ? new Date(state.builtAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
    $('sbRight').innerHTML =
      '索引 <b>' + num(state.stats.docs) + '</b> 条' +
      '<span class="sb-dot">·</span>' + num(state.stats.withText) + ' 篇含正文' +
      '<span class="sb-dot">·</span>倒排 ' + num(state.stats.terms) + ' 词' +
      '<span class="sb-dot">·</span>' + FT.util.formatBytes(state.indexBytes) +
      '<span class="sb-dot">·</span>更新于 ' + when;
  }

  /* 面板显隐：声明式推导，避免多处手写 show/hide 导致状态互相打架 */
  function filtersActive() {
    var f = state.filters;
    return !!(f.groups.length || f.tags.length || f.folders.length || f.starMin);
  }
  function updateVisibility() {
    var hasIndex = !!state.engine;
    var browsing = hasIndex && !state.building;
    $('progressPanel').hidden = !state.building;
    $('emptyState').hidden = hasIndex;
    $('overview').hidden = !(browsing && !state.query && !filtersActive() && state.hits.length > 0);
    $('listHead').hidden = !(browsing && (state.hits.length > 0 || (state.query && state.hits.length === 0)));
    $('noResult').hidden = !(browsing && state.query && state.hits.length === 0);
  }

  /* ==========================================================================
   * 交互
   * ======================================================================== */
  function selectRow(i) {
    if (i < 0 || i >= state.hits.length) return;
    if (i === state.sel) return;                 // 鼠标在列表上滑动时避免反复重绘
    state.sel = i;
    markSelected();
    scrollToSel();
    renderStatus();
  }

  function bind() {
    // 署名行：从 config.js 注入，而不是写死在 index.html —— 版本号只保留一个真源，
    // 否则每次升版都要在两处改，迟早漂移（selfcheck.js 里有一条断言守着这个约定）。
    try {
      var credit = $('credit');
      if (credit) credit.textContent = C.NAME + ' v' + C.VERSION + ' · ' + C.AUTHOR;
    } catch (e) { }

    // ---- 搜索框 ----
    var doSearch = debounce(function () { runSearch(); }, 110);
    $('q').addEventListener('input', function () {
      state.query = this.value;
      $('btnClear').classList.toggle('on', !!this.value);
      doSearch();
    });
    $('btnClear').addEventListener('click', function () {
      $('q').value = ''; state.query = '';
      $('btnClear').classList.remove('on');
      $('q').focus();
      runSearch();
    });
    $('sort').addEventListener('change', function () { state.sort = this.value; runSearch(); });

    // ---- 左侧筛选 ----
    function toggleChip(list, key) {
      var i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1); else list.push(key);
      renderRail(); runSearch();
    }
    $('typeList').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      toggleChip(state.filters.groups, b.getAttribute('data-k'));
    });
    $('tagList').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      toggleChip(state.filters.tags, b.getAttribute('data-k'));
    });
    $('folderList').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      toggleChip(state.filters.folders, b.getAttribute('data-k'));
    });
    $('starList').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      var n = parseInt(String(b.getAttribute('data-k')).replace('star', ''), 10) || 0;
      state.filters.starMin = state.filters.starMin === n ? 0 : n;
      renderRail(); runSearch();
    });

    // ---- 结果行 ----
    $('list').addEventListener('click', function (e) {
      var row = e.target.closest('.row'); if (!row) return;
      selectRow(parseInt(row.getAttribute('data-i'), 10));
      var id = row.getAttribute('data-id');
      if (e.metaKey || e.ctrlKey) EA.selectAndReveal(id);
    });
    $('list').addEventListener('dblclick', function (e) {
      var row = e.target.closest('.row'); if (!row) return;
      var h = state.hits[parseInt(row.getAttribute('data-i'), 10)];
      if (h) EA.openFileByPath(path.join(state.libraryPath, 'images', h.id + '.info', h.fileName || (h.name + '.' + h.ext)));
    });
    // 缩略图加载失败：先试 .jpg 备选，再退回扩展名文字块
    $('list').addEventListener('error', function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      var alt = img.getAttribute('data-fallback');
      if (alt && img.getAttribute('src') !== alt) { img.setAttribute('src', alt); return; }
      img.style.display = 'none';
    }, true);
    // 缩略图加载成功：隐藏扩展名占位文字（.has-img 控制）
    $('list').addEventListener('load', function (e) {
      var img = e.target;
      if (img && img.tagName === 'IMG' && img.parentNode) img.parentNode.classList.add('has-img');
    }, true);
    $('list').addEventListener('mousemove', function (e) {
      var row = e.target.closest('.row');
      if (row) selectRow(parseInt(row.getAttribute('data-i'), 10));
    });

    // ---- 键盘 ----
    document.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('q').focus(); $('q').select(); return; }
      if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); EA.hideWindow(); return; }
      if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); buildIndex(false); return; }
      if (mod) return;

      if (e.key === 'Escape') {
        if (!$('settingsModal').hidden) { closeSettings(); return; }
        if ($('q').value) { $('q').value = ''; state.query = ''; $('btnClear').classList.remove('on'); runSearch(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!$('settingsModal').hidden) return;
        if (!state.hits.length) return;
        e.preventDefault();
        selectRow(state.sel + (e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (e.key === 'Enter') {
        var h = state.hits[state.sel];
        if (!h) return;
        e.preventDefault();
        if (e.altKey) {
          EA.openFileByPath(path.join(state.libraryPath, 'images', h.id + '.info', h.fileName || (h.name + '.' + h.ext)));
        } else {
          EA.selectAndReveal(h.id);
          toast('已在 Eagle 中定位「' + U.escapeHtml(h.name) + '」');
        }
      }
    });

    // ---- 标题栏 / 设置 ----
    $('btnMin').addEventListener('click', EA.minimizeWindow);
    $('btnClose').addEventListener('click', EA.hideWindow);
    $('btnBuild').addEventListener('click', function () { buildIndex(false); });
    $('btnRebuild').addEventListener('click', function () { buildIndex(true); });
    $('btnCancel').addEventListener('click', function () { state.cancelFlag = true; toast('正在取消…'); });
    $('btnSettings').addEventListener('click', openSettings);
    $('btnSettingsCancel').addEventListener('click', closeSettings);
    $('btnSettingsSave').addEventListener('click', saveSettingsFromModal);
    // 预设卡片：点击 / 回车 / 空格 均可选中（只改 pending，保存时才生效）
    $('presetList').addEventListener('click', function (e) {
      var card = e.target.closest && e.target.closest('.preset');
      if (!card) return;
      pendingProfile = card.getAttribute('data-k');
      renderPresetList();
    });
    $('presetList').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var card = e.target.closest && e.target.closest('.preset');
      if (!card) return;
      e.preventDefault();
      pendingProfile = card.getAttribute('data-k');
      renderPresetList();
      var on = $('presetList').querySelector('.preset.on');
      if (on && on.focus) on.focus();
    });
    // 点击遮罩空白处关闭（弹层本身是全屏 flex 遮罩，只有卡片是内容）
    $('settingsModal').addEventListener('click', function (e) {
      if (e.target === this) closeSettings();
    });

    // 插件被点击 / 重新显示时聚焦搜索框
    EA.onPluginRun(function () { $('q').focus(); });
    EA.onPluginShow(function () { $('q').focus(); });

    // 主题跟随
    EA.onThemeChanged(function (theme) { applyTheme(theme); });
    // 资源库切换：旧索引与新库不匹配，必须提示重建
    EA.onLibraryChanged(function (libPath) {
      if (libPath && libPath !== state.libraryPath) {
        state.libraryPath = libPath;
        state.engine = null; state.stats = null;
        updateVisibility();
        $('emptyState').querySelector('.empty-title').textContent = '已切换到新的资源库';
        $('emptyState').querySelector('.empty-desc').innerHTML =
          '当前资源库：<b>' + U.escapeHtml(libPath) + '</b><br>需要为新资源库重新建立索引。';
        $('btnBuild').textContent = '为新资源库建立索引';
        renderStatus();
      }
    });
  }

  /* ==========================================================================
   * 设置弹层：索引范围（只有两档预设）
   * ------------------------------------------------------------------------
   * 设计说明：早先暴露 4 个数字输入框属于过度设计，且保存路径不直观
   * （用户反馈「点保存没反应」）。现在收敛为两张可点选的卡片，
   * 默认停在当前档位，点「保存并应用」后若档位真的变了就立刻重建索引，
   * 让动作有明确可见的后果（进度面板弹出），而不是静默写一个文件。
   * ======================================================================== */
  function renderPresetList() {
    var cur = pendingProfile || state.settings.profile;
    var order = ['normal', 'long'];
    $('presetList').innerHTML = order.map(function (k) {
      var p = C.profileOf(k);
      var on = (p.key === cur);
      return '<div class="preset' + (on ? ' on' : '') + '" data-k="' + U.escapeHtml(p.key) + '"' +
        ' role="radio" tabindex="0" aria-checked="' + on + '">' +
        '<div class="p-head">' +
        '<span class="p-dot" aria-hidden="true"></span>' +
        '<span class="p-name">' + U.escapeHtml(p.label) + '</span>' +
        (p.tag ? '<span class="p-tag">' + U.escapeHtml(p.tag) + '</span>' : '') +
        '</div>' +
        '<div class="p-desc">' + U.escapeHtml(p.desc) + '</div>' +
        '<div class="p-nums">' + U.escapeHtml(p.capacity) +
        '　·　单文件上限 ' + U.escapeHtml(FT.util.formatBytes(p.maxFileSize)) + '</div>' +
        '</div>';
    }).join('');
  }

  function openSettings() {
    pendingProfile = state.settings.profile || C.DEFAULTS.profile;
    renderPresetList();
    $('settingsModal').hidden = false;
    var first = $('presetList').querySelector('.preset.on') || $('presetList').firstChild;
    if (first && first.focus) first.focus();
  }

  function closeSettings() {
    $('settingsModal').hidden = true;
  }

  function saveSettingsFromModal() {
    var before = C.buildSignature(state.settings);
    var key = pendingProfile || state.settings.profile || C.DEFAULTS.profile;
    C.applyProfile(state.settings, key);
    var after = C.buildSignature(state.settings);
    EA.saveSettings(state.settings);
    closeSettings();

    if (before !== after) {
      // 档位真的变了：立刻重建，让覆盖范围马上生效（弹层下方的说明已预告这一行为）
      var p = C.profileOf(state.settings.profile);
      toast('索引范围已切换为「' + U.escapeHtml(p.label) + '」，正在重建索引…');
      buildIndex(true);
    } else {
      toast('索引范围未变：「' + U.escapeHtml(C.profileOf(state.settings.profile).label) + '」');
    }
  }

  /** 索引不可用时，首屏空状态按原因给出针对性文案与按钮 */
  function applyEmptyState(reason, detail) {
    var et = $('emptyState').querySelector('.empty-title');
    var ed = $('emptyState').querySelector('.empty-desc');
    var btn = $('btnBuild');
    btn.hidden = false;
    btn.textContent = '建立索引';

    if (reason === 'settings') {
      var nowP = C.profileOf(state.settings.profile);
      et.textContent = '索引范围已更改';
      // detail 是旧索引的指纹（maxCharsPerDoc|maxFileSize|includeTrashed）
      var oldChars = String(detail || '').split('|')[0];
      ed.innerHTML = '现有索引按 <b>每篇 ' + num(parseInt(oldChars, 10) || 0) + ' 字符</b> 的范围生成，' +
        '当前设置是「<b>' + U.escapeHtml(nowP.label) + '</b>」（每篇 ' + num(nowP.maxCharsPerDoc) + ' 字符）。<br>' +
        '重建索引后，更长的文档正文才会进入检索范围。';
      btn.textContent = '按新范围重建索引';
    } else if (reason === 'version') {
      et.textContent = '索引需要升级';
      ed.innerHTML = '索引结构版本已更新（' + U.escapeHtml(String(detail || '')) + '），旧索引无法继续使用。<br>重建一次即可，耗时与首次建立索引相同。';
      btn.textContent = '重建索引';
    } else if (reason === 'library') {
      et.textContent = '索引属于另一个资源库';
      ed.innerHTML = '现有索引来自：<br><code>' + U.escapeHtml(String(detail || '（未知）')) + '</code><br>' +
        '当前资源库：<br><code>' + U.escapeHtml(state.libraryPath || '') + '</code><br>请为当前资源库建立索引。';
      btn.textContent = '为当前资源库建立索引';
    } else if (reason === 'broken') {
      et.textContent = '索引文件损坏或缺失';
      ed.innerHTML = '倒排文件无法读取，可能上次写入被中断。<br>重建索引即可恢复。';
      btn.textContent = '重建索引';
    }
  }

  /* ==========================================================================
   * 启动
   * ======================================================================== */
  async function boot() {
    try {
      var ctx = await EA.init();
      // __dirname 在 Electron 渲染进程通常会注入，但不保证；它处在启动关键路径上，
      // 一旦未定义会抛 ReferenceError 把整个启动流程带崩，所以显式兜底。
      var fallbackDir = (typeof __dirname !== 'undefined') ? __dirname : '.';
      state.pluginPath = ctx.pluginPath || fallbackDir;
      state.libraryPath = ctx.libraryPath;
      C.PLUGIN_DIR = state.pluginPath;
      // 索引目录：默认落在插件目录下；测试宿主可用 C.SANDBOX.indexDir 重定向，
      // 避免自造样本库的索引覆盖真实索引（否则下次开插件会误判「换了资源库」）。
      state.indexDir = C.SANDBOX.indexDir || (path ? path.join(state.pluginPath, '.index') : null);

      applyTheme(ctx.theme);
      bind();

      if (!hasNode || !fs) {
        // 普通浏览器（非 Eagle 环境）：保留界面外壳并说明原因，不调用任何 Node API。
        var et = $('emptyState').querySelector('.empty-title');
        var ed = $('emptyState').querySelector('.empty-desc');
        et.textContent = '需要在 Eagle 中运行';
        ed.innerHTML = '本插件依赖 Eagle 提供的 Node 集成（读取素材文件、解析正文、访问资源库目录），' +
          '无法在普通浏览器中运行。<br><br>安装方式：把 <code>eagle-fulltext-search</code> 整个目录放到<br>' +
          '<code>~/Library/Application Support/Eagle/Plugins/</code>，然后完全退出并重开 Eagle。';
        $('btnBuild').hidden = true;
        return;
      }

      $('q').placeholder = state.libraryPath
        ? '搜索标题、注释、标签、文件夹与文件正文…'
        : '未检测到 Eagle 资源库';

      // 设置：默认值 + 落盘值。老版本设置里只有 maxCharsPerDoc / maxFileSize 而没有
      // profile 字段，这里按范围反推一次档位，再统一由 profile 派生两个数值，
      // 保证「设置 = 一个档位」这一不变式（避免出现「档位是普通文件、上限却是 400 万」的错位）。
      state.settings = Object.assign({}, C.DEFAULTS, EA.loadSettings());
      if (!state.settings.profile || !C.PROFILES[state.settings.profile]) {
        state.settings.profile = (state.settings.maxCharsPerDoc >= C.PROFILES.long.maxCharsPerDoc) ? 'long' : 'normal';
      }
      C.applyProfile(state.settings, state.settings.profile);

      if (!state.libraryPath) {
        $('emptyState').querySelector('.empty-title').textContent = '未连接到 Eagle 资源库';
        $('emptyState').querySelector('.empty-desc').innerHTML = '请先在 Eagle 中打开一个资源库，然后重新打开本插件。';
        $('btnBuild').hidden = true;
        return;
      }

      if (loadIndex()) {
        renderRail();
        renderOverview(null);
        await runSearch();
        updateVisibility();
        toast('索引已载入：<b>' + num(state.stats.docs) + '</b> 条 · ' + num(state.stats.withText) + ' 篇含正文');
      } else {
        updateVisibility();
        var mm = state.indexMismatch || { reason: 'no-index' };
        if (mm.reason && mm.reason !== 'no-index') {
          // 索引存在但不可用（版本升级 / 换了资源库 / 损坏 / 范围改过）→ 说清原因，而不是干巴巴一句「尚未建立索引」
          applyEmptyState(mm.reason, mm.detail);
        }
        // 资源库已有条目但尚未建索引 → 提示规模，让用户决定
        try {
          var n = fs.readdirSync(path.join(state.libraryPath, 'images')).filter(function (x) { return /\.info$/.test(x); }).length;
          $('emptyCount').textContent = num(n);
        } catch (e) { }
      }
      renderStatus();
      $('q').focus();
      $('tbSub').textContent = tbSubText();
    } catch (e) {
      // 兜底：保证窗口仍可关闭
      document.body.innerHTML =
        '<div style="padding:40px;font:14px/1.9 -apple-system,PingFang SC,sans-serif;color:#111416">' +
        '<h2 style="font-size:16px;margin:0 0 10px">插件启动失败</h2>' +
        '<pre style="white-space:pre-wrap;font-size:12px;color:#33393D">' +
        String(e && e.stack ? e.stack : e).replace(/</g, '&lt;') + '</pre></div>';
      try { EA.hideWindow && window.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') EA.hideWindow(); }); } catch (e2) { }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
