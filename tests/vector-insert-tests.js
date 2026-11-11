'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');
async function testVectorInsert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-vector-insert-'));
  const source = path.join(dir, 'main.cpp');
  fs.writeFileSync(source, [
    '#include <vector>', '#include <string>', '#include <iostream>', 'int main() {',
    'std::vector<int> v;', 'std::vector<double> d{1.5};', 'std::vector<char> c;',
    'std::vector<std::string> s;', 'int arr[2] = {1,2};',
    'volatile int marker = 1;', 'std::cout << v.size() << " " << d.size() << " " << c.size() << " " << s.size() << " " << marker;', '}', ''
  ].join('\n'));
  const session = new GDBSession();
  const waitStop = () => new Promise((resolve, reject) => { const timer = setTimeout(() => {session.off('status', h); reject(Error('stop timeout'));}, 12000); function h(e) { if(e.state === 'paused' || e.state === 'exited') {clearTimeout(timer); session.off('status',h); resolve(e);} } session.on('status',h); });
  try {
    const built = await compileSourceFile(source,{vectorHelpers:true}); assert(built.success,built.stderr);
    await session.addWatch('v');
    let wait = waitStop(); await session.start({executable:built.executable, sourceFile:source, cwd:dir, stopAtMain:true}); await wait;
    await session.setBreakpoint(source,10); wait = waitStop(); await session.continue(); await wait;
    const ctx = session._pauseContext();
    for (const name of ['v','d','c','s']) { const local = session.locals.find(v => v.name === name); assert(local?.sequence?.vectorOps, JSON.stringify(local)); }
    await session.insertVectorElement('v',null,'11',ctx);
    await session.insertVectorElement('v',null,'33',ctx);
    await session.insertVectorElement('v',1,'22',ctx);
    await session.insertVectorElement('v',0,'9',ctx);
    await session.insertVectorElement('v',4,'44',ctx);
    assert.deepStrictEqual((await session.getSequencePage('v',0,32,ctx)).items.map(x=>x.value),['9','11','22','33','44']);
    assert.deepStrictEqual(session.watches.find(w => w.expr === 'v').elements, ['9','11','22','33','44']);
    await session.insertVectorElement('d',null,'3.25',ctx);
    await session.insertVectorElement('c',null,'Z',ctx);
    await session.insertVectorElement('s',null,'你好 "x"',ctx);
    assert.equal((await session.getSequencePage('d',1,1,ctx)).items[0].value,'3.25');
    assert.equal((await session.getSequencePage('c',0,1,ctx)).items[0].value,'Z');
    const stringValue = (await session.getSequencePage('s',0,1,ctx)).items[0].value;
    assert(stringValue.includes('你好'), stringValue);
    assert(session.locals.find(v => v.name === 's').displayValue.includes('你好'));
    await assert.rejects(session.setSequenceElement('s',0,'test',ctx), /不可逐项修改/);
    assert.equal(session.locals.find(v => v.name === 's').sequence.length, 1);
    await assert.rejects(session.insertVectorElement('v',8,'1',ctx),/越界/);
    await assert.rejects(session.insertVectorElement('v',0,'1); quit',ctx),/整数/);
    await assert.rejects(session.insertVectorElement('arr',0,'1',ctx),/不支持/);
    const stale = {...ctx}; await session.selectFrame(0); await assert.rejects(session.insertVectorElement('v',null,'1',stale),/状态已变化/);
    wait=waitStop(); await session.continue(); await wait; session._pollProgramOutput(); assert.match(session.programOutput,/5 2 1 1 1/);
  } finally { await session.stop(); fs.rmSync(dir,{recursive:true,force:true}); }

  // A source-local libstdc++ ABI override must not be reinterpreted as the
  // separately compiled helper's std::string vector.
  const abiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-vector-abi-'));
  const abiFile = path.join(abiDir, 'main.cpp');
  fs.writeFileSync(abiFile, ['#define _GLIBCXX_USE_CXX11_ABI 0', '#include <vector>', '#include <string>', 'int main(){', 'std::vector<std::string> v;', 'volatile int marker=1;', 'return marker;', '}'].join('\n'));
  const abiSession = new GDBSession();
  const waitAbi = () => new Promise((resolve, reject) => { const timer = setTimeout(() => {abiSession.off('status', h); reject(Error('ABI stop timeout'));}, 12000); function h(e) { if (e.state === 'paused' || e.state === 'exited') {clearTimeout(timer); abiSession.off('status',h); resolve(e);} } abiSession.on('status',h); });
  try {
    const built = await compileSourceFile(abiFile,{vectorHelpers:true}); assert(built.success,built.stderr);
    let wait = waitAbi(); await abiSession.start({executable:built.executable,sourceFile:abiFile,cwd:abiDir,stopAtMain:true}); await wait;
    await abiSession.setBreakpoint(abiFile,6); wait=waitAbi(); await abiSession.continue(); await wait;
    const ctx = abiSession._pauseContext();
    await assert.rejects(abiSession.insertVectorElement('v',null,'hello',ctx),/ABI 布局不匹配/);
    assert.equal((await abiSession.getSequencePage('v',0,1,ctx)).length,0);
  } finally { await abiSession.stop(); fs.rmSync(abiDir,{recursive:true,force:true}); }
}
module.exports = { testVectorInsert };
if (require.main === module) testVectorInsert().then(()=>console.log('vector insertion ok')).catch(e=>{console.error(e);process.exitCode=1;});
