/**
 * Dream C++ Debugger — GDB/MI2 Session Controller
 * Manages GDB child process, MI2 command/response pipeline, STL unwrapping,
 * breakpoints, watch expressions, call stack, registers, and stdin/stdout capture.
 */
'use strict';

const { releaseWhenSafe } = require('./buildCleanup');

const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendBounded, MAX_OUTPUT_CHARS } = require('./outputLimits');
const { readRegularPrefix } = require('./safeFiles');
const {
  parseMILine,
  unescapeMIString,
  extractStdStringValue,
  extractStdVectorPointers,
  formatCppVariable
} = require('./miParser');

/**
 * Clean verbose C++ template types for display badges (e.g. std::vector<int, std::allocator<int> > -> vector<int>)
 */
function cleanCppType(rawType) {
  if (!rawType) return '';
  let text = String(rawType);
  // basic_string has nested template arguments; a non-greedy regex cuts at
  // the first inner '>' and can misidentify a vector as a string.
  const prefix = /std::(?:__cxx11::)?basic_string\s*</g;
  let match;
  while ((match = prefix.exec(text))) {
    let depth = 1, end = prefix.lastIndex;
    while (end < text.length && depth) {
      if (text[end] === '<') depth++;
      if (text[end] === '>') depth--;
      end++;
    }
    if (depth) break;
    const content = text.slice(prefix.lastIndex, end - 1);
    if (/^\s*char\s*$/.test(content) || /^\s*char\s*,\s*std::char_traits\s*<\s*char\s*>\s*,\s*std::allocator\s*<\s*char\s*>\s*$/.test(content)) {
      text = text.slice(0, match.index) + 'std::string' + text.slice(end);
      prefix.lastIndex = match.index + 'std::string'.length;
    } else prefix.lastIndex = end;
  }
  return text.replace(/,\s*std::allocator<[^<>]+>\s*/g, '').replace(/\s+>/g, '>').trim();
}

// GDB invokes a shell to process inferior redirection on Unix. Quote every
// argument separately; double quotes alone still allow $(...) expansion.
function quoteInferiorArgument(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('参数或路径包含不支持的控制字符');
  if (process.platform === 'win32') {
    // cmd.exe expansion/escaping is incompatible with POSIX shell quoting.
    // Fail closed instead of passing ambiguous shell metacharacters to GDB.
    if (/["%!^&|<>]/.test(text)) throw new Error('Windows 参数或路径包含不安全的字符');
    return '"' + text.replace(/\\/g, '/') + '"';
  }
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

// Global values are read in parallel batches; MI responses are matched by
// token, so a batch keeps large symbol tables fast.
const GLOBALS_EVAL_CONCURRENCY = 8;
// Panels only render (and evaluate) this many variable cards by default; the
// user can raise the window or show everything from the panel header.
const DEFAULT_VISIBLE_VARIABLES = 15;
const MAX_VISIBLE_VARIABLES = 1000;

function normalizeVisibleVariables(value) {
  const size = Math.trunc(Number(value));
  if (!Number.isFinite(size) || size < 1) return DEFAULT_VISIBLE_VARIABLES;
  return Math.min(size, MAX_VISIBLE_VARIABLES);
}
// Ask GDB for every symbol it knows (its own default is a hard 200).
const GLOBALS_SYMBOL_MAX_RESULTS = 100000;

class GDBSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gdbPath = options.gdbPath || 'gdb';
    this.maxArrayPreview = options.maxArrayPreview || 16;
    this.maxVisibleVariables = normalizeVisibleVariables(options.maxVisibleVariables);

    this.proc = null;
    this.sessionId = 0;
    this.pauseId = 0;
    this.state = 'idle'; // 'idle' | 'starting' | 'running' | 'paused' | 'exited' | 'error'
    this.executable = null;
    this.sourceFile = null;
    this.cwd = null;

    this.tokenCounter = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';

    this.currentFrame = 0;
    this.currentThread = 1;
    this.stopLocation = null; // { file, line, func, addr, reason }
    this.inferiorPid = null;
    this._refreshPromise = null;
    this._vectorMutation = null;
    this._vectorRevision = 0;
    this._lastStepOrigin = null;
    this._lastStepMode = null;
    this._autoSkipDepth = 0;

    // State caches for sidebar snapshot
    this.stack = [];
    this.locals = [];
    this.globals = [];
    this._globalSymbols = null;
    this.globalsTotal = 0;
    this.globalsLimit = this.maxVisibleVariables;
    this.globalsInfo = '';
    this.prevGlobalValues = new Map();
    this.prevLocalValues = new Map();
    this.watches = []; // [{ id, expr, value, type, kind, elements, error }]
    this.breakpoints = new Map(); // key: `${normPath}:${line}` -> { id, gdbNumber, file, line, enabled, condition, hitCount }
    this.registers = [];

    // Temp files & FIFO for inferior stdin/stdout
    this.tempDir = null;
    this.stdinFile = null;
    this.stdinMode = null;
    this.stdinClosed = false;
    this.stdinFifoFd = null;
    this.stdoutFile = null;
    this.outputCapture = null;
    this.stdoutReadOffset = 0;
    this.stdoutTimer = null;
    this._outputLimitReached = false;
    this.programOutput = '';
  }

  normalizeFilePath(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.replace(/\\/g, '/') : resolved;
  }

  /**
   * Start a new GDB MI2 debugging session on a compiled executable.
   * Safely awaits complete termination of any previous GDB process first.
   */
  async start(config = {}) {
    let handedToProcess = false;
    const release = typeof config.cleanupBuild === 'function' ? config.cleanupBuild : null;
    try {
      return await this._startSession(config, () => { handedToProcess = true; });
    } finally {
      if (release && !handedToProcess) { try { release(); } catch (_) {} }
    }
  }

  async _startSession(config = {}, transferBuild = () => {}) {
    await this.stop();

    const currentSessionId = ++this.sessionId;
    const inferiorTracker = { launchAttempted: false, pid: null, exited: false };
    this._inferiorTracker = inferiorTracker;
    this.executable = config.executable;
    this.sourceFile = config.sourceFile || null;
    const rawCwd = config.cwd || (this.executable ? path.dirname(this.executable) : process.cwd());
    this.cwd = rawCwd && fs.existsSync(rawCwd) ? rawCwd : process.cwd();
    this.state = 'starting';
    this.programOutput = '';
    this.stdoutBuffer = '';
    this.stdoutReadOffset = 0;
    this._outputLimitReached = false;
    this.prevLocalValues.clear();
    this.prevGlobalValues.clear();
    this._globalSymbols = null;
    this.globals = [];
    this.globalsTotal = 0;
    this.globalsLimit = this.maxVisibleVariables;
    this.globalsInfo = '';
    this.currentFrame = 0;
    this.inferiorPid = null;
    this.stack = [];
    this.locals = [];
    this.registers = [];
    this._emitSnapshot();

    // Prepare isolated temp directory for this session's stdin & stdout redirection
    const sessionTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-gdb-'));
    const sessionStdoutFile = path.join(sessionTempDir, 'stdout.txt');
    fs.writeFileSync(sessionStdoutFile, '', 'utf8');

    let sessionStdinTarget = path.join(sessionTempDir, 'stdin.txt');
    const stdinMode = config.stdinMode || 'text';
    this.stdinMode = stdinMode;
    this.stdinClosed = false;

    if (stdinMode === 'file' && config.stdinFile && fs.existsSync(config.stdinFile)) {
      sessionStdinTarget = path.resolve(config.stdinFile);
    } else if (stdinMode === 'stream' && process.platform !== 'win32') {
      const fifoPath = path.join(sessionTempDir, 'stdin.fifo');
      try {
        execFileSync('mkfifo', [fifoPath]);
        this.stdinFifoFd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        if (typeof config.stdin === 'string' && config.stdin.length > 0) {
          const initData = config.stdin.endsWith('\n') ? config.stdin : `${config.stdin}\n`;
          fs.writeSync(this.stdinFifoFd, Buffer.from(initData, 'utf8'));
        }
        sessionStdinTarget = fifoPath;
      } catch (_) {
        fs.writeFileSync(sessionStdinTarget, typeof config.stdin === 'string' ? config.stdin : '', 'utf8');
      }
    } else {
      fs.writeFileSync(sessionStdinTarget, typeof config.stdin === 'string' ? config.stdin : '', 'utf8');
    }

    this.tempDir = sessionTempDir;
    this.stdinFile = sessionStdinTarget;
    this.stdoutFile = sessionStdoutFile;
    this.outputCapture = config.outputCapture || null;

    // Validate and quote before spawning, so invalid paths cannot leave a GDB
    // process or FIFO behind.
    let redirectArgs;
    try {
      const userArgs = Array.isArray(config.args) ? config.args.map(quoteInferiorArgument).join(' ') : '';
      if (this.outputCapture && process.platform !== 'linux') throw new Error('当前平台暂不支持安全的调试输出文件重定向');
      const outputTarget = this.outputCapture ? '/proc/self/fd/3' : sessionStdoutFile;
      redirectArgs = `${userArgs} < ${quoteInferiorArgument(sessionStdinTarget)} > ${quoteInferiorArgument(outputTarget)} 2>&1`.trim();
    } catch (err) {
      this.closeStdin();
      this._cleanupTempFiles(sessionTempDir);
      this.state = 'error';
      this.emit('status', { state: 'error', reason: err.message });
      throw err;
    }

    const gdbArgs = ['--interpreter=mi2', '--quiet', this.executable];
    this.emit('output', {
      category: 'system',
      text: `[Dream GDB] 启动调试会话: ${this.gdbPath} ${gdbArgs.join(' ')}`
    });

    let proc;
    try {
      proc = spawn(this.gdbPath, gdbArgs, {
        cwd: this.cwd,
        env: process.env,
        ...(this.outputCapture ? { stdio: ['pipe', 'pipe', 'pipe', this.outputCapture.fd] } : {})
      });
      this.proc = proc;
      if (typeof config.cleanupBuild === 'function') {
        const release = config.cleanupBuild;
        proc.once('close', () => releaseWhenSafe(release, inferiorTracker));
        transferBuild();
      }
    } catch (err) {
      this.state = 'error';
      this.emit('status', { state: 'error', reason: err.message });
      throw err;
    }

    let spawnError = null;

    proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc || this.sessionId !== currentSessionId) return;
      this._onStdoutData(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      if (this.proc !== proc || this.sessionId !== currentSessionId) return;
      const text = chunk.toString();
      if (text.trim()) {
        this.emit('output', { category: 'log', text: text.trim() });
      }
    });

    proc.on('error', (err) => {
      spawnError = err;
      if (this.proc !== proc || this.sessionId !== currentSessionId) return;
      this.state = 'error';
      this.emit('output', {
        category: 'system',
        text: `[Dream GDB] 无法启动 GDB (${this.gdbPath}): ${err.message}`
      });
      this.emit('status', { state: 'error', reason: err.message });
    });

    proc.on('close', (code) => {
      // Always clean up this specific process's temp dir when it closes
      if (this.proc === proc && this.sessionId === currentSessionId) {
        this._stopOutputWatcher();
        this._pollProgramOutput(true);
        if (this.outputCapture) { void this.outputCapture.close(); this.outputCapture = null; }
        this.proc = null;
        for (const [, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error('GDB 进程已退出'));
        }
        this.pending.clear();
        if (this.state !== 'exited' && this.state !== 'idle') {
          this.state = 'exited';
          this.stopLocation = null;
          this._clearInspectionState();
          this.emit('status', { state: 'exited', reason: 'gdb-closed', exitCode: code });
          this._emitSnapshot();
        }
        this._cleanupTempFiles(sessionTempDir);
      } else {
        // An older GDB process finished closing; only clean up its own temp folder!
        try {
          if (sessionTempDir && fs.existsSync(sessionTempDir)) {
            fs.rmSync(sessionTempDir, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    });

    this._startOutputWatcher();

    // Initialize GDB session settings
    try {
      await this.sendCommand('-enable-pretty-printing');
    } catch (err) {
      if (spawnError || this.proc !== proc) {
        throw new Error(`未找到或无法启动 GDB (${this.gdbPath})，请确认系统已安装 GDB 并加入 PATH`);
      }
    }
    await this.sendCommand('-gdb-set print elements 64').catch(() => {});
    await this.sendCommand('-gdb-set print repeats 32').catch(() => {});
    // GDB refuses to read any value larger than max-value-size (64 KiB default),
    // which made arrays of more than ~16k ints unreadable. Previews stay small
    // because `print elements`/`print repeats` still bound the printed text.
    await this.sendCommand('-gdb-set max-value-size unlimited').catch(() => {});
    await this.sendCommand('-gdb-set pagination off').catch(() => {});
    await this.sendCommand('-gdb-set confirm off').catch(() => {});
    // Skip C++ STL / libstdc++ internal functions when stepping into user code
    await this.sendCommand('-interpreter-exec console "skip -rfu ^std::"').catch(() => {});
    await this.sendCommand('-interpreter-exec console "skip -rfu ^__gnu_cxx::"').catch(() => {});

    if (spawnError || this.proc !== proc) {
      throw new Error(`未找到或无法启动 GDB (${this.gdbPath})，请确认系统已安装 GDB 并加入 PATH`);
    }

    // Sync any pre-registered user breakpoints into GDB
    await this._syncAllBreakpointsToGdb();

    // Optionally add temporary breakpoint at main
    if (config.stopAtMain !== false) {
      await this.sendCommand('-break-insert -t main').catch(() => {});
    }

    // Configure arguments + stdin/stdout redirection
    try {
      await this.sendCommand(`-exec-arguments ${redirectArgs}`);
    } catch (err) {
      await this.stop();
      throw err;
    }

    // Start execution
    this.state = 'running';
    this.emit('status', { state: 'running', reason: 'launch' });
    this._emitSnapshot();
    inferiorTracker.launchAttempted = true;
    await this.sendCommand('-exec-run');
  }

  /**
   * Send an MI or CLI command to GDB and return a Promise with parsed MI results.
   */
  sendCommand(command, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (/[\r\n\0]/.test(command)) return reject(new Error('GDB 命令不能包含换行或空字符'));
      if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
        return reject(new Error('GDB 未运行'));
      }
      const token = this.tokenCounter++;
      const timer = setTimeout(() => {
        if (this.pending.has(token)) {
          this.pending.delete(token);
          reject(new Error(`GDB 命令超时: ${command}`));
        }
      }, timeoutMs);

      this.pending.set(token, { resolve, reject, command, timer });
      try {
        this.proc.stdin.write(`${token}${command}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(token);
        reject(err);
      }
    });
  }

  /**
   * Execute a user console command (CLI) inside GDB.
   */
  async evaluateConsoleCommand(cliCommand) {
    await this._waitPendingRefresh();
    if (this._vectorMutation) throw new Error('vector 操作正在进行中');
    if (!cliCommand || !cliCommand.trim()) return '';
    const trimmed = cliCommand.trim();
    this.emit('output', { category: 'console', text: `(gdb) ${trimmed}` });
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const res = await this.sendCommand(`-interpreter-exec console "${escaped}"`);
    if (this.state === 'paused') {
      await this.refreshState();
    }
    return res;
  }

  // ── Execution Control ──

  _isSystemLibraryFrame(frame) {
    if (!frame) return false;
    const file = String(frame.fullname || frame.file || '').replace(/\\/g, '/');
    const func = String(frame.func || '');
    if (
      func.startsWith('std::') ||
      func.startsWith('__gnu_cxx::') ||
      func.startsWith('__cxx11::') ||
      func.startsWith('_GLOBAL__sub_I_')
    ) {
      return true;
    }
    if (
      file.includes('/include/c++/') ||
      file.includes('/bits/') ||
      file.includes('/ext/') ||
      file.includes('/lib/gcc/')
    ) {
      return true;
    }
    return false;
  }

  _isCrtOrUnknownExitFrame(frame) {
    if (!frame) return false;
    const func = String(frame.func || '');
    const file = String(frame.fullname || frame.file || '').replace(/\\/g, '/');
    if (
      func === '??' ||
      func === '_start' ||
      func.includes('libc_start') ||
      func.includes('CRTStartup') ||
      func.includes('__tmain') ||
      file.includes('libc-start') ||
      file.includes('libc_start') ||
      file.includes('crt0') ||
      file.includes('crtexe')
    ) {
      return true;
    }
    return false;
  }

  async _waitPendingRefresh() {
    if (this._vectorMutation) await this._vectorMutation;
    if (this._refreshPromise) {
      try {
        await this._refreshPromise;
      } catch (_) {}
    }
  }

  _restorePausedStateOnError(err) {
    this._lastStepOrigin = null;
    this._lastStepMode = null;
    this._autoSkipDepth = 0;
    if (this.proc) {
      this.state = 'paused';
      this.emit('status', {
        state: 'paused',
        reason: 'command-error',
        location: this.stopLocation
      });
      this._emitSnapshot();
    }
    if (err && err.message) {
      this.emit('output', {
        category: 'system',
        text: `[Dream GDB] 单步/执行提示: ${err.message}`
      });
    }
  }

  async continue() {
    await this._waitPendingRefresh();
    if (this._vectorMutation) return;
    if (this.state !== 'paused') return;
    this._lastStepOrigin = null;
    this._lastStepMode = null;
    this._autoSkipDepth = 0;
    this.state = 'running';
    this.emit('status', { state: 'running', reason: 'continue' });
    this._emitSnapshot();
    try {
      await this.sendCommand('-exec-continue');
    } catch (err) {
      this._restorePausedStateOnError(err);
    }
  }

  async stepOver() {
    await this._waitPendingRefresh();
    if (this._vectorMutation) return;
    if (this.state !== 'paused') return;
    this._lastStepOrigin = this.stopLocation
      ? { func: this.stopLocation.func, line: this.stopLocation.line, file: this.stopLocation.file }
      : null;
    this._lastStepMode = 'stepOver';
    this._autoSkipDepth = 0;
    this.state = 'running';
    try {
      await this.sendCommand('-exec-next');
    } catch (err) {
      const msg = String(err && err.message ? err.message : '');
      if (msg.includes('Cannot find bounds of current function')) {
        try {
          await this.sendCommand('-exec-continue');
          return;
        } catch (_) {}
      }
      this._restorePausedStateOnError(err);
    }
  }

  async stepInto() {
    await this._waitPendingRefresh();
    if (this._vectorMutation) return;
    if (this.state !== 'paused') return;
    this._lastStepOrigin = this.stopLocation
      ? { func: this.stopLocation.func, line: this.stopLocation.line, file: this.stopLocation.file }
      : null;
    this._lastStepMode = 'stepInto';
    this._autoSkipDepth = 0;
    this.state = 'running';
    try {
      await this.sendCommand('-exec-step');
    } catch (err) {
      const msg = String(err && err.message ? err.message : '');
      if (msg.includes('Cannot find bounds of current function')) {
        try {
          await this.sendCommand('-exec-continue');
          return;
        } catch (_) {}
      }
      this._restorePausedStateOnError(err);
    }
  }

  async stepOut() {
    await this._waitPendingRefresh();
    if (this._vectorMutation) return;
    if (this.state !== 'paused') return;

    // Ensure frame #0 is selected before executing -exec-finish
    if (this.currentFrame !== 0) {
      this.currentFrame = 0;
      await this.sendCommand('-stack-select-frame 0').catch(() => {});
    }

    // If already in main() (or there is no user caller frame below frame #0),
    // do NOT execute -exec-finish (which either throws `"finish" not meaningful in the outermost frame.`
    // and locks up state, or steps out of main() into CRT/glibc startup stub `??`).
    const topFunc = this.stopLocation?.func || this.stack[0]?.func || '';
    const hasMainCallerBelow = this.stack.slice(1).some((f) => f && f.func === 'main');
    if (topFunc === 'main' || (!hasMainCallerBelow && this.stack.length <= 1)) {
      this.emit('output', {
        category: 'system',
        text: '[Dream GDB] 当前已处于 main() 最外层函数栈帧，「跳出 (Step Out)」已自动转为「单步跳过 (Step Over)」'
      });
      return this.stepOver();
    }

    this._lastStepOrigin = this.stopLocation
      ? { func: this.stopLocation.func, line: this.stopLocation.line, file: this.stopLocation.file }
      : null;
    this._lastStepMode = 'stepOut';
    this._autoSkipDepth = 0;
    this.state = 'running';
    try {
      await this.sendCommand('-exec-finish');
    } catch (err) {
      const msg = String(err && err.message ? err.message : '');
      if (
        msg.includes('outermost frame') ||
        msg.includes('not meaningful') ||
        msg.includes('Cannot find bounds')
      ) {
        try {
          this.emit('output', {
            category: 'system',
            text: '[Dream GDB] 当前已处于最外层栈帧，「跳出 (Step Out)」已自动转为「单步跳过 (Step Over)」'
          });
          await this.sendCommand('-exec-next');
          return;
        } catch (nextErr) {
          this._restorePausedStateOnError(nextErr);
          return;
        }
      }
      this._restorePausedStateOnError(err);
    }
  }

  async runToLocation(filePath, line) {
    const norm = this.normalizeFilePath(filePath);
    if (this.state === 'paused') {
      await this.sendCommand(`-break-insert -t "${norm}:${line}"`).catch(() => {});
      await this.continue();
    }
  }

  async pause() {
    if (this.state !== 'running' || !this.proc) return;
    try {
      if (this.inferiorPid && process.platform !== 'win32') {
        process.kill(this.inferiorPid, 'SIGINT');
      } else {
        this.proc.kill('SIGINT');
      }
    } catch (_) {
      try { this.proc.kill('SIGINT'); } catch (__) {}
    }
  }

  /**
   * Stream a line or chunk of standard input (stdin) into the running/paused inferior process.
   */
  sendStdin(text) {
    if (this.stdinMode !== 'stream' || this.stdinClosed || typeof text !== 'string' || !text.length) return false;
    const payload = text.endsWith('\n') ? text : `${text}\n`;
    try {
      if (this.stdinFifoFd !== null) {
        fs.writeSync(this.stdinFifoFd, Buffer.from(payload, 'utf8'));
      } else if (this.stdinFile && fs.existsSync(this.stdinFile)) {
        fs.appendFileSync(this.stdinFile, payload, 'utf8');
      } else {
        return false;
      }
      setTimeout(() => this._pollProgramOutput(), 80);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Send EOF to the streaming stdin pipe.
   */
  closeStdin() {
    const wasOpenStream = this.stdinMode === 'stream' && !this.stdinClosed;
    this.stdinClosed = true;
    if (this.stdinFifoFd !== null) {
      try {
        fs.closeSync(this.stdinFifoFd);
      } catch (_) {}
      this.stdinFifoFd = null;
      setTimeout(() => this._pollProgramOutput(), 80);
      return wasOpenStream;
    }
    return false;
  }

  /**
   * Completely stop the current GDB process and wait until the OS process has exited
   * so that subsequent compilations or restarts never collide with a lingering GDB instance.
   */
  async stop(options = {}) {
    this._stopOutputWatcher();
    this._pollProgramOutput();
    this.closeStdin();

    const oldProc = this.proc;
    const oldTempDir = this.tempDir;
    this.proc = null;
    this.stdoutBuffer = '';

    // Clear any pending commands from the old process
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('调试会话已终止'));
    }
    this.pending.clear();

    // Reset GDB breakpoint numbers so next start() re-inserts them cleanly
    for (const bp of this.breakpoints.values()) {
      bp.gdbNumber = null;
    }

    if (oldProc) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        oldProc.once('close', finish);

        try {
          if (oldProc.stdin && oldProc.stdin.writable) {
            oldProc.stdin.write('-gdb-exit\n');
          }
        } catch (_) {}

        setTimeout(() => {
          if (!settled) {
            try { oldProc.kill('SIGKILL'); } catch (_) {}
            setTimeout(finish, 80);
          }
        }, 200);
      });
    }

    this._pollProgramOutput(true);
    if (this.outputCapture) { await this.outputCapture.close().catch(() => {}); this.outputCapture = null; }
    this._clearInspectionState();
    this._cleanupTempFiles(oldTempDir);

    if (!options.keepStateExited) {
      this.state = 'idle';
      this.stopLocation = null;
      this.emit('status', { state: 'idle', reason: 'stopped' });
      this._emitSnapshot();
    }
  }

  // ── Breakpoint Management ──

  _bpKey(filePath, line) {
    return `${this.normalizeFilePath(filePath)}:${Number(line)}`;
  }

  async setBreakpoint(filePath, line, options = {}) {
    const norm = this.normalizeFilePath(filePath);
    const lineNum = Number(line);
    const key = this._bpKey(norm, lineNum);
    let bp = this.breakpoints.get(key);

    if (!bp) {
      bp = {
        id: key,
        gdbNumber: null,
        file: norm,
        line: lineNum,
        enabled: options.enabled !== false,
        condition: options.condition || '',
        hitCount: 0
      };
      this.breakpoints.set(key, bp);
    } else {
      if (options.enabled !== undefined) bp.enabled = Boolean(options.enabled);
      if (options.condition !== undefined) bp.condition = String(options.condition || '');
    }

    if (this.proc && (this.state === 'paused' || this.state === 'starting')) {
      await this._applyBreakpointToGdb(bp);
    }

    this.emit('breakpointChanged', this.getBreakpointsList());
    this._emitSnapshot();
    return bp;
  }

  async removeBreakpoint(filePath, line) {
    const key = this._bpKey(filePath, line);
    const bp = this.breakpoints.get(key);
    if (!bp) return;
    if (bp.gdbNumber && this.proc && this.state === 'paused') {
      await this.sendCommand(`-break-delete ${bp.gdbNumber}`).catch(() => {});
    }
    this.breakpoints.delete(key);
    this.emit('breakpointChanged', this.getBreakpointsList());
    this._emitSnapshot();
  }

  async toggleBreakpoint(filePath, line) {
    const key = this._bpKey(filePath, line);
    if (this.breakpoints.has(key)) {
      await this.removeBreakpoint(filePath, line);
      return { added: false };
    } else {
      const bp = await this.setBreakpoint(filePath, line);
      return { added: true, breakpoint: bp };
    }
  }

  async setBreakpointEnabled(filePath, line, enabled) {
    const key = this._bpKey(filePath, line);
    const bp = this.breakpoints.get(key);
    if (!bp) return;
    bp.enabled = Boolean(enabled);
    if (bp.gdbNumber && this.proc && this.state === 'paused') {
      const cmd = bp.enabled ? `-break-enable ${bp.gdbNumber}` : `-break-disable ${bp.gdbNumber}`;
      await this.sendCommand(cmd).catch(() => {});
    }
    this.emit('breakpointChanged', this.getBreakpointsList());
    this._emitSnapshot();
  }

  async setBreakpointCondition(filePath, line, condition) {
    const key = this._bpKey(filePath, line);
    let bp = this.breakpoints.get(key);
    if (!bp) {
      bp = await this.setBreakpoint(filePath, line, { condition });
      return bp;
    }
    bp.condition = String(condition || '').trim();
    if (bp.gdbNumber && this.proc && this.state === 'paused') {
      await this.sendCommand(`-break-condition ${bp.gdbNumber} ${bp.condition}`).catch(() => {});
    }
    this.emit('breakpointChanged', this.getBreakpointsList());
    this._emitSnapshot();
    return bp;
  }

  async clearAllBreakpoints() {
    if (this.proc && this.state === 'paused') {
      for (const bp of this.breakpoints.values()) {
        if (bp.gdbNumber) {
          await this.sendCommand(`-break-delete ${bp.gdbNumber}`).catch(() => {});
        }
      }
    }
    this.breakpoints.clear();
    this.emit('breakpointChanged', []);
    this._emitSnapshot();
  }

  getBreakpointsList() {
    return Array.from(this.breakpoints.values()).map((bp) => ({
      ...bp,
      fileName: path.basename(bp.file)
    }));
  }

  async _syncAllBreakpointsToGdb() {
    for (const bp of this.breakpoints.values()) {
      bp.gdbNumber = null;
      bp.hitCount = 0;
      await this._applyBreakpointToGdb(bp);
    }
  }

  async _applyBreakpointToGdb(bp) {
    try {
      if (!bp.gdbNumber) {
        const res = await this.sendCommand(`-break-insert "${bp.file}:${bp.line}"`);
        if (res && res.results && res.results.bkpt) {
          const bkpt = Array.isArray(res.results.bkpt) ? res.results.bkpt[0] : res.results.bkpt;
          bp.gdbNumber = bkpt.number;
        }
      }
      if (bp.gdbNumber) {
        if (bp.condition) {
          await this.sendCommand(`-break-condition ${bp.gdbNumber} ${bp.condition}`).catch(() => {});
        }
        if (!bp.enabled) {
          await this.sendCommand(`-break-disable ${bp.gdbNumber}`).catch(() => {});
        }
      }
    } catch (_) {}
  }

  // ── Watch Expressions & Variable Editing ──

  async addWatch(expr) {
    const clean = String(expr || '').trim();
    if (!clean) return;
    if (!this.watches.some((w) => w.expr === clean)) {
      this.watches.push({
        id: `watch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        expr: clean,
        value: '—',
        type: '',
        kind: 'scalar',
        elements: null,
        error: null
      });
    }
    if (this.state === 'paused') {
      await this._refreshWatches();
    }
    this._emitSnapshot();
  }

  async removeWatch(idOrExpr) {
    this.watches = this.watches.filter((w) => w.id !== idOrExpr && w.expr !== idOrExpr);
    this._emitSnapshot();
  }

  async _getContainerLength(name, isVector) {
    // Only simple local names are admitted into these GDB expressions.
    if (!/^[a-zA-Z_]\w*$/.test(name) && !(this._globalSymbols || []).some(v => v.expression === name)) throw new Error('无法验证数组边界');
    const expression = isVector
      ? `(long long)(${name}._M_impl._M_finish - ${name}._M_impl._M_start)`
      : `(unsigned long)(sizeof(${name}) / sizeof(${name}[0]))`;
    const result = await this.sendCommand(`-data-evaluate-expression "${expression}"`);
    const text = String(result?.results?.value ?? '').trim();
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('无法验证数组边界');
    return Number(text);
  }

  _pauseContext() {
    return { sessionId: this.sessionId, pauseId: this.pauseId, frame: this.currentFrame };
  }

  _assertPauseContext(context) {
    if (this.state !== 'paused' || !this.proc || !context ||
        context.sessionId !== this.sessionId || context.pauseId !== this.pauseId ||
        context.frame !== this.currentFrame) throw new Error('调试状态已变化，请重新打开查看器');
  }

  _sequenceKind(variable, rawType) {
    const type = String(rawType || variable.type || '');
    if (!/^[A-Za-z_]\w*$/.test(variable.name || '') || variable.kind === 'uninitialized') return null;
    if (/\bvector\s*</.test(type)) return /vector\s*<\s*bool\b/.test(type) ? null : 'vector';
    if (/^(?:std::)?(?:basic_string<char[^>]*>|string)$/.test(type.trim())) return 'string';
    const dims = this._arrayDimensions(type);
    if (dims) return dims.dims.length === 1 && /\bchar\s*$/.test(dims.base) ? 'chars' : 'array';
    return null;
  }

  /**
   * Parse a C array type such as `int [200]` or `int [20][20]`.
   * Returns { base, dims: [20, 20] } or null when the type is not a fixed array.
   */
  _arrayDimensions(rawType) {
    const match = String(rawType || '').trim().match(/^([^\[\]]+?)\s*((?:\[\s*\d+\s*\])+)$/);
    if (!match) return null;
    const dims = match[2].match(/\[\s*(\d+)\s*\]/g).map(text => Number(text.replace(/[^0-9]/g, '')));
    if (!dims.length || dims.some(size => !Number.isSafeInteger(size) || size < 0)) return null;
    return { base: match[1].trim(), dims };
  }

  /** Total number of scalar elements of a multi-dimensional array, or null. */
  _arrayElementCount(dims) {
    if (!Array.isArray(dims) || !dims.length) return null;
    let total = 1;
    for (const size of dims) {
      if (!Number.isSafeInteger(size) || size < 0) return null;
      total *= size;
      if (!Number.isSafeInteger(total) || total > 10000000) return null;
    }
    return total;
  }

  /** Row-major subscripts for a flat element index, or null for 1-D/unknown. */
  _arraySubscripts(dims, index) {
    if (!Array.isArray(dims) || dims.length <= 1) return null;
    const subscripts = new Array(dims.length);
    let remainder = Number(index);
    if (!Number.isSafeInteger(remainder) || remainder < 0) return null;
    for (let i = dims.length - 1; i >= 0; i--) {
      if (!Number.isSafeInteger(dims[i]) || dims[i] < 1) return null;
      subscripts[i] = remainder % dims[i];
      remainder = Math.floor(remainder / dims[i]);
    }
    return subscripts;
  }

  /**
   * Build the C subscript expression for a flat element index.
   * `grid[12][9]` index 20 becomes `grid[2][2]` (row-major, like the language).
   */
  _subscriptForIndex(name, dims, index) {
    const subscripts = this._arraySubscripts(dims, index);
    if (!subscripts) return `${name}[${Number(index)}]`;
    return name + subscripts.map(value => `[${value}]`).join('');
  }

  /** Human-readable element label for a flat index (`[2][2]` for `grid[12][9]`). */
  _elementLabel(dims, index) {
    const subscripts = this._arraySubscripts(dims, index);
    if (!subscripts) return `[${Number(index)}]`;
    return subscripts.map(value => `[${value}]`).join('');
  }

  async _sequenceLength(name, kind, dims) {
    if (kind !== 'string') {
      if (Array.isArray(dims) && dims.length > 1) {
        const total = this._arrayElementCount(dims);
        if (total === null) throw new Error('无法确认数组边界');
        return total;
      }
      return this._getContainerLength(name, kind === 'vector');
    }
    const res = await this.sendCommand(`-data-evaluate-expression "(unsigned long)${name}._M_string_length"`);
    const value = String(res?.results?.value ?? '').trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('无法确认字符串长度');
    return Number(value);
  }

  async _readSequenceItem(name, kind, index, isChar, isStringElement = false, dims = null) {
    let expression = kind === 'vector' ? `*(${name}._M_impl._M_start + ${index})` :
      kind === 'string' ? `${name}._M_dataplus._M_p[${index}]` : this._subscriptForIndex(name, dims, index);
    if (isChar) expression = `(unsigned char)(${expression})`;
    const res = await this.sendCommand(`-data-evaluate-expression "${expression}"`);
    const value = String(res?.results?.value ?? '');
    if (isStringElement) {
      const extracted = extractStdStringValue(value);
      const display = extracted && extracted !== '__UNINITIALIZED__' ? JSON.stringify(unescapeMIString(extracted.slice(1, -1))) : value;
      return { index, value: display, editValue: display };
    }
    if (!isChar) return { index, value, editValue: value, ...(Array.isArray(dims) && dims.length > 1 ? { label: this._elementLabel(dims, index) } : {}) };
    const m = value.match(/^\s*(\d+)/);
    if (!m || Number(m[1]) > 255) throw new Error('无法读取字符字节');
    const byte = Number(m[1]);
    const printable = byte >= 32 && byte <= 126;
    const display = printable ? String.fromCharCode(byte) : `0x${byte.toString(16).padStart(2, '0')}`;
    return { index, value: display, editValue: printable && byte !== 32 ? display : `0x${byte.toString(16).padStart(2, '0')}`,
      ...(Array.isArray(dims) && dims.length > 1 ? { label: this._elementLabel(dims, index) } : {}) };
  }

  async _describeSequence(formatted, rawType, expression = formatted.name, readOnly = false) {
    const kind = this._sequenceKind(formatted, rawType);
    if (!kind) return formatted;
    try {
      // Multi-dimensional arrays are paged as a flat list of scalar elements so
      // every cell stays readable and editable (`grid[2][2]`, not a whole row).
      const dims = kind === 'array' ? this._arrayDimensions(rawType) : null;
      const multiDim = !!dims && dims.dims.length > 1;
      const length = await this._sequenceLength(expression, kind, multiDim ? dims.dims : null);
      const isChar = kind === 'string' || kind === 'chars'
        || (kind === 'vector' && /vector\s*<\s*(?:signed |unsigned )?char\b/.test(rawType))
        || (multiDim && /\bchar\s*$/.test(dims.base));
      const isStringElement = kind === 'vector' && this._vectorElementType(rawType) === 'string';
      const previewCount = Math.min(length, Math.max(1, Math.min(this.maxArrayPreview, readOnly ? 8 : 32)));
      let items;
      if (isChar || isStringElement || multiDim) {
        items = [];
        for (let i = 0; i < previewCount; i++) {
          items.push(await this._readSequenceItem(expression, kind, i, isChar, isStringElement, multiDim ? dims.dims : null));
        }
      } else {
        items = (formatted.elements || []).slice(0, previewCount).map((value, index) => ({ index, value, editValue: value }));
        if (items.length < previewCount) {
          // The bulk read was refused or truncated (e.g. GDB max-value-size);
          // fall back to reading the preview one element at a time.
          items = [];
          for (let i = 0; i < previewCount; i++) items.push(await this._readSequenceItem(expression, kind, i, false, false));
        }
      }
      // If GDB returned a shortened preview, never claim it is complete.
      const sequence = { kind, length, isChar, items, truncated: items.length < length,
        editable: !readOnly && !/(?:^|\s)const(?:\s|$)/.test(rawType) };
      if (multiDim) sequence.dimensions = dims.dims;
      if (isStringElement) sequence.elementEditable = false;
      if (kind === 'vector') sequence.vectorOps = sequence.editable && !!this._vectorElementType(rawType);
      if (kind === 'string') sequence.stringOps = sequence.editable && rawType.trim() === 'std::string';
      if (kind !== 'string' && kind !== 'chars') {
        const prefix = kind === 'vector' ? `vector[${length}]`
          : multiDim ? dims.dims.map(size => `[${size}]`).join('')
          : `[${length}]`;
        formatted = { ...formatted, kind: 'array', elements: items.map(item => item.value),
          displayValue: `${prefix} { ${items.map(item => item.value).join(', ')}${sequence.truncated ? ', …' : ''} }` };
      } else if (formatted.displayValue.length > 180) {
        formatted = { ...formatted, displayValue: formatted.displayValue.slice(0, 180) + '…' };
        sequence.truncated = true;
        sequence.fullValueUnavailable = true;
      }
      return { ...formatted, sequence };
    } catch (_) {
      // Unavailable ABI/type: retain a read-only preview rather than guess bounds.
      return formatted;
    }
  }

  _vectorElementType(type) {
    // Exact type whitelist: the helper casts to std::vector<T, std::allocator<T>>.
    // Never cast custom allocators, references, nested containers or objects.
    const match = String(type || '').trim().match(/^std::vector\s*<\s*([^<>]+?)\s*>$/);
    if (!match) return null;
    const element = match[1].replace(/\s+/g, ' ').trim();
    const types = {
      'char': 'char', 'signed char': 'schar', 'unsigned char': 'uchar',
      'short': 'short', 'short int': 'short', 'unsigned short': 'ushort', 'unsigned short int': 'ushort',
      'int': 'int', 'unsigned': 'uint', 'unsigned int': 'uint', 'long': 'long', 'long int': 'long',
      'unsigned long': 'ulong', 'unsigned long int': 'ulong', 'long long': 'llong', 'long long int': 'llong',
      'unsigned long long': 'ullong', 'unsigned long long int': 'ullong',
      'float': 'float', 'double': 'double', 'std::string': 'string'
    };
    return Object.prototype.hasOwnProperty.call(types, element) ? types[element] : null;
  }

  async insertVectorElement(name, index, rawValue, context, options = {}) {
    await this._waitPendingRefresh();
    if (this._vectorMutation) throw new Error('vector 操作正在进行中');
    this._assertPauseContext(context);
    if (!/^[A-Za-z_]\w*$/.test(name || '')) throw new Error('只能修改当前栈帧中的局部变量');
    const variable = this.locals.find(v => v.name === name);
    const seq = variable && variable.sequence;
    const isString = !!(seq && seq.kind === 'string' && seq.stringOps);
    const type = seq && seq.editable && seq.kind === 'vector' ? this._vectorElementType(variable.type) : null;
    if (!type && !isString) throw new Error('此容器类型不支持插入或删除');
    const deleting = options.delete === true;
    const checkRevision = () => {
      if (options.revision !== undefined && options.revision !== this._vectorRevision) throw new Error('容器内容已变化，请重新选择元素');
    };
    checkRevision();
    const append = index === null && !deleting;
    let idx = append ? null : Number(index);
    if (!append && (!Number.isSafeInteger(idx) || idx < 0)) throw new Error('插入位置无效');
    const value = String(rawValue ?? '');
    let argument;
    if (deleting) {
      argument = '';
    } else if (type === 'string' || isString) {
      let bytes = Buffer.from(value, 'utf8');
      if (isString && (/^0x[0-9a-f]{1,2}$/i.test(value.trim()) || ['\\0','\\n','\\r','\\t','\\\\',"\\'"].includes(value))) bytes = Buffer.from([this._parseCharacterByte(value)]);
      if (isString && !bytes.length) throw new Error('请输入要插入的文本或字节');
      if (bytes.length > 4096) throw new Error('字符串不能超过 4096 字节');
      // Octal escapes avoid GDB command injection and preserve the exact UTF-8 bytes.
      const literal = Array.from(bytes, byte => '\\' + byte.toString(8).padStart(3, '0')).join('');
      argument = `"${literal}", ${bytes.length}`;
    } else if (['char', 'schar', 'uchar'].includes(type)) {
      argument = String(this._parseCharacterByte(value));
    } else if (type === 'float' || type === 'double') {
      const trimmed = value.trim();
      if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[fF]?$/.test(trimmed)) throw new Error('请输入十进制数值');
      argument = trimmed;
    } else {
      const trimmed = value.trim();
      if (!/^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)(?:[uU](?:ll|LL|l|L)?|(?:ll|LL|l|L)[uU]?)?$/.test(trimmed)) throw new Error('请输入整数值');
      argument = trimmed;
    }
    let release;
    this._vectorMutation = new Promise(resolve => { release = resolve; });
    this._emitSnapshot();
    try {
      const length = await this._sequenceLength(name, isString ? 'string' : 'vector');
      this._assertPauseContext(context);
      checkRevision();
      if (append) idx = length;
      if (options.requireEmpty && length !== 0) throw new Error('容器已不为空，请重新选择元素');
      if (options.anchorIndex !== undefined && (!Number.isSafeInteger(options.anchorIndex) || options.anchorIndex < 0 || options.anchorIndex >= length)) throw new Error('选择的元素已不存在');
      if (deleting && idx >= length) throw new Error('删除位置越界');
      if (idx > length) throw new Error(`插入位置越界（有效范围 0–${length}）`);
      // Reject known ABI/layout mismatches before casting to the helper's vector type.
      // This is particularly important for old vs new libstdc++ std::string ABI.
      const check = isString ? `(sizeof(${name}) == dream_debug_string_object_size)` : `(sizeof(${name}) == dream_debug_vector_size_${type}) && (sizeof(*${name}._M_impl._M_start) == dream_debug_element_size_${type})`;
      const layout = await this.sendCommand(`-data-evaluate-expression "${check}"`).catch(err => { throw new Error(`无法验证 vector 辅助代码的 ABI：${err.message}`); });
      this._assertPauseContext(context);
      if (!/^(?:true|1)$/.test(String(layout?.results?.value ?? ''))) throw new Error('vector 与调试助手的 ABI 布局不匹配，已拒绝操作');
      checkRevision();
      const expression = isString
        ? (deleting ? `dream_debug_string_erase((void*)&${name}, ${idx})` : `dream_debug_string_insert((void*)&${name}, ${idx}, ${argument})`)
        : (deleting ? `dream_debug_vector_erase_${type}((void*)&${name}, ${idx})` : `dream_debug_vector_insert_${type}((void*)&${name}, ${idx}, ${argument})`);
      const escaped = expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      let result;
      try { result = await this.sendCommand(`-data-evaluate-expression "${escaped}"`, 15000); }
      catch (err) {
        if (/命令超时/.test(err.message)) {
          // The call may still be executing: do not resume against unknown state.
          await this.stop();
          throw new Error('vector 操作调用超时，调试会话已停止；结果不确定');
        }
        throw new Error(`GDB 无法调用 vector 操作助手（可能不支持目标函数调用）：${err.message}`);
      }
      this._assertPauseContext(context);
      const code = String(result?.results?.value ?? '');
      if (code !== '0') throw new Error(code === '-2' ? '操作位置越界' : code === '-3' ? '当前编译设置不支持安全插入' : `插入失败（代码 ${code}）`);
      this._vectorRevision++;
      await this.refreshState();
      this._assertPauseContext(context);
    } finally {
      this._vectorMutation = null;
      release();
      this._emitSnapshot();
    }
  }

  async getSequencePage(name, offset, pageSize, context, scope = 'local') {
    await this._waitPendingRefresh();
    if (this._vectorMutation) throw new Error('vector 操作正在进行中');
    this._assertPauseContext(context);
    if (!/^[A-Za-z_]\w*$/.test(name || '')) throw new Error('只能查看当前栈帧中的局部变量');
    if (scope !== 'local' && scope !== 'global') throw new Error('变量作用域无效');
    const variable = (scope === 'global' ? this.globals : this.locals).find(v => v.name === name);
    if (!variable || !variable.sequence) throw new Error('该变量无法安全分页查看');
    const expr = scope === 'global' ? variable.expression : name;
    if (scope === 'global' && !(this._globalSymbols || []).some(v => v.id === name && v.expression === expr)) throw new Error('全局变量不可用');
    const seq = variable.sequence;
    const length = await this._sequenceLength(expr, seq.kind, seq.dimensions);
    this._assertPauseContext(context);
    const start = Number(offset);
    const size = Number(pageSize);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > 32 || (start >= length && start !== 0)) throw new Error('分页范围无效');
    const items = [];
    for (let i = start; i < Math.min(length, start + size); i++) {
      this._assertPauseContext(context);
      items.push(await this._readSequenceItem(expr, seq.kind, i, seq.isChar, this._vectorElementType(variable.type) === 'string', seq.dimensions));
    }
    this._assertPauseContext(context);
    return { name, offset: start, length, items, isChar: seq.isChar, editable: seq.editable && seq.elementEditable !== false, vectorOps: seq.vectorOps === true, stringOps: seq.stringOps === true, context };
  }

  _parseCharacterByte(input) {
    let value = String(input ?? '');
    if (/^0x[0-9a-f]{1,2}$/i.test(value.trim())) return parseInt(value.trim().slice(2), 16);
    const escapes = { '\\0': 0, '\\n': 10, '\\r': 13, '\\t': 9, '\\\\': 92, "\\'": 39 };
    if (Object.prototype.hasOwnProperty.call(escapes, value)) return escapes[value];
    if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") value = value.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(escapes, value)) return escapes[value];
    if (Buffer.byteLength(value, 'utf8') !== 1) throw new Error('请输入一个单字节字符、转义序列或 0x00–0xFF；多字节字符请修改整个字符串');
    return Buffer.from(value, 'utf8')[0];
  }

  async setSequenceElement(name, index, value, context) {
    await this._waitPendingRefresh();
    if (this._vectorMutation) throw new Error('vector 操作正在进行中');
    this._assertPauseContext(context);
    const variable = this.locals.find(v => v.name === name);
    if (!variable || !variable.sequence || !variable.sequence.editable || variable.sequence.elementEditable === false) throw new Error('变量不可逐项修改');
    const seq = variable.sequence;
    const idx = Number(index);
    if (!Number.isSafeInteger(idx) || idx < 0) throw new Error('索引无效');
    const length = await this._sequenceLength(name, seq.kind, seq.dimensions);
    this._assertPauseContext(context);
    if (idx >= length) throw new Error('索引越界');
    const input = seq.isChar ? String(this._parseCharacterByte(value)) : String(value ?? '').trim();
    // A single element/cell only ever takes a scalar: never a brace list.
    if (!input || /[\r\n\0]/.test(input) || input.includes('...') || input.includes('…') ||
        (!seq.isChar && (/[{}]/.test(input) || /^\[.*\]$/.test(input)))) throw new Error('元素值无效');
    const target = seq.kind === 'vector' ? `*(${name}._M_impl._M_start + ${idx})` :
      seq.kind === 'string' ? `${name}._M_dataplus._M_p[${idx}]` : this._subscriptForIndex(name, seq.dimensions, idx);
    const expression = `${target} = ${input}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await this.sendCommand(`-data-evaluate-expression "${expression}"`);
    this._assertPauseContext(context);
    await this.refreshState();
    this._assertPauseContext(context);
  }

  /**
   * Modify a local variable, std::string, std::vector, array, or element value during pause.
   */
  async setVariableValue(name, newValue) {
    await this._waitPendingRefresh();
    if (this._vectorMutation) throw new Error('vector 操作正在进行中');
    if (this.state !== 'paused') return false;
    const cleanName = String(name || '').trim();
    const rawInput = String(newValue ?? '').trim();
    if (!cleanName) return false;

    const escapeForMI = (expr) => expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapeCStringLiteral = (str) =>
      str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');

    try {
      // Check if modifying an indexed element like `fib[2]` or `dp[0]`
      const idxMatch = cleanName.match(/^([a-zA-Z_]\w*)\[(\d+)\]$/);
      if (idxMatch) {
        const baseName = idxMatch[1];
        const elemIdx = parseInt(idxMatch[2], 10);
        const baseVar = this.locals.find((v) => v.name === baseName);
        if (!baseVar || baseVar.kind !== 'array') throw new Error('无法验证数组边界');
        const isVec = baseVar.type.includes('vector') || (baseVar.raw && baseVar.raw.includes('_M_impl'));
        const length = await this._getContainerLength(baseName, isVec);
        if (!Number.isSafeInteger(elemIdx) || elemIdx >= length) throw new Error(`数组索引越界（长度 ${length}）`);
        const assignment = isVec
          ? `*(${baseName}._M_impl._M_start + ${elemIdx}) = ${rawInput}`
          : `${baseName}[${elemIdx}] = ${rawInput}`;
        await this.sendCommand(`-data-evaluate-expression "${escapeForMI(assignment)}"`);
        await this.refreshState();
        return true;
      }

      const targetVar = this.locals.find((v) => v.name === cleanName);
      if (targetVar?.kind === 'uninitialized') throw new Error('变量尚未初始化');
      const isStdString =
        targetVar && !/\bvector\s*</.test(targetVar.type) &&
        (targetVar.type.includes('string') ||
          (targetVar.raw && targetVar.raw.includes('_M_dataplus')) ||
          (targetVar.kind === 'string' && !targetVar.type.includes('*') && !targetVar.type.includes('[')));

      // 1. Handle std::string assignment (avoids GDB `Invalid cast.` on `title = "..."`)
      if (isStdString) {
        let strContent = rawInput;
        if (
          (strContent.startsWith('"') && strContent.endsWith('"')) ||
          (strContent.startsWith("'") && strContent.endsWith("'"))
        ) {
          strContent = strContent.slice(1, -1);
        }
        const byteLen = Buffer.byteLength(strContent, 'utf8');
        const cLiteral = `"${escapeCStringLiteral(strContent)}"`;
        try {
          const assignExpr = `${cleanName}.assign(${cLiteral}, ${byteLen})`;
          await this.sendCommand(`-data-evaluate-expression "${escapeForMI(assignExpr)}"`);
        } catch (_) {
          // Only fall back to raw libstdc++ storage if its actual capacity can
          // be determined. Never copy past it or guess another STL's layout.
          const capExpr = `(unsigned long)(${cleanName}._M_dataplus._M_p == ${cleanName}._M_local_buf ? sizeof(${cleanName}._M_local_buf) - 1 : ${cleanName}._M_allocated_capacity)`;
          const capResult = await this.sendCommand(`-data-evaluate-expression "${escapeForMI(capExpr)}"`);
          const capacityText = String(capResult?.results?.value ?? '').trim();
          if (!/^\d+$/.test(capacityText) || !Number.isSafeInteger(Number(capacityText)) || byteLen > Number(capacityText)) {
            throw new Error('无法安全修改字符串：目标容量不足或无法确认');
          }
          const memcpyExpr = `(void*)memcpy(${cleanName}._M_dataplus._M_p, ${cLiteral}, ${byteLen + 1})`;
          await this.sendCommand(`-data-evaluate-expression "${escapeForMI(memcpyExpr)}"`);
          await this.sendCommand(
            `-data-evaluate-expression "${escapeForMI(`${cleanName}._M_string_length = ${byteLen}`)}"`
          );
        }
        this._vectorRevision++;
        await this.refreshState();
        return true;
      }

      // 2. Handle whole std::vector or C array assignment (e.g. `{1, 2, 3}` or `vector[3] { 1, 2, 3 }`)
      if (targetVar && targetVar.kind === 'array') {
        if (!targetVar.sequence || targetVar.sequence.truncated || targetVar.sequence.elementEditable === false) throw new Error('长数组或无法确认长度的数组不可整体修改，请逐项修改');
        if (rawInput.includes('...') || rawInput.includes('…')) throw new Error('省略的数组不可整体修改，请逐项修改');
        const stripped = rawInput
          .replace(/^(?:std::)?vector\[\d+\]\s*/i, '')
          .replace(/^\[\d+\]\s*/, '')
          .replace(/^\{/, '')
          .replace(/\}$/, '')
          .trim();
        const parts = stripped
          ? stripped.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
        const isVec = targetVar.type.includes('vector') || (targetVar.raw && targetVar.raw.includes('_M_impl'));
        const length = await this._getContainerLength(cleanName, isVec);
        if (parts.length > length) throw new Error(`赋值元素过多（长度 ${length}）`);
        for (let i = 0; i < parts.length; i++) {
          const elemAssign = isVec
            ? `*(${cleanName}._M_impl._M_start + ${i}) = ${parts[i]}`
            : `${cleanName}[${i}] = ${parts[i]}`;
          await this.sendCommand(`-data-evaluate-expression "${escapeForMI(elemAssign)}"`);
        }
        await this.refreshState();
        return true;
      }

      // 3. Default scalar / pointer / struct member assignment
      const escapedExpr = escapeForMI(`${cleanName} = ${rawInput}`);
      await this.sendCommand(`-data-evaluate-expression "${escapedExpr}"`);
      await this.refreshState();
      return true;
    } catch (err) {
      this.emit('output', {
        category: 'system',
        text: `[Dream GDB] 修改变量 ${cleanName} 失败: ${err.message}`
      });
      return false;
    }
  }

  /**
   * Select active stack frame and refresh variables.
   */
  async selectFrame(frameLevel) {
    await this._waitPendingRefresh();
    if (this._vectorMutation) throw new Error('vector 操作正在进行中');
    if (this.state !== 'paused') return;
    this.pauseId++;
    this.currentFrame = Number(frameLevel) || 0;
    await this.sendCommand(`-stack-select-frame ${this.currentFrame}`).catch(() => {});
    await this.refreshState();
    const frame = this.stack.find((f) => Number(f.level) === this.currentFrame);
    if (frame && frame.fullname && frame.line) {
      this.stopLocation = {
        file: frame.fullname,
        line: Number(frame.line),
        func: frame.func,
        addr: frame.addr,
        reason: 'frame-select'
      };
      this.emit('status', {
        state: 'paused',
        reason: 'frame-select',
        location: this.stopLocation
      });
    }
  }

  /**
   * Evaluate arbitrary C++ expression and unwrap STL containers automatically.
   */
  async evaluateExpression(expr) {
    if (this.state !== 'paused') {
      throw new Error('当前未处于断点暂停状态');
    }
    const clean = String(expr || '').trim();
    const escaped = clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const res = await this.sendCommand(`-data-evaluate-expression "${escaped}"`);
    const rawVal = res?.results?.value ?? '';
    const unwrapped = await this._unwrapValueIfNeeded(clean, rawVal, '');
    return unwrapped;
  }

  // ── State Inspection on Stop ──

  async refreshState() {
    if (this.state !== 'paused' || !this.proc) return;

    this._pollProgramOutput();

    // Flush inferior stdout buffer if possible so user sees cout/printf without newline immediately
    await this.sendCommand('-data-evaluate-expression "(int)fflush(0)"', 1500).catch(() => {});
    this._pollProgramOutput();

    // 1. Call Stack
    try {
      const stackRes = await this.sendCommand('-stack-list-frames');
      const rawStack = stackRes?.results?.stack;
      const frames = Array.isArray(rawStack) ? rawStack : rawStack ? [rawStack] : [];
      this.stack = frames.map((f) => ({
        level: Number(f.level ?? 0),
        func: f.func || '??',
        file: f.file ? path.basename(f.file) : '',
        fullname: f.fullname || f.file || '',
        line: f.line ? Number(f.line) : null,
        addr: f.addr || ''
      }));
    } catch (_) {
      this.stack = [];
    }

    // 2. Local Variables & Arguments (combine --simple-values for types + --all-values for values)
    try {
      const simpleRes = await this.sendCommand(
        `-stack-list-variables --thread ${this.currentThread} --frame ${this.currentFrame} --simple-values`
      ).catch(() => null);
      const allRes = await this.sendCommand(
        `-stack-list-variables --thread ${this.currentThread} --frame ${this.currentFrame} --all-values`
      );

      const typeMap = new Map();
      const simpleVars = simpleRes?.results?.variables || [];
      for (const sv of (Array.isArray(simpleVars) ? simpleVars : [simpleVars])) {
        if (sv && sv.name) {
          typeMap.set(sv.name, cleanCppType(sv.type || ''));
        }
      }

      const rawVars = allRes?.results?.variables || [];
      const varList = Array.isArray(rawVars) ? rawVars : [rawVars];
      const nextLocals = [];

      const activeFrame = this.stack.find((f) => Number(f.level) === this.currentFrame) || this.stack[0];
      const frameFile = activeFrame?.fullname || this.stopLocation?.file || this.sourceFile;
      const frameLine = activeFrame?.line || this.stopLocation?.line || 0;
      const frameFunc = activeFrame?.func || this.stopLocation?.func || '';
      const declInfo = await this._findLocalDeclarationLines(
        frameFile,
        frameLine,
        frameFunc,
        varList.filter((v) => v && v.name && v.arg !== '1').map((v) => v.name)
      );

      for (const v of varList) {
        if (!v || !v.name) continue;
        const rawType = typeMap.get(v.name) || '';
        const isArg = v.arg === '1';
        const varDecl = !isArg ? declInfo.get(v.name) : null;

        // If declaration line is strictly below current execution line (or currently on a non-loop declaration line),
        // the variable's constructor/initializer has not executed yet!
        if (varDecl && (varDecl.line > frameLine || (varDecl.line === frameLine && !varDecl.isLoopHeader))) {
          nextLocals.push({
            name: v.name,
            type: rawType || 'auto',
            kind: 'uninitialized',
            displayValue: varDecl.line === frameLine
              ? `⏳ 待执行本行初始化 (第 ${varDecl.line} 行)`
              : `⏳ 尚未初始化 (第 ${varDecl.line} 行声明)`,
            elements: null,
            raw: v.value,
            isArg: false,
            changed: false
          });
          continue;
        }

        let formatted = await this._unwrapValueIfNeeded(v.name, v.value, rawType);
        formatted = await this._describeSequence(formatted, rawType);
        if (!formatted.sequence && formatted.kind === 'uninitialized') {
          // A bulk read that failed (huge array) must not hide a pageable sequence.
          const retry = await this._describeSequence(
            { name: v.name, type: rawType, kind: 'scalar', displayValue: '', elements: null }, rawType);
          if (retry && retry.sequence && retry.sequence.length > 0) {
            formatted = { ...retry, tooltip: '整体值过大，已按元素按需读取；可点击元素分页查看' };
          }
        }
        const prevVal = this.prevLocalValues.get(v.name);
        const changed = formatted.kind !== 'uninitialized' && prevVal !== undefined && prevVal !== formatted.displayValue;
        if (formatted.kind !== 'uninitialized') {
          this.prevLocalValues.set(v.name, formatted.displayValue);
        }
        nextLocals.push({
          ...formatted,
          isArg,
          changed
        });
      }
      this.locals = nextLocals;
    } catch (_) {
      this.locals = [];
    }

    // 3. Program globals from the source tree (bounded, read-only).
    if (this.state !== 'paused' || !this.proc) return;
    await this._refreshGlobals();

    // 4. Watch expressions
    if (this.state !== 'paused' || !this.proc) return;
    await this._refreshWatches();

    // 4. CPU Registers (top general-purpose registers)
    if (this.state !== 'paused' || !this.proc) return;
    await this._refreshRegisters();

    if (this.state === 'paused') {
      this._emitSnapshot();
    }
  }

  /**
   * Scan the active C/C++ source file around the current function to find the declaration line
   * of each local variable. In C/C++, local variables cannot be referenced before their declaration,
   * so the first appearance of `\bvarName\b` inside the function body is its declaration line.
   */
  async _findLocalDeclarationLines(filePath, currentLine, funcName, varNames) {
    const result = new Map();
    if (!filePath || !currentLine || !Array.isArray(varNames) || varNames.length === 0) {
      return result;
    }
    try {
      // Never synchronously open a FIFO/device or read an unbounded source file.
      const { text: content } = await readRegularPrefix(filePath, 2 * 1024 * 1024, true);
      const lines = content.split(/\r?\n/);
      const baseFunc = String(funcName || '')
        .replace(/\(.*$/, '')
        .split('::')
        .pop()
        .trim();

      // Locate function header line scanning backwards from currentLine
      let funcStartIdx = 0;
      if (baseFunc && /^[a-zA-Z_]\w*$/.test(baseFunc)) {
        const funcRe = new RegExp(`\\b${baseFunc}\\s*\\(`);
        for (let i = Math.min(currentLine - 1, lines.length - 1); i >= 0; i--) {
          const clean = lines[i].replace(/\/\/.*$/, '');
          if (funcRe.test(clean) && !clean.trim().endsWith(';')) {
            funcStartIdx = i;
            break;
          }
        }
      }

      // Scan forward from funcStartIdx to find end of function and first occurrence of each varName
      let braceDepth = 0;
      let seenOpenBrace = false;
      const pendingVars = new Set(varNames);

      for (let i = funcStartIdx; i < lines.length && pendingVars.size > 0; i++) {
        // Strip single-line comments and string literals
        const cleanLine = lines[i]
          .replace(/\/\/.*$/, '')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''");

        for (const ch of cleanLine) {
          if (ch === '{') {
            braceDepth++;
            seenOpenBrace = true;
          } else if (ch === '}') {
            braceDepth--;
          }
        }

        // Only match local declarations after the function signature's opening '{' (or on for/while header)
        if (seenOpenBrace) {
          const isLoopHeader = /^\s*(?:for|while)\s*\(/.test(cleanLine);
          for (const vName of Array.from(pendingVars)) {
            if (!/^[a-zA-Z_]\w*$/.test(vName)) {
              pendingVars.delete(vName);
              continue;
            }
            // '>' may end a template type (vector<int>v), not just ->.
            const idRe = new RegExp(`(?<![.\\w])(?<!->)\\b${vName}\\b`);
            if (i === funcStartIdx && vName === baseFunc) continue;
            const match = idRe.exec(cleanLine);
            if (!match) continue;
            const before = cleanLine.slice(0, match.index);
            const after = cleanLine.slice(match.index + vName.length);
            // A method/member use is not a declaration.
            if (/^\s*(?:\.|->)/.test(after) || /->\s*$/.test(before)) continue;
            if (/^\s*\(/.test(after)) {
              // Permit direct initializers (vector<int>v(3)) but do not
              // interpret an ordinary call such as v(...) as a declaration.
              const prefix = before.slice(Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1).trim();
              const typePrefix = /^(?:(?:const|volatile|static|constexpr|auto)\s+)*(?:(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)(?:\s*<[^;{}]*>)?\s*[*&]*\s*$/;
              if (!typePrefix.test(prefix) || /^(?:return|throw|co_return)\b/.test(prefix)) continue;
            }
            result.set(vName, { line: i + 1, isLoopHeader });
            pendingVars.delete(vName);
          }
        }

        if (seenOpenBrace && braceDepth <= 0) {
          break;
        }
      }
    } catch (_) {}

    return result;
  }

  async _unwrapValueIfNeeded(exprOrName, rawVal, rawType) {
    const vecPtrs = extractStdVectorPointers(rawVal);
    if (vecPtrs) {
      if (vecPtrs.uninitialized) {
        return {
          name: exprOrName,
          type: rawType || 'std::vector',
          kind: 'uninitialized',
          displayValue: '⏳ 尚未初始化 (未执行到构造语句)',
          elements: null,
          raw: rawVal
        };
      }
      try {
        const startAddr = BigInt(vecPtrs.startHex);
        const finishAddr = BigInt(vecPtrs.finishHex);
        if (finishAddr <= startAddr) {
          return {
            name: exprOrName,
            type: rawType || 'std::vector',
            kind: 'array',
            displayValue: 'vector[0] {}',
            elements: [],
            raw: rawVal
          };
        }
        const lenRes = await this.sendCommand(
          `-data-evaluate-expression "(int)(${exprOrName}._M_impl._M_finish - ${exprOrName}._M_impl._M_start)"`,
          1500
        );
        const totalLen = parseInt(lenRes?.results?.value ?? '0', 10);
        // A real vector never holds more elements than its capacity; this rejects
        // garbage pointers without imposing an arbitrary element-count limit.
        let capacity = NaN;
        try {
          const capRes = await this.sendCommand(
            `-data-evaluate-expression "(long long)(${exprOrName}._M_impl._M_end_of_storage - ${exprOrName}._M_impl._M_start)"`,
            1500
          );
          capacity = parseInt(capRes?.results?.value ?? '', 10);
        } catch (_) {}
        const lengthSane = !isNaN(totalLen) && totalLen >= 0 && totalLen <= 100000000 &&
          (isNaN(capacity) || (capacity >= 0 && totalLen <= capacity));
        if (!lengthSane) {
          return {
            name: exprOrName,
            type: rawType || 'std::vector',
            kind: 'uninitialized',
            displayValue: '⏳ 尚未初始化 (未执行到构造语句)',
            elements: null,
            raw: rawVal
          };
        }
        if (this._vectorElementType(rawType) === 'string') {
          return { name: exprOrName, type: rawType, kind: 'array', displayValue: `vector[${totalLen}]`, elements: [], raw: rawVal };
        }
        const previewCount = Math.min(totalLen, this.maxArrayPreview);
        if (previewCount > 0) {
          const elemRes = await this.sendCommand(
            `-data-evaluate-expression "*${exprOrName}._M_impl._M_start@${previewCount}"`,
            1500
          );
          const elemFormatted = formatCppVariable(exprOrName, elemRes?.results?.value ?? '{}', rawType || `vector[${totalLen}]`);
          if (elemFormatted.kind === 'uninitialized') {
            return elemFormatted;
          }
          return {
            ...elemFormatted,
            type: rawType || `std::vector[${totalLen}]`,
            displayValue: `vector[${totalLen}] { ${(elemFormatted.elements || []).join(', ')}${totalLen > previewCount ? ', ...' : ''} }`
          };
        }
      } catch (_) {}
    }
    return formatCppVariable(exprOrName, rawVal, rawType);
  }

  async _discoverGlobalSymbols() {
    if (!this.sourceFile) return { symbols: [], info: '无法确定源文件，不能列出全局变量。' };
    const root = path.dirname(path.resolve(this.sourceFile));
    const result = await this.sendCommand(`-symbol-info-variables --max-results ${GLOBALS_SYMBOL_MAX_RESULTS}`, 15000);
    const debug = result?.results?.symbols?.debug || [];
    const groups = Array.isArray(debug) ? debug : [debug];
    const symbols = [];
    const seen = new Set();
    let skippedUnsafe = false;
    for (const group of groups) {
      const list = Array.isArray(group.symbols) ? group.symbols : group.symbols ? [group.symbols] : [];
      if (!group.fullname) continue;
      const file = path.resolve(group.fullname);
      const relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative.split(path.sep).includes('.dream-debug')) continue;
      if (file === path.resolve(__dirname, 'vectorHelpers.cpp')) continue;
      const fileForGdb = file.replace(/\\/g, '/');
      if (/[\r\n\0'"]/.test(fileForGdb)) { skippedUnsafe = true; continue; }
      for (const symbol of list) {
        const name = String(symbol.name || '').replace(/\[abi:[A-Za-z0-9_]+\]/g, '');
        if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(name) || /^(?:std|__gnu_cxx)::/.test(name) || name.split('::').some(part => part.startsWith('__'))) continue;
        const expression = `'${fileForGdb}'::${name}`;
        if (seen.has(expression)) continue;
        seen.add(expression);
        symbols.push({ id: 'global_' + symbols.length, name, file, line: Number(symbol.line) || 0,
          type: cleanCppType(symbol.type || ''), expression });
      }
    }
    // Every discovered symbol is kept: there is no display limit.
    return { symbols, info: skippedUnsafe ? '部分路径含特殊字符的符号未列出。' : '' };
  }

  async _refreshGlobals() {
    const context = this._pauseContext();
    const same = () => this.state === 'paused' && !!this.proc && this.sessionId === context.sessionId && this.pauseId === context.pauseId && this.currentFrame === context.frame;
    try {
      if (!this._globalSymbols) {
        const result = await this._discoverGlobalSymbols();
        if (!same()) return;
        this._globalSymbols = result.symbols;
        this.globalsInfo = result.info;
      }
      // Only the visible window is read from GDB (default 15, configurable and
      // expandable); the total is kept so the panel can show what is hidden.
      this.globalsTotal = this._globalSymbols.length;
      const visible = this._globalSymbols.slice(0, this._globalsWindow());
      const entries = await this._evaluateGlobalSymbols(visible, same);
      if (!same() || !entries) return;
      this.globals = entries;
    } catch (_) {
      if (same()) {
        this.globals = [];
        this._globalSymbols = [];
        this.globalsTotal = 0;
        this.globalsInfo = '无法列出全局变量；当前 GDB 可能不支持符号查询。';
      }
    }
  }

  /** How many global symbols the panel currently shows (and GDB evaluates). */
  _globalsWindow() {
    const total = Array.isArray(this._globalSymbols) ? this._globalSymbols.length : 0;
    const limit = Math.trunc(Number(this.globalsLimit));
    const wanted = Number.isFinite(limit) && limit > 0 ? limit : this.maxVisibleVariables;
    return Math.min(total, Math.max(this.maxVisibleVariables, wanted));
  }

  /**
   * Reveal more global variables: `count` adds a page, the string 'all' shows
   * every discovered symbol. Each newly visible symbol is read from GDB.
   */
  async showMoreGlobals(count) {
    if (this.state !== 'paused' || !this.proc) throw new Error('仅在暂停时才能展开更多全局变量');
    if (!Array.isArray(this._globalSymbols)) return false;
    const total = this._globalSymbols.length;
    if (this.globals.length >= total) return false;
    const step = Math.trunc(Number(count));
    const target = count === 'all' ? total
      : Math.min(total, this._globalsWindow() + (Number.isFinite(step) && step > 0 ? step : this.maxVisibleVariables));
    if (target <= this.globals.length) return false;
    this.globalsLimit = target;
    await this._refreshGlobals();
    if (this.state === 'paused') this._emitSnapshot();
    return true;
  }

  /**
   * Read the current value of every visible global symbol. Requests are
   * pipelined a few at a time (MI replies are matched by token) so large
   * symbol tables stay fast.
   */
  async _evaluateGlobalSymbols(symbols, same) {
    const entries = new Array(symbols.length);
    let cursor = 0;
    let aborted = false;
    const worker = async () => {
      while (!aborted) {
        const index = cursor++;
        if (index >= symbols.length) return;
        if (!same()) { aborted = true; return; }
        const sym = symbols[index];
        try {
          const safeExpr = sym.expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const result = await this.sendCommand(`-data-evaluate-expression "${safeExpr}"`, 2000);
          if (!same()) { aborted = true; return; }
          let formatted = await this._unwrapValueIfNeeded(sym.expression, result?.results?.value ?? '', sym.type);
          formatted.name = sym.id;
          formatted = await this._describeSequence(formatted, sym.type, sym.expression, true);
          if (!same()) { aborted = true; return; }
          const old = this.prevGlobalValues.get(sym.expression);
          const changed = old !== undefined && old !== formatted.displayValue;
          this.prevGlobalValues.set(sym.expression, formatted.displayValue);
          entries[index] = { ...formatted, name: sym.id, displayName: sym.name, expression: sym.expression,
            sourceLabel: path.basename(sym.file) + (sym.line ? ':' + sym.line : ''), changed };
        } catch (_) {
          if (!same()) { aborted = true; return; }
          const sourceLabel = path.basename(sym.file) + (sym.line ? ':' + sym.line : '');
          // Reading the whole value may be refused (huge array, unsupported
          // setting). The variable is still pageable through its element
          // expressions, so keep it inspectable instead of hiding it.
          let recovered = null;
          try {
            const blank = { name: sym.id, type: sym.type, kind: 'scalar', displayValue: '', elements: null };
            const described = await this._describeSequence(blank, sym.type, sym.expression, true);
            if (described && described.sequence) recovered = described;
          } catch (_) {}
          if (recovered) {
            entries[index] = { ...recovered, name: sym.id, displayName: sym.name, expression: sym.expression,
              sourceLabel, changed: false, tooltip: '整体值过大，已按元素按需读取；可点击元素分页查看' };
            continue;
          }
          entries[index] = { name: sym.id, displayName: sym.name, expression: sym.expression, type: sym.type,
            sourceLabel, kind: 'uninitialized',
            displayValue: '无法读取', tooltip: '可能未初始化或已被优化', elements: null, changed: false };
        }
      }
    };
    const workers = Math.min(GLOBALS_EVAL_CONCURRENCY, Math.max(1, symbols.length));
    await Promise.all(Array.from({ length: workers }, worker));
    if (aborted || !same()) return null;
    return entries.filter(Boolean);
  }

  async _refreshWatches() {
    for (const w of this.watches) {
      try {
        const evaluated = await this.evaluateExpression(w.expr);
        w.value = evaluated.displayValue;
        w.type = evaluated.type;
        w.kind = evaluated.kind;
        w.elements = evaluated.elements;
        w.error = null;
      } catch (err) {
        w.value = '无法求值';
        w.error = err.message;
        w.elements = null;
      }
    }
  }

  async _refreshRegisters() {
    try {
      if (!this._regNames) {
        const namesRes = await this.sendCommand('-data-list-register-names', 2000);
        this._regNames = Array.isArray(namesRes?.results?.['register-names'])
          ? namesRes.results['register-names']
          : [];
      }
      const valsRes = await this.sendCommand('-data-list-register-values x 0 1 2 3 4 5 6 7 8 16', 2000);
      const rawRegs = valsRes?.results?.['register-values'] || [];
      this.registers = rawRegs
        .map((r) => ({
          number: Number(r.number),
          name: this._regNames[Number(r.number)] || `r${r.number}`,
          value: r.value
        }))
        .filter((r) => r.name);
    } catch (_) {
      this.registers = [];
    }
  }

  // ── Internal MI Stream Handling ──

  _onStdoutData(chunk) {
    this.stdoutBuffer += chunk.toString();
    if (this.stdoutBuffer.length > MAX_OUTPUT_CHARS * 2 && !this.stdoutBuffer.includes('\n')) {
      this.stdoutBuffer = '';
      this.emit('output', { category: 'system', text: '[GDB] MI 输出过长，已丢弃该片段' });
      return;
    }
    let newlineIdx;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      this._handleMILine(line);
    }
  }

  _handleMILine(line) {
    const record = parseMILine(line);
    if (!record) return;

    if (record.type === 'console') {
      if (record.content && record.content.trim()) {
        this.emit('output', { category: 'console', text: record.content.replace(/\n$/, '') });
      }
      return;
    }

    if (record.type === 'target') {
      if (record.content) {
        this.programOutput = appendBounded(this.programOutput, record.content);
        this.emit('output', { category: 'stdout', text: record.content });
        this._emitSnapshot();
      }
      return;
    }

    if (record.type === 'log') {
      return;
    }

    if (record.type === 'result' && record.token !== null) {
      const pending = this.pending.get(record.token);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(record.token);
        if (record.class === 'error') {
          pending.reject(new Error(record.results?.msg || 'GDB 命令执行错误'));
        } else {
          pending.resolve(record);
        }
      }
      return;
    }

    if (record.type === 'notify') {
      if (record.class === 'thread-group-started' && record.results?.pid) {
        this.inferiorPid = Number(record.results.pid);
        if (this._inferiorTracker && Number.isSafeInteger(this.inferiorPid) && this.inferiorPid > 0) this._inferiorTracker.pid = this.inferiorPid;
      } else if (record.class === 'breakpoint-modified' && record.results?.bkpt) {
        const bkpt = record.results.bkpt;
        for (const bp of this.breakpoints.values()) {
          if (String(bp.gdbNumber) === String(bkpt.number)) {
            bp.hitCount = Number(bkpt.times || 0);
          }
        }
      }
      return;
    }

    if (record.type === 'exec') {
      if (record.class === 'running') {
        this.state = 'running';
        this.emit('status', { state: 'running', reason: 'running' });
        this._emitSnapshot();
      } else if (record.class === 'stopped') {
        this._handleStoppedRecord(record.results || {});
      }
    }
  }

  async _handleStoppedRecord(results) {
    const reason = results.reason || 'stopped';
    this._pollProgramOutput();

    if (
      reason === 'exited-normally' ||
      reason === 'exited' ||
      reason === 'exited-signalled'
    ) {
      const exitCode = results['exit-code'] ? parseInt(results['exit-code'], 8) : 0;
      if (this._inferiorTracker) this._inferiorTracker.exited = true;
      this.state = 'exited';
      this.stopLocation = null;
      this.emit('output', {
        category: 'system',
        text: `[Dream GDB] 程序执行结束 (${reason}, exitCode=${exitCode})`
      });
      // Immediately release the underlying GDB process so the binary file is unlocked for recompilation
      await this.stop({ keepStateExited: true });
      this.emit('status', { state: 'exited', reason, exitCode });
      this._emitSnapshot();
      return;
    }

    const frame = results.frame || {};

    // 1. If stepping past the closing brace `}` of main() landed in CRT / glibc exit stub (`??`, `__libc_start_main`, `__tmainCRTStartup`),
    // automatically continue so the inferior exits cleanly instead of getting stuck at `??` without line bounds.
    if (
      (reason === 'end-stepping-range' || reason === 'function-finished') &&
      this._isCrtOrUnknownExitFrame(frame)
    ) {
      this._lastStepOrigin = null;
      this._lastStepMode = null;
      this._autoSkipDepth = 0;
      this.state = 'running';
      try {
        await this.sendCommand('-exec-continue');
        return;
      } catch (_) {}
    }

    // 2. If user clicked Step Into / Step Over / Step Out and GDB stopped inside an inlined C++ STL / system header frame
    // (such as bits/allocator.h or basic_string.h), automatically step out back to user source code!
    if (
      this._lastStepOrigin &&
      this._autoSkipDepth < 8 &&
      (reason === 'end-stepping-range' || reason === 'function-finished')
    ) {
      if (this._isSystemLibraryFrame(frame)) {
        this._autoSkipDepth++;
        this.state = 'running';
        try {
          await this.sendCommand('-exec-finish');
          return;
        } catch (_) {
          try {
            await this.sendCommand('-exec-next');
            return;
          } catch (__) {}
        }
      } else if (
        this._autoSkipDepth > 0 &&
        frame.func === this._lastStepOrigin.func &&
        Number(frame.line) === Number(this._lastStepOrigin.line)
      ) {
        // Returned from inlined STL helper back to the exact same line where stepping started;
        // step once more so user either enters the user function on this line or advances to the next line.
        this._autoSkipDepth++;
        this.state = 'running';
        const resumeCmd = this._lastStepMode === 'stepInto' ? '-exec-step' : '-exec-next';
        try {
          await this.sendCommand(resumeCmd);
          return;
        } catch (_) {}
      }
    }
    this._lastStepOrigin = null;
    this._lastStepMode = null;
    this._autoSkipDepth = 0;

    this.state = 'paused';
    this.pauseId++;
    this.currentFrame = 0;
    if (results['thread-id']) {
      this.currentThread = Number(results['thread-id']) || 1;
    }

    this.stopLocation = {
      file: frame.fullname || frame.file || this.sourceFile || '',
      line: frame.line ? Number(frame.line) : 1,
      func: frame.func || 'main',
      addr: frame.addr || '',
      reason,
      signalName: results['signal-name'] || null,
      signalMeaning: results['signal-meaning'] || null
    };

    const refreshTask = this.refreshState();
    this._refreshPromise = refreshTask;
    try {
      await refreshTask;
    } finally {
      if (this._refreshPromise === refreshTask) {
        this._refreshPromise = null;
      }
    }

    if (this.state === 'paused') {
      this.emit('status', {
        state: 'paused',
        reason,
        location: this.stopLocation
      });
    }
  }

  _startOutputWatcher() {
    this._stopOutputWatcher();
    this.stdoutTimer = setInterval(() => this._pollProgramOutput(), 120);
  }

  _stopOutputWatcher() {
    if (this.stdoutTimer) {
      clearInterval(this.stdoutTimer);
      this.stdoutTimer = null;
    }
  }

  _pollProgramOutput(final = false) {
    if (this.outputCapture) {
      try {
        const text = this.outputCapture.poll(final);
        if (text) {
          this.programOutput = appendBounded(this.programOutput, text);
          this.emit('output', { category: 'stdout', text });
          this._emitSnapshot();
        }
      } catch (err) {
        this.emit('output', { category: 'system', text: `[Dream GDB] 读取输出文件失败: ${err.message}` });
      }
      return;
    }
    if (!this.stdoutFile || !fs.existsSync(this.stdoutFile)) return;
    try {
      const stat = fs.statSync(this.stdoutFile);
      // Limit each read, and skip excessively large backlogs rather than
      // allocating a buffer proportional to an untrusted program's output.
      if (stat.size - this.stdoutReadOffset > MAX_OUTPUT_CHARS) {
        this.stdoutReadOffset = stat.size - MAX_OUTPUT_CHARS;
        this.programOutput = appendBounded(this.programOutput, '\n[输出过多，部分内容已截断]\n');
      }
      if (stat.size > this.stdoutReadOffset) {
        const fd = fs.openSync(this.stdoutFile, 'r');
        let text = '';
        try {
          while (stat.size > this.stdoutReadOffset) {
            const len = Math.min(stat.size - this.stdoutReadOffset, 65536);
            const buf = Buffer.alloc(len);
            const count = fs.readSync(fd, buf, 0, len, this.stdoutReadOffset);
            if (!count) break;
            this.stdoutReadOffset += count;
            text = appendBounded(text, buf.subarray(0, count).toString('utf8'));
          }
        } finally { fs.closeSync(fd); }
        this.programOutput = appendBounded(this.programOutput, text);
        this.emit('output', { category: 'stdout', text });
        this._emitSnapshot();
      }
      // Polling cannot be a hard disk quota, but stops runaway debug sessions.
      if (stat.size > 32 * 1024 * 1024 && !this._outputLimitReached && this.proc) {
        this._outputLimitReached = true;
        const warning = '[Dream GDB] 程序输出超过 32 MiB，已停止调试以保护磁盘空间。';
        this.programOutput = appendBounded(this.programOutput, `\n${warning}\n`);
        this.emit('output', { category: 'system', text: warning });
        this._emitSnapshot();
        void this.stop();
      }
    } catch (_) {}
  }

  _cleanupTempFiles(targetDir) {
    const dirToClean = targetDir || this.tempDir;
    if (dirToClean && fs.existsSync(dirToClean)) {
      try {
        fs.rmSync(dirToClean, { recursive: true, force: true });
      } catch (_) {}
    }
    if (!targetDir || targetDir === this.tempDir) {
      this.closeStdin();
      this.tempDir = null;
      this.stdinFile = null;
      this.stdinMode = null;
      this.stdoutFile = null;
    }
  }

  _clearInspectionState() {
    this.locals = []; this.globals = []; this.stack = []; this.registers = []; this.prevLocalValues.clear(); this.prevGlobalValues.clear();
    this.watches = this.watches.map(w => ({ ...w, value: '程序已结束', type: '', kind: 'scalar', elements: null, error: null }));
  }

  getSnapshot() {
    const inactive = ['idle', 'exited', 'error'].includes(this.state);
    return {
      sessionId: this.sessionId,
      pauseId: this.pauseId,
      vectorMutationBusy: !!this._vectorMutation,
      vectorRevision: this._vectorRevision,
      state: this.state,
      executable: this.executable,
      sourceFile: this.sourceFile,
      currentFrame: this.currentFrame,
      location: this.stopLocation,
      stack: inactive ? [] : this.stack,
      locals: inactive ? [] : this.locals,
      globals: inactive ? [] : this.globals,
      globalsTotal: inactive ? 0 : (this._globalSymbols ? this._globalSymbols.length : this.globals.length),
      globalsHasMore: !inactive && !!this._globalSymbols && this.globals.length < this._globalSymbols.length,
      maxVisibleVariables: this.maxVisibleVariables,
      globalsInfo: inactive ? '' : this.globalsInfo,
      watches: inactive ? this.watches.map(w => ({ ...w, value: '程序已结束', type: '', kind: 'scalar', elements: null, error: null })) : this.watches,
      breakpoints: this.getBreakpointsList(),
      registers: inactive ? [] : this.registers,
      programOutput: this.programOutput
    };
  }

  _emitSnapshot() {
    this.emit('snapshot', this.getSnapshot());
  }
}

module.exports = {
  GDBSession,
  cleanCppType
};
