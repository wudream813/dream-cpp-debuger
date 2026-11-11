'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { JSDOM, VirtualConsole } = require('jsdom');
const { getSidebarHtml } = require('../src/sidebarHtml');
const { getDashboardHtml } = require('../src/dashboardHtml');

async function testModeCompile() {
  const errors = [];
  const messages = [];
  function makeDom(html) {
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => errors.push(e));
    return new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc,
      beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: m => messages.push(m) }); } });
  }
  const sidebar = makeDom(getSidebarHtml({ nonce: 'test' }));
  const dashboard = makeDom(getDashboardHtml({ nonce: 'test' }));
  const send = (dom, snapshot) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot } }));
  const S = sidebar.window.document, D = dashboard.window.document;
  const id = (doc, name) => doc.getElementById(name);
  send(sidebar, { runId: 1, userMode: 'beginner', state: 'idle', isCompiling: true });
  send(dashboard, { runId: 1, userMode: 'beginner', state: 'idle', isCompiling: true });
  assert.strictEqual(id(S, 'compileProgress').hidden, false);
  assert.match(id(S, 'statusPill').textContent, /正在编译/);
  assert.strictEqual(id(S, 'btnStartDebug').disabled, true);
  assert.strictEqual(id(S, 'btnQuickRun'), null);
  assert.strictEqual(id(S, 'btnStartDebug').parentElement, id(S, 'btnOpenDashboard').parentElement);
  assert.strictEqual(id(S, 'startDebugLabel').textContent, '🐞 开始调试');
  assert.strictEqual(id(S, 'dashboardLabel').textContent, '🖥 调试台');
  id(S, 'btnModeSettings').click();
  assert.strictEqual(messages.at(-1).type, 'openModeSettings');
  assert.strictEqual(id(D, 'btnStop').disabled, false);
  assert.strictEqual(id(D, 'breakpointCard').hidden, true);
  assert.strictEqual(id(D, 'advancedCard').hidden, true);
  assert.strictEqual(dashboard.window.getComputedStyle(id(D, 'advancedCard')).display, 'none');
  assert.ok(id(D, 'stackBreakpointRow').classList.contains('beginner-layout'));
  assert.match(id(D, 'labelContinue').textContent, /下一个断点/);
  assert.match(id(D, 'btnContinue').title, /程序结束/);
  id(S, 'btnUserMode').click();
  assert.strictEqual(messages.at(-1).type, 'changeUserMode');
  send(sidebar, { runId: 1, userMode: 'expert', state: 'idle', isCompiling: false });
  send(dashboard, { runId: 1, userMode: 'expert', state: 'paused', isCompiling: false });
  assert.strictEqual(id(S, 'compileProgress').hidden, true);
  assert.strictEqual(id(S, 'btnStartDebug').disabled, false);
  assert.strictEqual(id(D, 'breakpointCard').hidden, false);
  assert.strictEqual(id(D, 'advancedCard').hidden, false);
  assert.strictEqual(id(D, 'labelContinue').textContent, '继续 F5');
  const fullType = 'std::vector<Example<\"long\">>';
  send(dashboard, { runId: 1, userMode: 'expert', state: 'paused', locals: [{ name: 'x', type: fullType, value: '1' }] });
  const tag = D.querySelector('.var-type');
  assert.strictEqual(tag.title, fullType);
  assert.strictEqual(tag.textContent, fullType);
  assert.strictEqual(dashboard.window.getComputedStyle(tag).textOverflow, 'ellipsis');
  id(D, 'btnContinue').click();
  assert.strictEqual(messages.at(-1).type, 'continue');
  assert.deepStrictEqual(errors, []);
  sidebar.window.close(); dashboard.window.close();

  // Exercise controller methods with controlled asynchronous compilers and persistent mode.
  const filename = path.join(__dirname, '..', 'extension.js');
  const realRequire = createRequire(filename);
  const pending = [];
  let selected, pickerCalls = 0;
  let saved, workspaceMode, lastTarget, updateFailure, storageFailure;
  const state = {}, warnings = [];
  const config = { get: (_k, def) => workspaceMode || saved || def, inspect: () => ({ globalValue: saved, workspaceValue: workspaceMode }),
    update: async (_k, v, target) => { lastTarget = target; if (updateFailure) throw Error('bad settings JSON'); if (target === 2) workspaceMode = v; else saved = v; } };
  const vscode = { ConfigurationTarget: { Global: 1, Workspace: 2 }, workspace: { textDocuments: [], getConfiguration: () => config }, window: {
    showQuickPick: async items => { pickerCalls++; return items.find(i => i.mode === selected); },
    showWarningMessage(m) { warnings.push(m); }, showErrorMessage() {}
  } };
  const fakeCompiler = { compileSourceFile: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const m = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\nmodule.exports.TestController = DreamDebugController; module.exports.initialUserMode = initialUserMode;\n})')(
    id => id === 'vscode' ? vscode : id === './src/compiler' ? fakeCompiler : realRequire(id), m, m.exports, filename, path.dirname(filename));
  const c = Object.create(m.exports.TestController.prototype);
  let snapshots = [];
  Object.assign(c, { context: { globalState: { get: key => state[key], update: async (key, value) => { if (storageFailure) throw Error('storage denied'); state[key] = value; } } },
    userMode: 'expert', modeWasSelected: false, modePromptShown: false, modePrompt: null,
    runId: 1, compilingRunId: null, compileQueue: Promise.resolve(), statusBarItem: {},
    streamHistory: [], session: { state: 'idle', getSnapshot: () => ({ state: 'idle' }), stop: async () => {} },
    resolveActiveSourceFile: () => null, postToAllViews: m => snapshots.push(m.snapshot) });
  selected = 'beginner';
  await Promise.all([c.ensureUserMode(), c.ensureUserMode()]);
  assert.strictEqual(pickerCalls, 1);
  assert.strictEqual(saved, 'beginner');
  assert.strictEqual(snapshots.at(-1).userMode, 'beginner');
  await c.ensureUserMode(); assert.strictEqual(pickerCalls, 1);
  selected = 'expert'; await c.chooseUserMode();
  assert.strictEqual(saved, 'expert'); assert.strictEqual(snapshots.at(-1).userMode, 'expert');
  selected = undefined; await c.chooseUserMode(); assert.strictEqual(saved, 'expert');
  saved = 'beginner'; c.syncUserModeFromConfig();
  assert.strictEqual(snapshots.at(-1).userMode, 'beginner', 'settings changes update both views');
  saved = undefined; c.legacyModeToMigrate = 'expert'; c.modeWasSelected = true;
  await c.ensureUserMode(); assert.strictEqual(saved, 'expert', 'old preference migrates to settings');
  saved = 'beginner'; c.legacyModeToMigrate = 'expert';
  await c.ensureUserMode(); assert.strictEqual(saved, 'beginner', 'configured mode wins over old preference');

  workspaceMode = 'expert'; saved = 'beginner';
  await c.setUserMode('beginner');
  assert.strictEqual(lastTarget, 2, 'write the workspace setting when it overrides the user setting');
  assert.strictEqual(workspaceMode, 'beginner');
  assert.strictEqual(snapshots.at(-1).userMode, 'beginner');
  workspaceMode = undefined;
  storageFailure = true; const warningCount = warnings.length;
  await c.setUserMode('expert');
  assert.strictEqual(saved, 'expert');
  assert.strictEqual(warnings.length, warningCount, 'cleanup failure must not be reported as settings failure');
  storageFailure = false; updateFailure = true;
  await c.setUserMode('beginner');
  assert.deepStrictEqual(state['dreamCppDebug.modeFallback'], { mode: 'beginner', previousConfig: 'expert' });
  assert.match(warnings.at(-1), /已切换并保存.*bad settings JSON/);
  let initial = m.exports.initialUserMode(config, c.context.globalState);
  assert.strictEqual(initial.userMode, 'beginner', 'fallback survives restart');
  saved = 'beginner';
  initial = m.exports.initialUserMode(config, c.context.globalState);
  assert.strictEqual(initial.userMode, 'beginner', 'changed settings override stale fallback');
  saved = 'expert'; storageFailure = true;
  await c.setUserMode('beginner');
  assert.match(warnings.at(-1), /无法保存.*bad settings JSON.*storage denied/);
  storageFailure = false; updateFailure = false;
  await c.setUserMode('expert');

  const one = c.compileWithProgress('one.cpp', {}, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(snapshots.at(-1).isCompiling, true);
  c.runId = 2;
  const two = c.compileWithProgress('two.cpp', {}, 2);
  await Promise.resolve();
  assert.strictEqual(pending.length, 1, 'builds must not overwrite one another');
  pending[0].resolve({ success: true }); await one;
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(snapshots.at(-1).isCompiling, true, 'stale build must not clear current progress');
  pending[1].reject(new Error('compiler failed'));
  await assert.rejects(two, /compiler failed/);
  assert.strictEqual(snapshots.at(-1).isCompiling, false);
  c.runId = 3; const three = c.compileWithProgress('three.cpp', {}, 3);
  await new Promise(resolve => setImmediate(resolve));
  await c.stopExecution();
  assert.strictEqual(snapshots.at(-1).isCompiling, false);
  pending[2].resolve({ success: true }); await three;
  assert.strictEqual(c.runId, 4, 'stop invalidates late compilation');

  // Both public launch paths must expose progress and refuse a late start after Stop.
  c.resolveActiveSourceFile = () => '/tmp/program.cpp';
  c.stdinMode = 'text'; c.stdinText = ''; c.stdinFile = '';
  c.sidebarProvider = { reveal() {} }; c.outputChannel = { appendLine() {} };
  c.applyCompilerDiagnostics = () => {}; c.openDashboardPanel = () => {};
  let started = false;
  c.session.start = async () => { started = true; };
  const readOnly = { enabled: false, enables: 0, disables: 0,
    async enable() { this.enabled = true; this.enables++; },
    async disable() { this.enabled = false; this.disables++; } };
  c.editorReadOnly = readOnly;
  for (const launch of ['startDebugSession', 'compileAndQuickRun']) {
    const startIndex = pending.length;
    const launching = c[launch]();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pending.length, startIndex + 1, launch + ' invokes compiler');
    assert.strictEqual(snapshots.at(-1).isCompiling, true, launch + ' shows progress');
    await c.stopExecution();
    pending[startIndex].resolve({ success: true, executable: '/tmp/test', durationMs: 1 });
    await launching;
    assert.strictEqual(started, false, launch + ' must not start after cancellation');
    assert.strictEqual(snapshots.at(-1).isCompiling, false);
    assert.strictEqual(readOnly.enabled, false, launch + ' must release read-only on cancellation');
  }
  let buildIndex = pending.length;
  let failure = c.startDebugSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(readOnly.enabled, true, 'source is locked before compilation');
  pending[buildIndex].resolve({ success: false });
  await failure;
  assert.strictEqual(readOnly.enabled, false, 'compilation failure unlocks editor');
  buildIndex = pending.length;
  failure = c.startDebugSession();
  await new Promise(resolve => setImmediate(resolve));
  pending[buildIndex].reject(new Error('compiler error'));
  await assert.rejects(failure, /compiler error/);
  assert.strictEqual(readOnly.enabled, false, 'compiler exception unlocks editor');
}
module.exports = { testModeCompile };
