/**
 * Dream C++ Debugger — GDB/MI2 Session Controller
 * Manages GDB child process, MI2 command/response pipeline, STL unwrapping,
 * breakpoints, watch expressions, call stack, registers, and stdin/stdout capture.
 */
'use strict';

const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendBounded, MAX_OUTPUT_CHARS } = require('./outputLimits');
const { readRegularPrefix } = require('./safeFiles');
const {
  parseMILine,
  extractStdVectorPointers,
  formatCppVariable
} = require('./miParser');

/**
 * Clean verbose C++ template types for display badges (e.g. std::vector<int, std::allocator<int> > -> vector<int>)
 */
function cleanCppType(rawType) {
  if (!rawType) return '';
  return String(rawType)
    .replace(/std::__cxx11::basic_string<char.*?>/g, 'std::string')
    .replace(/std::basic_string<char.*?>/g, 'std::string')
    .replace(/,\s*std::allocator<[^<>]+>\s*/g, '')
    .replace(/\s+>/g, '>')
    .trim();
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

class GDBSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gdbPath = options.gdbPath || 'gdb';
    this.maxArrayPreview = options.maxArrayPreview || 16;

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
    this._lastStepOrigin = null;
    this._lastStepMode = null;
    this._autoSkipDepth = 0;

    // State caches for sidebar snapshot
    this.stack = [];
    this.locals = [];
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
    await this.stop();

    const currentSessionId = ++this.sessionId;
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

    // Validate and quote before spawning, so invalid paths cannot leave a GDB
    // process or FIFO behind.
    let redirectArgs;
    try {
      const userArgs = Array.isArray(config.args) ? config.args.map(quoteInferiorArgument).join(' ') : '';
      redirectArgs = `${userArgs} < ${quoteInferiorArgument(sessionStdinTarget)} > ${quoteInferiorArgument(sessionStdoutFile)} 2>&1`.trim();
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
        env: process.env
      });
      this.proc = proc;
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
        this._pollProgramOutput();
        this.proc = null;
        for (const [, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error('GDB 进程已退出'));
        }
        this.pending.clear();
        if (this.state !== 'exited' && this.state !== 'idle') {
          this.state = 'exited';
          this.stopLocation = null;
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
    if (!/^[a-zA-Z_]\w*$/.test(name)) throw new Error('无法验证数组边界');
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
    if (/\b(?:std::)?(?:basic_string<char[^>]*>|string)\b/.test(type) && !/[\[*]/.test(type)) return 'string';
    if (/\bvector\s*</.test(type)) return /vector\s*<\s*bool\b/.test(type) ? null : 'vector';
    if (/^[^\[\]]+\[\d+\]$/.test(type.trim())) return /\bchar\s*\[/.test(type) ? 'chars' : 'array';
    return null;
  }

  async _sequenceLength(name, kind) {
    if (kind !== 'string') return this._getContainerLength(name, kind === 'vector');
    const res = await this.sendCommand(`-data-evaluate-expression "(unsigned long)${name}._M_string_length"`);
    const value = String(res?.results?.value ?? '').trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('无法确认字符串长度');
    return Number(value);
  }

  async _readSequenceItem(name, kind, index, isChar) {
    let expression = kind === 'vector' ? `*(${name}._M_impl._M_start + ${index})` :
      kind === 'string' ? `${name}._M_dataplus._M_p[${index}]` : `${name}[${index}]`;
    if (isChar) expression = `(unsigned char)(${expression})`;
    const res = await this.sendCommand(`-data-evaluate-expression "${expression}"`);
    const value = String(res?.results?.value ?? '');
    if (!isChar) return { index, value, editValue: value };
    const m = value.match(/^\s*(\d+)/);
    if (!m || Number(m[1]) > 255) throw new Error('无法读取字符字节');
    const byte = Number(m[1]);
    const printable = byte >= 32 && byte <= 126;
    const display = printable ? String.fromCharCode(byte) : `0x${byte.toString(16).padStart(2, '0')}`;
    return { index, value: display, editValue: printable && byte !== 32 ? display : `0x${byte.toString(16).padStart(2, '0')}` };
  }

  async _describeSequence(formatted, rawType) {
    const kind = this._sequenceKind(formatted, rawType);
    if (!kind) return formatted;
    try {
      const length = await this._sequenceLength(formatted.name, kind);
      const isChar = kind === 'string' || kind === 'chars' || (kind === 'vector' && /vector\s*<\s*(?:signed |unsigned )?char\b/.test(rawType));
      const previewCount = Math.min(length, Math.max(1, Math.min(this.maxArrayPreview, 32)));
      let items;
      if (isChar) {
        items = [];
        for (let i = 0; i < previewCount; i++) items.push(await this._readSequenceItem(formatted.name, kind, i, true));
      } else {
        items = (formatted.elements || []).slice(0, previewCount).map((value, index) => ({ index, value, editValue: value }));
      }
      // If GDB returned a shortened preview, never claim it is complete.
      const sequence = { kind, length, isChar, items, truncated: items.length < length,
        editable: !/(?:^|\s)const(?:\s|$)/.test(rawType) };
      if (kind !== 'string' && kind !== 'chars') {
        const prefix = kind === 'vector' ? `vector[${length}]` : `[${length}]`;
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

  async getSequencePage(name, offset, pageSize, context) {
    await this._waitPendingRefresh();
    this._assertPauseContext(context);
    if (!/^[A-Za-z_]\w*$/.test(name || '')) throw new Error('只能查看当前栈帧中的局部变量');
    const variable = this.locals.find(v => v.name === name);
    if (!variable || !variable.sequence) throw new Error('该变量无法安全分页查看');
    const seq = variable.sequence;
    const length = await this._sequenceLength(name, seq.kind);
    this._assertPauseContext(context);
    const start = Number(offset);
    const size = Number(pageSize);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(size) || size < 1 || size > 32 || (start >= length && start !== 0)) throw new Error('分页范围无效');
    const items = [];
    for (let i = start; i < Math.min(length, start + size); i++) {
      this._assertPauseContext(context);
      items.push(await this._readSequenceItem(name, seq.kind, i, seq.isChar));
    }
    this._assertPauseContext(context);
    return { name, offset: start, length, items, isChar: seq.isChar, editable: seq.editable, context };
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
    this._assertPauseContext(context);
    const variable = this.locals.find(v => v.name === name);
    if (!variable || !variable.sequence || !variable.sequence.editable) throw new Error('变量不可修改');
    const seq = variable.sequence;
    const idx = Number(index);
    if (!Number.isSafeInteger(idx) || idx < 0) throw new Error('索引无效');
    const length = await this._sequenceLength(name, seq.kind);
    this._assertPauseContext(context);
    if (idx >= length) throw new Error('索引越界');
    const input = seq.isChar ? String(this._parseCharacterByte(value)) : String(value ?? '').trim();
    if (!input || /[\r\n\0]/.test(input) || input.includes('...') || input.includes('…')) throw new Error('元素值无效');
    const target = seq.kind === 'vector' ? `*(${name}._M_impl._M_start + ${idx})` :
      seq.kind === 'string' ? `${name}._M_dataplus._M_p[${idx}]` : `${name}[${idx}]`;
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
        targetVar &&
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
        await this.refreshState();
        return true;
      }

      // 2. Handle whole std::vector or C array assignment (e.g. `{1, 2, 3}` or `vector[3] { 1, 2, 3 }`)
      if (targetVar && targetVar.kind === 'array') {
        if (!targetVar.sequence || targetVar.sequence.truncated) throw new Error('长数组或无法确认长度的数组不可整体修改，请逐项修改');
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

    // 3. Watch expressions
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
        if (isNaN(totalLen) || totalLen < 0 || totalLen > 100000) {
          return {
            name: exprOrName,
            type: rawType || 'std::vector',
            kind: 'uninitialized',
            displayValue: '⏳ 尚未初始化 (未执行到构造语句)',
            elements: null,
            raw: rawVal
          };
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

  _pollProgramOutput() {
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

  getSnapshot() {
    return {
      sessionId: this.sessionId,
      pauseId: this.pauseId,
      state: this.state,
      executable: this.executable,
      sourceFile: this.sourceFile,
      currentFrame: this.currentFrame,
      location: this.stopLocation,
      stack: this.stack,
      locals: this.locals,
      watches: this.watches,
      breakpoints: this.getBreakpointsList(),
      registers: this.registers,
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
