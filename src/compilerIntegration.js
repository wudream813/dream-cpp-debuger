'use strict';
const path = require('path');

// An older or absent companion extension is never a hard dependency. Once a
// build is delegated, do not retry locally: it could duplicate a live build.
async function compileDebugWithCompanion(vscode, source, options, fallback, log = () => {}) {
  const settings = vscode.workspace.getConfiguration('dreamCppDebug');
  if (settings.get('useCompilerIntegration', true) && /\.(?:cpp|cc|cxx|c\+\+)$/i.test(source)) {
    const extension = vscode.extensions?.getExtension('wudream.dream-cpp-compiler');
    if (extension) {
      let api;
      try { api = extension.isActive ? extension.exports : await extension.activate(); }
      catch (err) { log(`编译插件激活失败，使用内置编译：${err.message}`); }
      if (api && api.apiVersion === 1 && typeof api.compileForDebug === 'function') {
        log('正在使用 Dream C++ Compiler 的调试构建接口。');
        const result = await api.compileForDebug(path.resolve(source));
        if (!result || typeof result.success !== 'boolean' || (result.success && (typeof result.executable !== 'string' || typeof result.cleanupBuild !== 'function'))) {
          throw new Error('编译插件返回了不兼容的调试构建结果');
        }
        if (result.integration?.ignoredFlags?.length) log(`调试构建未使用的编译选项：${result.integration.ignoredFlags.join(' ')}`);
        return result;
      }
      if (api) log('编译插件版本不支持调试构建接口，使用内置编译。');
    }
  }
  return fallback(source, options);
}
module.exports = { compileDebugWithCompanion };
