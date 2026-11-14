'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const { GDBSession }=require('../src/gdbSession'); const {compileSourceFile}=require('../src/compiler'); const {prepareReverseFileIO}=require('../src/reverseFileIO');
function wait(session,state){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('lifecycle timeout: '+state)),15000);session.on('status',e=>{if(e.state===state){clearTimeout(t);resolve(e)}});});}
async function testReverseLifecycle(){
 if(process.platform!=='linux')return;
 for(const mode of ['stop','conflict','signal','nonzero','missing-gdb']){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-life-')); const src=path.join(dir,'p.cpp'), name=path.join(dir,'p.in'), warnings=[];
  let session;
  try{
   fs.writeFileSync(name,'before');fs.writeFileSync(src, mode==='signal'?'#include <signal.h>\nint main(){raise(SIGKILL);return 0;}\n': mode==='nonzero' ? 'int main(){return 7;}\n' : '#include <unistd.h>\nint main(){usleep(700000);return 0;}\n');
   const build=await compileSourceFile(src);assert(build.success,build.stderr);
   const io=await prepareReverseFileIO({cwd:dir,inputName:'p.in',stdinMode:'text',stdin:'temporary',onWarning:m=>warnings.push(m)});
   session=new GDBSession();
   if(mode==='missing-gdb'){
    session.gdbPath=path.join(dir,'not-installed-gdb');
    await assert.rejects(session.start({executable:build.executable,sourceFile:src,cwd:dir,reverseFileIO:io}),/GDB/);
    await session.stop();assert.strictEqual(fs.readFileSync(name,'utf8'),'before');assert(!fs.existsSync(path.join(dir,'.dream-gdb-file-io.lock')));
   } else if(mode==='stop'){
    const paused=wait(session,'paused');await session.start({executable:build.executable,sourceFile:src,cwd:dir,stopAtMain:true,reverseFileIO:io});await paused;
    await session.stop();assert.strictEqual(fs.readFileSync(name,'utf8'),'before');assert(!fs.existsSync(path.join(dir,'.dream-gdb-file-io.lock')));
   } else {
    const done=wait(session,'exited');await session.start({executable:build.executable,sourceFile:src,cwd:dir,stopAtMain:false,reverseFileIO:io});
    if(mode==='conflict'){fs.unlinkSync(name);fs.writeFileSync(name,'user modified');}
    await done;
    assert(fs.existsSync(path.join(dir,'.dream-gdb-file-io.lock')));const backup=fs.readdirSync(dir).find(x=>x.startsWith('p.in.dream-backup-'));
    assert(backup);assert.strictEqual(fs.readFileSync(path.join(dir,backup),'utf8'),'before');assert(warnings.length);
    if(mode==='conflict')assert.strictEqual(fs.readFileSync(name,'utf8'),'user modified');
   }
  }finally{if(session)await session.stop();fs.rmSync(dir,{recursive:true,force:true});}
 }
}
module.exports={testReverseLifecycle};
