/* =============================================================================
 * tokenizer.js —— 中英混排分词器
 * -----------------------------------------------------------------------------
 * 设计决策（这是全文检索效果的核心，值得说明清楚）：
 *
 * 1) 中文采用「二元切分（bigram）」而不是引入 jieba 等分词库。
 *    理由：素材库里大量是专业术语与自造词组（例如「卷积神经网络」「扫描电子显微镜」
 *    这类长名词，以及 ALOX5、scRNA-seq 这样的拉丁术语）。通用分词词典对术语的
 *    切分不稳定，一旦切错，检索就永远召不回（这是中文检索最常见的失败模式）。
 *    bigram 无词典、无歧义，召回率最高；精度问题用「原文逐字校验 + BM25 打分」补回来。
 *    例：「计算机视觉」→ 索引词 计算 / 算机 / 机视 / 视觉；查询同法切分后取交集，
 *    再用原文校验是否真的连续出现「计算机视觉」。
 *
 * 2) 拉丁文/数字按「词」切分，并保留连接符：scRNA-seq、IL-1β、3.5、a/b
 *    这类 token 一旦被拆开就无法检索，因此 '-' '_' '.' '/' '+' 在其两侧都是
 *    词字符时视为词内连接符。大小写经 NFKC + 小写化统一。
 *
 * 3) 不做词干化。中文无效，英文术语（single-cell → single cell）反而有害。
 *    前缀检索需求用查询语法 `term*` 支持。
 *
 * 4) 单一汉字（如「鼠」）会单独成为 term，但仅当它在原文中独立成段（CJK run
 *    长度为 1）时才产生；中文连续串不额外索引所有单字，避免倒排表爆炸。
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});
  var norm = FT.util.normalize;

  /* CJK / 假名 / 谚文 判定 */
  function isCJK(cp) {
    return (cp >= 0x3040 && cp <= 0x30FF) ||   // 平假名/片假名
      (cp >= 0x3400 && cp <= 0x4DBF) ||        // 扩展 A
      (cp >= 0x4E00 && cp <= 0x9FFF) ||        // 基本区
      (cp >= 0xF900 && cp <= 0xFAFF) ||        // 兼容表意
      (cp >= 0xAC00 && cp <= 0xD7AF) ||        // 谚文
      (cp >= 0x20000 && cp <= 0x2FA1F);        // 扩展 B+
  }
  /* 词内字符：数字、拉丁字母、拉丁扩展、希腊字母（β/α/γ 常见于细胞因子名） */
  function isWordChar(cp) {
    return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x61 && cp <= 0x7A) ||
      (cp >= 0x00C0 && cp <= 0x024F) || (cp >= 0x0370 && cp <= 0x03FF);
  }
  function isJoiner(cp) { return cp === 0x2D || cp === 0x5F || cp === 0x2E || cp === 0x2F || cp === 0x2B || cp === 0x27; }

  /* 极简停用词：只去掉「几乎不承载检索信息」的高频词 */
  var STOP = {};
  ('的 了 是 在 和 与 及 或 有 我 你 他 她 它 这 那 就 都 而 也 很 到 说 要 会 于 以 为 被 把 让 给 对 从 但 又 还 等 ' +
    'the a an and or of to in for is are was were be been on at by with from as it this that these those ' +
    '我 你 他 not no do does did can could will would should').split(/\s+/).forEach(function (w) { if (w) STOP[w] = 1; });

  /**
   * 主分词：返回 {terms: Map<term, tf>, cjk: [原始中文串...]}
   * cjk 用于查询侧的「原文校验」（短语/精确匹配）
   */
  function tokenize(text) {
    var terms = new Map();
    var cjkRuns = [];
    if (!text) return { terms: terms, cjk: cjkRuns };
    var s = norm(text);
    var i = 0, len = s.length;

    function add(t) {
      if (!t) return;
      if (STOP[t]) return;
      var cp = t.codePointAt(0);
      // 单个拉丁字母/希腊字母噪声过大，不索引；单个汉字保留（信息量高）
      if (!isCJK(cp) && t.length < 2 && !(cp >= 0x30 && cp <= 0x39)) return;
      terms.set(t, (terms.get(t) || 0) + 1);
    }

    while (i < len) {
      var cp = s.codePointAt(i);
      var cw = cp > 0xFFFF ? 2 : 1;

      if (isCJK(cp)) {
        /* ---- CJK 连串 → bigram ---- */
        var run = [], j = i;
        while (j < len) {
          var c2 = s.codePointAt(j);
          if (!isCJK(c2)) break;
          run.push(s.substr(j, c2 > 0xFFFF ? 2 : 1));
          j += c2 > 0xFFFF ? 2 : 1;
        }
        cjkRuns.push(run.join(''));
        // 一元 + 二元统一切分：
        //   一元（单字）——保证「单字查询」可用；
        //   二元（相邻两字）——保证多字词的高召回。
        // 不再额外索引「整串 run」：那会造成「建索引按 run 切、查询按用户输入切」
        // 的不对称——例如正文里是「深度学习方法综述」这一整个 run，而用户查
        // 「深度学习方法」时该 6 字串在倒排中并不存在，AND 必然为空，只能退化为 OR，
        // 既损失精度又误判为「部分匹配」。一元+二元是对称且够用的方案。
        for (var u = 0; u < run.length; u++) add(run[u]);
        for (var k = 0; k + 1 < run.length; k++) add(run[k] + run[k + 1]);
        i = j;
        continue;
      }

      if (isWordChar(cp)) {
        /* ---- 拉丁词，允许词内连接符 ---- */
        var word = '', p = i;
        while (p < len) {
          var cc = s.codePointAt(p);
          var st = cc > 0xFFFF ? 2 : 1;
          if (isWordChar(cc)) { word += s.substr(p, st); p += st; continue; }
          if (isJoiner(cc) && p + st < len) {
            var nx = s.codePointAt(p + st);
            var nxst = nx > 0xFFFF ? 2 : 1;
            if (isWordChar(nx)) { word += s.substr(p, st); p += st; continue; }
          }
          break;
        }
        add(word);
        i = p;
        continue;
      }
      i += cw;                                   // 标点/空白/其他符号：分隔
    }
    return { terms: terms, cjk: cjkRuns };
  }

  /** 查询侧：把用户输入切成索引词（与建索引规则一致） */
  function queryTerms(q) { return Array.from(tokenize(q).terms.keys()); }

  FT.tokenizer = {
    tokenize: tokenize,
    queryTerms: queryTerms,
    isCJK: isCJK,
    isWordChar: isWordChar,
    STOP: STOP
  };
})(typeof window !== 'undefined' ? window : globalThis);
