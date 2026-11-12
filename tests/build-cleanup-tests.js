'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileSourceFile } = require('../src/compiler');
const { GDBSession } = require('../src/gdbSession');
const { DreamGdbDebugAdapter } = require('../src/debugAdapter');
const { spawn } = require('child_process');
const { createBuildLease, releaseWhenSafe } = require('../src/buildCleanup');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitState = session => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { session.off('status', on); reject(Error('GDB state timeout')); }, 15000);
  function on(ev) { if (ev.state === 'paused' || ev.state === 'exited') { clearTimeout(timeout); session.off('status', on); resolve(ev); } }
  session.on('status', on);
});
async function testBuildCleanup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-cleanup-tests-'));
  const source = path.join(root, 'main.cpp');
  fs.writeFileSync(source, 'int main() {\n int value = 3;\n return value - 3;\n}\n');
  const builds = path.join(root, '.dream-debug');
  fs.mkdirSync(builds);
  const legacy = path.join(builds, 'build-legacy'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'program.debug.out'), 'keep');
  const sessions = [];
  try {
    const failedFile = path.join(root, 'invalid.cpp'); fs.writeFileSync(failedFile, 'syntax error\n');
    let result = await compileSourceFile(failedFile, { autoCleanup: true });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(fs.readdirSync(builds), ['build-legacy'], 'failed build is cleaned without touching legacy');
    result = await compileSourceFile(source, { autoCleanup: true, compilerPath: path.join(root, 'missing-compiler') });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(fs.readdirSync(builds), ['build-legacy'], 'failed compiler launch is cleaned');

    const first = await compileSourceFile(source, { autoCleanup: true });
    const second = await compileSourceFile(source, { autoCleanup: true });
    assert(first.success && second.success); assert.notStrictEqual(first.executable, second.executable);
    const a = new GDBSession(), b = new GDBSession(); sessions.push(a,b);
    let pending = waitState(a); await a.start({ executable: first.executable, sourceFile: source, cleanupBuild: first.cleanupBuild, stopAtMain: true }); await pending;
    pending = waitState(b); await b.start({ executable: second.executable, sourceFile: source, cleanupBuild: second.cleanupBuild, stopAtMain: true }); await pending;
    assert(fs.existsSync(first.executable) && fs.existsSync(second.executable), 'active debugging builds are retained');
    await a.stop();
    assert(!fs.existsSync(first.executable), 'stopped session is cleaned');
    assert(!fs.existsSync(path.dirname(first.executable)));
    assert(fs.existsSync(second.executable), 'another session stays intact');
    pending = waitState(b); await b.continue(); await pending;
    assert(!fs.existsSync(second.executable), 'natural exit is cleaned');
    assert(fs.existsSync(path.join(legacy, 'program.debug.out')), 'unmarked legacy build remains');

    // An already-built external executable is never owned by the extension.
    const external = await compileSourceFile(source);
    const s = new GDBSession(); sessions.push(s); pending = waitState(s);
    await s.start({ executable: external.executable, sourceFile: source, stopAtMain: true }); await pending; await s.stop();
    assert(fs.existsSync(external.executable), 'external/unmanaged binaries remain');

    // GDB launch failure still cleans the build once the GDB process closes.
    const bad = await compileSourceFile(source, { autoCleanup: true });
    const broken = new GDBSession({ gdbPath: path.join(root, 'no-gdb') }); sessions.push(broken);
    await assert.rejects(broken.start({ executable: bad.executable, sourceFile: source, cleanupBuild: bad.cleanupBuild }));
    await delay(50); assert(!fs.existsSync(bad.executable));

    // DAP launch also transfers ownership to the GDB session.
    const dapSession = new GDBSession(); sessions.push(dapSession);
    const adapter = new DreamGdbDebugAdapter(dapSession);
    pending = waitState(dapSession); await adapter._launchSession({ program: source, stopAtMain: true }); await pending;
    const dapExe = dapSession.executable; assert(fs.existsSync(dapExe));
    await dapSession.stop(); assert(!fs.existsSync(dapExe)); adapter.dispose();

    // User-created files and altered/replaced builds are never recursively deleted.
    const user = await compileSourceFile(source, { autoCleanup: true });
    const note = path.join(path.dirname(user.executable), 'user.txt'); fs.writeFileSync(note, 'keep me');
    assert.strictEqual(user.cleanupBuild(), true); assert.strictEqual(fs.readFileSync(note, 'utf8'), 'keep me');
    const modified = await compileSourceFile(source, { autoCleanup: true });
    fs.appendFileSync(modified.executable, 'user data');
    assert.strictEqual(modified.cleanupBuild(), false); assert(fs.existsSync(modified.executable));
    if (process.platform !== 'win32') {
      const swapped = await compileSourceFile(source, { autoCleanup: true });
      const victim = path.join(root, 'victim'); fs.writeFileSync(victim, 'safe');
      fs.unlinkSync(swapped.executable); fs.symlinkSync(victim, swapped.executable);
      assert.strictEqual(swapped.cleanupBuild(), false); assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'safe');
      const hard = await compileSourceFile(source, { autoCleanup: true });
      fs.linkSync(hard.executable, path.join(root, 'hardlink'));
      assert.strictEqual(hard.cleanupBuild(), false); assert(fs.existsSync(hard.executable));
      const dirSwap = await compileSourceFile(source, { autoCleanup: true });
      const oldDir = path.dirname(dirSwap.executable), movedDir = oldDir + '-moved';
      const userDir = path.join(root, 'user-dir'); fs.mkdirSync(userDir);
      fs.writeFileSync(path.join(userDir, 'program.debug.out'), 'do not delete');
      fs.renameSync(oldDir, movedDir); fs.symlinkSync(userDir, oldDir, 'dir');
      assert.strictEqual(dirSwap.cleanupBuild(), false);
      assert.strictEqual(fs.readFileSync(path.join(userDir, 'program.debug.out'), 'utf8'), 'do not delete');
      assert(fs.existsSync(path.join(movedDir, 'program.debug.out')));
      fs.unlinkSync(oldDir);
    }
    const rawDir = fs.mkdtempSync(path.join(builds, 'build-manual-'));
    const file = path.join(rawDir, 'program.debug.out');
    const lease = createBuildLease(rawDir, file); assert(lease);
    fs.writeFileSync(file, 'generated'); lease.capture();
    fs.writeFileSync(path.join(rawDir, '.dream-owned-build'), 'tampered');
    assert.strictEqual(lease.cleanup(), false); assert(fs.existsSync(file));

    let calls = 0;
    releaseWhenSafe(() => { calls++; return true; }, { launchAttempted: true, pid: null, exited: false }, 0);
    assert.strictEqual(calls, 0, 'unknown inferior must be preserved');
    releaseWhenSafe(() => { calls++; return true; }, { launchAttempted: true, pid: process.pid, exited: false }, 0);
    assert.strictEqual(calls, 0, 'live inferior must be preserved');
    releaseWhenSafe(() => { calls++; return true; }, { launchAttempted: true, pid: process.pid, exited: true }, 0);
    assert.strictEqual(calls, 1, 'confirmed exited inferior can be cleaned');
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      let deleted = 0;
      releaseWhenSafe(() => { deleted++; return true; }, { launchAttempted: true, pid: live.pid, exited: false }, 3);
      assert.strictEqual(deleted, 0, 'do not remove while tracked process is alive');
      const done = new Promise(resolve => live.once('close', resolve));
      live.kill(); await done;
      await delay(1200);
      assert.strictEqual(deleted, 1, 'cleanup occurs when tracked process actually exits');
    } finally { try { live.kill(); } catch (_) {} }
  } finally {
    for (const session of sessions) await session.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { testBuildCleanup };
