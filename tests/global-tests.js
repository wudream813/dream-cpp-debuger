'use strict';
const assert=require('assert');const fs=require('fs');const os=require('os');const path=require('path');
const {GDBSession}=require('../src/gdbSession');const {compileSourceFile}=require('../src/compiler');const {execFileSync}=require('child_process');
async function testGlobals(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-globals-'));const source=path.join(dir,'main.cpp');
 fs.writeFileSync(path.join(dir,'data.h'),'static int from_header = 23;\n');
 fs.writeFileSync(source,['#include <vector>', '#include <string>', '#include "data.h"', 'int total = 10;', 'static int secret = 7;', 'int nums[100]{};', 'std::vector<int> bag(100, 5);', 'std::string title = "Global text that is longer than a preview";', 'namespace ns { int total = 9; }', 'int main(){', '  int total = 99;', '  ++::total;', '  bag[80] = 77;', '  return total + ::total + secret + from_header;', '}',''].join('\n'));
 const session=new GDBSession();
 const wait=()=>new Promise((resolve,reject)=>{const t=setTimeout(()=>{session.off('status',h);reject(Error('global stop timeout'))},12000);function h(e){if(e.state==='paused'||e.state==='exited'){clearTimeout(t);session.off('status',h);resolve(e)}}session.on('status',h)});
 try {
  const built=await compileSourceFile(source,{vectorHelpers:true});assert(built.success,built.stderr);
  let stop=wait();await session.start({executable:built.executable,sourceFile:source,cwd:dir,stopAtMain:true});await stop;
  await session.setBreakpoint(source,12);stop=wait();await session.continue();await stop;
  const find=n=>session.globals.find(v=>v.displayName===n);
  for(const n of ['total','secret','nums','bag','title','ns::total','from_header'])assert(find(n),`missing ${n}: ${JSON.stringify(session.globals)} ${session.globalsInfo}`);
  assert.equal(find('total').displayValue,'10');assert.equal(session.locals.find(v=>v.name==='total').displayValue,'99');
  assert.equal(find('ns::total').displayValue,'9');assert.equal(find('secret').displayValue,'7');
  assert.equal(find('bag').sequence.length,100);assert.equal(find('nums').sequence.length,100);assert.equal(find('bag').sequence.editable,false);
  const ctx=session._pauseContext();let page=await session.getSequencePage(find('bag').name,80,32,ctx,'global');assert.equal(page.length,100);assert.equal(page.items[0].value,'5');assert.equal(page.editable,false);assert(!page.vectorOps);
  page=await session.getSequencePage(find('nums').name,80,32,ctx,'global');assert.equal(page.items[0].value,'0');
  page=await session.getSequencePage(find('title').name,16,32,ctx,'global');assert(page.isChar);assert(!page.editable);
  await assert.rejects(session.getSequencePage('global_999',0,1,ctx,'global'),/无法安全/);
  await assert.rejects(session.getSequencePage(find('bag').name,100,1,ctx,'global'),/范围/);
  stop=wait();await session.stepOver();await stop;assert.equal(find('total').displayValue,'11');assert.equal(find('total').changed,true);
  stop=wait();await session.stepOver();await stop;page=await session.getSequencePage(find('bag').name,80,1,session._pauseContext(),'global');assert.equal(page.items[0].value,'77');
  await session.stop();assert.deepStrictEqual(session.getSnapshot().globals,[]);
 }finally{await session.stop();fs.rmSync(dir,{recursive:true,force:true});}
 // Same static name in two translation units must resolve to the correct file.
 const multi=fs.mkdtempSync(path.join(os.tmpdir(),'dream-global-multifile-'));
 const one=path.join(multi,'one.cpp'), two=path.join(multi,'two.cpp'), exe=path.join(multi,'program');
 fs.writeFileSync(one,'static int same = 111;\nvoid f();\nint main(){\n f();\n return same;\n}\n');
 fs.writeFileSync(two,'static int same = 222;\nvoid f(){same++;}\n');
 execFileSync('g++',['-g','-O0',one,two,'-o',exe]);
 const ms=new GDBSession();
 const waitMulti=()=>new Promise((resolve,reject)=>{const t=setTimeout(()=>{ms.off('status',h);reject(Error('multi-file stop timeout'))},10000);function h(e){if(e.state==='paused'||e.state==='exited'){clearTimeout(t);ms.off('status',h);resolve(e)}}ms.on('status',h)});
 try {
  let stop=waitMulti();await ms.start({executable:exe,sourceFile:one,cwd:multi,stopAtMain:true});await stop;
  const matching=ms.globals.filter(v=>v.displayName==='same');assert.equal(matching.length,2,JSON.stringify(ms.globals));
  assert.deepStrictEqual(matching.map(v=>v.displayValue).sort(),['111','222']);
  assert(matching.some(v=>v.sourceLabel.startsWith('one.cpp:'))&&matching.some(v=>v.sourceLabel.startsWith('two.cpp:')));
 }finally{await ms.stop();fs.rmSync(multi,{recursive:true,force:true});}
 // C globals and file-scope statics are discovered without C++ namespaces.
 const cdir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-global-c-'));const csrc=path.join(cdir,'main.c');
 fs.writeFileSync(csrc,'int counter = 5;\nstatic int hidden = 8;\nint main(void) {\n int counter = 77;\n return counter + hidden;\n}\n');
 const cs=new GDBSession();
 const waitC=()=>new Promise((resolve,reject)=>{const t=setTimeout(()=>{cs.off('status',h);reject(Error('C stop timeout'))},10000);function h(e){if(e.state==='paused'||e.state==='exited'){clearTimeout(t);cs.off('status',h);resolve(e)}}cs.on('status',h)});
 try {const built=await compileSourceFile(csrc);assert(built.success,built.stderr);let stopped=waitC();await cs.start({executable:built.executable,sourceFile:csrc,cwd:cdir,stopAtMain:true});await stopped;await cs.setBreakpoint(csrc,5);stopped=waitC();await cs.continue();await stopped;assert.equal(cs.globals.find(v=>v.displayName==='counter').displayValue,'5');assert.equal(cs.globals.find(v=>v.displayName==='hidden').displayValue,'8');assert.equal(cs.locals.find(v=>v.name==='counter').displayValue,'77');}
 finally {await cs.stop();fs.rmSync(cdir,{recursive:true,force:true});}
 const fake=new GDBSession();fake.sourceFile='/tmp/proj/main.cpp';fake.state='paused';fake.proc={};
 fake.sendCommand=async()=>({results:{symbols:{debug:[{fullname:'/tmp/proj/main.cpp',symbols:Array.from({length:105},(_,i)=>({name:'v'+i,type:'int'}))}]}}});
 // Discovery no longer truncates at 100: every symbol is kept and values are read lazily.
 const discovered=await fake._discoverGlobalSymbols();
 assert.equal(discovered.symbols.length,105);assert.equal(discovered.symbols[104].name,'v104');assert.equal(discovered.info,'');
 // Values are read lazily: the first window is evaluated, loadMoreGlobals extends it.
 fake.sendCommand=async(cmd)=>cmd.startsWith('-symbol-info-variables')
   ? {results:{symbols:{debug:[{fullname:'/tmp/proj/main.cpp',symbols:Array.from({length:105},(_,i)=>({name:'v'+i,type:'int'}))}]}}}
   : {results:{value:'1'}};
 fake._globalSymbols=null;await fake._refreshGlobals();
 assert.equal(fake.globals.length,100);assert.equal(fake.globalsTotal,105);
 assert(fake.globalsInfo.includes('已显示 100 / 共 105 项'),fake.globalsInfo);
 let fakeSnap=fake.getSnapshot();assert.equal(fakeSnap.globalsHasMore,true);assert.equal(fakeSnap.globalsTotal,105);
 assert.equal(await fake.loadMoreGlobals(10),true);
 assert.equal(fake.globals.length,110>105?105:110);assert.equal(fake.getSnapshot().globalsHasMore,false);
 assert.equal(await fake.loadMoreGlobals(10),false);
 fake.state='running';await assert.rejects(fake.loadMoreGlobals(10),/暂停/);fake.state='paused';
 fake._globalSymbols=null;fake.sendCommand=async()=>{throw Error('unsupported')};await fake._refreshGlobals();assert(fake.globalsInfo.includes('不支持'));
 fake._globalSymbols=[{id:'global_0',name:'broken',file:'/tmp/proj/main.cpp',line:4,type:'int',expression:'broken'}];
 await fake._refreshGlobals();
 assert.equal(fake.globals[0].displayValue,'无法读取');
 assert.equal(fake.globals[0].tooltip,'可能未初始化或已被优化');
 assert.equal(fake.getSnapshot().globals[0].tooltip,'可能未初始化或已被优化');
}
module.exports={testGlobals};if(require.main===module)testGlobals().then(()=>console.log('global tests ok')).catch(e=>{console.error(e);process.exitCode=1});
