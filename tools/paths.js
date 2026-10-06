'use strict';
/* =============================================================================
 * paths.js —— 可选测试依赖的解析（jsdom / playwright）
 * -----------------------------------------------------------------------------
 * test-ui.js 需要 jsdom，preview.js 需要 playwright。它们是「开发期依赖」，
 * 不进插件运行时，所以不放在插件目录里，也不应把某台机器上的绝对路径写死在代码里。
 * 这里按固定顺序探测，找不到就给出明确的安装指引 —— 而不是抛一个难懂的 MODULE_NOT_FOUND。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

/** 依次尝试的 node_modules 根目录 */
function candidates() {
  const list = [];
  if (process.env.WB_NODE_MODULES) list.push(process.env.WB_NODE_MODULES);
  list.push(path.join(__dirname, 'node_modules'));                       // tools/node_modules
  list.push(path.resolve(__dirname, '..', 'node_modules'));              // <repo>/node_modules
  if (process.env.NODE_PATH) list.push(...process.env.NODE_PATH.split(path.delimiter));
  if (process.env.HOME) list.push(path.join(process.env.HOME, '.workbuddy/binaries/node/workspace/node_modules'));
  return list.filter(Boolean);
}

/**
 * 解析一个可选依赖。
 * @param {string} name 模块名（如 'jsdom'）
 * @param {string} [installHint] 安装提示里显示的名字
 */
function requireOptional(name, installHint) {
  for (const dir of candidates()) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return require(full);
  }
  try { return require(name); } catch (e) { /* 继续走下面给提示 */ }

  console.error('\n缺少可选的测试依赖：' + name);
  console.error('  安装：npm i -D ' + (installHint || name));
  console.error('  或把已有的 node_modules 目录通过环境变量指过来：');
  console.error('      WB_NODE_MODULES=/path/to/node_modules node <script>.js');
  process.exit(2);
}

/* ---------------------------------------------------------------- 素材库解析
 * tools/testlib/（测试样本库）是**生成物**，被 .gitignore 排除，所以「刚 clone 下来」
 * 是没有的。缺库时统一给一句可执行的生成指引，而不是抛 ENOENT 堆栈，
 * 也不静默回退到某个与机器相关的默认路径。 */

const FIXTURE_LIB = path.join(__dirname, 'testlib');

/** 一个目录算不算可用的 Eagle 资源库：至少有 images/ */
function hasLibrary(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'images'));
}

/**
 * 解析要跑测试的素材库；不可用就打印指引并退出。
 * @param {string} [explicit] 用户显式指定的库路径（参数或环境变量）
 * @param {string} scriptName 用于提示里拼出可复制的命令
 * @returns {string} 可用的库路径
 */
function resolveFixtureLibrary(explicit, scriptName) {
  const lib = explicit || FIXTURE_LIB;
  if (hasLibrary(lib)) return lib;

  const lines = [''];
  lines.push('✗ 找不到可用的素材库：' + lib);
  if (explicit) lines.push('  （你指定的路径不存在，或不含 images/ 目录）');
  lines.push('');
  lines.push('  中性测试样本库是生成物、未入库，clone 之后需要先生成：');
  lines.push('      npm run fixtures');
  lines.push('      # 等价于 python3 tools/make-fixtures.py && python3 tools/make-cjk-pdf.py');
  lines.push('      # 需要 Python 3 + reportlab（pip install reportlab）');
  lines.push('');
  lines.push('  想用自己的 Eagle 资源库跑，把库路径作为参数传给脚本：');
  lines.push('      node tools/' + (scriptName || 'test-core.js') + ' /path/to/xxx.library');
  lines.push('');
  console.error(lines.join('\n'));
  process.exit(3);
}

module.exports = { requireOptional, candidates, resolveFixtureLibrary, hasLibrary, FIXTURE_LIB };
