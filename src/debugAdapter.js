/**
 * Dream C++ Debugger — Native VS Code Debug Adapter Protocol (DAP) Bridge
 * Bridges VS Code's built-in Debug Adapter Protocol (`type: "dream-cpp-gdb"`)
 * with Dream's GDBSession and synchronizes live state with the Dream Sidebar.
 */
'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { isSourceFile, compileSourceFile } = require('./compiler');

class DreamGdbDebugAdapter {
  constructor(session, onCompileReport) {
    this.session = session;
    this.onCompileReport = onCompileReport || (() => {});
    this._sendMessageEmitter = new EventEmitter();
    this.seq = 1;
    this.launchConfig = null;

    this.onDidSendMessage = (listener) => {
      this._sendMessageEmitter.on('message', listener);
      return {
        dispose: () => this._sendMessageEmitter.removeListener('message', listener)
      };
    };

    this._onStatus = (ev) => {
      if (ev.state === 'paused') {
        this._sendEvent('stopped', {
          reason: ev.reason === 'breakpoint-hit' ? 'breakpoint' : 'step',
          threadId: 1,
          allThreadsStopped: true
        });
      } else if (ev.state === 'exited') {
        this._sendEvent('exited', { exitCode: ev.exitCode || 0 });
        this._sendEvent('terminated', {});
      }
    };

    this._onOutput = (ev) => {
      const category = ev.category === 'stdout' ? 'stdout' : 'console';
      this._sendEvent('output', {
        category,
        output: `${ev.text}\n`
      });
    };

    this.session.on('status', this._onStatus);
    this.session.on('output', this._onOutput);
  }

  async handleMessage(msg) {
    if (!msg || msg.type !== 'request') return;
    const { command, arguments: args = {}, seq } = msg;

    try {
      switch (command) {
        case 'initialize': {
          this._sendResponse(seq, command, true, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsConditionalBreakpoints: true,
            supportsSetVariable: true
          });
          this._sendEvent('initialized', {});
          break;
        }

        case 'launch': {
          this.launchConfig = args;
          this._sendResponse(seq, command, true, {});
          break;
        }

        case 'setBreakpoints': {
          const filePath = args.source?.path;
          const lines = Array.isArray(args.breakpoints) ? args.breakpoints : [];
          const verified = [];
          if (filePath) {
            // Remove existing breakpoints in this file first
            for (const bp of this.session.getBreakpointsList()) {
              if (this.session.normalizeFilePath(bp.file) === this.session.normalizeFilePath(filePath)) {
                await this.session.removeBreakpoint(filePath, bp.line);
              }
            }
            for (const item of lines) {
              const bp = await this.session.setBreakpoint(filePath, item.line, {
                condition: item.condition || ''
              });
              verified.push({
                verified: true,
                line: bp.line
              });
            }
          }
          this._sendResponse(seq, command, true, { breakpoints: verified });
          break;
        }

        case 'configurationDone': {
          this._sendResponse(seq, command, true, {});
          if (this.launchConfig) {
            await this._launchSession(this.launchConfig);
          }
          break;
        }

        case 'threads': {
          this._sendResponse(seq, command, true, {
            threads: [{ id: 1, name: 'main' }]
          });
          break;
        }

        case 'stackTrace': {
          const frames = (this.session.stack || []).map((f) => ({
            id: f.level + 1,
            name: f.func,
            line: f.line || 1,
            column: 1,
            source: f.fullname
              ? { name: path.basename(f.fullname), path: f.fullname }
              : undefined
          }));
          this._sendResponse(seq, command, true, {
            stackFrames: frames,
            totalFrames: frames.length
          });
          break;
        }

        case 'scopes': {
          this._sendResponse(seq, command, true, {
            scopes: [
              {
                name: '局部变量 (Locals)',
                variablesReference: 1000,
                expensive: false
              },
              {
                name: 'CPU 寄存器 (Registers)',
                variablesReference: 2000,
                expensive: false
              }
            ]
          });
          break;
        }

        case 'variables': {
          const ref = args.variablesReference;
          if (ref === 1000) {
            const vars = (this.session.locals || []).map((v) => ({
              name: v.name,
              value: v.displayValue,
              type: v.type,
              variablesReference: 0
            }));
            this._sendResponse(seq, command, true, { variables: vars });
          } else if (ref === 2000) {
            const regs = (this.session.registers || []).map((r) => ({
              name: r.name,
              value: r.value,
              type: 'register',
              variablesReference: 0
            }));
            this._sendResponse(seq, command, true, { variables: regs });
          } else {
            this._sendResponse(seq, command, true, { variables: [] });
          }
          break;
        }

        case 'setVariable': {
          const ok = await this.session.setVariableValue(args.name, args.value);
          this._sendResponse(seq, command, ok, { value: args.value });
          break;
        }

        case 'continue': {
          await this.session.continue();
          this._sendResponse(seq, command, true, { allThreadsContinued: true });
          break;
        }

        case 'next': {
          await this.session.stepOver();
          this._sendResponse(seq, command, true, {});
          break;
        }

        case 'stepIn': {
          await this.session.stepInto();
          this._sendResponse(seq, command, true, {});
          break;
        }

        case 'stepOut': {
          await this.session.stepOut();
          this._sendResponse(seq, command, true, {});
          break;
        }

        case 'pause': {
          await this.session.pause();
          this._sendResponse(seq, command, true, {});
          break;
        }

        case 'evaluate': {
          const evaluated = await this.session.evaluateExpression(args.expression);
          this._sendResponse(seq, command, true, {
            result: evaluated.displayValue,
            type: evaluated.type,
            variablesReference: 0
          });
          break;
        }

        case 'disconnect':
        case 'terminate': {
          await this.session.stop();
          this._sendResponse(seq, command, true, {});
          break;
        }

        default: {
          this._sendResponse(seq, command, true, {});
          break;
        }
      }
    } catch (err) {
      this._sendResponse(seq, command, false, {}, err.message);
    }
  }

  async _launchSession(cfg) {
    let targetProgram = cfg.program;
    let sourceFile = null;

    if (isSourceFile(targetProgram)) {
      sourceFile = targetProgram;
      const compileRes = await compileSourceFile(sourceFile, {
        compilerPath: cfg.compilerPath || 'g++',
        compileFlags: cfg.compileFlags
      });
      this.onCompileReport(compileRes);
      if (!compileRes.success) {
        this._sendEvent('output', {
          category: 'stderr',
          output: `[编译失败]\n${compileRes.stderr}\n`
        });
        this._sendEvent('terminated', {});
        return;
      }
      targetProgram = compileRes.executable;
    }

    if (cfg.gdbPath) {
      this.session.gdbPath = cfg.gdbPath;
    }
    await this.session.start({
      executable: targetProgram,
      sourceFile,
      cwd: cfg.cwd,
      args: cfg.args,
      stdin: cfg.stdin || '',
      stopAtMain: cfg.stopAtMain !== false
    });
  }

  _sendResponse(requestSeq, command, success, body = {}, message = undefined) {
    this._sendMessageEmitter.emit('message', {
      type: 'response',
      seq: this.seq++,
      request_seq: requestSeq,
      command,
      success,
      message,
      body
    });
  }

  _sendEvent(event, body = {}) {
    this._sendMessageEmitter.emit('message', {
      type: 'event',
      seq: this.seq++,
      event,
      body
    });
  }

  dispose() {
    this.session.removeListener('status', this._onStatus);
    this.session.removeListener('output', this._onOutput);
  }
}

module.exports = {
  DreamGdbDebugAdapter
};
