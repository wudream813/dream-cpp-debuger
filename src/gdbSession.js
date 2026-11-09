/**
 * Dream C++ Debugger — GDB/MI2 Session Controller
 * Manages GDB child process, MI2 command/response pipeline, STL unwrapping,
 * breakpoints, watch expressions, call stack, registers, and stdin/stdout capture.
 */
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

class GDBSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gdbPath = options.gdbPath || 'gdb';
    this.maxArrayPreview = options.maxArrayPreview || 16;

    this.proc = null;
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

    // State caches for sidebar snapshot
    this.stack = [];
    this.locals = [];
    this.prevLocalValues = new Map();
    this.watches = []; // [{ id, expr, value, type, kind, elements, error }]
    this.breakpoints = new Map(); // key: `${normPath}:${line}` -> { id, gdbNumber, file, line, enabled, condition, hitCount }
    this.registers = [];

    // Temp files for inferior stdin/stdout
    this.tempDir = null;
    this.stdinFile = null;
    this.stdoutFile = null;
    this.stdoutReadOffset = 0;
    this.stdoutTimer = null;
    this.programOutput = '';
  }

  normalizeFilePath(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.replace(/\\/g, '/') : resolved;
  }

  /**
   * Start a new GDB MI2 debugging session on a compiled executable.
   */
  async start(config = {}) {
    await this.stop();

    this.executable = config.executable;
    this.sourceFile = config.sourceFile || null;
    this.cwd = config.cwd || (this.executable ? path.dirname(this.executable) : process.cwd());
    this.state = 'starting';
    this.programOutput = '';
    this.stdoutReadOffset = 0;
    this.prevLocalValues.clear();
    this.currentFrame = 0;

    // Prepare temp directory for inferior stdin & stdout redirection
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-gdb-'));
    this.stdinFile = path.join(this.tempDir, 'stdin.txt');
    this.stdoutFile = path.join(this.tempDir, 'stdout.txt');
    fs.writeFileSync(this.stdinFile, typeof config.stdin === 'string' ? config.stdin : '', 'utf8');
    fs.writeFileSync(this.stdoutFile, '', 'utf8');

    const gdbArgs = ['--interpreter=mi2', '--quiet', this.executable];
    this.emit('output', {
      category: 'system',
      text: `[Dream GDB] 启动调试会话: ${this.gdbPath} ${gdbArgs.join(' ')}`
    });

    try {
      this.proc = spawn(this.gdbPath, gdbArgs, {
        cwd: this.cwd,
        env: process.env
      });
    } catch (err) {
      this.state = 'error';
      this.emit('status', { state: 'error', reason: err.message });
      throw err;
    }

    this.proc.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) {
        this.emit('output', { category: 'log', text: text.trim() });
      }
    });

    this.proc.on('error', (err) => {
      this.state = 'error';
      this.emit('output', {
        category: 'system',
        text: `[Dream GDB] 无法启动 GDB (${this.gdbPath}): ${err.message}`
      });
      this.emit('status', { state: 'error', reason: err.message });
    });

    this.proc.on('close', (code) => {
      this._stopOutputWatcher();
      this._pollProgramOutput();
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error('GDB 进程已退出'));
      }
      this.pending.clear();
      if (this.state !== 'exited') {
        this.state = 'exited';
        this.stopLocation = null;
        this.emit('status', { state: 'exited', reason: 'gdb-closed', exitCode: code });
        this._emitSnapshot();
      }
      this._cleanupTempFiles();
    });

    this._startOutputWatcher();

    // Initialize GDB session settings
    await this.sendCommand('-enable-pretty-printing').catch(() => {});
    await this.sendCommand('-gdb-set print elements 64').catch(() => {});
    await this.sendCommand('-gdb-set print repeats 32').catch(() => {});
    await this.sendCommand('-gdb-set pagination off').catch(() => {});
    await this.sendCommand('-gdb-set confirm off').catch(() => {});

    // Sync any pre-registered user breakpoints into GDB
    await this._syncAllBreakpointsToGdb();

    // Optionally add temporary breakpoint at main
    if (config.stopAtMain !== false) {
      await this.sendCommand('-break-insert -t main').catch(() => {});
    }

    // Configure arguments + stdin/stdout redirection
    const userArgs = Array.isArray(config.args) ? config.args.join(' ') : '';
    const escIn = this.stdinFile.replace(/\\/g, '/');
    const escOut = this.stdoutFile.replace(/\\/g, '/');
    const redirectArgs = `${userArgs} < "${escIn}" > "${escOut}" 2>&1`.trim();
    await this.sendCommand(`-exec-arguments ${redirectArgs}`).catch(() => {});

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
      if (!this.proc || !this.proc.stdin.writable) {
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
      this.proc.stdin.write(`${token}${command}\n`);
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

  async continue() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.emit('status', { state: 'running', reason: 'continue' });
    this._emitSnapshot();
    await this.sendCommand('-exec-continue');
  }

  async stepOver() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    await this.sendCommand('-exec-next');
  }

  async stepInto() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    await this.sendCommand('-exec-step');
  }

  async stepOut() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    await this.sendCommand('-exec-finish');
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
      this.proc.kill('SIGINT');
    }
  }

  async stop() {
    this._stopOutputWatcher();
    if (!this.proc) {
      this.state = 'idle';
      this.stopLocation = null;
      return;
    }
    try {
      this.sendCommand('-gdb-exit', 1000).catch(() => {});
      setTimeout(() => {
        if (this.proc) {
          try { this.proc.kill('SIGKILL'); } catch (_) {}
        }
      }, 300);
    } catch (_) {}
    this.proc = null;
    this.state = 'idle';
    this.stopLocation = null;
    this._cleanupTempFiles();
    this.emit('status', { state: 'idle', reason: 'stopped' });
    this._emitSnapshot();
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

  /**
   * Modify a local variable or expression value during pause.
   */
  async setVariableValue(name, newValue) {
    if (this.state !== 'paused') return false;
    const escapedExpr = `${name} = ${newValue}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      await this.sendCommand(`-data-evaluate-expression "${escapedExpr}"`);
      await this.refreshState();
      return true;
    } catch (err) {
      this.emit('output', {
        category: 'system',
        text: `[Dream GDB] 修改变量 ${name} 失败: ${err.message}`
      });
      return false;
    }
  }

  /**
   * Select active stack frame and refresh variables.
   */
  async selectFrame(frameLevel) {
    if (this.state !== 'paused') return;
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

      for (const v of varList) {
        if (!v || !v.name) continue;
        const rawType = typeMap.get(v.name) || '';
        const formatted = await this._unwrapValueIfNeeded(v.name, v.value, rawType);
        const prevVal = this.prevLocalValues.get(v.name);
        const changed = prevVal !== undefined && prevVal !== formatted.displayValue;
        this.prevLocalValues.set(v.name, formatted.displayValue);
        nextLocals.push({
          ...formatted,
          isArg: v.arg === '1',
          changed
        });
      }
      this.locals = nextLocals;
    } catch (_) {
      this.locals = [];
    }

    // 3. Watch expressions
    await this._refreshWatches();

    // 4. CPU Registers (top general-purpose registers)
    await this._refreshRegisters();

    this._emitSnapshot();
  }

  async _unwrapValueIfNeeded(exprOrName, rawVal, rawType) {
    const vecPtrs = extractStdVectorPointers(rawVal);
    if (vecPtrs) {
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
        const totalLen = Math.max(0, parseInt(lenRes?.results?.value ?? '0', 10));
        const previewCount = Math.min(totalLen, this.maxArrayPreview);
        if (previewCount > 0) {
          const elemRes = await this.sendCommand(
            `-data-evaluate-expression "*${exprOrName}._M_impl._M_start@${previewCount}"`,
            1500
          );
          const elemFormatted = formatCppVariable(exprOrName, elemRes?.results?.value ?? '{}', rawType || `vector[${totalLen}]`);
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
        this.programOutput += record.content;
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
      this.emit('status', { state: 'exited', reason, exitCode });
      this._emitSnapshot();
      return;
    }

    this.state = 'paused';
    this.currentFrame = 0;
    if (results['thread-id']) {
      this.currentThread = Number(results['thread-id']) || 1;
    }

    const frame = results.frame || {};
    this.stopLocation = {
      file: frame.fullname || frame.file || this.sourceFile || '',
      line: frame.line ? Number(frame.line) : 1,
      func: frame.func || 'main',
      addr: frame.addr || '',
      reason,
      signalName: results['signal-name'] || null,
      signalMeaning: results['signal-meaning'] || null
    };

    await this.refreshState();

    this.emit('status', {
      state: 'paused',
      reason,
      location: this.stopLocation
    });
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
      if (stat.size > this.stdoutReadOffset) {
        const fd = fs.openSync(this.stdoutFile, 'r');
        const len = stat.size - this.stdoutReadOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.stdoutReadOffset);
        fs.closeSync(fd);
        this.stdoutReadOffset = stat.size;
        const chunk = buf.toString('utf8');
        this.programOutput += chunk;
        this.emit('output', { category: 'stdout', text: chunk });
        this._emitSnapshot();
      }
    } catch (_) {}
  }

  _cleanupTempFiles() {
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
    this.tempDir = null;
    this.stdinFile = null;
    this.stdoutFile = null;
  }

  getSnapshot() {
    return {
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
