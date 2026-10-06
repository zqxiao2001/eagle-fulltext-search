/* =============================================================================
 * util.js —— 通用工具层
 * -----------------------------------------------------------------------------
 * 设计决策：
 *  1. 本插件所有 JS 均为「传统脚本 + IIFE」形式（非 ES Module），原因：Eagle 插件
 *     运行在 Electron 渲染进程（Chromium 107 + Node 16），只有传统脚本能直接使用
 *     顶层 require()；ESM 下无法 require('fs')。
 *  2. 所有模块挂到全局命名空间 FT.*，同时兼容 Node 环境（我的本地测试脚本直接
 *     require 这些文件跑真实数据），因此末尾统一做 `root.FT = FT` 处理。
 *  3. 不引入任何 npm 依赖：ZIP/OOXML 自研（zip.js），PDF 用本地内置 pdf.js。
 * ========================================================================== */
(function (root) {
  'use strict';

  var FT = (root.FT = root.FT || {});

  /* ---------------------------------------------------------------------------
   * 运行环境探测
   * ------------------------------------------------------------------------ */
  var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  var isEagle = typeof window !== 'undefined' && typeof window.eagle !== 'undefined';

  /* ---------------------------------------------------------------------------
   * 文本编码：统一按 UTF-8 读取，检测到大量替换字符（U+FFFD）时回退 GBK
   * 说明：Electron 107 与 Node 22 均内置 full-icu，TextDecoder('gbk') 可用，
   *      这是中文 txt/csv 常见编码问题的兜底方案。
   * ------------------------------------------------------------------------ */
  function decodeBuffer(buf) {
    if (!buf || !buf.length) return '';
    var start = 0, forced = null;
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) start = 3;      // UTF-8 BOM
    else if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) { start = 2; forced = 'utf-16le'; }
    else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { start = 2; forced = 'utf-16be'; }
    var body = buf.slice(start);
    if (forced) { try { return new TextDecoder(forced).decode(body); } catch (e) { /* 落到下面 */ } }

    var utf8 = body.toString('utf8');
    // 统计替换字符，超过千分之三且样本足够大 → 判定为非 UTF-8
    var bad = 0;
    for (var i = 0; i < utf8.length; i++) if (utf8.charCodeAt(i) === 0xFFFD) bad++;
    if (bad > 0 && bad / Math.max(1, utf8.length) > 0.003) {
      try {
        var gbk = new TextDecoder('gbk', { fatal: false }).decode(body);
        var bad2 = 0;
        for (var j = 0; j < gbk.length; j++) if (gbk.charCodeAt(j) === 0xFFFD) bad2++;
        if (bad2 < bad) return gbk;
      } catch (e) { /* GBK 不可用则保留 utf8 结果 */ }
    }
    return utf8;
  }

  /* ---------------------------------------------------------------------------
   * 控制字符清理：去掉 OOXML/PDF 提取中常见的 NUL、私用区字符、连续空白
   * 保留 \n \t，并把 3 个以上连续换行压成 2 个（片段展示更干净）
   * ------------------------------------------------------------------------ */
  function cleanText(s) {
    if (!s) return '';
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    s = s.replace(/[\uE000-\uF8FF]/g, '');          // 私用区
    s = s.replace(/\uFFFD/g, '');                    // 残留替换字符
    s = s.replace(/[ \t\u00A0]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  /* ---------------------------------------------------------------------------
   * 温和归一化（用于建索引与查询，两侧必须一致）
   *  - NFKC：全角→半角，兼容字符统一（如 ＡＢＣ→ABC、①②→1）
   *  - 小写化：拉丁文大小写不敏感
   * 注意：不做词干化（stemming）。原因：本插件面向中英混排的科研素材库，
   *      词干化对中文无效、对英文术语（如 scRNA-seq）反而有害；改为支持前缀通配。
   * ------------------------------------------------------------------------ */
  function normalize(s) {
    if (!s) return '';
    try { s = s.normalize('NFKC'); } catch (e) { /* 老 Node 兜底 */ }
    return s.toLowerCase();
  }

  /* ---------------------------------------------------------------------------
   * HTML 转义：所有渲染到 DOM 的文本必须经此函数，防止文件名/注释里的
   * <script> 等内容造成注入（素材库文件名不可信）
   * ------------------------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------------------------------------------------------------------
   * Node Buffer 收口
   * -----------------------------------------------------------------------------
   * Eagle 的渲染进程同时注入 Node 集成，因此 `Buffer` 是**全局**可用的。
   * 但测试宿主（jsdom / 纯浏览器）没有这个全局，只可能通过 require('buffer') 拿到。
   * 这里两条路都试，统一从 util 取，避免各处直接引用全局 —— 那种写法漏了守卫时
   * 不会报错、而是静默走进异常分支，比崩溃更难查（本项目就因此出现过「测试假绿」）。
   * ------------------------------------------------------------------------ */
  var NodeBuffer = (typeof Buffer !== 'undefined') ? Buffer : (function () {
    try { return require('buffer').Buffer; } catch (e) { return null; }
  })();

  /** 转成 Node Buffer；取不到就显式抛错，绝不静默降级出乱码 */
  function toBuffer(value, enc) {
    if (!NodeBuffer) throw new Error('当前环境没有 Buffer，无法处理二进制数据');
    return NodeBuffer.from(value, enc);
  }

  /* ---------------------------------------------------------------------------
   * 事件循环让渡：正文提取/分词是 CPU 密集任务，长时间同步执行会让插件窗口
   * 白屏。每处理 N 个文件或 M 字符后 await 一次，保持 UI 可响应 + 可取消。
   * ------------------------------------------------------------------------ */
  function tick() {
    return new Promise(function (r) {
      if (typeof setImmediate === 'function') setImmediate(r); else setTimeout(r, 0);
    });
  }

  /* 字节数格式化 */
  function formatBytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
  }

  /* 时间戳 → 相对时间（结果列表右侧显示） */
  function formatTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 86400000 * 30) return Math.floor(d / 86400000) + ' 天前';
    var dt = new Date(ts);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }

  /* 高亮渲染：给定原文 + 匹配区间数组 → 安全 HTML
   * 关键点：先按区间切分「原文」，再逐段转义，避免「先转义再匹配」导致
   * &quot; 之类实体被二次匹配（这是最常见的 XSS/错位高亮 bug 来源） */
  function highlightHtml(text, ranges, cls) {
    if (!text) return '';
    if (!ranges || !ranges.length) return escapeHtml(text);
    var out = '', last = 0;
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (r.start < last) continue;              // 重叠区间跳过
      if (r.start > last) out += escapeHtml(text.slice(last, r.start));
      out += '<mark class="' + (cls || '') + '">' + escapeHtml(text.slice(r.start, r.end)) + '</mark>';
      last = r.end;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  FT.util = {
    isNode: isNode, isEagle: isEagle,
    decodeBuffer: decodeBuffer, cleanText: cleanText, normalize: normalize,
    escapeHtml: escapeHtml, tick: tick, toBuffer: toBuffer,
    formatBytes: formatBytes, formatTime: formatTime, highlightHtml: highlightHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
