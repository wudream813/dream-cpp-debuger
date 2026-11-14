'use strict';
const assert=require('assert'), fs=require('fs'), os=require('os'), path=require('path'), vm=require('vm');
const { createRequire }=require('module'); const { GDBSession }=require('../src/gdbSession'); const { compileSourceFile }=require('../src/compiler');
async function testFileIOController(){
 if(process.platform!=='linux') return;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-io-ui-')), src=path.join(dir,'main.cpp');
 const input=path.join(dir,'problem.in'), output=path.join(dir,'problem.out'), result=path.join(dir,'result.txt');
 const program=`// useFileRedirect: true\n// useUnFileRedirect: true\n// inputFile: input.txt\n// outputFile: result.txt\n// unFileInputFile: problem.in\n// unFileOutputFile: problem.out\n// WorkDir: <cppDir>\n#include <cstdio>\nint main(){ FILE *in=fopen("problem.in","r"), *out=fopen("problem.out","w"); int x=0; if(!in||!out)return 3; fscanf(in,"%d",&x);fprintf(out,"%d",x+10);fclose(in);fclose(out);return 0; }\n`;
 fs.writeFileSync(src,program);fs.writeFileSync(path.join(dir,'input.txt'),'32');fs.writeFileSync(input,'original in');fs.writeFileSync(output,'original out');
 const fake={workspace:{textDocuments:[],getConfiguration:()=>({get:(k,d)=>k==='stopAtMain'?false:d})},window:{showWarningMessage(m){throw Error(m)},showErrorMessage(m){throw Error(m)}}};
 const filename=path.join(__dirname,'..','extension.js'), realRequire=createRequire(filename), mod={exports:{}};
 const code=fs.readFileSync(filename,'utf8')+'\nmodule.exports.TestController=DreamDebugController;';
 vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+code+'\n})')(id=>id==='vscode'?fake:realRequire(id),mod,mod.exports,filename,path.dirname(filename));
 const c=Object.create(mod.exports.TestController.prototype), session=new GDBSession();
 Object.assign(c,{runId:0,stdinMode:'text',stdinText:'999',stdinFile:'',outputFile:'',streamHistory:[],session,
  sidebarProvider:{reveal(){}},statusBarItem:{},outputChannel:{appendLine(){}}, resolveActiveSourceFile:()=>src,
  pushSnapshotToWebview(){},applyCompilerDiagnostics(){},openDashboardPanel(){},compileWithProgress:async file=>compileSourceFile(file)});
 try {
  const done=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('controller timed out')),15000);session.on('status',e=>{if(e.state==='exited'){clearTimeout(t);resolve()}})});
  await c.startDebugSession();await done;
  assert.strictEqual(fs.readFileSync(result,'utf8'),'42');assert.strictEqual(fs.readFileSync(input,'utf8'),'original in');assert.strictEqual(fs.readFileSync(output,'utf8'),'original out');
  assert(!fs.existsSync(path.join(dir,'.dream-gdb-file-io.lock')));
  assert(c.getRawFileIOConfig(src).fileIO);await c.handleWebviewMessage({type:'updateFileIOConfig',key:'fileIO',value:false});assert.strictEqual(c.getRawFileIOConfig(src).fileIO,false);
  await c.handleWebviewMessage({type:'resetFileIOConfig'});assert.strictEqual(c.getRawFileIOConfig(src).fileIO,true);
  const modes = [
   ['// useFileRedirect: true\n// inputFile: input.txt\n// outputFile: result.txt\n', '#include <cstdio>\nint main(){int x;scanf("%d",&x);printf("%d",x+10);return 0;}\n'],
   ['// useFileRedirect: true\n// useUnFileRedirect: true\n// inputFile: input.txt\n// outputFile: result.txt\n// unFileInputFile: problem.in\n// unFileOutputFile: CON\n', '#include <cstdio>\nint main(){FILE*f=fopen("problem.in","r");int x;fscanf(f,"%d",&x);printf("%d",x+10);fclose(f);return 0;}\n'],
   ['// useFileRedirect: true\n// useUnFileRedirect: true\n// inputFile: input.txt\n// outputFile: result.txt\n// unFileInputFile: CON\n// unFileOutputFile: problem.out\n', '#include <cstdio>\nint main(){int x;scanf("%d",&x);FILE*f=fopen("problem.out","w");fprintf(f,"%d",x+10);fclose(f);return 0;}\n']
  ];
  for (const [header,body] of modes) {
    fs.writeFileSync(src,header+body);fs.writeFileSync(result,'old result');
    const finished=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('mode timed out')),15000);session.on('status',e=>{if(e.state==='exited'){clearTimeout(t);resolve()}})});
    await c.startDebugSession();await finished;assert.strictEqual(fs.readFileSync(result,'utf8'),'42');
    assert.strictEqual(fs.readFileSync(input,'utf8'),'original in');assert.strictEqual(fs.readFileSync(output,'utf8'),'original out');
  }
 } finally {await session.stop();fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={testFileIOController};
