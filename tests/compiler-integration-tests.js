'use strict';
const assert = require('assert');
const { compileDebugWithCompanion } = require('../src/compilerIntegration');
const { DreamGdbDebugAdapter } = require('../src/debugAdapter');
const { EventEmitter } = require('events');
async function testCompilerIntegration() {
  let ext, enabled = true, fallbackCalls = 0, calls = 0;
  const fake = { workspace: { getConfiguration: () => ({ get: () => enabled }) }, extensions: { getExtension: () => ext } };
  const fallback = async () => { fallbackCalls++; return { success: false, from: 'builtin' }; };
  const logs = [];
  const run = file => compileDebugWithCompanion(fake, file, {}, fallback, m => logs.push(m));
  assert.strictEqual((await run('/tmp/a.cpp')).from, 'builtin');
  ext = { isActive: false, activate: async () => ({}) };
  assert.strictEqual((await run('/tmp/a.cpp')).from, 'builtin');
  assert(logs.some(m => m.includes('版本不支持')));
  ext = { isActive: true, exports: { apiVersion: 1, compileForDebug: async () => { calls++; return { success: true, executable: '/tmp/a', cleanupBuild: () => true, integration: { ignoredFlags: ['-bad'] } }; } } };
  const result = await run('/tmp/a.cpp'); assert(result.success); assert.strictEqual(calls, 1);
  assert(logs.some(m => m.includes('-bad')));
  assert.strictEqual((await run('/tmp/a.c')).from, 'builtin');
  enabled = false; assert.strictEqual((await run('/tmp/a.cpp')).from, 'builtin');
  enabled = true; ext.exports.compileForDebug = async () => { throw Error('compiler failed'); };
  const before = fallbackCalls; await assert.rejects(run('/tmp/a.cpp'), /compiler failed/); assert.strictEqual(fallbackCalls, before);
  ext.exports.compileForDebug = async () => ({ success: true, executable: '/tmp/a' });
  await assert.rejects(run('/tmp/a.cpp'), /不兼容/);
  // A stop during delegated compilation must release the returned build and
  // must not launch GDB after the user already stopped the DAP session.
  const session = new EventEmitter(); let starts = 0, releaseCount = 0, resolveBuild;
  session.stop = async () => {}; session.start = async () => { starts++; };
  const adapter = new DreamGdbDebugAdapter(session, null, () => new Promise(resolve => { resolveBuild = resolve; }));
  const launching = adapter._launchSession({ program: '/tmp/a.cpp' });
  await new Promise(resolve => setImmediate(resolve));
  await adapter.handleMessage({ type: 'request', command: 'disconnect', seq: 1 });
  resolveBuild({ success: true, executable: '/tmp/test', cleanupBuild: () => { releaseCount++; } });
  await launching; assert.strictEqual(starts, 0); assert.strictEqual(releaseCount, 1); adapter.dispose();

}
module.exports = { testCompilerIntegration };
