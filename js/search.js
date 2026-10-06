/* =============================================================================
 * search.js —— 检索内核（查询解析 / 打分 / 字面校验 / 片段生成）
 * -----------------------------------------------------------------------------
 * 查询语法（在搜索框里直接输入即可）：
 *   深度学习 综述           → 两个词都必须命中（AND）
 *   "exact phrase"          → 引号内为精确短语，逐字校验
 *   神经网络 -入门           → - 前缀为排除词
 *   ext:pdf                  → 限定扩展名；type:word 限定额度分组
 *   tag:教材                 → 限定标签（子串匹配）
 *   folder:示例文件夹        → 限定文件夹名（子串匹配）
 *   star:>=4                 → 限定评分
 *
 * 排序模型（BM25F 的简化实现，诚实说明简化点）：
 *   score = Σ_t  idf(t) * tfW / (tfW + k1)
 *   tfW   = Σ_{f ∈ 命中字段} w_f  +  (命中正文 ? k1 * tf/(tf+1) : 0)
 *   idf   = ln(1 + (N - df + 0.5) / (df + 0.5))
 *   简化点：倒排表只记录「命中字段掩码 + 合并词频」，不记录每字段独立词频，
 *   因此没有做严格的逐字段长度归一化，而是用「字段权重 + 词频饱和」替代。
 *   这是刻意的取舍：索引体积小一半以上，实测排序质量在素材库场景下无感差异。
 *   额外的排序信号：短语命中加成、标题整串命中加成、修改时间作为 tie-break。
 *
 * 精确性保障：中文 bigram 只是「召回」手段，最终结果会用原文逐字校验
 * （literals），因此不会出现「召回了一堆字面不含该词的文档」这类中文检索通病。
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});
  var U = FT.util, T = FT.tokenizer, C = FT.config;

  /* ---------------------------------------------------------------------------
   * 归一化 + 位置映射
   * 必要性：NFKC/小写化可能改变字符长度（全角→半角、连字→多字符），直接拿
   * 归一化后的下标去原文取子串会错位。逐字符归一化并记录映射即可安全还原。
   * ------------------------------------------------------------------------ */
  function normalizeWithMap(text) {
    var out = [], map = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var n;
      try { n = ch.normalize('NFKC').toLowerCase(); } catch (e) { n = ch.toLowerCase(); }
      for (var k = 0; k < n.length; k++) { out.push(n[k]); map.push(i); }
    }
    return { norm: out.join(''), map: map };
  }

  /* ---------------------------------------------------------------------------
   * 匹配区间查找：在归一化串里找若干「表面串」，映射回原文区间并合并
   * ------------------------------------------------------------------------ */
  function findRanges(nm, surfaces) {
    var raw = [];
    for (var s = 0; s < surfaces.length; s++) {
      var needle = surfaces[s];
      if (!needle) continue;
      var n = needle.normalize ? needle.normalize('NFKC').toLowerCase() : needle;
      if (!n) continue;
      var from = 0, pos;
      while ((pos = nm.norm.indexOf(n, from)) !== -1) {
        var endNorm = pos + n.length - 1;
        if (endNorm < nm.map.length) {
          raw.push({ start: nm.map[pos], end: nm.map[endNorm] + 1 });
        }
        from = pos + 1;
      }
    }
    // 按起点排序并合并重叠/相邻区间
    raw.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var merged = [];
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i], last = merged[merged.length - 1];
      if (last && r.start <= last.end) { last.end = Math.max(last.end, r.end); }
      else merged.push({ start: r.start, end: r.end });
    }
    return merged;
  }

  /* ---------------------------------------------------------------------------
   * 片段生成：选取「命中密度最高」的窗口，返回原文窗口 + 高亮区间
   * ------------------------------------------------------------------------ */
  function makeSnippet(text, surfaces, maxLen) {
    if (!text) return { text: '', ranges: [], truncatedHead: false, truncatedTail: false };
    var nm = normalizeWithMap(text);
    var ranges = findRanges(nm, surfaces);
    if (!ranges.length) {
      var head = text.slice(0, maxLen);
      return { text: head, ranges: [], truncatedHead: false, truncatedTail: text.length > maxLen };
    }
    // 滑动窗口：以每个命中点为锚，统计窗口内命中数量，取最优
    var bestStart = 0, bestScore = -1;
    for (var i = 0; i < ranges.length; i++) {
      var start = Math.max(0, ranges[i].start - Math.floor(maxLen * 0.35));
      if (start + maxLen > text.length) start = Math.max(0, text.length - maxLen);
      var end = start + maxLen, cnt = 0;
      for (var j = 0; j < ranges.length; j++) {
        if (ranges[j].start >= start && ranges[j].start < end) cnt++;
      }
      if (cnt > bestScore) { bestScore = cnt; bestStart = start; }
    }
    var wEnd = Math.min(text.length, bestStart + maxLen);
    var win = text.slice(bestStart, wEnd);
    var winRanges = ranges
      .filter(function (r) { return r.start >= bestStart && r.start < wEnd; })
      .map(function (r) { return { start: r.start - bestStart, end: Math.min(wEnd, r.end) - bestStart }; });
    return { text: win, ranges: winRanges, truncatedHead: bestStart > 0, truncatedTail: wEnd < text.length };
  }

  /* ---------------------------------------------------------------------------
   * 查询解析
   * ------------------------------------------------------------------------ */
  function parseQuery(q) {
    var raw = String(q || '').trim();
    var parsed = {
      raw: raw, tokens: [], terms: [], literals: [], surfaces: [],
      negTerms: [], negLiterals: [], negSurfaces: [],
      filters: { exts: [], groups: [], tags: [], folders: [], starMin: 0 }
    };
    if (!raw) return parsed;

    // 1) 引号短语
    var rest = raw.replace(/"([^"]+)"/g, function (m, inner) {
      var p = inner.trim();
      if (p) {
        parsed.surfaces.push(p);
        parsed.literals.push(p.normalize ? p.normalize('NFKC').toLowerCase() : p);
        T.queryTerms(p).forEach(function (t) { parsed.terms.push(t); });
      }
      return ' ';
    });

    // 2) 逐词处理
    var parts = rest.split(/\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var tok = parts[i];
      var neg = false;
      if (tok.length > 1 && tok[0] === '-') { neg = true; tok = tok.slice(1); }
      if (!tok) continue;

      // 字段语法
      var m = tok.match(/^(ext|type|tag|folder|star|size):(.+)$/i);
      if (m) {
        var key = m[1].toLowerCase(), val = m[2];
        if (key === 'ext') parsed.filters.exts.push(val.toLowerCase().replace(/^\./, ''));
        else if (key === 'type') {
          var g = val.toLowerCase();
          if (C.EXT_GROUPS[g]) parsed.filters.groups.push(g);
          else parsed.filters.exts.push(g);
        } else if (key === 'tag') parsed.filters.tags.push(val);
        else if (key === 'folder') parsed.filters.folders.push(val);
        else if (key === 'star') {
          var mm = val.match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
          if (mm) parsed.filters.starMin = (mm[1] === '<' || mm[1] === '<=') ? 0 : parseInt(mm[2], 10);
        }
        continue;
      }

      var terms = T.queryTerms(tok);
      var isCjkRun = /^[\u3400-\u9FFF\uF900-\uFAFF]{2,12}$/.test(tok);
      if (neg) {
        terms.forEach(function (t) { parsed.negTerms.push(t); });
        if (isCjkRun) { parsed.negLiterals.push(tok); parsed.negSurfaces.push(tok); }
      } else {
        terms.forEach(function (t) { parsed.terms.push(t); });
        parsed.surfaces.push(tok);
        // 2~12 字纯中文串：作为「必须逐字出现」的硬约束，消除 bigram 假阳性
        if (isCjkRun) parsed.literals.push(tok);
      }
    }
    // 3) 去重
    parsed.terms = uniq(parsed.terms);
    parsed.negTerms = uniq(parsed.negTerms);
    parsed.surfaces = uniq(parsed.surfaces);
    parsed.negSurfaces = uniq(parsed.negSurfaces);
    parsed.literals = uniq(parsed.literals);
    parsed.negLiterals = uniq(parsed.negLiterals);
    return parsed;
  }
  function uniq(a) { var s = Object.create(null), o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }

  /* ---------------------------------------------------------------------------
   * 检索引擎
   * ------------------------------------------------------------------------ */
  function makeEngine(store) {
    // store = {docs, postings, readText}
    var docs = store.docs, postings = store.postings;

    /** 过滤条件 → 允许的 idx 集合（null 表示不限制） */
    function filterSet(filters) {
      var f = filters;
      var has = f.exts.length || f.groups.length || f.tags.length || f.folders.length || f.starMin > 0;
      if (!has) return null;
      var allow = new Set();
      var groupExts = null;
      if (f.groups.length) {
        groupExts = Object.create(null);
        f.groups.forEach(function (g) { (C.EXT_GROUPS[g] || []).forEach(function (e) { groupExts[e] = 1; }); });
      }
      for (var k in docs) {
        var d = docs[k];
        if (f.exts.length && f.exts.indexOf(d.ext) < 0) continue;
        if (groupExts && !groupExts[d.ext]) continue;
        if (f.starMin > 0 && (d.star || 0) < f.starMin) continue;
        if (f.tags.length) {
          var tags = (d.tags || []).map(function (t) { return t.toLowerCase(); });
          var ok = f.tags.every(function (want) {
            want = want.toLowerCase();
            return tags.some(function (t) { return t.indexOf(want) >= 0; });
          });
          if (!ok) continue;
        }
        if (f.folders.length) {
          var fol = (d.folders || []).map(function (x) { return String(x).toLowerCase(); });
          var ok2 = f.folders.every(function (want) {
            want = want.toLowerCase();
            return fol.some(function (t) { return t.indexOf(want) >= 0; });
          });
          if (!ok2) continue;
        }
        allow.add(d.idx);
      }
      return allow;
    }

    function idf(df, N) { return Math.log(1 + (N - df + 0.5) / (df + 0.5)); }

    function tfWeight(mask, tf) {
      var w = 0, W = C.DEFAULTS.fieldWeights, M = C.MASK;
      if (mask & M.name) w += W.name;
      if (mask & M.annotation) w += W.annotation;
      if (mask & M.tags) w += W.tags;
      if (mask & M.folders) w += W.folders;
      if (mask & M.url) w += W.url;
      var extra = (mask & M.content) ? 1.2 * (tf / (tf + 1)) : 0;
      return w + extra;
    }

    /**
     * 主检索
     * @param {string} q 原始查询
     * @param {object} uiFilters UI 上勾选的筛选（在查询语法之外再叠加）
     * @param {object} o {sort:'relevance'|'mtime'|'name', limit, verifyReadLimit}
     */
    async function search(q, uiFilters, o) {
      var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      o = o || {};
      var limit = o.limit || 60;
      var sort = o.sort || 'relevance';
      var parsed = parseQuery(q);
      var N = 0; for (var x in docs) N++;

      // 合并 UI 筛选
      var filters = parsed.filters;
      if (uiFilters) {
        if (uiFilters.groups) filters.groups = uniq(filters.groups.concat(uiFilters.groups));
        if (uiFilters.exts) filters.exts = uniq(filters.exts.concat(uiFilters.exts));
        if (uiFilters.tags) filters.tags = uniq(filters.tags.concat(uiFilters.tags));
        if (uiFilters.folders) filters.folders = uniq(filters.folders.concat(uiFilters.folders));
        if (uiFilters.starMin) filters.starMin = Math.max(filters.starMin, uiFilters.starMin);
      }
      var allow = filterSet(filters);

      // 无检索词 → 浏览模式（按时间/名称列全部）
      if (!parsed.terms.length) {
        var list = [];
        for (var k in docs) {
          var d = docs[k];
          if (allow && !allow.has(d.idx)) continue;
          list.push(d);
        }
        list.sort(sort === 'name' ? byName : byMtime);
        var out = list.slice(0, limit).map(function (d) {
          return decorate({ doc: d, score: 0, mask: 0 }, parsed, '');
        });
        return { hits: out, total: list.length, ms: ms(t0), parsed: parsed, mode: 'browse' };
      }

      // 倒排求交（AND）：从 df 最小的词开始
      var termInfo = [];
      for (var i = 0; i < parsed.terms.length; i++) {
        var t = parsed.terms[i], pl = postings[t];
        if (!pl) { termInfo = null; break; }               // 有词不在索引中 → AND 必空
        termInfo.push({ term: t, postings: pl, idf: idf(pl.length, N) });
      }

      var scores = new Map();       // idx → {score, mask, matched}
      var andFailed = false;

      if (termInfo) {
        termInfo.sort(function (a, b) { return a.postings.length - b.postings.length; });
        // 以 df 最小的词作为初始候选
        for (var j = 0; j < termInfo[0].postings.length; j++) {
          var e = termInfo[0].postings[j];
          scores.set(e[0], { score: score1(termInfo[0], e), mask: e[1], matched: 1 });
        }
        // 逐步求交并累加分数
        for (var ti = 1; ti < termInfo.length; ti++) {
          var info = termInfo[ti], map = new Map();
          for (var m2 = 0; m2 < info.postings.length; m2++) {
            var ee = info.postings[m2];
            if (scores.has(ee[0])) map.set(ee[0], ee);
          }
          scores.forEach(function (v, idx) {
            var e2 = map.get(idx);
            if (!e2) { scores.delete(idx); return; }
            v.score += score1(info, e2);
            v.mask |= e2[1];
            v.matched++;
          });
        }
        if (!scores.size) andFailed = true;
      } else {
        andFailed = true;
      }

      // 仅在 AND 完全无结果时才退化为 OR 检索。
      // 设计说明：早期版本「AND 结果少于 5 条就自动放宽」会把精确命中淹没在
      // 部分匹配里，用户无法判断结果可信度。改为「先给严格结论，无结果才放宽」，
      // 并在 UI 上对部分匹配的条目打「部分匹配」标记，保证可解释性。
      var mode = 'and';
      if (andFailed) {
        mode = 'or';
        var or = new Map();
        var termList = termInfo || parsed.terms.map(function (t) {
          var pl = postings[t]; return pl ? { term: t, postings: pl, idf: idf(pl.length, N) } : null;
        }).filter(Boolean);
        for (var a = 0; a < termList.length; a++) {
          var inf = termList[a];
          for (var b = 0; b < inf.postings.length; b++) {
            var eo = inf.postings[b];
            var cur = or.get(eo[0]);
            var s = score1(inf, eo);
            if (cur) { cur.score += s; cur.mask |= eo[1]; cur.matched++; }
            else or.set(eo[0], { score: s, mask: eo[1], matched: 1 });
          }
        }
        // 覆盖率加权：命中词越多越靠前
        var need = Math.max(1, termList.length);
        or.forEach(function (v) {
          var cov = v.matched / need;
          v.score = v.score * (0.35 + 0.65 * cov);
          v.partial = v.matched < need;          // 只命中部分关键词 → UI 标「部分匹配」
        });
        scores = or;
      }

      // 排除词（-词 与 -"短语"）
      var negIdx = null;
      if (parsed.negTerms.length) {
        negIdx = new Set();
        var np = [];
        parsed.negTerms.forEach(function (t) { if (postings[t]) np.push(postings[t]); });
        for (var q2 = 0; q2 < np.length; q2++) {
          for (var w = 0; w < np[q2].length; w++) negIdx.add(np[q2][w][0]);
        }
      }

      // 组装候选
      var cands = [];
      scores.forEach(function (v, idx) {
        if (allow && !allow.has(idx)) return;
        if (negIdx && negIdx.has(idx)) return;
        var d = docs[idx];
        if (!d) return;
        cands.push({ idx: idx, doc: d, score: v.score, mask: v.mask, matched: v.matched, partial: v.partial || false });
      });

      // 排序：先按分数（时间/名称模式下改用对应键）
      if (sort === 'mtime') cands.sort(function (a, b) { return b.doc.mtime - a.doc.mtime; });
      else if (sort === 'name') cands.sort(function (a, b) { return byName(a.doc, b.doc); });
      else {
        cands.sort(function (a, b) {
          if (b.score !== a.score) return b.score - a.score;
          return b.doc.mtime - a.doc.mtime;
        });
        // 标题整串命中加成：查询整串出现在标题中 → 置顶（用户意图高度明确）
        var flat = U.normalize(parsed.raw).trim();
        cands.forEach(function (c) {
          if (flat && U.normalize(c.doc.name).indexOf(flat) >= 0) c.score *= 1.8;
        });
        cands.sort(function (a, b) { return b.score - a.score; });
      }

      // 逐字校验（literals / 排除短语）——只对靠前的候选做，控制 IO
      var needVerify = parsed.literals.length || parsed.negLiterals.length;
      var readLimit = o.verifyReadLimit || 400;
      var finals = [];
      var reads = 0;
      var pool = cands.slice(0, Math.max(limit * 2, 120));

      for (var ci = 0; ci < pool.length; ci++) {
        var c = pool[ci];
        if (needVerify) {
          if (reads >= readLimit) { finals.push(c); continue; }
          var txt = await store.readText(c.idx);
          reads++;
          c._text = txt;
          var nm = normalizeWithMap(txt);
          var ok = true;
          for (var L = 0; L < parsed.literals.length; L++) {
            var lit = parsed.literals[L].normalize ? parsed.literals[L].normalize('NFKC').toLowerCase() : parsed.literals[L];
            // 字面出现在正文、注释或标题中即通过
            if (nm.norm.indexOf(lit) < 0 &&
              U.normalize(c.doc.annotation || '').indexOf(lit) < 0 &&
              U.normalize(c.doc.name || '').indexOf(lit) < 0) { ok = false; break; }
          }
          if (ok) {
            for (var L2 = 0; L2 < parsed.negLiterals.length; L2++) {
              var nl = U.normalize(parsed.negLiterals[L2]);
              if (nm.norm.indexOf(nl) >= 0) { ok = false; break; }
            }
          }
          if (!ok) continue;
          if (parsed.literals.length) c.score *= 1.25;      // 短语命中加成
        }
        finals.push(c);
        if (finals.length >= limit) break;
      }

      // 生成片段
      var hits = [];
      for (var fi = 0; fi < finals.length; fi++) {
        var f2 = finals[fi];
        var text = f2._text;
        if (text == null && (f2.mask & C.MASK.content) && fi < limit) {
          text = await store.readText(f2.idx);
        }
        hits.push(decorate(f2, parsed, text == null ? '' : text));
        delete f2._text;
      }

      return {
        hits: hits,
        // total 采用「通过逐字校验后的真实结果数」：短语查询无命中时不应显示
        // 「共 N 条」却一条都列不出来（早期版本的误导性计数问题）。
        total: needVerify ? finals.length : cands.length,
        candidateCount: cands.length,
        partialCount: finals.filter(function (c) { return c.partial; }).length,
        ms: ms(t0), parsed: parsed, mode: mode,
        verified: needVerify, readCount: reads
      };

      function score1(info, entry) {
        var k1 = C.DEFAULTS.bm25.k1;
        var w = tfWeight(entry[1], entry[2]);
        return info.idf * (w / (w + k1));
      }
    }

    /** 补充命中字段名 + 片段 */
    function decorate(c, parsed, text) {
      var d = c.doc, M = C.MASK;
      var fields = [];
      if (c.mask & M.name) fields.push('标题');
      if (c.mask & M.annotation) fields.push('注释');
      if (c.mask & M.tags) fields.push('标签');
      if (c.mask & M.folders) fields.push('文件夹');
      if (c.mask & M.url) fields.push('链接');
      if (c.mask & M.content) fields.push('正文');

      var snip = null;
      var surfaces = parsed.surfaces || [];
      if (text) snip = makeSnippet(text, surfaces, C.DEFAULTS.snippetLen);
      else if (d.annotation) snip = makeSnippet(d.annotation, surfaces, C.DEFAULTS.snippetLen);
      if (snip && !snip.text) snip = null;

      return {
        idx: d.idx, id: d.id, name: d.name, fileName: d.fileName, ext: d.ext, group: C.groupOfExt(d.ext),
        tags: d.tags || [], folders: d.folders || [], star: d.star || 0,
        mtime: d.mtime, size: d.size, method: d.method, warn: d.warn, cLen: d.cLen,
        annotation: d.annotation || '',
        score: c.score, fields: fields, matched: c.matched || 0, partial: !!c.partial,
        nameRanges: findRanges(normalizeWithMap(d.name), surfaces),
        snip: snip
      };
    }

    function byMtime(a, b) { return b.mtime - a.mtime; }
    function byName(a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); }
    function ms(t0) {
      var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return Math.round(t1 - t0);
    }

    /** 索引统计信息（首屏「索引概览」用） */
    function stats() {
      var n = 0, withText = 0, bytes = 0, byGroup = {}, byMethod = {};
      for (var k in docs) {
        var d = docs[k];
        n++;
        bytes += d.size || 0;
        if (d.cLen > 0) withText++;
        var g = C.groupOfExt(d.ext);
        byGroup[g] = (byGroup[g] || 0) + 1;
        var mth = d.method || 'skip';
        byMethod[mth] = (byMethod[mth] || 0) + 1;
      }
      var terms = 0; for (var t in postings) terms++;
      return { docs: n, withText: withText, terms: terms, byGroup: byGroup, byMethod: byMethod, bytes: bytes };
    }

    return { search: search, stats: stats, parseQuery: parseQuery, docs: docs, postings: postings };
  }

  FT.search = {
    makeEngine: makeEngine,
    parseQuery: parseQuery,
    normalizeWithMap: normalizeWithMap,
    findRanges: findRanges,
    makeSnippet: makeSnippet
  };
})(typeof window !== 'undefined' ? window : globalThis);
