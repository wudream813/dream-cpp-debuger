'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');
async function testPaging() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-paging-'));
  const file = path.join(dir, 'main.cpp');
  fs.writeFileSync(file, ['#include <vector>', '#include <string>', 'int main(){', 'std::vector<int> v(100, 5);', 'int arr[100]{};', 'char letters[100] = "hello";', 'std::string title = "Hello, world!";', 'volatile int marker = 1;', 'return v[80] + arr[80] + letters[1] + title[1] + marker;', '}'].join('\n'));
  const session = new GDBSession();
  const wait = () => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('timeout')), 12000); const f = e => { if (e.state === 'paused' || e.state === 'exited') { clearTimeout(timer); session.off('status', f); resolve(e); } }; session.on('status', f); });
  try {
    const built = await compileSourceFile(file); assert(built.success, built.stderr);
    let pending = wait(); await session.start({executable: built.executable, sourceFile: file, cwd: dir, stopAtMain: true}); await pending;
    await session.setBreakpoint(file, 8); pending = wait(); await session.continue(); await pending;
    const ctx = session._pauseContext();
    for (const name of ['v', 'arr', 'letters', 'title']) {
      const variable = session.locals.find(v => v.name === name);
      assert(variable && variable.sequence, `${name} missing sequence ${JSON.stringify(variable)}`);
      assert.equal(variable.sequence.length, name === 'title' ? 13 : 100);
    }
    for (const name of ['v', 'arr', 'letters']) {
      const page = await session.getSequencePage(name, 80, 32, ctx);
      assert.equal(page.items.length, 20); assert.equal(page.items[0].index, 80);
    }
    await session.setSequenceElement('v', 80, '47', ctx);
    await session.setSequenceElement('arr', 80, '55', ctx);
    await session.setSequenceElement('letters', 1, 'Z', ctx);
    await session.setSequenceElement('title', 1, '0x61', ctx);
    for (const [name, idx, val] of [['v',80,'47'], ['arr',80,'55'], ['letters',1,'Z'], ['title',1,'a']]) {
      assert.equal((await session.getSequencePage(name, idx, 1, ctx)).items[0].value, val);
    }
    assert.equal(await session.setVariableValue('v', '{1, 2, ...}'), false);
    assert.equal((await session.getSequencePage('v', 80, 1, ctx)).items[0].value, '47');
    await assert.rejects(session.setSequenceElement('arr', 100, '1', ctx), /越界/);
    await assert.rejects(session.setSequenceElement('title', 1, '中', ctx), /单字节/);
    await assert.rejects(session.getSequencePage('arr', 0, 33, ctx), /范围/);
    await assert.rejects(session.getSequencePage('arr', 100, 1, ctx), /范围/);
    const stale = {...ctx}; await session.selectFrame(0);
    await assert.rejects(session.setSequenceElement('v', 80, '1', stale), /状态已变化/);
  } finally { await session.stop(); fs.rmSync(dir, {recursive:true, force:true}); }
}
module.exports = { testPaging };
if (require.main === module) testPaging().then(() => console.log('paging ok')).catch(e => { console.error(e); process.exitCode = 1; });
