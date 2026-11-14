'use strict';
const assert=require('assert');const {JSDOM}=require('jsdom');const {getSidebarHtml}=require('../src/sidebarHtml');
function testFileIOUI(){
 const messages=[];const dom=new JSDOM(getSidebarHtml({nonce:'test'}),{runScripts:'dangerously',beforeParse(w){w.acquireVsCodeApi=()=>({postMessage:m=>messages.push(m)});}});
 const {window:w}=dom,d=w.document;
 w.dispatchEvent(new w.MessageEvent('message',{data:{type:'snapshot',snapshot:{state:'idle',fileIOConfig:{fileIO:true,reverseIO:false,inputFile:'data.in',outputFile:'CON',reverseInput:'task.in',reverseOutput:'task.out',workDir:'<cppDir>',customVariable:'x'}}}}));
 assert(d.getElementById('ioFileIO').checked);assert.strictEqual(d.getElementById('ioInputFile').value,'data.in');
 const toggle=d.getElementById('ioReverseIO');toggle.checked=true;toggle.dispatchEvent(new w.Event('change'));
 assert.strictEqual(messages.at(-1).type,'updateFileIOConfig');assert.strictEqual(messages.at(-1).key,'reverseIO');assert.strictEqual(messages.at(-1).value,true);
 const input=d.getElementById('ioReverseInput');input.value='manual.in';input.dispatchEvent(new w.Event('change'));assert.strictEqual(messages.at(-1).value,'manual.in');
 d.getElementById('ioReset').click();assert.strictEqual(messages.at(-1).type,'resetFileIOConfig');dom.window.close();
}
module.exports={testFileIOUI};
