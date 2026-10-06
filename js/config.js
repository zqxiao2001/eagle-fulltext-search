/* =============================================================================
 * config.js —— 全局常量与设置
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});

  /* ---------------------------------------------------------------------------
   * 索引范围预设（只有两档）
   * ---------------------------------------------------------------------------
   * 早先版本暴露了「单篇字符上限 / 读取体积上限 / 是否含回收站 / 是否增量」4 个输入框，
   * 属于过度设计：真正有意义的只有「单篇文档能索引多少正文」这一个维度。
   * 现在收敛为两个预设，按「文档类别」而非「字数多寡」划分：
   *   normal —— 单篇文档：论文、注释、表格、代码、普通文档、报告
   *   long   —— 整本书 / 长篇合集：书籍、长篇报告、访谈逐字稿、超长网页存档
   *
   * 数值依据：
   *   · 一页中文排版约 700~900 字 → 1000 页 ≈ 70~90 万字符；
   *     英文版式（含空格）约为中文的 3 倍 → 1000 页 ≈ 250~300 万字符。
   *   · normal 取 100 万字符：远超任何单篇论文/报告（一篇 60 页论文约 5 万字符），
   *     连 600 页的中文专著也放得下，因此对「单篇文档」实际上不构成限制；
   *   · long 取 2000 万字符：对「一千页的书」留出 6~28 倍余量，实质等于不截断，
   *     但仍保留一个有限上限，避免某个异常巨大的文件把索引和内存撑爆。
   *
   * 取值来源说明：这两档不是凭空定的。初版交付后实测发现默认上限（10 万字符）
   * 会截断一篇约 13 万字符的长文档，因此 normal 档上调到 100 万（约 7 倍余量），
   * 保证「默认档位不会误伤任何单篇文档」。
   * 注意：此处及文档中一律只写量级，不写任何具体文档的精确字节数 / 字符数 —— 精确
   * 度量会间接指认某一篇素材，属个人数据。回归守卫见 tools/.private-terms。
   * ------------------------------------------------------------------------ */
  var PROFILES = {
    normal: {
      key: 'normal',
      label: '普通文件',
      tag: '默认',
      desc: '论文、图片注释、表格、代码、普通文档、报告。',
      capacity: '单篇最多 100 万字符（约 600 页中文 / 200 页英文，覆盖全部单篇文档）',
      maxCharsPerDoc: 1000000,
      maxFileSize: 200 * 1024 * 1024
    },
    long: {
      key: 'long',
      label: '长文本',
      tag: '书籍 / 长篇',
      desc: '书籍、长篇报告、访谈逐字稿、超长网页存档。',
      capacity: '单篇最多 2000 万字符（一本 1000 页的书约 70~300 万字符，本档留 6 倍以上余量）',
      maxCharsPerDoc: 20000000,
      maxFileSize: 256 * 1024 * 1024
    }
  };

  /* 默认设置。两个上限由档位派生，避免「档位改了一个数、DEFAULTS 忘了改」的双真源问题
     （test-core.js 的索引契约自检里有一条断言专门守这个不变式）。 */
  var DEFAULTS = {
    profile: 'normal',
    maxCharsPerDoc: PROFILES.normal.maxCharsPerDoc,
    maxFileSize: PROFILES.normal.maxFileSize,
    includeTrashed: false,      // 回收站条目默认不索引（不暴露给用户，保持选项极简）
    incremental: true,          // 增量更新常开；「重建索引」按钮本身就是全量
    snippetLen: 260,            // 结果片段长度
    fieldWeights: { name: 6, annotation: 3.5, tags: 4.5, folders: 2, content: 1, url: 0.8 },
    bm25: { k1: 1.2 }
  };

  FT.config = {
    /* 运行时由 eagle-api.js（Eagle 环境）或本地测试脚本注入的插件根目录绝对路径。
       用途：定位 libs/pdfjs、索引目录。 */
    PLUGIN_DIR: null,

    /* -------------------------------------------------------------------------
     * 测试沙箱覆盖（正常运行恒为 null，只有本仓库的测试脚本会写入）
     * -------------------------------------------------------------------------
     * 为什么需要它：本地测试用的是自造样本库（tools/testlib），如果沿用默认的
     * 「索引与设置都写在插件目录下」，跑一次测试就会把真实插件的 .index/ 与
     * settings.json 替换成样本库的版本 → 下一次在 Eagle 里打开插件，会看到
     * 「索引来自另一个资源库，请重建」的误判，甚至检索不到自己的素材。
     * 因此把这两处路径做成可覆盖，测试全部重定向到 tools/test-index/。
     *
     * 注入方式两种（都只影响测试宿主）：
     *   · Node 侧脚本：FT.config.SANDBOX.indexDir = '...'（test-ui.js / test-core.js）
     *   · 页面侧脚本：加载任何 JS 之前先定义 window.__FT_SANDBOX__（preview.js）
     * ---------------------------------------------------------------------- */
    SANDBOX: (function () {
      var s = (root && root.__FT_SANDBOX__) || {};
      return { indexDir: s.indexDir || null, settingsFile: s.settingsFile || null };
    })(),

    ID: 'fulltext-search',
    NAME: '全文检索',
    AUTHOR: '肖至勍',
    VERSION: '1.1.1',

    /* 索引结构版本：任何影响倒排/文档结构的变化都要 +1，
       插件启动时比对 meta 中的版本号，不一致则自动全量重建，避免脏索引。 */
    INDEX_VERSION: 5,

    PROFILES: PROFILES,
    DEFAULTS: DEFAULTS,

    /* 字段位掩码：postings 中用位运算记录「该词命中了哪些字段」 */
    MASK: { name: 1, annotation: 2, tags: 4, folders: 8, content: 16, url: 32 },
    MASK_NAMES: ['name', 'annotation', 'tags', 'folders', 'content', 'url'],

    /* 扩展名分组：用于 UI 筛选与 ext: / type: 查询语法 */
    EXT_GROUPS: {
      image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg', 'psd', 'ai'],
      pdf: ['pdf'],
      word: ['docx', 'doc', 'rtf', 'odt', 'wps'],
      excel: ['xlsx', 'xls', 'csv', 'tsv', 'ods', 'et'],
      ppt: ['pptx', 'ppt', 'odp', 'dps'],
      text: ['txt', 'md', 'markdown', 'log', 'tex', 'bib', 'srt', 'vtt', 'json', 'xml', 'yaml', 'yml',
        'py', 'js', 'ts', 'r', 'sh', 'sql', 'java', 'c', 'cpp', 'html', 'htm'],
      ebook: ['epub', 'mobi', 'azw3', 'djvu'],
      media: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'ogg'],
      design: ['sketch', 'fig', 'xd', 'blend', 'obj', 'fbx', 'stl'],
      archive: ['zip', 'rar', '7z', 'tar', 'gz']
    },

    /* 类型显示名（UI 徽章 + 筛选栏） */
    GROUP_LABEL: {
      image: '图片', pdf: 'PDF', word: 'Word', excel: '表格', ppt: '演示',
      text: '文本', ebook: '电子书', media: '音视频', design: '设计', archive: '压缩包', other: '其他'
    },

    /* 该扩展名是否可能包含「可检索正文」——UI 中用于提示索引覆盖率 */
    TEXTY_GROUPS: ['pdf', 'word', 'excel', 'ppt', 'text', 'ebook', 'other']
  };

  /** ext → group 反查 */
  FT.config.groupOfExt = function (ext) {
    ext = String(ext || '').toLowerCase();
    var g = FT.config.EXT_GROUPS;
    for (var k in g) { if (g[k].indexOf(ext) >= 0) return k; }
    return 'other';
  };

  /** 取预设（未知 key 回落到 normal） */
  FT.config.profileOf = function (key) {
    return FT.config.PROFILES[key] || FT.config.PROFILES.normal;
  };

  /** 把某个预设应用到 settings 上（就地修改并返回） */
  FT.config.applyProfile = function (settings, key) {
    var p = FT.config.profileOf(key);
    settings.profile = p.key;
    settings.maxCharsPerDoc = p.maxCharsPerDoc;
    settings.maxFileSize = p.maxFileSize;
    return settings;
  };

  /**
   * 索引参数指纹：索引里记录它，加载时比对。
   * 用途：用户改了索引范围但重建中断（或直接杀进程）时，避免沿用「按旧参数生成、
   * 覆盖范围不足」的旧索引而让人误以为长文档搜不到是数据问题。
   */
  FT.config.buildSignature = function (settings) {
    return [settings.maxCharsPerDoc, settings.maxFileSize, settings.includeTrashed ? 1 : 0].join('|');
  };
})(typeof window !== 'undefined' ? window : globalThis);
