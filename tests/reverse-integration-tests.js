'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { compileSourceFile } = require('../src/compiler');
const { prepareReverseFileIO } = require('../src/reverseFileIO');
const { openOutputFile } = require('../src/outputFile');
const { GDBSession } = require('../src/gdbSession');
function exited(session) { return new Promise((resolve,reject) => { const timer = setTimeout(() => reject(Error('reverse GDB timeout')), 15000); session.on('status', e => { if (e.state === 'exited') { clearTimeout(timer); resolve(e); } }); }); }
async function testReverseIntegration() {
 if (process.platform !== 'linux') return;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-io-int-')), source=path.join(dir,'main.cpp');
 const input=path.join(dir,'a.in'), output=path.join(dir,'a.out'), result=path.join(dir,'result.out');
 try {
  fs.writeFileSync(source, `#include <cstdio>\n#include <unistd.h>\nint main(){FILE *a=fopen("a.in","r"), *b=fopen("a.out","w"); int x=0; fscanf(a,"%d",&x); fprintf(b,"result=%d\\n",x+1); fflush(b); usleep(1000000); for(int i=0;i<300000;i++)fputs("0123456789",b); fclose(a);fclose(b);return 0;}\n`);
  fs.writeFileSync(input,'old input'); fs.writeFileSync(output,'old output');
  const built=await compileSourceFile(source); assert(built.success,built.stderr);
  const warnings=[];
  const io=await prepareReverseFileIO({cwd:dir,inputName:'a.in',outputName:'a.out',stdinMode:'text',stdin:'41',protectedPaths:[source,built.executable],outputFile:result,onWarning:m=>warnings.push(m)});
  const sink=await openOutputFile(result,[source,input,output]);
  const session=new GDBSession(); let done=exited(session);
  await session.start({executable:built.executable,sourceFile:source,cwd:dir,stopAtMain:false,reverseFileIO:io,reverseSink:sink,stdinMode:'text'});
  await new Promise(r=>setTimeout(r,550)); assert.strictEqual(fs.readFileSync(result,'utf8'),'result=42\n');
  await done;
  assert.strictEqual(fs.statSync(result).size, 3000010); assert(fs.readFileSync(result,'utf8').startsWith('result=42\n'));
  assert.strictEqual(fs.readFileSync(input,'utf8'),'old input');assert.strictEqual(fs.readFileSync(output,'utf8'),'old output');
  assert(!fs.existsSync(path.join(dir,'.dream-gdb-file-io.lock')));assert.deepStrictEqual(warnings,[]);
  await session.stop();
  const live=await prepareReverseFileIO({cwd:dir,inputName:'a.in',outputName:'a.out',stdinMode:'stream',onWarning:m=>warnings.push(m)});
  done=exited(session);await session.start({executable:built.executable,sourceFile:source,cwd:dir,stopAtMain:false,reverseFileIO:live,stdinMode:'stream'});
  await new Promise(r=>setTimeout(r,250));assert(session.sendStdin('24'));session.closeStdin();await done;assert(session.programOutput.includes('result=25'));
  assert.strictEqual(fs.readFileSync(input,'utf8'),'old input'); assert.strictEqual(fs.readFileSync(output,'utf8'),'old output'); await session.stop();
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
module.exports={testReverseIntegration};
