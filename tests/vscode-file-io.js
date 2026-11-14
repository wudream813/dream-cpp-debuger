'use strict';
const vscode=require('vscode'), assert=require('assert'), fs=require('fs'), os=require('os'), path=require('path');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
exports.run=async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dream-real-fileio-')), src=path.join(dir,'main.cpp');
 try {
  fs.writeFileSync(src,'// useFileRedirect: true\n// useUnFileRedirect: true\n// inputFile: input.txt\n// outputFile: result.txt\n// unFileInputFile: test.in\n// unFileOutputFile: test.out\n// workDir: <cppDir>\n#include <cstdio>\nint main(){FILE *a=fopen("test.in","r"),*b=fopen("test.out","w");int x=0;if(!a||!b)return 2;fscanf(a,"%d",&x);fprintf(b,"%d",x+1);fclose(a);fclose(b);return 0;}\n');
  fs.writeFileSync(path.join(dir,'input.txt'),'41');fs.writeFileSync(path.join(dir,'test.in'),'old in');fs.writeFileSync(path.join(dir,'test.out'),'old out');
  const conf=vscode.workspace.getConfiguration('dreamCppDebug');await conf.update('interfaceMode','expert',vscode.ConfigurationTarget.Global);await conf.update('stopAtMain',false,vscode.ConfigurationTarget.Global);
  const doc=await vscode.workspace.openTextDocument(src);await vscode.window.showTextDocument(doc);
  await vscode.extensions.getExtension('wudream.dream-cpp-debuger').activate();await vscode.commands.executeCommand('dream-cpp-debug.startDebug');
  const result=path.join(dir,'result.txt');let finished=false;
  for(let i=0;i<150;i++){if(fs.existsSync(result)&&fs.readFileSync(result,'utf8')==='42'&&fs.readFileSync(path.join(dir,'test.in'),'utf8')==='old in'&&fs.readFileSync(path.join(dir,'test.out'),'utf8')==='old out'&&!fs.existsSync(path.join(dir,'.dream-gdb-file-io.lock'))){finished=true;break;}await wait(100);}
  assert(finished,'combined file IO should finish, restore originals and write result');
  console.log('REAL_VSCODE_FILE_IO_PASS');
 } finally {await vscode.commands.executeCommand('dream-cpp-debug.stop');await wait(200);fs.rmSync(dir,{recursive:true,force:true});}
};
