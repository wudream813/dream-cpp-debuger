/**
 * Dream C++ Debugger (GDB) — Main VS Code Extension Entry
 * Left Sidebar: Compile / Run controls + Stdin (Text / Stream / File) & Stdout I/O
 * Right Editor Pane (`ViewColumn.Beside`): Full GDB Debug Dashboard (Variables, STL/Arrays, Watch, Call Stack, Breakpoints, Console)
 * Author: wudream813
 */
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { appendBounded } = require('./src/outputLimits');
const { openOutputFile } = require('./src/outputFile');
const { readRegularPrefix } = require('./src/safeFiles');
const { GDBSession } = require('./src/gdbSession');
const { isSourceFile, compileSourceFile, runExecutable } = require('./src/compiler');
const { getSidebarHtml } = require('./src/sidebarHtml');
const { getDashboardHtml } = require('./src/dashboardHtml');
const { DreamGdbDebugAdapter } = require('./src/debugAdapter');
const { EditorReadOnly } = require('./src/editorReadOnly');
const { compileDebugWithCompanion } = require('./src/compilerIntegration');
const { withCompileNotification } = require('./src/compileProgress');

function initialUserMode(config, globalState) {
  const inspected = config.inspect('interfaceMode');
  const configured = inspected?.workspaceValue ?? inspected?.globalValue;
  const effective = config.get('interfaceMode', 'expert');
  const legacy = globalState.get('dreamCppDebug.userMode');
  const fallback = globalState.get('dreamCppDebug.modeFallback');
  const valid = value => ['beginner', 'expert'].includes(value);
  const useFallback = fallback && valid(fallback.mode) && fallback.previousConfig === effective;
  return {
    userMode: useFallback ? fallback.mode : valid(configured) ? effective : valid(legacy) ? legacy : 'expert',
    modeWasSelected: !!useFallback || valid(configured) || valid(legacy),
    legacyModeToMigrate: !useFallback && valid(legacy) ? legacy : null
  };
}

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
      nonce: crypto.randomBytes(16).toString('base64')
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try { await this.controller.handleWebviewMessage(msg); }
      catch (err) { vscode.window.showErrorMessage(`Dream C++ Debugger: ${err.message}`); }
    });

    this.controller.pushSnapshotToWebview();
    void this.controller.ensureUserMode().catch(err => vscode.window.showErrorMessage(`模式选择失败：${err.message}`));
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
    Object.assign(this, initialUserMode(this.config, context.globalState));
    this.modeRevision = 0;
    this.modePromptShown = false;
    this.modePrompt = null;
    this.editorReadOnly = new EditorReadOnly(vscode);
    this.preparingDebugRunId = null;
    this.compilingRunId = null;
    this.compileQueue = Promise.resolve();
    this.session = new GDBSession({
      gdbPath: this.config.get('gdbPath', 'gdb'),
      maxArrayPreview: this.config.get('maxArrayPreview', 16)
    });

    this.stdinMode = 'text';
    this.stdinText = '';
    this.stdinFile = '';
    this.stdinFilePreview = '';
    this.outputFile = '';
    this.streamHistory = [];
    this.runId = 0;
    this.resettingRunId = null;
    this.quickRunSawStderr = false;
    this.activeRunProcess = null;
    this.activeRunCancel = null;
    this.activeFileRunPromise = null;
    this.quickRunId = null;
    this.activeRunStream = false;

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

  async clearOldModeState() {
    // A failed cleanup is not a failed settings update.
    try {
      await this.context.globalState.update('dreamCppDebug.userMode', undefined);
      await this.context.globalState.update('dreamCppDebug.modeFallback', undefined);
    } catch (err) {
      if (this.outputChannel) this.outputChannel.appendLine(`[模式] 清理旧偏好失败：${err.message}`);
    }
  }

  syncUserModeFromConfig() {
    this.modeRevision = (this.modeRevision || 0) + 1;
    this.modeWasSelected = true;
    this.legacyModeToMigrate = null;
    void this.clearOldModeState();
    this.userMode = vscode.workspace.getConfiguration('dreamCppDebug').get('interfaceMode', 'expert');
    this.pushSnapshotToWebview();
  }

  openModeSettings() {
    return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:wudream.dream-cpp-debuger');
  }

  async setUserMode(mode) {
    const config = vscode.workspace.getConfiguration('dreamCppDebug');
    const inspected = config.inspect('interfaceMode');
    const previousConfig = config.get('interfaceMode', 'expert');
    // A workspace override takes precedence over the user setting; update the
    // active level so the selector and Settings always agree.
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    let updateError;
    try { await config.update('interfaceMode', mode, target); }
    catch (err) { updateError = err; }
    if (!updateError) {
      this.userMode = vscode.workspace.getConfiguration('dreamCppDebug').get('interfaceMode', mode);
      this.modeWasSelected = true;
      await this.clearOldModeState();
      this.pushSnapshotToWebview();
      return;
    }

    // Keep mode switching functional even when user settings cannot be written
    // (for example invalid JSON, policies or an unregistered setting).
    this.userMode = mode;
    this.modeWasSelected = true;
    let storageError;
    try { await this.context.globalState.update('dreamCppDebug.modeFallback', { mode, previousConfig }); }
    catch (err) { storageError = err; }
    this.pushSnapshotToWebview();
    const description = storageError
      ? `模式已切换，但无法保存：${updateError.message}；${storageError.message}`
      : `模式已切换并保存，但未能同步到 VS Code 设置：${updateError.message}`;
    void Promise.resolve(vscode.window.showWarningMessage(description, '打开模式设置'))
      .then(action => action === '打开模式设置' ? this.openModeSettings() : undefined)
      .catch(() => {});
  }

  async ensureUserMode() {
    if (this.legacyModeToMigrate) {
      const legacy = this.legacyModeToMigrate;
      this.legacyModeToMigrate = null;
      const config = vscode.workspace.getConfiguration('dreamCppDebug');
      const inspected = config.inspect('interfaceMode');
      if (inspected?.globalValue === undefined && inspected?.workspaceValue === undefined) {
        await this.setUserMode(legacy);
      } else {
        await this.clearOldModeState();
      }
    }
    if (this.modeWasSelected || this.modePromptShown) return;
    this.modePromptShown = true;
    await this.chooseUserMode();
  }

  async chooseUserMode() {
    if (this.modePrompt) return this.modePrompt;
    const revision = this.modeRevision || 0;
    const task = (async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '新手模式', description: '简洁、通俗', detail: '隐藏 GDB 命令、寄存器和断点管理；仍可在编辑器设置断点。', mode: 'beginner' },
        { label: '老手模式', description: '完整功能', detail: '保留 GDB 命令、寄存器和断点管理等高级功能。', mode: 'expert' }
      ], { title: '选择调试界面模式', placeHolder: '以后可在侧栏或 VS Code 设置中切换', ignoreFocusOut: true });
      if (!choice || !['beginner', 'expert'].includes(choice.mode) || revision !== (this.modeRevision || 0)) return;
      await this.setUserMode(choice.mode);
    })();
    this.modePrompt = task;
    try { await task; } finally { if (this.modePrompt === task) this.modePrompt = null; }
  }

  async compileWithProgress(sourceFile, options, runId) {
    this.compilingRunId = runId;
    this.statusBarItem.text = '$(sync~spin) 正在编译 C/C++ 源码...';
    this.pushSnapshotToWebview();
    const abort = new AbortController();
    this.activeCompileAbort = abort;
    const previous = this.compileQueue || Promise.resolve();
    const task = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: '正在编译...', cancellable: true }, async (_progress, token) => {
      const subscription = token.onCancellationRequested(() => abort.abort());
      try {
        await previous.catch(() => {});
        if (runId !== this.runId || abort.signal.aborted) return null;
        const buildOptions = { ...options, signal: abort.signal };
        const result = options.companionDebug
          ? await compileDebugWithCompanion(vscode, sourceFile, buildOptions, compileSourceFile, msg => this.outputChannel.appendLine(`[Dream Compiler] ${msg}`))
          : await compileSourceFile(sourceFile, buildOptions);
        if (abort.signal.aborted) {
          if (typeof result?.cleanupBuild === 'function') result.cleanupBuild();
          return { success: false, cancelled: true, diagnostics: [], errors: [], warnings: [] };
        }
        return result;
      } finally { subscription.dispose(); }
    });
    this.compileQueue = task.catch(() => {});
    try { return await task; }
    finally {
      if (this.activeCompileAbort === abort) this.activeCompileAbort = null;
      if (this.compilingRunId === runId) {
        this.compilingRunId = null;
        if (runId === this.runId) {
          this.updateStatusBar(this.session.state, this.session.stopLocation);
          this.pushSnapshotToWebview();
        }
      }
    }
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
      nonce: crypto.randomBytes(16).toString('base64')
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      try { await this.handleWebviewMessage(msg); }
      catch (err) { vscode.window.showErrorMessage(`Dream C++ Debugger: ${err.message}`); }
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
      if (isActive) {
        if (!this.editorReadOnly.enabled) void this.editorReadOnly.enable().catch(() => {});
      } else if (this.preparingDebugRunId !== this.runId && this.compilingRunId !== this.runId) {
        void this.editorReadOnly.disable().catch(() => {});
      }

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

  resolveStdinFilePath(rawPath, sourceFile) {
    if (!rawPath) return '';
    if (path.isAbsolute(rawPath)) return rawPath;
    if (sourceFile) {
      const relToSource = path.resolve(path.dirname(sourceFile), rawPath);
      if (fs.existsSync(relToSource)) return relToSource;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const relToWorkspace = path.resolve(folders[0].uri.fsPath, rawPath);
      if (fs.existsSync(relToWorkspace)) return relToWorkspace;
    }
    return path.resolve(rawPath);
  }

  async updateStdinFileInfo(rawPath) {
    const requestId = this.stdinPreviewRequestId = (this.stdinPreviewRequestId || 0) + 1;
    this.stdinFile = rawPath || '';
    if (!this.stdinFile) {
      this.stdinFilePreview = '尚未选择输入文件';
      this.pushSnapshotToWebview();
      return false;
    }
    const resolved = this.resolveStdinFilePath(this.stdinFile, this.resolveActiveSourceFile());
    let preview;
    let valid = false;
    try {
      const { stat, text } = await readRegularPrefix(resolved, 512);
      const sizeStr = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)} KB` : `${stat.size} B`;
      preview = `${path.basename(resolved)} (${sizeStr})\n` +
        `────────────────────────\n${text}${stat.size > 512 ? '\n...(后略)' : ''}`;
      valid = true;
    } catch (err) {
      preview = `⚠ 读取文件失败: ${err.message}`;
    }
    if (requestId !== this.stdinPreviewRequestId) return false;
    this.stdinFilePreview = preview;
    this.pushSnapshotToWebview();
    return valid;
  }

  pushSnapshotToWebview() {
    const snap = this.session.getSnapshot();
    if (this.resettingRunId === this.runId) snap.programOutput = '';
    const activeFile = this.resolveActiveSourceFile();
    snap.activeFileName = activeFile ? path.basename(activeFile) : '';
    snap.stdinMode = this.stdinMode;
    snap.stdinText = this.stdinText;
    snap.stdinFile = this.stdinFile;
    snap.stdinFilePreview = this.stdinFilePreview;
    snap.outputFile = this.outputFile || '';
    snap.userMode = this.userMode || 'expert';
    snap.isCompiling = this.compilingRunId === this.runId;
    snap.quickRunning = this.quickRunId === this.runId && !!this.activeRunProcess && !snap.isCompiling;
    snap.streamHistory = this.streamHistory.slice();
    snap.runId = this.runId;
    this.postToAllViews({
      type: 'snapshot',
      snapshot: snap
    });
  }

  async startDebugSession(options = {}) {
    if (typeof options === 'string') {
      this.stdinText = options;
    } else if (options && typeof options === 'object') {
      if (typeof options.stdin === 'string') this.stdinText = options.stdin;
      if (typeof options.stdinMode === 'string') this.stdinMode = options.stdinMode;
      if (typeof options.stdinFile === 'string') await this.updateStdinFileInfo(options.stdinFile);
    }

    const sourceFile = this.resolveActiveSourceFile();
    if (!sourceFile) {
      vscode.window.showWarningMessage('请先打开一个 C/C++ 源文件 (.cpp / .c) 再启动 GDB 调试。');
      return;
    }

    const resolvedStdinFile =
      this.stdinMode === 'file' ? this.resolveStdinFilePath(this.stdinFile, sourceFile) : '';
    if (this.stdinMode === 'file' && (!resolvedStdinFile || !(await this.updateStdinFileInfo(this.stdinFile)))) {
      vscode.window.showWarningMessage('请先选择一个有效的本地输入文件 (.in / .txt)，或切换到文本预设/流式输入模式。');
      return;
    }

    const selectedOutputFile = this.outputFile || '';
    this.activeCompileAbort?.abort();
    const runId = ++this.runId;
    this.quickRunId = null;
    this.resettingRunId = runId;
    this.quickRunSawStderr = false;
    this.streamHistory = [];
    this.session.programOutput = '';
    this.pushSnapshotToWebview();
    const previousFileRun = this.activeFileRunPromise;
    this.cancelActiveRun();
    if (previousFileRun) await previousFileRun.catch(() => {});
    if (runId !== this.runId) return;

    // Save dirty document before compiling
    const openDoc = vscode.workspace.textDocuments.find((d) => d.fileName === sourceFile);
    if (openDoc && openDoc.isDirty && !(await openDoc.save())) {
      if (runId === this.runId) vscode.window.showWarningMessage('源文件未能保存，已取消调试。');
      return;
    }

    this.sidebarProvider.reveal();
    this.config = vscode.workspace.getConfiguration('dreamCppDebug');

    if (runId !== this.runId) return;
    // Stop can flush output from the old inferior; clear it again afterwards.
    await this.session.stop();
    if (runId !== this.runId) return;
    this.session.programOutput = '';
    this.resettingRunId = null;
    this.pushSnapshotToWebview();

    this.preparingDebugRunId = runId;
    try {
      if (this.editorReadOnly) await this.editorReadOnly.enable();
      if (runId !== this.runId) return;
      if (openDoc && openDoc.isDirty && !(await openDoc.save())) {
        vscode.window.showWarningMessage('源文件未能保存，已取消调试。');
        return;
      }
      if (runId !== this.runId) return;
      this.statusBarItem.text = '$(sync~spin) 正在编译 C++ 源码...';
      this.outputChannel.appendLine(`[Dream Compiler] 正在编译: ${sourceFile}`);

      let compileResult;
      try {
        compileResult = await this.compileWithProgress(sourceFile, {
          autoCleanup: true,
          companionDebug: true,
          vectorHelpers: true,
          compilerPath: this.config.get('compilerPath', 'g++'),
          compileFlags: this.config.get('compileFlags', ['-g', '-O0', '-std=c++17'])
        }, runId);
      } catch (err) {
        if (runId === this.runId) vscode.window.showErrorMessage(`调试编译失败：${err.message}`);
        return;
      }

      let releaseBuild = compileResult && compileResult.cleanupBuild;
      try {
        if (runId !== this.runId) return;
        if (!compileResult || compileResult.cancelled) {
          this.outputChannel.appendLine('[Dream Compiler] 编译已取消。');
          return;
        }
        this.applyCompilerDiagnostics(sourceFile, compileResult);

        if (!compileResult.success) {
          this.updateStatusBar('idle');
          vscode.window.showErrorMessage(`编译失败 (CE)，请查看左侧边栏或“问题 (Problems)”面板中的错误详情。`);
          return;
        }

        this.outputChannel.appendLine(
          compileResult.integration?.cacheHit
            ? `[Dream Compiler] 智能编译：源码和依赖未变化，复用调试构建 -> ${compileResult.executable}`
            : `[Dream Compiler] 编译成功 (${compileResult.durationMs} ms) -> ${compileResult.executable}`
        );

        // Automatically open the spacious Debug Dashboard in the right half of the current editor window
        this.openDashboardPanel(true);

        this.session.gdbPath = this.config.get('gdbPath', 'gdb');
        this.session.maxArrayPreview = this.config.get('maxArrayPreview', 16);

        let outputCapture = null;
        try {
          if (selectedOutputFile) {
            if (process.platform !== 'linux') throw new Error('调试输出到文件目前仅支持 Linux');
            outputCapture = await openOutputFile(selectedOutputFile, [sourceFile, resolvedStdinFile, compileResult.executable], { shouldProceed: () => runId === this.runId });
            if (runId !== this.runId) { await outputCapture.close(); return; }
          }
          const cleanupBuild = releaseBuild;
          releaseBuild = null; // The session owns it from this point, even if start fails.
          await this.session.start({
            cleanupBuild,
            outputCapture,
            executable: compileResult.executable,
            sourceFile,
            cwd: path.dirname(sourceFile),
            stdinMode: this.stdinMode,
            stdin: this.stdinMode === 'text' ? this.stdinText : '',
            stdinFile: resolvedStdinFile,
            stopAtMain: this.config.get('stopAtMain', true)
          });
        } catch (err) {
          if (runId === this.runId) {
            await this.session.stop();
            vscode.window.showErrorMessage(`启动调试失败: ${err.message}`);
          }
          if (outputCapture) await outputCapture.close().catch(() => {});
        }
      } finally {
        if (releaseBuild) releaseBuild();
      }
    } finally {
      if (this.preparingDebugRunId === runId) this.preparingDebugRunId = null;
      if (runId === this.runId && this.editorReadOnly && !['starting', 'running', 'paused'].includes(this.session.state)) {
        await this.editorReadOnly.disable();
      }
    }
  }

  async compileAndQuickRun(options = {}) {
    if (typeof options === 'string') {
      this.stdinText = options;
    } else if (options && typeof options === 'object') {
      if (typeof options.stdin === 'string') this.stdinText = options.stdin;
      if (typeof options.stdinMode === 'string') this.stdinMode = options.stdinMode;
      if (typeof options.stdinFile === 'string') await this.updateStdinFileInfo(options.stdinFile);
    }

    const sourceFile = this.resolveActiveSourceFile();
    if (!sourceFile) {
      vscode.window.showWarningMessage('请先打开一个 C/C++ 源文件 (.cpp / .c)。');
      return;
    }

    const resolvedStdinFile =
      this.stdinMode === 'file' ? this.resolveStdinFilePath(this.stdinFile, sourceFile) : '';
    if (this.stdinMode === 'file' && (!resolvedStdinFile || !(await this.updateStdinFileInfo(this.stdinFile)))) {
      vscode.window.showWarningMessage('请先选择一个有效的本地输入文件 (.in / .txt)，或切换到文本预设/流式输入模式。');
      return;
    }

    const selectedOutputFile = this.outputFile || '';
    const runId = ++this.runId;
    this.quickRunId = runId;
    this.resettingRunId = runId;
    this.quickRunSawStderr = false;
    this.streamHistory = [];
    this.session.programOutput = '';
    this.pushSnapshotToWebview();
    const previousFileRun = this.activeFileRunPromise;
    this.cancelActiveRun();
    if (previousFileRun) await previousFileRun.catch(() => {});
    if (runId !== this.runId) return;

    const openDoc = vscode.workspace.textDocuments.find((d) => d.fileName === sourceFile);
    if (openDoc && openDoc.isDirty) {
      await openDoc.save();
    }

    this.sidebarProvider.reveal();
    this.config = vscode.workspace.getConfiguration('dreamCppDebug');

    if (runId !== this.runId) return;
    await this.session.stop();
    if (runId !== this.runId) return;
    this.session.programOutput = '';
    this.resettingRunId = null;
    this.pushSnapshotToWebview();

    const compileResult = await this.compileWithProgress(sourceFile, {
      autoCleanup: true,
      compilerPath: this.config.get('compilerPath', 'g++'),
      compileFlags: this.config.get('compileFlags', ['-g', '-O0', '-std=c++17'])
    }, runId);

    let releaseBuild = compileResult && compileResult.cleanupBuild;
    try {
      if (runId !== this.runId) return;
      if (!compileResult || compileResult.cancelled) {
        this.quickRunId = null;
        this.outputChannel.appendLine('[Dream Compiler] 编译已取消。');
        return;
      }
      this.applyCompilerDiagnostics(sourceFile, compileResult);
      if (!compileResult.success) {
        this.quickRunId = null;
        vscode.window.showErrorMessage('C/C++ 编译失败 (CE)，请查看错误提示。');
        return;
      }

      this.session.programOutput = '';
      this.pushSnapshotToWebview();

      let outputCapture = null, previewTimer = null, runRes, runningPromise = null;
      const pollOutputFile = (final = false) => {
        if (!outputCapture) return;
        const text = outputCapture.poll(final);
        if (text && runId === this.runId) {
          this.session.programOutput = appendBounded(this.session.programOutput, text);
          this.pushSnapshotToWebview();
        }
      };
      try {
        if (selectedOutputFile) {
          outputCapture = await openOutputFile(selectedOutputFile, [sourceFile, resolvedStdinFile, compileResult.executable], { shouldProceed: () => runId === this.runId });
          if (runId !== this.runId) { await outputCapture.close(); return; }
          previewTimer = setInterval(() => {
            try { pollOutputFile(); } catch (err) {
              clearInterval(previewTimer); previewTimer = null;
              this.outputChannel.appendLine(`[Dream C++] 读取输出文件预览失败: ${err.message}`);
            }
          }, 120);
        }
        runningPromise = runExecutable(compileResult.executable, {
        outputCapture,
        cwd: path.dirname(sourceFile),
        stdin: this.stdinMode === 'text' ? this.stdinText : '',
        stdinFile: this.stdinMode === 'file' ? resolvedStdinFile : '',
        streamMode: this.stdinMode === 'stream',
        timeoutMs: this.stdinMode === 'stream' ? 60000 : 10000,
        onProcess: (proc, cancel) => {
          if (releaseBuild && typeof proc.once === 'function') {
            const release = releaseBuild;
            releaseBuild = null;
            proc.once('close', () => release());
          }
          if (runId !== this.runId) { cancel(); return; }
          this.activeRunProcess = proc;
          this.activeRunCancel = cancel;
          this.activeRunStream = this.stdinMode === 'stream';
          this.pushSnapshotToWebview();
        },
        onOutput: (chunk, _outputSoFar, category) => {
          if (runId !== this.runId) return;
          if (category === 'stderr' && !this.quickRunSawStderr) {
            this.session.programOutput = appendBounded(this.session.programOutput, '\n[stderr]\n');
            this.quickRunSawStderr = true;
          }
          this.session.programOutput = appendBounded(this.session.programOutput, chunk);
          this.pushSnapshotToWebview();
        }
      });
        if (outputCapture) this.activeFileRunPromise = runningPromise;
        runRes = await runningPromise;

      } catch (err) {
        if (runId === this.runId) {
          this.quickRunId = null;
          vscode.window.showErrorMessage(`运行失败：${err.message}`);
        }
        return;
      } finally {
        if (this.activeFileRunPromise === runningPromise) this.activeFileRunPromise = null;
        if (previewTimer) clearInterval(previewTimer);
        if (outputCapture) {
          try { pollOutputFile(true); } catch (err) { this.outputChannel.appendLine(`[Dream C++] 读取输出文件预览失败: ${err.message}`); }
          await outputCapture.close().catch(() => {});
        }
      }

      if (runId !== this.runId) return;
      this.activeRunProcess = null;
      this.activeRunCancel = null;
      this.quickRunId = null;
      const resultLabel = runRes.cancelled ? '已停止' : runRes.killedByTimeout ? '运行超时' : '运行完毕';
      this.session.programOutput = appendBounded(this.session.programOutput,
        `\n──────────────────────────────\n` +
        `[${resultLabel}] 退出码: ${runRes.exitCode} · 耗时: ${runRes.durationMs} ms`);
      this.pushSnapshotToWebview();
    } finally {
      if (releaseBuild) releaseBuild();
    }
  }

  cancelActiveRun() {
    const cancel = this.activeRunCancel;
    const proc = this.activeRunProcess;
    this.activeRunCancel = null;
    this.activeRunProcess = null;
    this.activeRunStream = false;
    if (cancel) cancel();
    else if (proc) { try { proc.kill(); } catch (_) {} }
  }

  async stopExecution() {
    this.activeCompileAbort?.abort();
    if (this.quickRunId === this.runId || this.compilingRunId === this.runId || this.preparingDebugRunId === this.runId) {
      ++this.runId; // invalidate pending compile/start and late output callbacks
      this.quickRunId = null;
      this.compilingRunId = null;
      this.resettingRunId = null;
      this.updateStatusBar('idle');
      this.session.programOutput = appendBounded(this.session.programOutput, '\n[已停止]\n');
      this.pushSnapshotToWebview();
    }
    this.cancelActiveRun();
    await this.session.stop();
    if (this.editorReadOnly) await this.editorReadOnly.disable();
  }

  sendStreamStdin(text) {
    if (typeof text !== 'string' || !text.length) return;
    const line = text.endsWith('\n') ? text : `${text}\n`;
    let sent = false;
    if (this.activeRunProcess && this.activeRunStream && this.activeRunProcess.stdin?.writable && !this.activeRunProcess.killed) {
      try { this.activeRunProcess.stdin.write(line); sent = true; } catch (_) {}
    } else if (!this.activeRunProcess) {
      sent = this.session.sendStdin(line);
    }
    if (!sent) {
      vscode.window.showWarningMessage('当前没有可用的流式输入，请以流式输入模式启动程序。');
      return;
    }
    const cleanText = text.replace(/\r?\n$/, '');
    this.streamHistory.push(`→ ${cleanText.slice(0, 8192)}`);
    if (this.streamHistory.length > 1000) this.streamHistory.shift();
    this.pushSnapshotToWebview();
  }

  closeStreamStdin() {
    let sent = false;
    if (this.activeRunProcess && this.activeRunStream && this.activeRunProcess.stdin?.writable && !this.activeRunProcess.killed) {
      try { this.activeRunProcess.stdin.end(); sent = true; } catch (_) {}
    } else if (!this.activeRunProcess) {
      sent = this.session.closeStdin();
    }
    if (!sent) {
      vscode.window.showWarningMessage('当前没有可关闭的流式输入。');
      return;
    }
    this.streamHistory.push('■ [已发送 EOF]');
    if (this.streamHistory.length > 1000) this.streamHistory.shift();
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
      case 'changeUserMode':
        await this.chooseUserMode();
        break;
      case 'ready':
        this.pushSnapshotToWebview();
        break;
      case 'startDebug':
        await this.startDebugSession({
          stdinMode: msg.stdinMode,
          stdin: msg.stdin,
          stdinFile: msg.stdinFile
        });
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
        await this.startDebugSession();
        break;
      case 'stop':
        await this.stopExecution();
        break;
      case 'updateStdinMode':
        this.stdinMode = msg.mode || 'text';
        break;
      case 'updateStdin':
        this.stdinText = msg.stdin || '';
        break;
      case 'pickOutputFile': {
        const activeFile = this.resolveActiveSourceFile();
        const defaultUri = activeFile ? vscode.Uri.file(path.join(path.dirname(activeFile), 'output.txt')) : undefined;
        const uri = await vscode.window.showSaveDialog({
          title: '选择程序输出文件（每次运行覆盖）', saveLabel: '选择输出文件', defaultUri,
          filters: { '文本文件': ['txt', 'out', 'log'], '所有文件': ['*'] }
        });
        if (uri && uri.scheme === 'file') { this.outputFile = uri.fsPath; this.pushSnapshotToWebview(); }
        else if (uri) vscode.window.showWarningMessage('请选择本地文件');
        break;
      }
      case 'clearOutputFile':
        this.outputFile = '';
        this.pushSnapshotToWebview();
        break;
      case 'pickStdinFile': {
        const activeFile = this.resolveActiveSourceFile();
        const defaultUri = activeFile ? vscode.Uri.file(path.dirname(activeFile)) : undefined;
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: '作为标准输入 (stdin)',
          defaultUri,
          filters: {
            '输入文件 (.in, .txt, .dat)': ['in', 'txt', 'dat', 'csv'],
            '所有文件 (*)': ['*']
          }
        });
        if (uris && uris.length > 0) {
          await this.updateStdinFileInfo(uris[0].fsPath);
        }
        break;
      }
      case 'setStdinFilePath':
        await this.updateStdinFileInfo(msg.filePath || '');
        break;
      case 'sendStreamStdin':
        this.sendStreamStdin(msg.text || '');
        break;
      case 'closeStreamStdin':
        this.closeStreamStdin();
        break;
      case 'clearStreamHistory':
        this.streamHistory = [];
        this.pushSnapshotToWebview();
        break;
      case 'clearProgramOutput':
        this.quickRunSawStderr = false;
        this.session.programOutput = '';
        this.pushSnapshotToWebview();
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
      case 'vectorContextAction': {
        const context = msg.context;
        try {
          this.session._assertPauseContext(context);
          if (!['left', 'right', 'delete', 'empty'].includes(msg.mode) || !Number.isSafeInteger(msg.revision)) throw new Error('操作无效');
          const anchor = msg.mode === 'empty' ? null : msg.index;
          if (anchor !== null && (!Number.isSafeInteger(anchor) || anchor < 0 || anchor >= Number.MAX_SAFE_INTEGER)) throw new Error('元素索引无效');
          const currentVar = this.session.locals.find(v => v.name === msg.name);
          const isString = currentVar?.sequence?.stringOps === true;
          let value = '';
          if (msg.mode !== 'delete') {
            value = await vscode.window.showInputBox({
              prompt: msg.mode === 'empty' ? `向空 ${msg.name} 添加第一个元素` : `在 ${msg.name}[${anchor}] ${msg.mode === 'left' ? '左侧' : '右侧'}插入元素`,
              placeHolder: isString ? '输入文本、转义序列或 0x00–0xFF（按字节插入）' : msg.isChar ? '单字节字符或 0x00–0xFF' : '输入元素值'
            });
            if (value === undefined) break;
          }
          this.session._assertPauseContext(context);
          const index = msg.mode === 'empty' ? 0 : anchor + (msg.mode === 'right' ? 1 : 0);
          await this.session.insertVectorElement(msg.name, index, value, context, {
            revision: msg.revision, delete: msg.mode === 'delete', requireEmpty: msg.mode === 'empty',
            ...(anchor === null ? {} : { anchorIndex: anchor })
          });
          const local = this.session.locals.find(v => v.name === msg.name);
          this.postToAllViews({ type: 'sequenceEdited', requestId: msg.requestId, name: msg.name, length: local?.sequence?.length });
        } catch (err) {
          this.postToAllViews({ type: 'sequenceError', requestId: msg.requestId, message: err.message });
          vscode.window.showErrorMessage(`容器操作失败：${err.message}`);
        }
        break;
      }
      case 'sequencePage': {
        try {
          const page = await this.session.getSequencePage(msg.name, msg.offset, 32, msg.context, msg.scope === 'global' ? 'global' : 'local');
          this.postToAllViews({ type: 'sequencePage', requestId: msg.requestId, page });
        } catch (err) {
          this.postToAllViews({ type: 'sequenceError', requestId: msg.requestId, message: err.message });
        }
        break;
      }
      case 'editSequenceElement': {
        const context = msg.context;
        try {
          this.session._assertPauseContext(context);
          const val = await vscode.window.showInputBox({
            prompt: `修改 ${msg.name}${msg.label || '[' + msg.index + ']'}` + (msg.isChar ? '（单字节字符、转义序列或 0x00–0xFF；UTF-8 按字节索引）' : ''),
            value: msg.currentValue || ''
          });
          if (val !== undefined) await this.session.setSequenceElement(msg.name, msg.index, val, context);
          this.postToAllViews({ type: 'sequenceEdited', requestId: msg.requestId });
        } catch (err) {
          this.postToAllViews({ type: 'sequenceError', requestId: msg.requestId, message: err.message });
          vscode.window.showErrorMessage(`修改失败：${err.message}`);
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
    this.activeCompileAbort?.abort();
    ++this.runId;
    this.quickRunId = null;
    this.cancelActiveRun();
    this.session.stop();
    if (this.editorReadOnly) void this.editorReadOnly.disable().catch(() => {});
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
      if (controller.editorReadOnly.cleaning) return;
      void controller.editorReadOnly.onActiveEditorChanged().catch(() => {});
      if (editor && editor.document && isSourceFile(editor.document.fileName)) {
        controller.lastTargetFile = editor.document.fileName;
        controller.pushSnapshotToWebview();
        if (controller.session.state === 'paused' && controller.session.stopLocation) {
          controller.applyEditorDecorations(controller.session.stopLocation);
        }
      }
    })
  );

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('dreamCppDebug.interfaceMode')) return;
    controller.syncUserModeFromConfig();
  }));

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
          md.isTrusted = false;
          md.appendMarkdown(`**Dream GDB 实时求值**\n\n`);
          md.appendCodeblock(`${expr}: ${evaluated.type || 'auto'} = ${evaluated.displayValue}`, 'cpp');
          return new vscode.Hover(md, range);
        } catch (_) {
          return null;
        }
      }
    })
  );

  // 5. Register Native Debug Adapter (`type: "dream-cpp-gdb"`)
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
        }, (source, options, cfg) => withCompileNotification(vscode, source, options, (file, buildOptions) => {
          if (cfg.compilerPath || cfg.compileFlags) return compileSourceFile(file, buildOptions);
          return compileDebugWithCompanion(vscode, file, buildOptions, compileSourceFile, msg => controller.outputChannel.appendLine(`[Dream Compiler] ${msg}`));
        }));
        return new vscode.DebugAdapterInlineImplementation(adapter);
      }
    })
  );

  // 6. Register Extension Commands
  const register = (id, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('dream-cpp-debug.startDebug', () => controller.startDebugSession());
  register('dream-cpp-debug.chooseUserMode', () => controller.chooseUserMode());
  register('dream-cpp-debug.openModeSettings', () => controller.openModeSettings());
  register('dream-cpp-debug.openDashboard', () => controller.openDashboardPanel(false));
  register('dream-cpp-debug.continue', () => controller.session.continue());
  register('dream-cpp-debug.pause', () => controller.session.pause());
  register('dream-cpp-debug.stepOver', () => controller.session.stepOver());
  register('dream-cpp-debug.stepInto', () => controller.session.stepInto());
  register('dream-cpp-debug.stepOut', () => controller.session.stepOut());
  register('dream-cpp-debug.restart', () => controller.startDebugSession());
  register('dream-cpp-debug.stop', () => controller.stopExecution());

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
