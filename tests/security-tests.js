'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile, runExecutable } = require('../src/compiler');
const { appendBounded, MAX_OUTPUT_CHARS } = require('../src/outputLimits');
const { getSidebarHtml } = require('../src/sidebarHtml');
const { getDashboardHtml } = require('../src/dashboardHtml');

async function testSecurity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-security-test-'));
  try {
    const src = path.join(dir, 'a.cpp');
    fs.writeFileSync(src, '#include <iostream>\nint main(int argc,char** argv){std::string s;std::getline(std::cin,s);std::cout<<s<<"|"<<argv[1]<<std::endl;}\n');
    const buildRoot = path.join(dir, '.dream-debug');
    fs.mkdirSync(buildRoot);
    const protectedFile = path.join(buildRoot, 'another.debug.out');
    fs.writeFileSync(protectedFile, 'do not delete');
    const built = await compileSourceFile(src);
    assert.ok(built.success, built.stderr);
    assert.strictEqual(fs.readFileSync(protectedFile, 'utf8'), 'do not delete');

    if (process.platform !== 'win32') {
      const inputFile = path.join(dir, "space 'quote' $(touch${IFS}marker)");
      fs.writeFileSync(inputFile, 'input-ok\n');
      const session = new GDBSession();
      try {
        const exited = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('GDB security test timeout')), 7000);
          session.on('status', ev => { if (ev.state === 'exited') { clearTimeout(timer); resolve(); } });
        });
        await session.start({ executable: built.executable, sourceFile: src, cwd: dir,
          stdinMode: 'file', stdinFile: inputFile, stopAtMain: false,
          args: ['arg $(touch marker2)'] });
        assert.strictEqual(session.sendStdin('must not append'), false);
        await exited;
        assert.strictEqual(fs.readFileSync(inputFile, 'utf8'), 'input-ok\n');
        assert.ok(session.programOutput.includes('input-ok|arg $(touch marker2)'), session.programOutput);
        assert.ok(!fs.existsSync(path.join(dir, 'marker')));
        assert.ok(!fs.existsSync(path.join(dir, 'marker2')));
      } finally { await session.stop(); }
    }
    // A large or sparse inferior output must not cause a proportional allocation;
    // the session is stopped once the on-disk limit is noticed.
    const largeOutput = path.join(dir, 'large-output');
    fs.closeSync(fs.openSync(largeOutput, 'w'));
    fs.truncateSync(largeOutput, 33 * 1024 * 1024);
    const limited = new GDBSession();
    limited.stdoutFile = largeOutput;
    limited.proc = {};
    let stopped = false;
    limited.stop = async () => { stopped = true; };
    limited._pollProgramOutput();
    assert.ok(stopped && limited._outputLimitReached);
    assert.ok(limited.programOutput.length <= MAX_OUTPUT_CHARS);
    assert.ok(limited.programOutput.includes('32 MiB'));

    // Invalid MI line breaks are rejected before a GDB process is created.
    const invalid = new GDBSession();
    await assert.rejects(invalid.start({ executable: built.executable, cwd: dir,
      args: ['bad\n-gdb-exit'] }), /控制字符/);
    assert.strictEqual(invalid.proc, null);
    assert.strictEqual(invalid.tempDir, null);

    const bounded = appendBounded('', 'x'.repeat(MAX_OUTPUT_CHARS * 2));
    assert.ok(bounded.length <= MAX_OUTPUT_CHARS && bounded.includes('截断'));
    const generated = path.join(dir, 'output.cpp');
    fs.writeFileSync(generated, '#include <cstdio>\nint main(){for(int i=0;i<1500000;i++) putchar(120);}\n');
    const outBuild = await compileSourceFile(generated);
    const run = await runExecutable(outBuild.executable);
    assert.ok(run.stdout.length <= MAX_OUTPUT_CHARS && run.stdout.includes('截断'));

    const fake = new GDBSession();
    fake.state = 'paused';
    fake.locals = [{ name: 'title', type: 'std::string', kind: 'string', raw: '' }];
    const commands = [];
    fake.sendCommand = async cmd => {
      commands.push(cmd);
      if (cmd.includes('.assign(')) throw new Error('no symbol');
      if (cmd.includes('_M_allocated_capacity')) return { results: { value: '15' } };
      return { results: {} };
    };
    fake.refreshState = async () => {};
    assert.strictEqual(await fake.setVariableValue('title', 'x'.repeat(16)), false);
    assert.ok(!commands.some(c => c.includes('memcpy')), 'must not copy past capacity');
    commands.length = 0;
    assert.strictEqual(await fake.setVariableValue('title', 'short'), true);
    assert.ok(commands.some(c => c.includes('memcpy')));
    fake.sendCommand = GDBSession.prototype.sendCommand;
    await assert.rejects(fake.sendCommand('-gdb-version\n-gdb-exit'), /换行/);

    for (const html of [getSidebarHtml({ nonce: 'testnonce' }), getDashboardHtml({ nonce: 'testnonce' })]) {
      assert.ok(html.includes('Content-Security-Policy'));
      assert.ok(html.includes("script-src 'nonce-testnonce'"));
      assert.ok(html.includes("default-src 'none'"));
    }
    assert.notStrictEqual(getSidebarHtml(), getSidebarHtml(), 'default nonces should be random');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { testSecurity };
