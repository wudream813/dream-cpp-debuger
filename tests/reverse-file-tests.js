'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { prepareReverseFileIO } = require('../src/reverseFileIO');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');
async function testReverseFileIO() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-reverse-'));
  const input = path.join(dir, 'case.in'), output = path.join(dir, 'case.out');
  try {
    fs.writeFileSync(input, 'original input'); fs.writeFileSync(output, 'original output');
    const io = await prepareReverseFileIO({ cwd: dir, inputName: 'case.in', outputName: 'case.out', stdinMode: 'text', stdin: '42\n' });
    assert.strictEqual(fs.readFileSync(input, 'utf8'), '42\n');
    fs.writeFileSync(output, 'result 42');
    assert.strictEqual(io.poll(null), 'result 42');
    await assert.rejects(prepareReverseFileIO({ cwd: dir, inputName: 'case.in', outputName: 'case.out', stdinMode: 'text' }), /EEXIST/);
    assert(io.cleanup());
    assert.strictEqual(fs.readFileSync(input, 'utf8'), 'original input');
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'original output');
    assert(!fs.existsSync(path.join(dir, '.dream-gdb-file-io.lock')));
    await assert.rejects(prepareReverseFileIO({ cwd: dir, inputName: '../escape', stdinMode: 'text' }), /\.\./);
    await assert.rejects(prepareReverseFileIO({ cwd: dir, inputName: 'case.in', outputName: 'case.in', stdinMode: 'text' }), /同一/);
    await assert.rejects(prepareReverseFileIO({ cwd: dir, inputName: 'case.in', stdinMode: 'text', outputFile: path.join(dir,'.dream-gdb-file-io.lock') }), /锁/);
    const missingDir = path.join(dir, 'missing'); fs.mkdirSync(missingDir); fs.writeFileSync(path.join(missingDir,'in'), 'old');
    const missingWarnings = [];
    const missing = await prepareReverseFileIO({cwd:missingDir,inputName:'in',stdinMode:'text',stdin:'temporary',onWarning:m=>missingWarnings.push(m)});
    fs.unlinkSync(path.join(missingDir,'in')); assert.strictEqual(missing.cleanup(),false); assert.strictEqual(missing.cleanup(),false);
    assert(!fs.existsSync(path.join(missingDir,'in'))); assert(missingWarnings.length);
    assert(fs.readdirSync(missingDir).some(x=>x.startsWith('in.dream-backup-')));
    const modifiedDir=path.join(dir,'modified');fs.mkdirSync(modifiedDir);fs.writeFileSync(path.join(modifiedDir,'in'),'old');
    const modified = await prepareReverseFileIO({cwd:modifiedDir,inputName:'in',stdinMode:'text',stdin:'temporary'});
    fs.writeFileSync(path.join(modifiedDir,'in'),'new user data');assert.strictEqual(modified.cleanup(),false);
    assert.strictEqual(fs.readFileSync(path.join(modifiedDir,'in'),'utf8'),'new user data');
    // Inject failure after a backup link is created but before staging completes.
    const realLstat = fs.lstatSync; let injected = false;
    fs.lstatSync = function (file, ...args) {
      if (!injected && String(file).includes('.dream-backup-')) { injected = true; throw Object.assign(new Error('injected'), { code: 'EIO' }); }
      return realLstat.call(this, file, ...args);
    };
    try { await assert.rejects(prepareReverseFileIO({ cwd: dir, inputName: 'case.in', stdinMode: 'text' }), /injected/); }
    finally { fs.lstatSync = realLstat; }
    assert.strictEqual(fs.readFileSync(input, 'utf8'), 'original input');
    assert(!fs.readdirSync(dir).some(x => x.includes('.dream-backup-')));
    assert(!fs.existsSync(path.join(dir, '.dream-gdb-file-io.lock')));
    if (process.platform === 'linux') {
      const source = path.join(dir, 'sample.cpp');
      fs.writeFileSync(source, '#include <cstdio>\nint main(){ FILE *a=fopen("case.in","r"); FILE *b=fopen("case.out","w"); FILE *c=fopen("asset.txt","r"); int x=0; if(!a||!b||!c)return 2; fscanf(a,"%d",&x); fprintf(b,"%d %c",x+1,fgetc(c)); fclose(a);fclose(b);fclose(c);return 0;}\n');
      fs.writeFileSync(path.join(dir, 'asset.txt'), 'Z');
      const built = await compileSourceFile(source); assert(built.success, built.stderr);
      const staging = await prepareReverseFileIO({ cwd: dir, inputName: 'case.in', outputName: 'case.out', stdinMode: 'text', stdin: '42', protectedPaths: [source, built.executable] });
      const session = new GDBSession();
      const finished = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('GDB timeout')), 15000); session.on('status', e => { if (e.state === 'exited') { clearTimeout(timer); resolve(); } }); });
      try { await session.start({ executable: built.executable, sourceFile: source, cwd: dir, stopAtMain: false }); await finished; assert.strictEqual(staging.poll(null), '43 Z'); }
      finally { await session.stop(); assert(staging.cleanup()); }
      assert.strictEqual(fs.readFileSync(input, 'utf8'), 'original input');
      assert.strictEqual(fs.readFileSync(output, 'utf8'), 'original output');
    }
    if (process.platform !== 'win32') {
      const sourceAlias = path.join(dir, 'source-alias'); fs.symlinkSync(input, sourceAlias);
      await assert.rejects(prepareReverseFileIO({cwd:dir,inputName:'case.in',stdinMode:'text',protectedPaths:[sourceAlias]}), /冲突/);
      assert.strictEqual(fs.readFileSync(input,'utf8'),'original input'); fs.unlinkSync(sourceAlias);
      const victim = path.join(dir, 'victim'); fs.writeFileSync(victim, 'keep');
      fs.unlinkSync(output); fs.symlinkSync(victim, output);
      await assert.rejects(prepareReverseFileIO({ cwd: dir, outputName: 'case.out' }), /普通文件/);
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep'); fs.unlinkSync(output);
      const warnings = [];
      const changed = await prepareReverseFileIO({ cwd: dir, inputName: 'case.in', outputName: 'case.out', stdinMode: 'text', onWarning: m => warnings.push(m) });
      fs.unlinkSync(input); fs.writeFileSync(input, 'new user file');
      assert.strictEqual(changed.cleanup(), false); assert.strictEqual(fs.readFileSync(input, 'utf8'), 'new user file');
      assert(warnings[0].includes('备份'));
      const backup = fs.readdirSync(dir).find(x => x.startsWith('case.in.dream-backup-'));
      assert.strictEqual(fs.readFileSync(path.join(dir, backup), 'utf8'), 'original input');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { testReverseFileIO };
