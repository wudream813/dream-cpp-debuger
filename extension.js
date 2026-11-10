/**
 * Dream C++ Debugger (GDB) — Main VS Code Extension Entry
 * Left Sidebar: Compile / Run controls + Stdin & Stdout I/O
 * Right Editor Pane (`ViewColumn.Beside`): Full GDB Debug Dashboard (Variables, STL/Arrays, Watch, Call Stack, Breakpoints, Console)
 * Author: wudream813
 */
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { GDBSession } = require('./src/gdbSession');
const { isSourceFile, compileSourceFile, runExecutable } = require('./src/compiler');
const { getSidebarHtml } = require('./src/sidebarHtml');
const { getDashboardHtml } = require('./src/dashboardHtml');
const { DreamGdbDebugAdapter } = require('./src/debugAdapter');

class DreamSidebarProvider {
  constructor(context, controller) {
    this.context = context;
    this.controller = controller;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = getSidebarHtml({
      nonce: String(Date.now())
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.controller.handleWebviewMessage(msg);
    });

    this.controller.pushSnapshotToWebview();
  }

  postMessage(message) {
    if (this.view && this.view.webview) {
      this.view.webview.postMessage(message);
    }
  }

  reveal() {
    if (this.view && typeof this.view.show === 'function') {
      this.view.show(true);
    }
  }
}

class DreamDebugController {
  constructor(context) {
    this.context = context;
    this.config = vscode.workspace.getConfiguration('dreamCppDebug');
    this.session = new GDBSession({
      gdbPath: this.config.get('gdbPath', 'gdb'),
      maxArrayPreview: this.config.get('maxArrayPreview', 16)
    });

    this.stdinText = '';
    this.lastTargetFile = null;
    this.syncingBreakpoints = false;
    this.dashboardPanel = null;

    this.diagnostics = vscode.languages.createDiagnosticCollection('dream-cpp-debug');
    this.outputChannel = vscode.window.createOutputChannel('Dream C++ Debugger (GDB)');

    // Editor decorations for paused line & inline variable values
    this.pausedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(245, 158, 11, 0.18)',
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: '#f59e0b',
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'gutter-arrow.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: '#f59e0b',
      overviewRulerLane: vscode.OverviewRulerLane.Full
    });

    this.inlineValuesDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 1.6em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic'
      }
    });

    // Status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'dream-cpp-debug.openDashboard';
    this.updateStatusBar('idle');
    this.statusBarItem.show();

    this.sidebarProvider = new DreamSidebarProvider(context, this);
    this._bindSessionEvents();
  }

  /**
   * Open or reveal the spacious GDB Debug Dashboard in the right half of the current editor window (`ViewColumn.Beside`).
   */
  openDashboardPanel(preserveFocus = true) {
    if (this.dashboardPanel) {
      this.dashboardPanel.reveal(vscode.ViewColumn.Beside, preserveFocus);
      this.pushSnapshotToWebview();
      return this.dashboardPanel;
    }

    // Ensure the active C/C++ editor stays in ViewColumn.One before splitting to Beside
    const activeEditor = vscode.window.activeTextEditor;
    const targetColumn =
      activeEditor && activeEditor.viewColumn === vscode.ViewColumn.One
        ? vscode.ViewColumn.Two
        : vscode.ViewColumn.Beside;

    const panel = vscode.window.createWebviewPanel(
      'dreamCppDebugDashboard',
      'GDB 调试台 · Dream C++',
      { viewColumn: targetColumn, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri]
      }
    );

    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'activity-icon.svg');
    panel.webview.html = getDashboardHtml({
      nonce: String(Date.now())
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleWebviewMessage(msg);
    });

    panel.onDidDispose(() => {
      this.dashboardPanel = null;
    });

    this.dashboardPanel = panel;
    this.pushSnapshotToWebview();
    return panel;
  }

  postToAllViews(message) {
    this.sidebarProvider.postMessage(message);
    if (this.dashboardPanel && this.dashboardPanel.webview) {
      this.dashboardPanel.webview.postMessage(message);
    }
  }

  _bindSessionEvents() {
    this.session.on('status', async (ev) => {
      const isActive = ev.state === 'paused' || ev.state === 'running' || ev.state === 'starting';
      const isPaused = ev.state === 'paused';
      vscode.commands.executeCommand('setContext', 'dreamCppDebug.active', isActive);
      vscode.commands.executeCommand('setContext', 'dreamCppDebug.paused', isPaused);

      this.updateStatusBar(ev.state, ev.location);

      if (isPaused && ev.location && ev.location.file) {
        await this.revealLocationInEditor(ev.location.file, ev.location.line || 1, true);
      } else {
        this.clearEditorDecorations();
      }
      this.pushSnapshotToWebview();
    });

    this.session.on('snapshot', () => {
      this.pushSnapshotToWebview();
      if (this.session.state === 'paused' && this.session.stopLocation) {
        this.applyEditorDecorations(this.session.stopLocation);
      }
    });

    this.session.on('output', (ev) => {
      if (ev.text) {
        this.outputChannel.appendLine(ev.text);
        if (ev.category === 'console' || ev.category === 'system') {
          this.postToAllViews({
            type: 'consoleOutput',
            text: ev.text
          });
        }
      }
    });
  }

  updateStatusBar(state, location = null) {
    if (state === 'paused' && location) {
      const fname = path.basename(location.file || '');
      this.statusBarItem.text = `$(debug-pause) GDB 暂停: ${fname}:${location.line || 1}`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (state === 'running' || state === 'starting') {
      this.statusBarItem.text = '$(sync~spin) GDB 调试运行中...';
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = '$(debug-alt) Dream C++ Debug';
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  resolveActiveSourceFile() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document && isSourceFile(editor.document.fileName)) {
      this.lastTargetFile = editor.document.fileName;
      return this.lastTargetFile;
    }
    for (const visible of vscode.window.visibleTextEditors) {
      if (visible.document && isSourceFile(visible.document.fileName)) {
        this.lastTargetFile = visible.document.fileName;
        return this.lastTargetFile;
      }
    }
    if (this.lastTargetFile && fs.existsSync(this.lastTargetFile)) {
      return this.lastTargetFile;
    }
    return null;
  }

  pushSnapshotToWebview() {
    const snap = this.session.getSnapshot();
    const activeFile = this.resolveActiveSourceFile();
    snap.activeFileName = activeFile ? path.basename(activeFile) : '';
    snap.stdinText = this.stdinText;
    this.postToAllViews({
      type: 'snapshot',
      snapshot: snap
    });
  }

  async startDebugSession(customStdin) {
    if (typeof customStdin === 'string') {
      this.stdinText = customStdin;
    }
    const sourceFile = this.resolveActiveSourceFile();
    if (!sourceFile) {
      vscode.window.showWarningMessage('请先打开一个 C/C++ 源文件 (.cpp / .c) 再启动 GDB 调试。');
      return;
    }

    // Save dirty document before compiling
    const openDoc = vscode.workspace.textDocuments.find((d) => d.fileName === sourceFile);
    if (openDoc && openDoc.isDirty) {
      await openDoc.save();
    }

    this.sidebarProvider.reveal();
    this.config = vscode.workspace.getConfiguration('dreamCppDebug');

    // Ensure any previous GDB process is completely terminated before compiling (prevents .exe file lock on Windows)
    await this.session.stop();

    this.statusBarItem.text = '$(sync~spin) 正在编译 C++ 源码...';
    this.outputChannel.appendLine(`[Dream Compiler] 正在编译: ${sourceFile}`);

    const compileResult = await compileSourceFile(sourceFile, {
      compilerPath: this.config.get('compilerPath', 'g++'),
      compileFlags: this.config.get('compileFlags', ['-g', '-O0', '-std=c++17'])
    });

    this.applyCompilerDiagnostics(sourceFile, compileResult);

    if (!compileResult.success) {
      this.updateStatusBar('idle');
      vscode.window.showErrorMessage(`编译失败 (CE)，请查看左侧边栏或“问题 (Problems)”面板中的错误详情。`);
      return;
    }

    this.outputChannel.appendLine(
      `[Dream Compiler] 编译成功 (${compileResult.durationMs} ms) -> ${compileResult.executable}`
    );

    // Automatically open the spacious Debug Dashboard in the right half of the current editor window
    this.openDashboardPanel(true);

    this.session.gdbPath = this.config.get('gdbPath', 'gdb');
    this.session.maxArrayPreview = this.config.get('maxArrayPreview', 16);

    try {
      await this.session.start({
        executable: compileResult.executable,
        sourceFile,
        cwd: path.dirname(sourceFile),
        stdin: this.stdinText,
        stopAtMain: this.config.get('stopAtMain', true)
      });
    } catch (err) {
      vscode.window.showErrorMessage(`启动 GDB 失败: ${err.message}`);
    }
  }

  async compileAndQuickRun(customStdin) {
    if (typeof customStdin === 'string') {
      this.stdinText = customStdin;
    }
    const sourceFile = this.resolveActiveSourceFile();
    if (!sourceFile) {
      vscode.window.showWarningMessage('请先打开一个 C/C++ 源文件 (.cpp / .c)。');
      return;
    }

    const openDoc = vscode.workspace.textDocuments.find((d) => d.fileName === sourceFile);
    if (openDoc && openDoc.isDirty) {
      await openDoc.save();
    }

    this.sidebarProvider.reveal();
    this.config = vscode.workspace.getConfiguration('dreamCppDebug');

    await this.session.stop();

    const compileResult = await compileSourceFile(sourceFile, {
      compilerPath: this.config.get('compilerPath', 'g++'),
      compileFlags: this.config.get('compileFlags', ['-g', '-O0', '-std=c++17'])
    });

    this.applyCompilerDiagnostics(sourceFile, compileResult);
    if (!compileResult.success) {
      vscode.window.showErrorMessage('C/C++ 编译失败 (CE)，请查看错误提示。');
      return;
    }

    const runRes = await runExecutable(compileResult.executable, {
      stdin: this.stdinText,
      cwd: path.dirname(sourceFile)
    });

    const summary =
      `${runRes.stdout}${runRes.stderr ? `\n[stderr]\n${runRes.stderr}` : ''}\n` +
      `──────────────────────────────\n` +
      `[运行完毕] 退出码: ${runRes.exitCode} · 耗时: ${runRes.durationMs} ms`;

    this.session.programOutput = summary;
    this.pushSnapshotToWebview();
  }

  applyCompilerDiagnostics(sourceFile, compileResult) {
    this.diagnostics.clear();
    const list = compileResult.diagnostics || [];
    this.postToAllViews({
      type: 'compileDiagnostics',
      diagnostics: list,
      success: compileResult.success
    });

    if (list.length === 0) return;

    const byFile = new Map();
    for (const d of list) {
      const target = d.file || sourceFile;
      if (!byFile.has(target)) byFile.set(target, []);
      const lineIdx = Math.max(0, (d.line || 1) - 1);
      const colIdx = Math.max(0, (d.column || 1) - 1);
      const range = new vscode.Range(lineIdx, colIdx, lineIdx, colIdx + 20);
      const sev =
        d.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : d.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
      byFile.get(target).push(new vscode.Diagnostic(range, d.message, sev));
    }

    for (const [file, diags] of byFile.entries()) {
      this.diagnostics.set(vscode.Uri.file(file), diags);
    }
  }

  async revealLocationInEditor(filePath, line, decorate = false) {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const normTarget = this.session.normalizeFilePath(filePath);
      const existingEditor = vscode.window.visibleTextEditors.find(
        (ed) => ed.document && this.session.normalizeFilePath(ed.document.fileName) === normTarget
      );
      const targetColumn = existingEditor ? existingEditor.viewColumn : vscode.ViewColumn.One;

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: targetColumn,
        preserveFocus: true
      });
      const zeroLine = Math.max(0, (Number(line) || 1) - 1);
      const range = new vscode.Range(zeroLine, 0, zeroLine, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      if (decorate) {
        this.applyEditorDecorations({ file: filePath, line: Number(line) || 1 });
      }
    } catch (_) {}
  }

  applyEditorDecorations(location) {
    if (!location || !location.file) return;
    const normLoc = this.session.normalizeFilePath(location.file);
    const editor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document && this.session.normalizeFilePath(ed.document.fileName) === normLoc
    );
    if (!editor) return;

    const zeroLine = Math.max(0, (location.line || 1) - 1);
    const lineRange = editor.document.lineAt(Math.min(zeroLine, editor.document.lineCount - 1)).range;
    editor.setDecorations(this.pausedLineDecoration, [lineRange]);

    const showInline = vscode.workspace.getConfiguration('dreamCppDebug').get('showInlineValues', true);
    const initializedLocals = this.session.locals.filter((v) => v.kind !== 'uninitialized');
    if (showInline && initializedLocals.length > 0) {
      const summary = initializedLocals
        .slice(0, 5)
        .map((v) => `${v.name} = ${v.displayValue}`)
        .join('  │  ');
      editor.setDecorations(this.inlineValuesDecoration, [
        {
          range: lineRange,
          renderOptions: {
            after: {
              contentText: `  // ${summary}`
            }
          }
        }
      ]);
    } else {
      editor.setDecorations(this.inlineValuesDecoration, []);
    }
  }

  clearEditorDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.pausedLineDecoration, []);
      editor.setDecorations(this.inlineValuesDecoration, []);
    }
  }

  async syncVscodeBreakpointsToSession() {
    if (this.syncingBreakpoints) return;
    this.syncingBreakpoints = true;
    try {
      const vscodeBps = vscode.debug.breakpoints.filter(
        (b) => b instanceof vscode.SourceBreakpoint && b.location && b.location.uri
      );
      const seenKeys = new Set();
      for (const b of vscodeBps) {
        const filePath = b.location.uri.fsPath;
        const line = b.location.range.start.line + 1;
        const key = `${this.session.normalizeFilePath(filePath)}:${line}`;
        seenKeys.add(key);
        await this.session.setBreakpoint(filePath, line, {
          enabled: b.enabled,
          condition: b.condition || ''
        });
      }
      for (const existing of this.session.getBreakpointsList()) {
        if (!seenKeys.has(existing.id)) {
          await this.session.removeBreakpoint(existing.file, existing.line);
        }
      }
    } finally {
      this.syncingBreakpoints = false;
    }
  }

  async handleWebviewMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ready':
        this.pushSnapshotToWebview();
        break;
      case 'startDebug':
        await this.startDebugSession(msg.stdin);
        break;
      case 'compileAndRun':
        await this.compileAndQuickRun(msg.stdin);
        break;
      case 'openDashboard':
        this.openDashboardPanel(false);
        break;
      case 'continue':
        await this.session.continue();
        break;
      case 'stepOver':
        await this.session.stepOver();
        break;
      case 'stepInto':
        await this.session.stepInto();
        break;
      case 'stepOut':
        await this.session.stepOut();
        break;
      case 'restart':
        await this.startDebugSession(msg.stdin);
        break;
      case 'stop':
        await this.session.stop();
        break;
      case 'updateStdin':
        this.stdinText = msg.stdin || '';
        break;
      case 'addWatch':
        await this.session.addWatch(msg.expr);
        break;
      case 'removeWatch':
        await this.session.removeWatch(msg.id);
        break;
      case 'selectFrame':
        await this.session.selectFrame(msg.level);
        if (msg.file && msg.line) {
          await this.revealLocationInEditor(msg.file, msg.line, true);
        }
        break;
      case 'jumpToLine':
        await this.revealLocationInEditor(msg.file, msg.line, false);
        break;
      case 'toggleBreakpointEnabled':
        await this.session.setBreakpointEnabled(msg.file, msg.line, msg.enabled);
        break;
      case 'removeBreakpoint':
        await this.session.removeBreakpoint(msg.file, msg.line);
        break;
      case 'promptBreakpointCondition': {
        const cond = await vscode.window.showInputBox({
          prompt: `设置断点触发条件 (${path.basename(msg.file)}:${msg.line})`,
          placeHolder: '例如: i == 5 && sum > 100（留空表示无条件）'
        });
        if (cond !== undefined) {
          await this.session.setBreakpointCondition(msg.file, msg.line, cond);
        }
        break;
      }
      case 'promptEditVariable': {
        const newVal = await vscode.window.showInputBox({
          prompt: `修改变量 ${msg.name} 的当前值`,
          value: msg.currentValue || ''
        });
        if (newVal !== undefined) {
          await this.session.setVariableValue(msg.name, newVal);
        }
        break;
      }
      case 'gdbCommand':
        await this.session.evaluateConsoleCommand(msg.command).catch((err) => {
          this.postToAllViews({
            type: 'consoleOutput',
            text: `[错误] ${err.message}`
          });
        });
        break;
    }
  }

  dispose() {
    this.session.stop();
    if (this.dashboardPanel) {
      this.dashboardPanel.dispose();
    }
    this.diagnostics.dispose();
    this.outputChannel.dispose();
    this.pausedLineDecoration.dispose();
    this.inlineValuesDecoration.dispose();
    this.statusBarItem.dispose();
  }
}

function activate(context) {
  const controller = new DreamDebugController(context);

  // 1. Register Left Sidebar Webview (Compile/Run + Stdin/Stdout)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dream-cpp-debug.sidebar', controller.sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 2. Sync native VS Code breakpoints
  context.subscriptions.push(
    vscode.debug.onDidChangeBreakpoints(() => {
      controller.syncVscodeBreakpointsToSession();
    })
  );
  controller.syncVscodeBreakpointsToSession();

  // 3. Track active C/C++ editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document && isSourceFile(editor.document.fileName)) {
        controller.lastTargetFile = editor.document.fileName;
        controller.pushSnapshotToWebview();
        if (controller.session.state === 'paused' && controller.session.stopLocation) {
          controller.applyEditorDecorations(controller.session.stopLocation);
        }
      }
    })
  );

  // 4. Register Hover Evaluator during paused GDB session
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(['cpp', 'c'], {
      async provideHover(document, position) {
        if (controller.session.state !== 'paused') return null;
        const enabled = vscode.workspace.getConfiguration('dreamCppDebug').get('enableHoverEval', true);
        if (!enabled) return null;

        const range = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*|->[a-zA-Z_]\w*|\[\d+\])*/);
        if (!range) return null;
        const expr = document.getText(range);
        if (!expr) return null;

        try {
          const evaluated = await controller.session.evaluateExpression(expr);
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(`**Dream GDB 实时求值**\n\n`);
          md.appendCodeblock(`${expr}: ${evaluated.type || 'auto'} = ${evaluated.displayValue}`, 'cpp');
          return new vscode.Hover(md, range);
        } catch (_) {
          return null;
        }
      }
    })
  );

  // 5. Register CodeLens above main() function
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(['cpp', 'c'], {
      provideCodeLenses(document) {
        const enabled = vscode.workspace.getConfiguration('dreamCppDebug').get('enableCodeLens', true);
        if (!enabled) return [];
        const text = document.getText();
        const lenses = [];
        const mainRegex = /^\s*(?:int|signed|void)\s+main\s*\(/gm;
        let match;
        while ((match = mainRegex.exec(text)) !== null) {
          const pos = document.positionAt(match.index);
          const range = new vscode.Range(pos.line, 0, pos.line, 0);
          lenses.push(
            new vscode.CodeLens(range, {
              title: '$(debug-alt) GDB 调试 (右侧打开调试台)',
              command: 'dream-cpp-debug.startDebug',
              tooltip: '自动使用 g++ -g 编译并在当前窗口右半边打开 GDB 调试面板'
            }),
            new vscode.CodeLens(range, {
              title: '$(play) 快速编译运行',
              command: 'dream-cpp-debug.compileAndRun',
              tooltip: '编译并带入左侧边栏 stdin 直接运行输出结果'
            })
          );
        }
        return lenses;
      }
    })
  );

  // 6. Register Native Debug Adapter (`type: "dream-cpp-gdb"`)
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('dream-cpp-gdb', {
      resolveDebugConfiguration(_folder, config) {
        if (!config.type && !config.request && !config.name) {
          const editor = vscode.window.activeTextEditor;
          if (editor && isSourceFile(editor.document.fileName)) {
            config.type = 'dream-cpp-gdb';
            config.name = 'Dream GDB: 调试当前文件';
            config.request = 'launch';
            config.program = '${file}';
            config.cwd = '${fileDirname}';
            config.stopAtMain = true;
          }
        }
        return config;
      }
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory('dream-cpp-gdb', {
      createDebugAdapterDescriptor() {
        controller.sidebarProvider.reveal();
        controller.openDashboardPanel(true);
        const adapter = new DreamGdbDebugAdapter(controller.session, (compileRes) => {
          const active = controller.resolveActiveSourceFile();
          if (active) controller.applyCompilerDiagnostics(active, compileRes);
        });
        return new vscode.DebugAdapterInlineImplementation(adapter);
      }
    })
  );

  // 7. Register Extension Commands
  const register = (id, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('dream-cpp-debug.startDebug', () => controller.startDebugSession());
  register('dream-cpp-debug.compileAndRun', () => controller.compileAndQuickRun());
  register('dream-cpp-debug.openDashboard', () => controller.openDashboardPanel(false));
  register('dream-cpp-debug.continue', () => controller.session.continue());
  register('dream-cpp-debug.pause', () => controller.session.pause());
  register('dream-cpp-debug.stepOver', () => controller.session.stepOver());
  register('dream-cpp-debug.stepInto', () => controller.session.stepInto());
  register('dream-cpp-debug.stepOut', () => controller.session.stepOut());
  register('dream-cpp-debug.restart', () => controller.startDebugSession());
  register('dream-cpp-debug.stop', () => controller.session.stop());

  register('dream-cpp-debug.openSidebar', () => {
    vscode.commands.executeCommand('workbench.view.extension.dream-cpp-debug');
  });

  register('dream-cpp-debug.runToCursor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const file = editor.document.fileName;
    const line = editor.selection.active.line + 1;
    if (controller.session.state === 'idle' || controller.session.state === 'exited') {
      await controller.session.setBreakpoint(file, line);
      await controller.startDebugSession();
    } else if (controller.session.state === 'paused') {
      await controller.session.runToLocation(file, line);
    }
  });

  register('dream-cpp-debug.toggleBreakpoint', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const file = editor.document.fileName;
    const line = editor.selection.active.line + 1;
    await controller.session.toggleBreakpoint(file, line);
  });

  register('dream-cpp-debug.addConditionalBreakpoint', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const file = editor.document.fileName;
    const line = editor.selection.active.line + 1;
    const cond = await vscode.window.showInputBox({
      prompt: `在第 ${line} 行设置条件断点`,
      placeHolder: '输入 C++ 布尔表达式，例如: i == 10 || x < 0'
    });
    if (cond !== undefined) {
      await controller.session.setBreakpoint(file, line, { condition: cond });
    }
  });

  register('dream-cpp-debug.addWatch', async () => {
    const editor = vscode.window.activeTextEditor;
    let selected = '';
    if (editor && !editor.selection.isEmpty) {
      selected = editor.document.getText(editor.selection).trim();
    }
    if (!selected) {
      selected = await vscode.window.showInputBox({
        prompt: '输入要添加到右侧调试台监视 (Watch) 的 C++ 表达式',
        placeHolder: '例如: dp[i][j]、*ptr、arr@10'
      });
    }
    if (selected) {
      await controller.session.addWatch(selected);
      controller.openDashboardPanel(true);
    }
  });

  register('dream-cpp-debug.evaluateSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    let expr = '';
    if (editor && !editor.selection.isEmpty) {
      expr = editor.document.getText(editor.selection).trim();
    } else {
      expr = await vscode.window.showInputBox({
        prompt: '输入要通过 GDB 立即求值的 C++ 表达式'
      });
    }
    if (!expr) return;
    try {
      const res = await controller.session.evaluateExpression(expr);
      vscode.window.showInformationMessage(`${expr} (${res.type}) = ${res.displayValue}`);
    } catch (err) {
      vscode.window.showWarningMessage(`求值失败: ${err.message}`);
    }
  });

  register('dream-cpp-debug.clearBreakpoints', async () => {
    await controller.session.clearAllBreakpoints();
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  });

  context.subscriptions.push(controller);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
