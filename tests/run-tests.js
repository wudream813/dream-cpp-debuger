/**
 * Dream C++ Debugger — Unit & Real GDB/MI2 End-to-End Test Suite
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  unescapeMIString,
  parseMILine,
  extractStdVectorPointers,
  extractStdStringValue,
  parseBraceElements,
  formatCppVariable
} = require('../src/miParser');

const {
  isSourceFile,
  parseCompilerDiagnostics,
  compileSourceFile,
  runExecutable
} = require('../src/compiler');

const { GDBSession } = require('../src/gdbSession');
const { getSidebarHtml } = require('../src/sidebarHtml');
const { getDashboardHtml } = require('../src/dashboardHtml');

async function runAllTests() {
  let passed = 0;
  function ok(name) {
    passed++;
    console.log(`  ✓ ${name}`);
  }

  console.log('=== 1. GDB/MI2 Parser & C++ Value Unpacker Tests ===');

  // Test UTF-8 octal unescaping
  assert.strictEqual(unescapeMIString('\\344\\270\\255\\346\\226\\207\\n'), '中文\n');
  ok('unescapeMIString decodes UTF-8 octal sequences and escapes');

  // Test MI stopped record parsing
  const stoppedRec = parseMILine(
    '*stopped,reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x0000555555555200",func="main",args=[],file="main.cpp",fullname="/workspace/main.cpp",line="15"},thread-id="1"'
  );
  assert.strictEqual(stoppedRec.type, 'exec');
  assert.strictEqual(stoppedRec.class, 'stopped');
  assert.strictEqual(stoppedRec.results.reason, 'breakpoint-hit');
  assert.strictEqual(stoppedRec.results.frame.func, 'main');
  assert.strictEqual(stoppedRec.results.frame.line, '15');
  ok('parseMILine parses *stopped exec record with nested frame tuple');

  // Test MI result record with list of variables
  const varRec = parseMILine(
    '12^done,variables=[{name="x",type="int",value="42"},{name="arr",type="int [4]",value="{1, 2, 3, 4}"}]'
  );
  assert.strictEqual(varRec.token, 12);
  assert.strictEqual(varRec.class, 'done');
  assert.strictEqual(varRec.results.variables.length, 2);
  assert.strictEqual(varRec.results.variables[0].name, 'x');
  assert.strictEqual(varRec.results.variables[1].value, '{1, 2, 3, 4}');
  ok('parseMILine parses tokenized result record with variable list');

  // Test std::vector pointer extraction & std::string extraction
  const rawVec = '{<std::_Vector_base<int, std::allocator<int> >> = {_M_impl = {_M_start = 0x55555556b2b0, _M_finish = 0x55555556b2c0, _M_end_of_storage = 0x55555556b2c0}}}';
  const ptrs = extractStdVectorPointers(rawVec);
  assert.ok(ptrs);
  assert.strictEqual(ptrs.startHex, '0x55555556b2b0');
  assert.strictEqual(ptrs.finishHex, '0x55555556b2c0');
  ok('extractStdVectorPointers extracts _M_start and _M_finish from raw libstdc++ vector');

  const rawStr = '{_M_dataplus = {_M_p = 0x7fffffffead0 "Hello Dream"}, _M_string_length = 11}';
  assert.strictEqual(extractStdStringValue(rawStr), '"Hello Dream"');
  ok('extractStdStringValue extracts string literal from raw libstdc++ std::string');

  // Test array brace parser & <repeats N times>
  const elems = parseBraceElements('{10, 20, 0 <repeats 3 times>, 99}');
  assert.deepStrictEqual(elems, ['10', '20', '0', '0', '0', '99']);
  const formattedArr = formatCppVariable('dp', '{2, 4, 8, 16}', 'int [4]');
  assert.strictEqual(formattedArr.kind, 'array');
  assert.deepStrictEqual(formattedArr.elements, ['2', '4', '8', '16']);
  ok('parseBraceElements & formatCppVariable unpack C/C++ arrays and repeat blocks');

  console.log('\n=== 2. Smart Compiler & Diagnostic Parser Tests ===');
  assert.strictEqual(isSourceFile('/path/to/main.cpp'), true);
  assert.strictEqual(isSourceFile('/path/to/binary.out'), false);

  const sampleStderr = `/tmp/test.cpp:14:9: error: 'undeclaredVar' was not declared in this scope\n/tmp/test.cpp:8:6: warning: unused variable 'unused' [-Wunused-variable]\n/tmp/test.cpp:23:9: 警告: unused variable 'dp' [-Wunused-variable]`;
  const diags = parseCompilerDiagnostics(sampleStderr);
  assert.strictEqual(diags.length, 3);
  assert.strictEqual(diags[0].line, 14);
  assert.strictEqual(diags[0].severity, 'error');
  assert.strictEqual(diags[1].severity, 'warning');
  assert.strictEqual(diags[2].severity, 'warning');
  ok('parseCompilerDiagnostics strictly separates error (CE) vs warning (English & Chinese GCC)');

  const demoSource = path.join(__dirname, '..', 'examples', 'demo_debug.cpp');
  const compileRes = await compileSourceFile(demoSource);
  assert.strictEqual(compileRes.success, true, `Compile failed: ${compileRes.stderr}`);
  assert.strictEqual(compileRes.errors.length, 0, 'Expected 0 compile errors');
  assert.strictEqual(compileRes.warnings.length, 0, 'Default compileFlags should not trigger unused-variable warning');
  assert.ok(fs.existsSync(compileRes.executable));
  ok(`compileSourceFile compiled examples/demo_debug.cpp cleanly (${compileRes.durationMs} ms)`);

  const runRes = await runExecutable(compileRes.executable, { stdin: '6\n' });
  assert.strictEqual(runRes.exitCode, 0);
  assert.ok(runRes.stdout.includes('PrefixSum(6) = 20'), `Unexpected stdout: ${runRes.stdout}`);
  ok('runExecutable injects stdin and captures stdout accurately');

  console.log('\n=== 3. Real GDB/MI2 Session End-to-End Integration Tests ===');
  const session = new GDBSession({ gdbPath: 'gdb' });

  // Wait for first pause at main
  const pausedAtMain = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for pause at main')), 8000);
    const onStatus = (ev) => {
      if (ev.state === 'paused') {
        clearTimeout(timer);
        session.removeListener('status', onStatus);
        resolve(ev);
      }
    };
    session.on('status', onStatus);
  });

  // Pre-set a breakpoint at line 11 (inside computePrefixSum loop) and line 27 (before return in main)
  await session.setBreakpoint(demoSource, 11);
  await session.setBreakpoint(demoSource, 27);
  await session.addWatch('total * 10');

  await session.start({
    executable: compileRes.executable,
    sourceFile: demoSource,
    stdin: '5\n',
    stopAtMain: true
  });

  const firstStop = await pausedAtMain;
  assert.strictEqual(firstStop.state, 'paused');
  assert.strictEqual(firstStop.location.func, 'main');
  ok(`GDBSession started and paused at main() entry (line ${firstStop.location.line})`);

  // Continue to breakpoint inside computePrefixSum (line 11)
  const waitNextPause = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for GDB stop')), 8000);
      const handler = (ev) => {
        if (ev.state === 'paused' || ev.state === 'exited') {
          clearTimeout(timer);
          session.removeListener('status', handler);
          resolve(ev);
        }
      };
      session.on('status', handler);
    });

  let stopPromise = waitNextPause();
  await session.continue();
  let stopEv = await stopPromise;
  assert.strictEqual(stopEv.state, 'paused');
  assert.strictEqual(stopEv.location.line, 11);
  assert.ok(session.stack.length >= 2, 'Expected at least 2 stack frames (computePrefixSum + main)');
  assert.ok(session.stack[0].func.includes('computePrefixSum'));
  ok('GDBSession hit breakpoint inside computePrefixSum() and populated Call Stack');

  // Step over once so `total += nums[0]` executes
  stopPromise = waitNextPause();
  await session.stepOver();
  await stopPromise;

  const totalVar = session.locals.find((v) => v.name === 'total');
  assert.ok(totalVar, 'Expected local variable total');
  assert.strictEqual(totalVar.displayValue, '1');
  const watchItem = session.watches.find((w) => w.expr === 'total * 10');
  assert.ok(watchItem);
  assert.strictEqual(watchItem.value, '10');
  ok('GDBSession stepOver updated local variable `total = 1` and Watch `total * 10 = 10`');

  // Disable loop breakpoint and continue to line 27 in main() to verify std::vector, std::string, and array unwrapping
  await session.setBreakpointEnabled(demoSource, 11, false);
  stopPromise = waitNextPause();
  await session.continue();
  stopEv = await stopPromise;
  assert.strictEqual(stopEv.location.line, 27);

  const fibVar = session.locals.find((v) => v.name === 'fib');
  const dpVar = session.locals.find((v) => v.name === 'dp');
  const titleVar = session.locals.find((v) => v.name === 'title');
  assert.ok(fibVar && Array.isArray(fibVar.elements));
  assert.deepStrictEqual(fibVar.elements, ['1', '1', '2', '3', '5', '8', '13']);
  assert.ok(dpVar && Array.isArray(dpVar.elements));
  assert.deepStrictEqual(dpVar.elements, ['1', '2', '4', '8', '16', '32']);
  assert.ok(titleVar && titleVar.displayValue.includes('Dream C++ GDB Debugger'));
  ok('GDBSession unwrapped std::vector<int> fib, int dp[6], and std::string title');

  // Test live variable editing in GDB
  const edited = await session.setVariableValue('result', '777');
  assert.strictEqual(edited, true);
  const resVar = session.locals.find((v) => v.name === 'result');
  assert.strictEqual(resVar.displayValue, '777');
  ok('GDBSession modified variable `result = 777` live during pause');

  // Continue to program exit and verify programOutput captures modified result 777
  stopPromise = waitNextPause();
  await session.continue();
  const exitEv = await stopPromise;
  assert.strictEqual(exitEv.state, 'exited');
  assert.ok(
    session.programOutput.includes('PrefixSum(5) = 777'),
    `Expected modified output 777, got: ${session.programOutput}`
  );
  await session.stop();
  ok('GDBSession captured modified stdout output and exited cleanly');

  // Test starting a 2nd and 3rd debug session on the SAME GDBSession instance (regression test for 2nd-run failure)
  await session.clearAllBreakpoints();
  const waitPause = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for pause on repeated start')), 8000);
      const onStatus = (ev) => {
        if (ev.state === 'paused') {
          clearTimeout(timer);
          session.removeListener('status', onStatus);
          resolve(ev);
        }
      };
      session.on('status', onStatus);
    });

  // 2nd run (after 1st session exited)
  const secondPausePromise = waitPause();
  await session.start({
    executable: compileRes.executable,
    sourceFile: demoSource,
    stdin: '4\n',
    stopAtMain: true
  });
  const secondStop = await secondPausePromise;
  assert.strictEqual(secondStop.state, 'paused');
  assert.strictEqual(secondStop.location.func, 'main');
  ok('GDBSession 2nd consecutive start() succeeded without race condition');

  // 3rd run (restarting while 2nd session is still paused!)
  const thirdPausePromise = waitPause();
  await session.start({
    executable: compileRes.executable,
    sourceFile: demoSource,
    stdin: '3\n',
    stopAtMain: true
  });
  const thirdStop = await thirdPausePromise;
  assert.strictEqual(thirdStop.state, 'paused');
  assert.strictEqual(thirdStop.location.func, 'main');

  const thirdExitPromise = waitNextPause();
  await session.continue();
  const thirdExit = await thirdExitPromise;
  assert.strictEqual(thirdExit.state, 'exited');
  await session.stop();
  fs.rmSync(path.join(__dirname, '..', 'examples', '.dream-debug'), { recursive: true, force: true });
  ok('GDBSession 3rd consecutive start() (mid-session restart) succeeded and exited cleanly');

  console.log('\n=== 4. Dual-Pane UI Verification (Left Sidebar I/O + Right Dashboard) ===');
  const sidebarHtml = getSidebarHtml({ nonce: 'test-nonce' });
  assert.ok(sidebarHtml.includes('标准输入 (stdin)'));
  assert.ok(sidebarHtml.includes('程序输出 (stdout / stderr)'));
  assert.ok(sidebarHtml.includes('编译并开始 GDB 调试'));
  assert.ok(!sidebarHtml.includes('localsContainer'), 'Left sidebar should only hold compile/run and stdin/stdout');
  assert.ok(sidebarHtml.includes('body.vscode-light'));
  assert.ok(sidebarHtml.includes('diag-warning'));
  ok('Left Sidebar (getSidebarHtml) holds only Compile/Run controls + Stdin/Stdout I/O');

  const dashHtml = getDashboardHtml({ nonce: 'test-nonce' });
  assert.ok(dashHtml.includes('局部变量 & STL / 数组可视化'));
  assert.ok(dashHtml.includes('监视表达式 (Watch Expressions)'));
  assert.ok(dashHtml.includes('调用栈 (Call Stack)'));
  assert.ok(dashHtml.includes('断点管理 (支持条件断点)'));
  assert.ok(dashHtml.includes('GDB 交互命令台 & CPU 寄存器'));
  assert.ok(dashHtml.includes('body.vscode-light'));
  ok('Right Dashboard (getDashboardHtml) renders full spacious GDB inspection workspace');

  console.log(`\n🎉 All ${passed} tests passed!`);
}

runAllTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
