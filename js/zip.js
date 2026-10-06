/* =============================================================================
 * zip.js —— 纯 Node 原生 ZIP 读取器（零依赖）
 * -----------------------------------------------------------------------------
 * 为什么自己写：docx / pptx / xlsx / epub / odt 本质都是 ZIP 容器，抽取正文只需
 * 「解压 + 读 XML」。为这一个需求引入 JSZip/yauzl 会让插件必须带 node_modules
 * 分发，安装摩擦大。Node 原生 zlib 已提供 inflateRaw，解析中央目录仅需约 80 行。
 *
 * 支持：deflate(8) / store(0)、ZIP64 扩展、unicode 路径、数据描述符文件
 *      （数据描述符时 csize 在中央目录中依然正确，因此从中央目录取长度即可）
 * 不支持：加密 ZIP、bzip2/lzma —— 命中时抛错，由上层降级为「仅索引元数据」
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});
  var zlib = require('zlib');

  var SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50;
  var SIG_CD = 0x02014b50, SIG_LFH = 0x04034b50;

  function findEOCD(buf) {
    var max = Math.min(buf.length, 65557);          // 22 + 最大注释 65535
    for (var i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
      if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
  }

  /**
   * 解析 ZIP
   * @param {Buffer} buf 完整文件字节
   * @returns {{names:string[], entries:Object, read:Function, readText:Function, has:Function}}
   */
  function readZip(buf) {
    if (!buf || buf.length < 22) throw new Error('文件过小，不是有效 ZIP');
    var eocd = findEOCD(buf);
    if (eocd < 0) throw new Error('未找到 ZIP 结束记录（EOCD）');

    var count = buf.readUInt16LE(eocd + 10);
    var cdOffset = buf.readUInt32LE(eocd + 16);

    // —— ZIP64：字段为 0xFFFF/0xFFFFFFFF 时走 ZIP64 结束记录 ——
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
      var loc = eocd - 20;
      if (loc >= 0 && buf.readUInt32LE(loc) === SIG_LOC64) {
        var z64 = Number(buf.readBigUInt64LE(loc + 8));
        if (z64 > 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_EOCD64) {
          count = Number(buf.readBigUInt64LE(z64 + 32));
          cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
        }
      }
    }

    var entries = Object.create(null);
    var p = cdOffset;
    for (var i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== SIG_CD) break;    // 中央目录损坏，用已解析部分
      var method = buf.readUInt16LE(p + 10);
      var csize = buf.readUInt32LE(p + 20);
      var usize = buf.readUInt32LE(p + 24);
      var nameLen = buf.readUInt16LE(p + 28);
      var extraLen = buf.readUInt16LE(p + 30);
      var commentLen = buf.readUInt16LE(p + 32);
      var lho = buf.readUInt32LE(p + 42);
      var name = buf.toString('utf8', p + 46, p + 46 + nameLen);

      // extra field 中取 ZIP64 真实值
      var e = p + 46 + nameLen, endExtra = e + extraLen;
      while (e + 4 <= endExtra) {
        var hid = buf.readUInt16LE(e), hsz = buf.readUInt16LE(e + 2);
        if (hid === 0x0001) {
          var q = e + 4;
          if (usize === 0xFFFFFFFF && q + 8 <= e + 4 + hsz) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xFFFFFFFF && q + 8 <= e + 4 + hsz) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xFFFFFFFF && q + 8 <= e + 4 + hsz) { lho = Number(buf.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + hsz;
      }
      entries[name] = { method: method, csize: csize, usize: usize, lho: lho };
      p += 46 + nameLen + extraLen + commentLen;
    }

    var api = {
      entries: entries,
      names: Object.keys(entries),
      has: function (n) { return !!entries[n]; }
    };

    /** 读取单个条目为 Buffer（未压缩原始字节） */
    api.read = function (name) {
      var en = entries[name];
      if (!en) return null;
      if (buf.readUInt32LE(en.lho) !== SIG_LFH) throw new Error('本地文件头签名错误: ' + name);
      var nLen = buf.readUInt16LE(en.lho + 26);
      var eLen = buf.readUInt16LE(en.lho + 28);
      var start = en.lho + 30 + nLen + eLen;
      var raw = buf.slice(start, start + en.csize);
      if (en.method === 0) return FT.util.toBuffer(raw);
      if (en.method === 8) {
        try { return zlib.inflateRawSync(raw); }
        catch (err) { return zlib.inflateSync(raw); }   // 少数写入器带 zlib 头
      }
      throw new Error('不支持的压缩方式 method=' + en.method + '（文件：' + name + '）');
    };

    /** 读取并解码为文本（XML/HTML 等） */
    api.readText = function (name) {
      var b = api.read(name);
      return b ? FT.util.decodeBuffer(b) : null;
    };

    return api;
  }

  /** 正则批量读取（按名称模式），返回 [{name, text}] */
  function readTextsMatching(zip, re, limit) {
    var out = [];
    for (var i = 0; i < zip.names.length; i++) {
      var n = zip.names[i];
      if (re.test(n)) {
        var t = zip.readText(n);
        if (t) out.push({ name: n, text: t });
        if (limit && out.length >= limit) break;
      }
    }
    return out;
  }

  FT.zip = { readZip: readZip, readTextsMatching: readTextsMatching };
})(typeof window !== 'undefined' ? window : globalThis);
