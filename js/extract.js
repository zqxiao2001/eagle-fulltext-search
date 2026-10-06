/* =============================================================================
 * extract.js —— 正文提取层（按扩展名分派）
 * -----------------------------------------------------------------------------
 * 覆盖格式：
 *   文本类  txt md markdown csv tsv json jsonl xml yaml yml log srt vtt tex bib
 *          代码类(py/js/ts/java/c/cpp/h/sql/sh/r/ini/conf/toml) + 未知扩展名启发式
 *   PDF     pdf（内置 pdf.js 3.11.174 legacy，含 CJK cmaps）
 *   OOXML   docx pptx xlsx（自研 ZIP + XML 解析，含页眉页脚/备注/批注/sharedStrings）
 *   ODF     odt ods odp（content.xml）
 *   ePub    epub（全部 xhtml）
 *   RTF     rtf
 *   旧二进制 doc xls ppt wps et（启发式提取，标注为近似结果）
 *
 * 统一契约：
 *   extract({ buffer, ext, filePath, opts }) -> Promise<{ text, method, warning }>
 *   method 取值：utf8 / gbk / pdf / ooxml / odf / epub / rtf / legacy-binary / skip
 *   返回 text 为 '' 表示「无正文可索引」（图片、音视频、字体、加密文件等），
 *   此时该条目仍会以「标题/注释/标签」参与检索。
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});
  var U = FT.util;

  /* ---------------------------------------------------------------------------
   * 格式分类表
   * ------------------------------------------------------------------------ */
  var PLAIN = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml',
    'log', 'srt', 'vtt', 'ass', 'tex', 'bib', 'py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java',
    'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'zsh',
    'bash', 'bat', 'ps1', 'sql', 'r', 'm', 'jl', 'lua', 'pl', 'ini', 'conf', 'cfg', 'toml', 'env',
    'properties', 'gitignore', 'dockerfile', 'makefile', 'cmake', 'diff', 'patch', 'nfo', 'smi', 'sami'];
  var OOXML = { docx: 'word', pptx: 'ppt', xlsx: 'xl' };
  var ODF = ['odt', 'ods', 'odp', 'fodt'];
  var SKIP_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg',
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', 'wmv', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg',
    'ttf', 'otf', 'woff', 'woff2', 'psd', 'ai', 'sketch', 'fig', 'blend', 'obj', 'fbx', 'stl', '3ds',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'pkg', 'exe', 'dll', 'so', 'dylib', 'iso'];

  /* ---------------------------------------------------------------------------
   * 文本清洗：把 XML/HTML 标记转成纯文本
   *  - 先摘掉 script/style（其内容不是正文）
   *  - 块级结束标签 → \n，单元格 → \t
   *  - 解实体
   * ------------------------------------------------------------------------ */
  function stripMarkup(html, opts) {
    opts = opts || {};
    var s = String(html || '');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<\?[\s\S]*?\?>/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|dd|dt|pre|figcaption|title|caption)>/gi, '\n');
    s = s.replace(/<\/t[dh]>/gi, '\t');
    s = s.replace(/<li[^>]*>/gi, '\n· ');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    return s;
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return safeChar(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return safeChar(parseInt(d, 10)); })
      .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
      .replace(/&middot;/gi, '·').replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
      .replace(/&hellip;/gi, '…').replace(/&ldquo;/gi, '“').replace(/&rdquo;/gi, '”')
      .replace(/&amp;/gi, '&');
  }
  function safeChar(cp) {
    if (!cp || cp < 0 || cp > 0x10FFFF) return '';
    try { return String.fromCodePoint(cp); } catch (e) { return ''; }
  }

  /* ---------------------------------------------------------------------------
   * PDF：pdf.js 文本抽取
   * 环境差异：
   *   - Eagle 渲染进程：index.html 用 <script src="libs/pdfjs/pdf.js"> 载入，
   *     globalThis.pdfjsLib 存在；workerSrc 指向本地 pdf.worker.js，若 file:// 下
   *     Worker 创建失败，pdf.js 会自动降级为主线程 fake worker。
   *   - Node 测试环境：require 绝对路径的 legacy build。
   * CJK 关键点：必须提供 cMapUrl（内置 168 个 .bcmap），否则中文 PDF 会抽出乱码。
   * ------------------------------------------------------------------------ */
  var _pdfjs = null;
  function getPdfjs() {
    if (_pdfjs) return _pdfjs;
    if (root.pdfjsLib) { _pdfjs = root.pdfjsLib; return _pdfjs; }      // Eagle 渲染进程：index.html 的 <script> 已载入
    if (typeof require === 'function' && FT.config && FT.config.PLUGIN_DIR) {
      try { _pdfjs = require(FT.config.PLUGIN_DIR + '/libs/pdfjs/pdf.js'); return _pdfjs; } catch (e) { /* 继续 */ }
    }
    try { _pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } catch (e) { _pdfjs = null; }
    return _pdfjs;
  }

  /* ---------------------------------------------------------------------------
   * pdf.js 环境装配（渲染进程里的三个坑，逐个绕开）
   *  坑 1｜Worker：Eagle 插件页面是 file:// 源，Chromium 会拦截 file:// 的 Worker
   *       与动态 import，pdf.js 的 worker 起不来。解法：显式把 pdf.worker.js
   *       通过 require 挂到 globalThis.pdfjsWorker —— pdf.js 检测到该全局变量
   *       后会直接走「主线程 fake worker」，不再尝试创建 Worker。
   *  坑 2｜CMap：默认的 DOMCMapReaderFactory 用 fetch 读 cMapUrl，file:// 下同样
   *       被拦截，中文 PDF 会抽出乱码。解法：注入基于 Node fs 的 CMapReaderFactory
   *       直接读本地 cmaps 目录（1.6MB / 168 个 bcmap，随插件分发）。
   *  坑 3｜Electron 判定：pdf.js 的 isNodeJS 在 Electron 渲染进程里为 false
   *       （它显式排除了 process.type !== 'browser'），因此不会自动走 Node 分支，
   *       上面两条兜底是必需的。
   * ------------------------------------------------------------------------ */
  var _pdfSetup = null;
  function setupPdfjs() {
    var lib = getPdfjs();
    if (!lib) return null;
    if (_pdfSetup && _pdfSetup.lib === lib) return _pdfSetup;

    var base = (FT.config && FT.config.PLUGIN_DIR) ? FT.config.PLUGIN_DIR : '.';
    var hasRequire = (typeof require === 'function');
    var setup = { lib: lib, extra: {} };

    // 坑 1：主线程 worker 处理器
    if (hasRequire && !root.pdfjsWorker) {
      try { root.pdfjsWorker = require(base + '/libs/pdfjs/pdf.worker.js'); }
      catch (e) { /* 失败则退回 pdf.js 默认逻辑，不影响非 PDF 条目 */ }
    }

    // 坑 2：fs 版 CMap 读取器
    if (hasRequire && lib.CMapReaderFactory) {
      try {
        var fs = require('fs');
        var BaseF = lib.CMapReaderFactory;
        function FsCMapReaderFactory(params) { BaseF.call(this, params); }
        FsCMapReaderFactory.prototype = Object.create(BaseF.prototype);
        FsCMapReaderFactory.prototype.constructor = FsCMapReaderFactory;
        FsCMapReaderFactory.prototype.fetch = function (data) {
          var name = data && data.name;
          try {
            var buf = fs.readFileSync(base + '/libs/pdfjs/cmaps/' + name + '.bcmap');
            return Promise.resolve({ cMapData: new Uint8Array(buf), isCompressed: true });
          } catch (e) { return Promise.reject(e); }
        };
        setup.extra.CMapReaderFactory = FsCMapReaderFactory;
      } catch (e) { /* 注入失败：退回默认 fetch 工厂 */ }
    }

    // 保留 workerSrc 设置（在能创建 Worker 的环境里可提升性能）
    try {
      if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = base + '/libs/pdfjs/pdf.worker.js';
      }
    } catch (e) { /* 忽略 */ }

    _pdfSetup = setup;
    return setup;
  }

  async function extractPdf(buffer, opts) {
    var setup = setupPdfjs();
    if (!setup) return { text: '', method: 'pdf', warning: 'pdf.js 未加载，跳过 PDF 正文' };
    var lib = setup.lib;
    var base = (FT.config && FT.config.PLUGIN_DIR) ? FT.config.PLUGIN_DIR : '.';
    var doc = null;
    try {
      var params = {
        data: new Uint8Array(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer),
        cMapUrl: base + '/libs/pdfjs/cmaps/',
        cMapPacked: true,
        // 不渲染、不取字体，纯文本抽取更快且不需要 canvas
        disableFontFace: true,
        isEvalSupported: false,
        useSystemFonts: false,
        verbosity: 0
      };
      if (setup.extra.CMapReaderFactory) params.CMapReaderFactory = setup.extra.CMapReaderFactory;
      var task = lib.getDocument(params);
      doc = await task.promise;
      var parts = [];
      var maxChars = (opts && opts.maxChars) || 200000;
      var total = 0;
      var pages = doc.numPages;
      for (var i = 1; i <= pages; i++) {
        var page = await doc.getPage(i);
        var tc = await page.getTextContent();
        var line = '', prevY = null, buf2 = [];
        for (var k = 0; k < tc.items.length; k++) {
          var it = tc.items[k];
          if (typeof it.str !== 'string') continue;
          var y = it.transform ? it.transform[5] : null;
          // 依据 y 坐标变化插入换行，避免整页文字挤成一行（影响片段可读性）
          if (prevY !== null && y !== null && Math.abs(y - prevY) > 4) { buf2.push('\n'); }
          buf2.push(it.str);
          if (it.hasEOL) buf2.push('\n');
          prevY = y;
        }
        line = buf2.join('');
        parts.push(line);
        total += line.length;
        if (total >= maxChars) break;
        await U.tick();                       // 每页让出事件循环，UI 不卡
      }
      return { text: parts.join('\n'), method: 'pdf', warning: '', pages: pages };
    } catch (e) {
      return { text: '', method: 'pdf', warning: 'PDF 解析失败：' + (e && e.message ? e.message : e) };
    } finally {
      try { if (doc) await doc.destroy(); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------------------------------------------------------------------------
   * OOXML（docx / pptx / xlsx）
   * 说明：不追求版式还原，只追求「正文文字不漏」——因为目标是全文检索。
   *  docx : document.xml + 页眉页脚 + 脚注尾注 + 批注 + 文本框（都在 document.xml 内）
   *  pptx : slides + notesSlides
   *  xlsx : sharedStrings + 各 worksheet（含 t="s" 索引还原、inlineStr、数值原文）
   * ------------------------------------------------------------------------ */
  function ooxmlXmlToText(xml, kind) {
    var s = String(xml || '');
    if (kind === 'docx') {
      s = s.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, ' ');     // 域代码（如页码域）不是正文
      s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
      s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
      s = s.replace(/<\/w:p>/g, '\n');
      s = s.replace(/<\/w:tc>/g, '\t');
      s = s.replace(/<\/w:(tr|tbl)>/g, '\n');
      s = s.replace(/<[^>]+>/g, '');                                   // 剩余标签全去掉
    } else if (kind === 'pptx') {
      s = s.replace(/<a:br\b[^>]*\/?>/g, '\n');
      s = s.replace(/<\/a:p>/g, '\n');
      s = s.replace(/<[^>]+>/g, '');
    } else {
      s = s.replace(/<[^>]+>/g, ' ');
    }
    return decodeEntities(s);
  }

  async function extractDocx(zip) {
    var out = [];
    var targets = ['word/document.xml'];
    zip.names.forEach(function (n) {
      if (/^word\/(header|footer)\d*\.xml$/.test(n) ||
        /^word\/(footnotes|endnotes|comments)\.xml$/.test(n)) targets.push(n);
    });
    for (var i = 0; i < targets.length; i++) {
      if (!zip.has(targets[i])) continue;
      var t = ooxmlXmlToText(zip.readText(targets[i]), 'docx');
      if (t && t.trim()) out.push(cleanDocxText(t));
      await U.tick();
    }
    // 文档属性（标题/主题/关键词），有些库把关键信息只写在这里
    if (zip.has('docProps/core.xml')) {
      var core = zip.readText('docProps/core.xml');
      var meta = [];
      ['dc:title', 'dc:subject', 'dc:description', 'cp:keywords', 'dc:creator'].forEach(function (tag) {
        var m = core.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
        if (m && m[1].trim()) meta.push(decodeEntities(m[1]));
      });
      if (meta.length) out.push(meta.join(' '));
    }
    return out.join('\n');
  }

  function cleanDocxText(t) { return t.replace(/\u0000/g, '').replace(/[ \t]*\n[ \t]*/g, '\n'); }

  async function extractPptx(zip) {
    var out = [];
    var slides = zip.names.filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
      .sort(function (a, b) { return parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10); });
    var notes = zip.names.filter(function (n) { return /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n); });
    var all = slides.concat(notes);
    for (var i = 0; i < all.length; i++) {
      var t = ooxmlXmlToText(zip.readText(all[i]), 'pptx');
      if (t && t.trim()) out.push(t.trim());
      if (i % 10 === 0) await U.tick();
    }
    return out.join('\n');
  }

  async function extractXlsx(zip) {
    // sharedStrings：`<si>` 为一个字符串，内部可能被 `<r>` 拆成多段 `<t>`
    var shared = [];
    if (zip.has('xl/sharedStrings.xml')) {
      var sx = zip.readText('xl/sharedStrings.xml');
      var re = /<si\b[^>]*>([\s\S]*?)<\/si>/g, m;
      while ((m = re.exec(sx))) {
        var inner = m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '');         // 注音不是正文
        var t = '';
        var tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g, tm;
        while ((tm = tre.exec(inner))) t += decodeEntities(tm[1]);
        shared.push(t);
      }
    }
    var out = [];
    // 工作表名
    if (zip.has('xl/workbook.xml')) {
      var wb = zip.readText('xl/workbook.xml');
      var nm = wb.match(/<sheet\b[^>]*name="([^"]*)"/g) || [];
      out.push(nm.map(function (s) { return s.replace(/.*name="([^"]*)".*/, '$1'); }).join(' '));
    }
    var sheets = zip.names.filter(function (n) { return /^xl\/worksheets\/sheet\d*\.xml$/.test(n); });
    for (var i = 0; i < sheets.length; i++) {
      var xml = zip.readText(sheets[i]);
      var cells = [];
      var cre = /<c\b([^>]*)>([\s\S]*?)<\/c>/g, cm;
      while ((cm = cre.exec(xml))) {
        var attrs = cm[1], body = cm[2];
        var type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
        if (type === 'inlineStr') {
          var isM = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
          if (isM) cells.push(decodeEntities(isM[1]));
        } else {
          var vM = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          if (!vM) continue;
          var v = decodeEntities(vM[1]);
          if (type === 's') {
            var idx = parseInt(v, 10);
            if (!isNaN(idx) && shared[idx] != null) cells.push(shared[idx]);   // 共享字符串还原
          } else if (type === 'str' || type === 'e') {
            cells.push(v);
          } else if (v !== '') {
            cells.push(v);                                                     // 数值/日期原文
          }
        }
      }
      if (cells.length) out.push(cells.join(' '));
      await U.tick();
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------------------
   * ODF（odt/ods/odp）：content.xml 里 <text:p>/<text:h> 为段落
   * ------------------------------------------------------------------------ */
  async function extractOdf(zip) {
    if (!zip.has('content.xml')) return '';
    var s = zip.readText('content.xml');
    s = s.replace(/<text:s\b[^>]*\/>/g, ' ');
    s = s.replace(/<text:tab\b[^>]*\/>/g, '\t');
    s = s.replace(/<\/text:(p|h)>/g, '\n');
    s = s.replace(/<\/table:table-cell>/g, '\t');
    s = s.replace(/<\/table:table-row>/g, '\n');
    return decodeEntities(s.replace(/<[^>]+>/g, ''));
  }

  /* ---------------------------------------------------------------------------
   * ePub：全部 xhtml/html
   * ------------------------------------------------------------------------ */
  async function extractEpub(zip, opts) {
    var parts = [], total = 0, maxChars = (opts && opts.maxChars) || 200000;
    for (var i = 0; i < zip.names.length; i++) {
      var n = zip.names[i];
      if (!/\.(x?html?|xml)$/i.test(n)) continue;
      var t = stripMarkup(zip.readText(n));
      if (t && t.trim()) { parts.push(t.trim()); total += t.length; }
      if (total >= maxChars) break;
      if (i % 10 === 0) await U.tick();
    }
    return parts.join('\n');
  }

  /* ---------------------------------------------------------------------------
   * RTF：控制字清理 + \'hh 十六进制字节还原（中文 RTF 常用 GBK）
   * ------------------------------------------------------------------------ */

  /* 这些组的内容不是正文，必须整组摘除。
     注意 `{\fonttbl...}` 是**普通组**而非 `{\*\...}` 目标组，
     早先只删后者，导致字体名（如 `SimSun;`）漏进正文，污染检索结果与片段展示。
     摘除时要按**花括号配对**遍历（RTF 组可嵌套），不能用非贪婪正则。 */
  var RTF_SKIP_GROUP = /^\{\\(?:fonttbl|colortbl|stylesheet|listtable|listoverridetable|generator|info|pict|themedata|colorschememapping|latentstyles|rsidtbl|xmlnstbl|filetbl|revtbl|datastore|mmathPr)\b|^\{\\\*/;

  function stripRtfGroups(s) {
    var out = '', i = 0;
    while (i < s.length) {
      if (s.charAt(i) !== '{') { out += s.charAt(i); i++; continue; }
      var depth = 0, j = i;
      for (; j < s.length; j++) {
        var ch = s.charAt(j);
        if (ch === '\\') { j++; continue; }          // 跳过 \{ \} \\ 的转义字符，避免误判配对
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      var inner = s.slice(i + 1, Math.max(i + 1, j - 1));   // 去掉外层花括号
      if (RTF_SKIP_GROUP.test('{' + inner)) {
        out += ' ';
      } else {
        // 【关键】必须递归：整篇文档本身就是一个 `{\rtf1...}` 组，
        // 只判断最外层的话，嵌套在里面的 {\fonttbl...} 永远看不到。
        out += '{' + stripRtfGroups(inner) + '}';
      }
      i = j;
    }
    return out;
  }

  function rtfToText(raw) {
    var s = stripRtfGroups(String(raw || ''));
    s = s.replace(/\\u(-?\d+)\s?\??/g, function (m, d) {
      var c = parseInt(d, 10); if (c < 0) c += 65536;
      return safeChar(c);
    });
    s = s.replace(/\\'([0-9a-fA-F]{2})/g, function (m, h) {
      // 单字节编码还原：先收集为 Latin-1 字节，稍后整体按 GBK 尝试解码
      return String.fromCharCode(parseInt(h, 16));
    });
    s = s.replace(/\\par\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, '\t');
    s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, '');      // 其余控制字
    s = s.replace(/[{}]/g, '');
    s = s.replace(/\\\\/g, '\\');
    // 再次尝试把 Latin-1 字节串按 GBK 还原（中文 RTF 的常见情形）
    try {
      var codes = [], needGbk = false;
      for (var i = 0; i < s.length; i++) {
        var cc = s.charCodeAt(i);
        codes.push(cc);
        if (cc >= 0x80 && cc <= 0xFF) needGbk = true;
      }
      if (needGbk) {
        var buf = U.toBuffer(codes.map(function (c) { return c & 0xFF; }));
        var g = new TextDecoder('gbk', { fatal: false }).decode(buf);
        var bad = (g.match(/\uFFFD/g) || []).length;
        if (bad < codes.length * 0.05) return g;
      }
    } catch (e) { /* 忽略 */ }
    return s;
  }

  /* ---------------------------------------------------------------------------
   * 旧版二进制 Office（doc/xls/ppt/wps/et）
   * 诚实说明：这是「近似提取」，不做完整 OLE/CFB 结构解析（那需要几 MB 的依赖）。
   * 策略：同时尝试 UTF-16LE 与 GBK 两条通道，保留连续可打印片段，并按
   *      「片段中中英文数字占比」过滤，避免把二进制噪声当成正文。
   * 结果会带 warning，UI 中标注「近似提取」，不参与高可信度展示。
   * ------------------------------------------------------------------------ */
  function legacyBinaryText(buf) {
    var cands = [];
    // 通道 1：UTF-16LE
    var run = [];
    for (var i = 0; i + 1 < buf.length; i += 2) {
      var cp = buf.readUInt16LE(i);
      if (isTextish(cp)) run.push(cp);
      else { if (run.length >= 4) cands.push(String.fromCharCode.apply(null, run)); run = []; }
    }
    if (run.length >= 4) cands.push(String.fromCharCode.apply(null, run));
    // 通道 2：GBK（字节 0x20-0x7E 与双字节汉字区）
    var bytes = [], byteRuns = [];
    for (var j = 0; j < buf.length; j++) {
      var b = buf[j];
      if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7E)) { bytes.push(b); continue; }
      if (b >= 0x81 && b <= 0xFE && j + 1 < buf.length && buf[j + 1] >= 0x40 && buf[j + 1] <= 0xFE) {
        bytes.push(b); bytes.push(buf[j + 1]); j++; continue;
      }
      if (bytes.length >= 6) byteRuns.push(U.toBuffer(bytes));
      bytes = [];
    }
    if (bytes.length >= 6) byteRuns.push(U.toBuffer(bytes));
    byteRuns.forEach(function (r) {
      try { cands.push(new TextDecoder('gbk', { fatal: false }).decode(r)); } catch (e) { /* 忽略 */ }
    });

    // 过滤：中英文数字占比达标，且长度足够
    var kept = [];
    var seen = Object.create(null);
    for (var k = 0; k < cands.length; k++) {
      var t = cands[k].replace(/[\u0000-\u001F]/g, ' ').trim();
      if (t.length < 4) continue;
      var good = 0;
      for (var q = 0; q < t.length; q++) {
        var c = t.charCodeAt(q);
        if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x30 && c <= 0x39) ||
          (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x20) good++;
      }
      if (good / t.length < 0.7) continue;
      var key = t.slice(0, 24);
      if (seen[key]) continue;
      seen[key] = 1;
      kept.push(t);
      if (kept.length > 800) break;
    }
    return kept.join('\n');
  }
  function isTextish(cp) {
    return (cp >= 0x20 && cp <= 0x7E) || (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3000 && cp <= 0x303F) || (cp >= 0xFF00 && cp <= 0xFFEF) || cp === 9 || cp === 10 || cp === 13;
  }

  /* ---------------------------------------------------------------------------
   * 未知扩展名：先判断是否「像文本」，像则按文本索引
   * ------------------------------------------------------------------------ */
  function looksLikeText(buf) {
    var n = Math.min(buf.length, 8192), printable = 0;
    for (var i = 0; i < n; i++) {
      var b = buf[i];
      if (b === 0) return false;                      // 出现 NUL 基本可判定为二进制
      if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x7E) || b >= 0x80) printable++;
    }
    return n > 0 && printable / n > 0.9;
  }

  /* ---------------------------------------------------------------------------
   * 主入口
   * ------------------------------------------------------------------------ */
  async function extract(ctx) {
    var buffer = ctx.buffer, ext = String(ctx.ext || '').toLowerCase();
    var opts = ctx.opts || {};
    var maxChars = opts.maxChars || 200000;

    if (buffer == null) return { text: '', method: 'skip', warning: '文件无法读取' };
    if (SKIP_EXT.indexOf(ext) >= 0) return { text: '', method: 'skip', warning: '' };

    try {
      /* ---- PDF ---- */
      if (ext === 'pdf') {
        var r = await extractPdf(buffer, { maxChars: maxChars });
        return { text: U.cleanText(r.text).slice(0, maxChars), method: 'pdf', warning: r.warning || '' };
      }

      /* ---- OOXML ---- */
      if (OOXML[ext]) {
        var zip = FT.zip.readZip(buffer);
        var text = ext === 'docx' ? await extractDocx(zip)
          : ext === 'pptx' ? await extractPptx(zip)
            : await extractXlsx(zip);
        return { text: U.cleanText(text).slice(0, maxChars), method: 'ooxml', warning: '' };
      }

      /* ---- ODF ---- */
      if (ODF.indexOf(ext) >= 0) {
        var z2 = FT.zip.readZip(buffer);
        return { text: U.cleanText(await extractOdf(z2)).slice(0, maxChars), method: 'odf', warning: '' };
      }

      /* ---- ePub ---- */
      if (ext === 'epub') {
        var z3 = FT.zip.readZip(buffer);
        return { text: U.cleanText(await extractEpub(z3, { maxChars: maxChars })).slice(0, maxChars), method: 'epub', warning: '' };
      }

      /* ---- RTF ---- */
      if (ext === 'rtf') {
        return { text: U.cleanText(rtfToText(U.decodeBuffer(buffer))).slice(0, maxChars), method: 'rtf', warning: '' };
      }

      /* ---- HTML ---- */
      if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
        return { text: U.cleanText(stripMarkup(U.decodeBuffer(buffer))).slice(0, maxChars), method: 'utf8', warning: '' };
      }

      /* ---- 旧版二进制 Office ---- */
      if (['doc', 'xls', 'ppt', 'wps', 'et', 'dps'].indexOf(ext) >= 0) {
        var legacy = legacyBinaryText(buffer);
        return {
          text: U.cleanText(legacy).slice(0, maxChars),
          method: 'legacy-binary',
          warning: legacy ? '旧版二进制格式，正文为近似提取' : '旧版二进制格式，未能提取正文'
        };
      }

      /* ---- 纯文本家族 / 未知扩展名 ---- */
      if (PLAIN.indexOf(ext) >= 0 || looksLikeText(buffer)) {
        var txt = U.decodeBuffer(buffer);
        return { text: U.cleanText(txt).slice(0, maxChars), method: 'utf8', warning: '' };
      }

      return { text: '', method: 'skip', warning: '' };
    } catch (e) {
      return { text: '', method: 'error', warning: (ext || '未知格式') + ' 提取失败：' + (e && e.message ? e.message : e) };
    }
  }

  FT.extract = {
    extract: extract,
    stripMarkup: stripMarkup,
    legacyBinaryText: legacyBinaryText,
    looksLikeText: looksLikeText,
    PLAIN: PLAIN, SKIP_EXT: SKIP_EXT, OOXML: OOXML, ODF: ODF
  };
})(typeof window !== 'undefined' ? window : globalThis);
