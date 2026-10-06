/* =============================================================================
 * eagle-api.js —— Eagle 宿主桥接层
 * -----------------------------------------------------------------------------
 * 职责：把 Eagle 宿主能力收敛到一个薄封装里，并对外提供「在纯浏览器里也能跑」
 * 的降级实现（方便调试样式、也避免任何一步异常把整个插件窗口搞崩）。
 * 使用到的宿主 API（均为官方 Plugin API）：
 *   eagle.onPluginCreate / onPluginRun / onPluginShow / onThemeChanged / onLibraryChanged
 *   eagle.app.locale / version / theme / isDarkColors()
 *   eagle.library.path / name
 *   eagle.item.select(ids) / item.open(id) / item.getSelected()
 *   eagle.window.hide() / minimize() / focus() / setBackgroundColor()
 *   eagle.shell.openPath() / openExternal()
 * ========================================================================== */
(function (root) {
  'use strict';
  var FT = (root.FT = root.FT || {});
  var E = (typeof root.eagle !== 'undefined') ? root.eagle : null;

  var ctx = {
    isEagle: !!E,
    pluginPath: null,
    pluginId: FT.config.ID,
    libraryPath: null,
    libraryName: '',
    theme: 'LIGHT',
    locale: 'zh_CN',
    appVersion: ''
  };

  function cb(fn) { return function () { if (typeof fn === 'function') fn.apply(null, arguments); }; }

  /** 初始化：拿到插件路径、资源库路径、主题 */
  function init() {
    return new Promise(function (resolve) {
      if (!E) { resolve(ctx); return; }
      var done = false;
      function finish() {
        if (done) return; done = true;
        try { ctx.libraryPath = E.library.path; } catch (e) { }
        try { ctx.libraryName = E.library.name; } catch (e) { }
        try { ctx.theme = E.app.theme || 'LIGHT'; } catch (e) { }
        try { ctx.locale = E.app.locale || 'zh_CN'; } catch (e) { }
        try { ctx.appVersion = E.app.version + ' (build ' + E.app.build + ')'; } catch (e) { }
        resolve(ctx);
      }
      try {
        E.onPluginCreate(function (plugin) {
          ctx.pluginPath = plugin && plugin.path ? plugin.path : null;
          if (plugin && plugin.manifest && plugin.manifest.id) ctx.pluginId = plugin.manifest.id;
          finish();
        });
      } catch (e) { }
      // 兜底：某些情况下 onPluginCreate 已错过，用超时保证不卡住启动流程
      setTimeout(finish, 600);
    });
  }

  function onPluginRun(fn) { if (E && E.onPluginRun) E.onPluginRun(cb(fn)); }
  function onPluginShow(fn) { if (E && E.onPluginShow) E.onPluginShow(cb(fn)); }
  function onPluginHide(fn) { if (E && E.onPluginHide) E.onPluginHide(cb(fn)); }
  function onThemeChanged(fn) { if (E && E.onThemeChanged) E.onThemeChanged(cb(fn)); }
  function onLibraryChanged(fn) { if (E && E.onLibraryChanged) E.onLibraryChanged(cb(fn)); }

  /** 在 Eagle 中选中并定位到该条目（关键交互：检索结果 → 回到素材库） */
  async function selectAndReveal(id) {
    if (!E) return false;
    var ok = false;
    try { if (E.item.select) ok = await E.item.select([id]); } catch (e) { }
    try { await E.item.open(id); } catch (e) { }
    return ok;
  }
  async function getSelectedIds() {
    if (!E || !E.item.getSelected) return [];
    try { var items = await E.item.getSelected(); return (items || []).map(function (i) { return i.id; }); }
    catch (e) { return []; }
  }
  async function openFileByPath(p) {
    if (E && E.shell && E.shell.openPath) { try { return await E.shell.openPath(p); } catch (e) { } }
    return false;
  }
  function hideWindow() { if (E && E.window && E.window.hide) E.window.hide(); }
  function minimizeWindow() { if (E && E.window && E.window.minimize) E.window.minimize(); }
  function focusWindow() { if (E && E.window && E.window.focus) E.window.focus(); }
  function setBackgroundColor(hex) { try { if (E && E.window && E.window.setBackgroundColor) E.window.setBackgroundColor(hex); } catch (e) { } }
  function isDark() {
    try { if (E && E.app && E.app.isDarkColors) return !!E.app.isDarkColors(); } catch (e) { }
    return false;
  }
  /** 主题名 → light / dark（Eagle 的 BLUE/PURPLE 走浅色，保持零彩色视觉基调） */
  function themeMode(theme) {
    var t = String(theme || ctx.theme || '').toUpperCase();
    if (t === 'DARK' || t === 'GRAY') return 'dark';
    if (t === 'AUTO') return isDark() ? 'dark' : 'light';
    return 'light';
  }

  /* ---- 设置读写（落盘在插件目录，不碰资源库） ---- */
  function settingsPath() {
    // 测试沙箱优先：本地测试跑在自造样本库上，绝不能覆盖真实插件的设置文件。
    if (FT.config.SANDBOX && FT.config.SANDBOX.settingsFile) return FT.config.SANDBOX.settingsFile;
    if (!ctx.pluginPath) return null;
    var path = require('path');
    return path.join(ctx.pluginPath, 'settings.json');
  }
  function loadSettings() {
    try {
      var fs = require('fs'), p = settingsPath();
      if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { }
    return {};
  }
  function saveSettings(obj) {
    try {
      var fs = require('fs'), p = settingsPath();
      if (p) fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { }
  }

  FT.eagle = {
    ctx: ctx, init: init, isDark: isDark, themeMode: themeMode,
    onPluginRun: onPluginRun, onPluginShow: onPluginShow, onPluginHide: onPluginHide,
    onThemeChanged: onThemeChanged, onLibraryChanged: onLibraryChanged,
    selectAndReveal: selectAndReveal, getSelectedIds: getSelectedIds,
    openFileByPath: openFileByPath,
    hideWindow: hideWindow, minimizeWindow: minimizeWindow, focusWindow: focusWindow,
    setBackgroundColor: setBackgroundColor,
    loadSettings: loadSettings, saveSettings: saveSettings
  };
})(typeof window !== 'undefined' ? window : globalThis);
