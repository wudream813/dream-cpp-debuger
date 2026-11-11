'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { execFileSync } = require('child_process');
const { readRegularPrefix } = require('../src/safeFiles');
const { GDBSession } = require('../src/gdbSession');
const { runExecutable } = require('../src/compiler');

function testController() {
  const filename = path.join(__dirname, '..', 'extension.js');
  const realRequire = createRequire(filename);
  const m = { exports: {} };
  const wrapped = fs.readFileSync(filename, 'utf8') + '\nmodule.exports.TestController = DreamDebugController;';
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + wrapped + '\n})')(
    id => id === 'vscode' ? { workspace: {} } : realRequire(id), m, m.exports, filename, path.dirname(filename));
  const c = Object.create(m.exports.TestController.prototype);
  c.pushSnapshotToWebview = () => {};
  c.resolveActiveSourceFile = () => null;
  return c;
}

async function testSafetyRegressions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-safety-'));
  try {
    const f = path.join(dir, 'input.txt');
    fs.writeFileSync(f, 'first\nsecond');
    const c = testController();
    assert.strictEqual(await c.updateStdinFileInfo(f), true);
    assert.ok(c.stdinFilePreview.includes('first'));
    assert.strictEqual(await c.updateStdinFileInfo(dir), false);
    assert.ok(c.stdinFilePreview.includes('普通文件'));

    if (process.platform !== 'win32') {
      const fifo = path.join(dir, 'pipe');
      execFileSync('mkfifo', [fifo]);
      assert.strictEqual(await c.updateStdinFileInfo(fifo), false);
      assert.ok(c.stdinFilePreview.includes('普通文件'));
      const lines = await new GDBSession()._findLocalDeclarationLines(fifo, 1, 'main', ['n']);
      assert.strictEqual(lines.size, 0);
      await assert.rejects(runExecutable(process.execPath, { stdinFile: fifo }), /普通文件/);
    }
    const large = path.join(dir, 'large.cpp');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 2 * 1024 * 1024 + 1);
    assert.strictEqual((await new GDBSession()._findLocalDeclarationLines(large, 1, 'main', ['v'])).size, 0);

    // Inject a read error after opening: the handle must close on every path.
    const originalOpen = fs.promises.open;
    let closed = 0;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      const originalClose = handle.close.bind(handle);
      handle.read = async () => { throw new Error('injected read error'); };
      handle.close = async () => { closed++; return originalClose(); };
      return handle;
    };
    try {
      for (let i = 0; i < 30; i++) await assert.rejects(readRegularPrefix(f, 512), /injected/);
      assert.strictEqual(closed, 30, 'every successfully opened handle must be closed');
    } finally { fs.promises.open = originalOpen; }

    if (process.platform !== 'win32') {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const marker1 = path.join(dir, 'timeout-marker');
      const marker2 = path.join(dir, 'cancel-marker');
      function parentCode(marker) {
        const childCode = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),1200)`;
        return `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
      }
      let start = Date.now();
      const timed = await runExecutable(process.execPath, { args: ['-e', parentCode(marker1)], timeoutMs: 450 });
      assert.strictEqual(timed.killedByTimeout, true);
      assert.ok(Date.now() - start < 1300, 'timeout waited on inherited child pipes');
      start = Date.now();
      const cancelled = await runExecutable(process.execPath, {
        args: ['-e', parentCode(marker2)], timeoutMs: 5000,
        onProcess: (_proc, cancel) => setTimeout(cancel, 450)
      });
      assert.strictEqual(cancelled.cancelled, true);
      assert.ok(Date.now() - start < 1300, 'cancel waited on inherited child pipes');
      await delay(1450);
      assert.ok(!fs.existsSync(marker1) && !fs.existsSync(marker2), 'child survived termination');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { testSafetyRegressions };
