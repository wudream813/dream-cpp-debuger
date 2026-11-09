/**
 * Dream C++ Debugger — Smart C/C++ Compiler & Runner
 * Compiles C/C++ source files with debug symbols (-g -O0) and parses GCC/Clang diagnostics.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SOURCE_EXTS = new Set(['.cpp', '.cc', '.cxx', '.c++', '.c']);
const DIAG_REGEX = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note|致命错误|错误|警告|附注):\s*(.+)$/i;

function isSourceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTS.has(ext);
}

/**
 * Parse GCC / Clang stderr output into structured diagnostic objects.
 * Strictly separates compile errors ('error') from warnings ('warning') and notes ('info').
 */
function parseCompilerDiagnostics(stderrText, defaultFile = '') {
  const diagnostics = [];
  if (!stderrText) return diagnostics;
  const lines = String(stderrText).split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(DIAG_REGEX);
    if (m) {
      const rawSeverity = m[4].toLowerCase();
      let severity = 'info';
      if (rawSeverity.includes('error') || rawSeverity.includes('错误')) {
        severity = 'error';
      } else if (rawSeverity.includes('warning') || rawSeverity.includes('警告')) {
        severity = 'warning';
      }
      diagnostics.push({
        file: m[1].trim() || defaultFile,
        line: Math.max(1, parseInt(m[2], 10)),
        column: m[3] ? Math.max(1, parseInt(m[3], 10)) : 1,
        severity,
        message: m[5].trim()
      });
    }
  }
  return diagnostics;
}

/**
 * Compile a C/C++ source file with debug symbols for GDB.
 */
function compileSourceFile(sourceFile, options = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const absSource = path.resolve(sourceFile);
    const sourceDir = path.dirname(absSource);
    const ext = path.extname(absSource).toLowerCase();
    const baseName = path.basename(absSource, ext);

    let compiler = options.compilerPath || 'g++';
    if (ext === '.c' && compiler === 'g++') {
      compiler = 'gcc';
    }

    const userFlags = Array.isArray(options.compileFlags)
      ? [...options.compileFlags]
      : ['-g', '-O0', '-std=c++17'];

    // Filter out C++ standard flags when compiling plain C with gcc
    const flags = ext === '.c'
      ? userFlags.filter((f) => !f.startsWith('-std=c++'))
      : userFlags;

    if (!flags.some((f) => f === '-g' || f.startsWith('-g'))) {
      flags.unshift('-g');
    }

    let outDir = path.join(sourceDir, '.dream-debug');
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (_) {
      outDir = path.join(os.tmpdir(), 'dream-cpp-debug');
      fs.mkdirSync(outDir, { recursive: true });
    }

    const exeName = process.platform === 'win32' ? `${baseName}.exe` : `${baseName}.debug.out`;
    const outputBinary = options.outputBinary || path.join(outDir, exeName);

    // Remove stale binary before compiling so we never mistake an old binary for a fresh compile
    if (fs.existsSync(outputBinary)) {
      try { fs.unlinkSync(outputBinary); } catch (_) {}
    }

    const args = [...flags, absSource, '-o', outputBinary];
    const commandLine = `${compiler} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

    let stdout = '';
    let stderr = '';
    let proc;

    try {
      proc = spawn(compiler, args, {
        cwd: options.cwd || sourceDir,
        env: process.env
      });
    } catch (err) {
      return resolve({
        success: false,
        executable: null,
        commandLine,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - startTime,
        diagnostics: [{
          file: absSource,
          line: 1,
          column: 1,
          severity: 'error',
          message: `无法启动编译器 "${compiler}": ${err.message}`
        }]
      });
    }

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      resolve({
        success: false,
        executable: null,
        commandLine,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        durationMs: Date.now() - startTime,
        diagnostics: [{
          file: absSource,
          line: 1,
          column: 1,
          severity: 'error',
          message: `未找到编译器 "${compiler}" (${err.message})，请检查系统 PATH 或设置 dreamCppDebug.compilerPath`
        }]
      });
    });

    proc.on('close', (code) => {
      const diagnostics = parseCompilerDiagnostics(stderr, absSource);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');
      const success = code === 0 && fs.existsSync(outputBinary);
      resolve({
        success,
        exitCode: code,
        executable: success ? outputBinary : null,
        commandLine,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        diagnostics,
        errors,
        warnings
      });
    });
  });
}

/**
 * Run a compiled binary directly with optional stdin and capture output + timing.
 */
function runExecutable(executablePath, options = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const args = Array.isArray(options.args) ? options.args : [];
    const cwd = options.cwd || path.dirname(executablePath);
    const timeoutMs = options.timeoutMs || 15000;

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;

    const proc = spawn(executablePath, args, { cwd, env: process.env });
    const timer = setTimeout(() => {
      killedByTimeout = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    if (typeof options.stdin === 'string' && options.stdin.length > 0) {
      proc.stdin.write(options.stdin.endsWith('\n') ? options.stdin : `${options.stdin}\n`);
    }
    proc.stdin.end();

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        signal: null,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        durationMs: Date.now() - startTime,
        killedByTimeout
      });
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        killedByTimeout
      });
    });
  });
}

module.exports = {
  isSourceFile,
  parseCompilerDiagnostics,
  compileSourceFile,
  runExecutable
};
