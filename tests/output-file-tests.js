'use strict';
const assert=require('assert'); const fs=require('fs'); const os=require('os'); const path=require('path'); const cp=require('child_process');
const {openOutputFile,PREVIEW_BYTES,PREVIEW_NOTICE}=require('../src/outputFile');
const {compileSourceFile,runExecutable}=require('../src/compiler'); const {GDBSession}=require('../src/gdbSession');
async function testOutputFile(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-output-test-'));const file=path.join(dir,'output $(no shell).txt');const source=path.join(dir,'main.cpp');
 fs.writeFileSync(source,['#include <cstdio>', '#include <cstring>', '#include <unistd.h>', 'int main(){', 'int value = 42;', 'char buf[16384];', 'memset(buf, 120, sizeof buf);', 'for(int i=0;i<2200;i++) fwrite(buf, 1, sizeof buf, stdout);', 'fflush(stdout);', 'fputs("END",stderr);', 'return value == 42 ? 0 : 1;', '}',''].join('\n'));
 const expected=2200*16384+3;
 try {
  fs.writeFileSync(file,'old data');
  await assert.rejects(openOutputFile(file,[],{shouldProceed:()=>false}),/取消/);assert.equal(fs.readFileSync(file,'utf8'),'old data');
  await assert.rejects(openOutputFile(source,[source]),/不能与/);assert(fs.readFileSync(source,'utf8').includes('int main'));
  const hard=path.join(dir,'hardlink');fs.linkSync(source,hard);await assert.rejects(openOutputFile(hard,[source]),/不能与/);
  if(process.platform!=='win32') {const link=path.join(dir,'link');fs.symlinkSync(source,link);await assert.rejects(openOutputFile(link,[source]),/普通文件/);const fifo=path.join(dir,'fifo');cp.execFileSync('mkfifo',[fifo]);await assert.rejects(openOutputFile(fifo,[]),/普通文件/);}
  const built=await compileSourceFile(source);assert(built.success,built.stderr);
  if(process.platform==='linux') {
   const slowSrc=path.join(dir,'slow.cpp');
   fs.writeFileSync(slowSrc, '#include <cstdio>\n#include <unistd.h>\nint main(){fputs("first\\n",stdout);fflush(stdout);usleep(1300000);fputs("last\\n",stderr);return 0;}\n');
   const slow=await compileSourceFile(slowSrc);assert(slow.success,slow.stderr);
   let live=await openOutputFile(file,[slowSrc,slow.executable]);
   let started;const didStart=new Promise(resolve=>{started=resolve;});
   const running=runExecutable(slow.executable,{outputCapture:live,timeoutMs:5000,onProcess:()=>started()});
   await didStart;await new Promise(resolve=>setTimeout(resolve,500));assert.equal(fs.readFileSync(file,'utf8'),'first\n');assert.equal(live.poll(),'first\n');
   assert.equal((await running).exitCode,0);assert.equal(fs.readFileSync(file,'utf8'),'first\nlast\n');await live.close();
   live=await openOutputFile(file,[slowSrc,slow.executable]);const s=new GDBSession();
   const finished=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('live output GDB timeout')),8000);s.on('status',e=>{if(e.state==='exited'){clearTimeout(timer);resolve()}})});
   try {await s.start({executable:slow.executable,sourceFile:slowSrc,cwd:dir,stopAtMain:false,outputCapture:live});await new Promise(resolve=>setTimeout(resolve,500));assert.equal(fs.readFileSync(file,'utf8'),'first\n');await finished;assert.equal(fs.readFileSync(file,'utf8'),'first\nlast\n');}
   finally {await s.stop();await live.close();}
  }

  let capture=await openOutputFile(file,[source,built.executable]);assert.equal(fs.statSync(file).size,0);
  const result=await runExecutable(built.executable,{outputCapture:capture,timeoutMs:15000});assert.equal(result.exitCode,0);assert.equal(fs.statSync(file).size,expected);
  let preview=capture.poll(true);assert(preview.startsWith('x'.repeat(100)));assert(preview.includes(PREVIEW_NOTICE));assert(preview.length < PREVIEW_BYTES+300);await capture.close();
  assert.equal(fs.readFileSync(file).subarray(-3).toString(),'END');assert(!fs.existsSync(path.join(dir,'no shell')));
  if(process.platform==='linux') {
   capture=await openOutputFile(file,[source,built.executable]);
   const session=new GDBSession();await session.addWatch('value');
   const wait=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{session.off('status',h);reject(Error('GDB output test timeout'));},20000);function h(e){if(e.state==='paused'||e.state==='exited'){clearTimeout(timer);session.off('status',h);resolve(e)}}session.on('status',h)});
   try{
    let stopped=wait();await session.start({executable:built.executable,sourceFile:source,cwd:dir,outputCapture:capture,stopAtMain:true});await stopped;
    await session.setBreakpoint(source,7);stopped=wait();await session.continue();await stopped;assert(session.locals.some(x=>x.name==='value'));assert(session.getSnapshot().locals.length);
    stopped=wait();await session.continue();const exit=await stopped;assert.equal(exit.state,'exited');
    assert.equal(fs.statSync(file).size,expected);assert.equal(fs.readFileSync(file).subarray(-3).toString(),'END');
    assert(session.programOutput.includes(PREVIEW_NOTICE));assert(!session.programOutput.includes('32 MiB'));assert(session.programOutput.length<PREVIEW_BYTES+300);
    const snap=session.getSnapshot();assert.deepStrictEqual(snap.locals,[]);assert.deepStrictEqual(snap.stack,[]);assert.deepStrictEqual(snap.registers,[]);assert(snap.watches.some(w=>w.expr==='value'));assert(!snap.watches.some(w=>w.value==='42'));
   } finally {await session.stop();await capture.close();}
   // Explicit stop must also clear cached inspection data.
   const fake=new GDBSession();fake.state='paused';fake.locals=[{name:'stale'}];fake.stack=[{level:0}];fake.registers=[{name:'r'}];fake.watches=[{id:'1',expr:'v',value:'old',elements:['old']}];await fake.stop();assert.deepStrictEqual(fake.locals,[]);assert.deepStrictEqual(fake.getSnapshot().locals,[]);assert.equal(fake.getSnapshot().watches[0].value,'程序已结束');
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={testOutputFile};
if(require.main===module)testOutputFile().then(()=>console.log('output file tests ok')).catch(e=>{console.error(e);process.exitCode=1});
