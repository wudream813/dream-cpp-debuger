'use strict';
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { getSidebarHtml } = require('../src/sidebarHtml');

async function testResets() {
  // Execute the actual webview script in a small DOM stub, not just string checks.
  const elements = {};
  function element(id) {
    return elements[id] ||= { textContent: '', value: '', className: '', scrollTop: 0,
      scrollHeight: 0, classList: { toggle() {} }, handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; }, querySelectorAll() { return []; } };
  }
  const messages = [];
  let receive;
  const html = getSidebarHtml({ nonce: 'test' });
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document: { getElementById: element, querySelectorAll: () => [], activeElement: null },
    window: { addEventListener: (_type, fn) => { receive = fn; } },
    acquireVsCodeApi: () => ({ postMessage: m => messages.push(m) }),
    navigator: {}
  });
  const snapshot = (value) => receive({ data: { type: 'snapshot', snapshot: value } });
  snapshot({ runId: 1, state: 'paused', programOutput: 'old output', streamHistory: ['→ 42', '→ 43'] });
  assert.strictEqual(element('streamHistoryBox').textContent, '→ 42\n→ 43');
  element('streamLineInput').value = 'draft';
  snapshot({ runId: 2, state: 'paused', programOutput: '', streamHistory: [] });
  assert.strictEqual(element('programOutputBox').textContent, '等待程序输出...');
  assert.ok(!element('streamHistoryBox').textContent.includes('42'));
  assert.strictEqual(element('streamLineInput').value, '');
  element('btnClearStdout').handlers.click();
  assert.strictEqual(messages.at(-1).type, 'clearProgramOutput');

  // Exercise real controller methods with a fake compiler and delayed old run.
  const filename = path.join(__dirname, '..', 'extension.js');
  const realRequire = createRequire(filename);
  let oldRunOptions, resolveOldRun;
  const fakeVscode = {
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (_k, def) => def }) },
    window: { showWarningMessage() {}, showErrorMessage(m) { throw Error(m); } }
  };
  let runImpl = (_exe, options) => {
    oldRunOptions = options;
    options.onProcess({ kill() {}, stdin: { write() {}, end() {} } });
    return new Promise(resolve => { resolveOldRun = resolve; });
  };
  const fakeCompiler = {
    compileSourceFile: async () => ({ success: true, executable: '/tmp/test', durationMs: 1 }),
    runExecutable: (...args) => runImpl(...args)
  };
  const m = { exports: {} };
  const wrapped = fs.readFileSync(filename, 'utf8') + '\nmodule.exports.TestController = DreamDebugController;';
  const requireMock = id => id === 'vscode' ? fakeVscode : id === './src/compiler' ? fakeCompiler : realRequire(id);
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + wrapped + '\n})')(
    requireMock, m, m.exports, filename, path.dirname(filename));
  const controller = Object.create(m.exports.TestController.prototype);
  const starts = [];
  Object.assign(controller, {
    runId: 0, stdinMode: 'stream', stdinText: 'old preset', stdinFile: '', streamHistory: [],
    activeRunProcess: null, sidebarProvider: { reveal() {} }, statusBarItem: {},
    outputChannel: { appendLine() {} }, resolveActiveSourceFile: () => '/tmp/test.cpp',
    pushSnapshotToWebview() {}, applyCompilerDiagnostics() {}, openDashboardPanel() {},
    session: {
      programOutput: 'previous',
      stop: async function () {},
      start: async options => starts.push(options),
      sendStdin() {}, closeStdin() {}
    }
  });
  const oldRun = controller.compileAndQuickRun();
  // Allow compilation and process startup to finish.
  await new Promise(resolve => setImmediate(resolve));
  oldRunOptions.onOutput('old');
  controller.streamHistory.push('→ old input');
  await controller.startDebugSession();
  assert.strictEqual(controller.session.programOutput, '');
  assert.deepStrictEqual(controller.streamHistory, []);
  assert.strictEqual(starts[0].stdin, '', 'text preset must not leak into streaming input');
  oldRunOptions.onOutput('late old output');
  resolveOldRun({ stdout: 'old', stderr: '', exitCode: 0, durationMs: 5 });
  await oldRun;
  assert.strictEqual(controller.session.programOutput, '', 'late quick-run output must not leak into debug session');

  // Stop must invalidate a pending run and invoke its cancellation callback.
  let cancelCalled = false;
  runImpl = (_exe, options) => {
    options.onProcess({ kill() {} }, () => { cancelCalled = true; resolveOldRun({ stdout: '', stderr: '', exitCode: null, durationMs: 1, cancelled: true }); });
    return new Promise(resolve => { resolveOldRun = resolve; });
  };
  const nextRun = controller.compileAndQuickRun();
  await new Promise(resolve => setImmediate(resolve));
  await controller.stopExecution();
  await nextRun;
  assert.ok(cancelCalled, 'stop must invoke process-tree cancellation');
  assert.ok(controller.session.programOutput.includes('[已停止]'));

}
module.exports = { testResets };
