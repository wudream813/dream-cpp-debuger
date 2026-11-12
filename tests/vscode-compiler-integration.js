'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const wait = ms => new Promise(r => setTimeout(r, ms));
exports.run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-pair-'));
  const file = path.join(root, 'pair.cpp');
  const paired = process.env.DREAM_EXPECT_COMPANION === '1';
  const cached = process.env.DREAM_EXPECT_CACHED === '1';
  const oldCompanion = process.env.DREAM_EXPECT_COMPANION === 'old';
  const header = paired ? '// compileOptions: -std=c++17 -DINTEGRATED=1 -O2 -Wl,--stack=123\n#ifndef INTEGRATED\n#error companion not used\n#endif\n' : '';
  fs.writeFileSync(file, header + 'int main() {\n volatile int x = 1;\n return x - 1;\n}\n');
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.workspace.getConfiguration('dreamCppDebug').update('interfaceMode', 'beginner', vscode.ConfigurationTarget.Global);
  await vscode.extensions.getExtension('wudream.dream-cpp-debuger').activate();
  const compiler = vscode.extensions.getExtension('wudream.dream-cpp-compiler');
  if (paired) {
    assert(compiler, 'companion installed');
    const api = await compiler.activate();
    assert.strictEqual(api.apiVersion, 1);
    const result = await api.compileForDebug(file);
    assert(result.success, result.stderr);
    assert(result.commandLine.includes('-DINTEGRATED=1'));
    assert(result.commandLine.includes('-O0') && !result.commandLine.includes('-O2'));
    assert(result.integration.ignoredFlags.includes('-Wl,--stack=123'));
    if (process.platform === 'linux') {
      const symbols = execFileSync('nm', [result.executable], { encoding: 'utf8' });
      assert(symbols.includes('dream_debug_vector_insert_int'), 'vector mutation helper linked');
      assert(symbols.includes('dream_debug_string_insert'), 'string mutation helper linked');
    }
    assert(result.cleanupBuild());
    if (cached) {
      assert(fs.existsSync(result.executable), 'idle build remains for smart compile');
      const repeated = await api.compileForDebug(file);
      assert(repeated.success && repeated.integration.cacheHit, 'unchanged source reuses debug build');
      assert.strictEqual(repeated.executable, result.executable);
      repeated.cleanupBuild();
    } else assert(!fs.existsSync(result.executable));
    await vscode.commands.executeCommand('dream-cpp-compiler.startDebug');
  } else {
    if (oldCompanion) { assert(compiler); assert(!(await compiler.activate())?.compileForDebug); }
    else assert(!compiler, 'no companion installed');
    await vscode.commands.executeCommand('dream-cpp-debug.startDebug');
  }
  const buildRoot = path.join(root, '.dream-debug');
  assert.strictEqual(fs.readdirSync(buildRoot).length, 1, 'debug build created and kept during session');
  await vscode.commands.executeCommand('dream-cpp-debug.stop');
  await wait(300);
  assert.strictEqual(fs.readdirSync(buildRoot).length, cached ? 1 : 0, 'idle cache retained only when enabled');
  if (paired) {
    // Exercise the companion through the native DAP entry too, not only the sidebar command.
    let reportStop;
    const stopped = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('DAP did not stop at main')), 15000);
      reportStop = () => { clearTimeout(timeout); resolve(); };
    });
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('dream-cpp-gdb', {
      createDebugAdapterTracker() { return { onDidSendMessage(message) {
        if (message.type === 'event' && message.event === 'stopped') reportStop();
      } }; }
    });
    try {
      assert(await vscode.debug.startDebugging(undefined, { name: 'Integration test', type: 'dream-cpp-gdb', request: 'launch', program: file, cwd: root, stopAtMain: true }));
      await stopped;
      assert.strictEqual(fs.readdirSync(buildRoot).length, 1, 'DAP delegated build stays while debugging');
      await vscode.debug.stopDebugging();
      await wait(300);
      assert.strictEqual(fs.readdirSync(buildRoot).length, cached ? 1 : 0, 'DAP build released to cache or cleaned');
    } finally { tracker.dispose(); }
  }
  console.log(paired ? 'REAL_VSCODE_COMPANION_PASS' : oldCompanion ? 'REAL_VSCODE_OLD_COMPANION_PASS' : 'REAL_VSCODE_STANDALONE_PASS');
  fs.rmSync(root, { recursive: true, force: true });
};
