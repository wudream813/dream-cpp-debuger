'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');
async function testStringContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dream-string-menu-'));
  const source = path.join(dir,'main.cpp');
  fs.writeFileSync(source,['#include <string>', '#include <iostream>', 'int main(){', 'std::string s = "AB";', 'std::string empty;', 'std::string large(100, \'x\');', 'char fixed[5] = "AB";', 'volatile int marker=1;', 'std::cout << s.size() << " " << empty.size() << " " << large.size() << " " << marker;', '}',''].join('\n'));
  const session=new GDBSession();
  const wait=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{session.off('status',h);reject(Error('stop timeout'));},12000);function h(e){if(e.state==='paused'||e.state==='exited'){clearTimeout(timer);session.off('status',h);resolve(e)}}session.on('status',h)});
  try {
    const built=await compileSourceFile(source,{vectorHelpers:true});assert(built.success,built.stderr);
    await session.addWatch('s');let stopped=wait();await session.start({executable:built.executable,sourceFile:source,cwd:dir,stopAtMain:true});await stopped;
    await session.setBreakpoint(source,8);stopped=wait();await session.continue();await stopped;const ctx=session._pauseContext();
    const page=async(name,offset=0)=>session.getSequencePage(name,offset,32,ctx);
    assert((await page('s')).stringOps);assert((await page('large',80)).stringOps);assert(!(await page('fixed')).stringOps);
    const revision=session._vectorRevision;
    await session.insertVectorElement('s',0,'L',ctx,{revision,anchorIndex:0});
    await assert.rejects(session.insertVectorElement('s',0,'Q',ctx,{revision,anchorIndex:0}),/容器内容已变化/);
    await session.insertVectorElement('s',3,'R',ctx,{revision:session._vectorRevision,anchorIndex:2});
    assert.deepStrictEqual((await page('s')).items.map(i=>i.value),['L','A','B','R']);
    await session.insertVectorElement('s',1,'',ctx,{delete:true,revision:session._vectorRevision,anchorIndex:1});
    assert.deepStrictEqual((await page('s')).items.map(i=>i.value),['L','B','R']);
    await session.insertVectorElement('s',1,'中',ctx,{revision:session._vectorRevision,anchorIndex:1});
    assert.deepStrictEqual((await page('s')).items.map(i=>i.value),['L','0xe4','0xb8','0xad','B','R']);
    await session.insertVectorElement('s',2,'',ctx,{delete:true,revision:session._vectorRevision,anchorIndex:2});
    assert.deepStrictEqual((await page('s')).items.map(i=>i.value),['L','0xe4','0xad','B','R']);
    await session.insertVectorElement('empty',0,'0x00',ctx,{revision:session._vectorRevision,requireEmpty:true});
    assert.equal((await page('empty')).items[0].value,'0x00');
    await session.insertVectorElement('empty',0,'',ctx,{delete:true,revision:session._vectorRevision,anchorIndex:0});
    assert.equal((await page('empty')).length,0);
    await session.insertVectorElement('large',80,'Z',ctx,{revision:session._vectorRevision,anchorIndex:80});
    assert.equal((await page('large',80)).items[0].value,'Z');
    await session.insertVectorElement('large',80,'',ctx,{delete:true,revision:session._vectorRevision,anchorIndex:80});
    assert.equal((await page('large',80)).items[0].value,'x');
    await assert.rejects(session.insertVectorElement('fixed',0,'A',ctx,{revision:session._vectorRevision,anchorIndex:0}),/不支持/);
    await assert.rejects(session.insertVectorElement('s',500,'',ctx,{delete:true,revision:session._vectorRevision,anchorIndex:500}),/不存在|越界/);
    await assert.rejects(session.insertVectorElement('s',0,'',ctx,{revision:session._vectorRevision,anchorIndex:0}),/请输入/);
    const stale={...ctx};await session.selectFrame(0);await assert.rejects(session.insertVectorElement('s',0,'Z',stale,{revision:session._vectorRevision,anchorIndex:0}),/状态已变化/);
    stopped=wait();await session.continue();await stopped;session._pollProgramOutput();assert.match(session.programOutput,/5 0 100 1/);
  } finally {await session.stop();fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={testStringContext};
if(require.main===module)testStringContext().then(()=>console.log('string context GDB OK')).catch(e=>{console.error(e);process.exitCode=1});
