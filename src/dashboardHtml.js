/**
 * Dream C++ Debugger — Right-Pane Debug Dashboard Webview UI (`ViewColumn.Beside`)
 * Spacious, high-contrast inspection workspace for Local Variables, STL/Array Visualizers,
 * Watch Expressions, Call Stack, Conditional Breakpoints, CPU Registers, and GDB Console.
 */
'use strict';

function getDashboardHtml(options = {}) {
  const nonce = options.nonce || require('crypto').randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dream C++ GDB 调试台</title>
  <style nonce="${nonce}">
    /* ── Dark Theme High-Contrast Palette ── */
    :root,
    body.vscode-dark,
    body.vscode-high-contrast {
      --bg-base: #11151f;
      --bg-card: #1a2130;
      --bg-card-header: #232c40;
      --bg-elevated: #131924;
      --bg-hover: #2a354d;
      --bg-input: #0d111a;

      --fg-main: #f8fafc;
      --fg-secondary: #e2e8f0;
      --fg-muted: #cbd5e1;

      --border-strong: #475569;
      --border-subtle: #334155;
      --border-focus: #6366f1;

      --accent: #4f46e5;
      --accent-hover: #4338ca;

      --var-name-color: #38bdf8;
      --var-val-color: #4ade80;
      --var-str-color: #fb923c;
      --var-ptr-color: #c084fc;
      --var-type-bg: #334155;
      --var-type-fg: #f1f5f9;

      --badge-bg: #3730a3;
      --badge-fg: #e0e7ff;

      --paused-bg: rgba(245, 158, 11, 0.22);
      --paused-border: #f59e0b;
      --paused-fg: #fef08a;

      --running-bg: rgba(16, 185, 129, 0.22);
      --running-border: #10b981;
      --running-fg: #a7f3d0;

      --error-bg: rgba(225, 29, 72, 0.25);
      --error-border: #f43f5e;
      --error-fg: #fecdd3;

      --array-cell-bg: #1e293b;
      --array-cell-border: #6366f1;
      --array-idx-fg: #cbd5e1;
      --array-val-fg: #ffffff;

      --output-bg: #0b0f17;
      --output-fg: #f1f5f9;

      --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
      --font-mono: var(--vscode-editor-font-family, "JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace);
    }

    /* ── Light Theme High-Contrast Palette ── */
    body.vscode-light,
    body.vscode-high-contrast-light {
      --bg-base: #f1f5f9;
      --bg-card: #ffffff;
      --bg-card-header: #e2e8f0;
      --bg-elevated: #f8fafc;
      --bg-hover: #dbeafe;
      --bg-input: #ffffff;

      --fg-main: #0f172a;
      --fg-secondary: #1e293b;
      --fg-muted: #334155;

      --border-strong: #94a3b8;
      --border-subtle: #cbd5e1;
      --border-focus: #4f46e5;

      --accent: #4f46e5;
      --accent-hover: #3730a3;

      --var-name-color: #0369a1;
      --var-val-color: #15803d;
      --var-str-color: #c2410c;
      --var-ptr-color: #6d28d9;
      --var-type-bg: #e2e8f0;
      --var-type-fg: #0f172a;

      --badge-bg: #e0e7ff;
      --badge-fg: #1e3a8a;

      --paused-bg: #fef3c7;
      --paused-border: #d97706;
      --paused-fg: #78350f;

      --running-bg: #d1fae5;
      --running-border: #059669;
      --running-fg: #064e3b;

      --error-bg: #ffe4e6;
      --error-border: #e11d48;
      --error-fg: #881337;

      --array-cell-bg: #eef2ff;
      --array-cell-border: #6366f1;
      --array-idx-fg: #334155;
      --array-val-fg: #0f172a;

      --output-bg: #0f172a;
      --output-fg: #f8fafc;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
      color: var(--fg-main);
      background: var(--bg-base);
      padding: 14px;
      user-select: none;
    }

    /* ── Sticky Top Header & Transport Toolbar ── */
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--bg-card);
      border: 1.5px solid var(--border-strong);
      border-radius: 10px;
      padding: 11px 14px;
      margin-bottom: 14px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
    }

    .top-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 10px;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .brand-dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #64748b;
      border: 1.5px solid rgba(255, 255, 255, 0.45);
    }
    .brand-dot.running {
      background: #10b981;
      box-shadow: 0 0 10px #10b981;
    }
    .brand-dot.paused {
      background: #f59e0b;
      box-shadow: 0 0 10px #f59e0b;
    }

    .file-title {
      font-weight: 700;
      font-size: 14.5px;
      color: var(--fg-main);
    }

    .status-pill {
      font-size: 12px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--bg-card-header);
      color: var(--fg-main);
      border: 1.5px solid var(--border-strong);
    }
    .status-pill.paused {
      background: var(--paused-bg);
      color: var(--paused-fg);
      border-color: var(--paused-border);
    }
    .status-pill.running {
      background: var(--running-bg);
      color: var(--running-fg);
      border-color: var(--running-border);
    }

    .location-banner {
      display: none;
      align-items: center;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      font-weight: 700;
      background: var(--paused-bg);
      border: 1.5px solid var(--paused-border);
      color: var(--paused-fg);
      padding: 4px 11px;
      border-radius: 7px;
      cursor: pointer;
    }
    .location-banner.visible {
      display: inline-flex;
    }

    .transport-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 7px;
    }

    .ctrl-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 8px;
      border-radius: 7px;
      border: 1.5px solid var(--border-strong);
      background: var(--bg-elevated);
      color: var(--fg-main);
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      transition: all 0.14s ease;
    }
    .ctrl-btn svg {
      width: 15px;
      height: 15px;
      flex-shrink: 0;
    }
    .ctrl-btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: var(--border-focus);
      transform: translateY(-1px);
    }
    .ctrl-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .ctrl-btn.continue-btn:not(:disabled) {
      color: #34d399;
      border-color: #10b981;
    }
    .ctrl-btn.danger:not(:disabled) {
      color: #fb7185;
      border-color: #f43f5e;
    }

    /* ── Dashboard Content Grid ── */
    .dashboard-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }

    @media (min-width: 720px) {
      .two-col-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
      }
    }

    .section-card {
      background: var(--bg-card);
      border: 1.5px solid var(--border-strong);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .two-col-row .section-card {
      margin-bottom: 0;
    }
    .two-col-row.beginner-layout { grid-template-columns: 1fr; }
    .section-card[hidden] { display: none; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 13px;
      background: var(--bg-card-header);
      border-bottom: 1.5px solid var(--border-strong);
      font-weight: 700;
      font-size: 13px;
    }

    .section-body {
      padding: 12px 13px;
    }

    .badge-count {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 700;
      padding: 1px 8px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      border: 1px solid var(--border-subtle);
    }

    /* ── Wide Variable & Array Cards ── */
    .var-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .var-item {
      background: var(--bg-elevated);
      border: 1.5px solid var(--border-subtle);
      border-radius: 8px;
      padding: 9px 12px;
      transition: all 0.2s ease;
    }
    .var-item.changed {
      border-color: var(--paused-border);
      background: var(--paused-bg);
    }

    .var-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .var-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      max-width: 100%;
    }

    .var-name {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--var-name-color);
      font-size: 13.5px;
    }

    .var-type {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--var-type-bg);
      color: var(--var-type-fg);
      display: inline-block;
      min-width: 0;
      max-width: min(32ch, 45vw);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .var-changed-tag {
      font-size: 10.5px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--paused-border);
      color: #0f172a;
    }

    .var-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .var-val {
      font-family: var(--font-mono);
      font-size: 13.5px;
      font-weight: 700;
      color: var(--var-val-color);
      word-break: break-all;
      user-select: text;
    }
    .var-val.string { color: var(--var-str-color); }
    .var-val.pointer { color: var(--var-ptr-color); }
    .var-val.uninitialized {
      color: var(--fg-muted);
      font-weight: 500;
      font-style: italic;
      font-size: 12px;
    }

    .icon-action {
      background: var(--bg-card-header);
      border: 1px solid var(--border-strong);
      color: var(--fg-main);
      cursor: pointer;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 11.5px;
      font-weight: 700;
    }
    .icon-action:hover {
      background: var(--bg-hover);
      border-color: var(--border-focus);
    }

    /* Spacious 1D Visual Array Strip */
    .array-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 9px;
      padding-top: 6px;
      border-top: 1px dashed var(--border-subtle);
    }
    .array-cell {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 46px;
      border: 1.5px solid var(--array-cell-border);
      border-radius: 6px;
      background: var(--array-cell-bg);
      padding: 4px 8px;
      font-family: var(--font-mono);
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .array-cell:hover {
      border-color: var(--paused-border);
      transform: translateY(-1px);
    }
    .array-idx {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--array-idx-fg);
      border-bottom: 1px solid var(--border-subtle);
      width: 100%;
      text-align: center;
      margin-bottom: 2px;
    }
    .array-v {
      font-size: 13px;
      font-weight: 700;
      color: var(--array-val-fg);
    }

    .sequence-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .sequence-overlay[hidden] { display: none; }
    .sequence-dialog { width: min(700px, 100%); max-height: 85vh; overflow: auto; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-focusBorder); border-radius: 10px; padding: 18px; box-shadow: 0 12px 35px rgba(0,0,0,.35); }
    .sequence-head, .sequence-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .sequence-message { color: var(--vscode-descriptionForeground); margin: 10px 0; }
    .vector-menu { position: fixed; z-index: 120; min-width: 150px; padding: 5px; border: 1px solid var(--vscode-menu-border, var(--vscode-focusBorder)); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editor-background)); color: var(--vscode-menu-foreground, var(--vscode-editor-foreground)); box-shadow: 0 5px 18px rgba(0,0,0,.35); }
    .vector-menu[hidden] { display: none; }
    .vector-menu button { display: block; width: 100%; padding: 7px 12px; border: 0; border-radius: 3px; text-align: left; color: inherit; background: transparent; cursor: pointer; }
    .vector-menu button:hover, .vector-menu button:focus { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); outline: none; }
    /* ── Input Row (Watch & GDB Console) ── */
    .input-row {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    .text-input {
      width: 100%;
      background: var(--bg-input);
      border: 1.5px solid var(--border-strong);
      color: var(--fg-main);
      font-family: var(--font-mono);
      font-size: 12.5px;
      padding: 7px 11px;
      border-radius: 7px;
      outline: none;
    }
    .text-input:focus {
      border-color: var(--border-focus);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid var(--border-strong);
      background: var(--accent);
      color: #ffffff;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 700;
      padding: 7px 14px;
      border-radius: 7px;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn:hover {
      background: var(--accent-hover);
    }

    /* ── Call Stack & Breakpoints ── */
    .stack-item, .bp-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 7px;
      background: var(--bg-elevated);
      border: 1.5px solid var(--border-subtle);
      margin-bottom: 6px;
      cursor: pointer;
    }
    .stack-item:hover, .bp-item:hover {
      border-color: var(--border-focus);
      background: var(--bg-hover);
    }
    .stack-item.active {
      border-color: var(--paused-border);
      background: var(--paused-bg);
    }

    .frame-badge {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    .mono-loc {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      color: var(--fg-muted);
    }

    .cond-pill {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    /* ── GDB Console & Registers ── */
    .output-box {
      font-family: var(--font-mono);
      font-size: 12.5px;
      background: var(--output-bg);
      border: 1.5px solid var(--border-strong);
      border-radius: 7px;
      padding: 9px 11px;
      max-height: 160px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      user-select: text;
      color: var(--output-fg);
    }

    .reg-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      gap: 6px;
      margin-top: 8px;
    }
    .reg-cell {
      display: flex;
      justify-content: space-between;
      background: var(--bg-elevated);
      border: 1.5px solid var(--border-subtle);
      padding: 5px 9px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
    }
    .reg-name { color: var(--var-ptr-color); font-weight: 700; }
    .reg-val { color: var(--fg-main); }

    .empty-hint {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--fg-muted);
      text-align: center;
      padding: 12px 6px;
    }

    .globals-more {
      display: block;
      width: 100%;
      margin-top: 6px;
      background: var(--bg-card-header);
      border: 1px dashed var(--border-strong);
      color: var(--fg-main);
      cursor: pointer;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
    }
    .globals-more:hover {
      background: var(--bg-hover);
      border-color: var(--border-focus);
    }
    .globals-more[disabled] { cursor: progress; opacity: .7; }
  </style>
</head>
<body>
  <!-- Sticky Top Control Bar -->
  <div class="top-bar">
    <div class="top-status-row">
      <div class="brand-group">
        <span id="statusDot" class="brand-dot"></span>
        <span id="targetFileName" class="file-title">GDB 调试工作台</span>
        <span id="statusPill" class="status-pill">就绪 Ready</span>
      </div>

      <div id="locationBanner" class="location-banner" title="点击跳转到当前断点所在代码行">
        <span id="locationText">▶ main() · 第 1 行</span>
        <span>跳转源码 ↗</span>
      </div>
    </div>

    <div class="transport-grid">
      <button id="btnContinue" class="ctrl-btn continue-btn" disabled title="继续运行 Continue (F5)">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3v10l9-5-9-5z"/></svg>
        <span id="labelContinue">继续 F5</span>
      </button>
      <button id="btnStepOver" class="ctrl-btn" disabled title="单步跳过 Step Over (F10)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 10a5 5 0 0 1 10 0"/><polyline points="11 7 13.5 10 10.5 11"/><circle cx="8" cy="12" r="1.5" fill="currentColor"/></svg>
        <span id="labelStepOver">跳过 F10</span>
      </button>
      <button id="btnStepInto" class="ctrl-btn" disabled title="单步进入 Step Into (F11)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="8" y1="2" x2="8" y2="10"/><polyline points="5 7.5 8 10.5 11 7.5"/><circle cx="8" cy="13.5" r="1.5" fill="currentColor"/></svg>
        <span id="labelStepInto">进入 F11</span>
      </button>
      <button id="btnStepOut" class="ctrl-btn" disabled title="单步跳出 Step Out (Shift+F11)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="8" y1="10" x2="8" y2="2"/><polyline points="5 5 8 2 11 5"/><circle cx="8" cy="13.5" r="1.5" fill="currentColor"/></svg>
        <span id="labelStepOut">跳出</span>
      </button>
      <button id="btnRestart" class="ctrl-btn" title="重新编译并启动 GDB 调试">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 8a5 5 0 1 1-1.4-3.5"/><polyline points="13 2 13 5.5 9.5 5.5"/></svg>
        <span>重新调试</span>
      </button>
      <button id="btnStop" class="ctrl-btn danger" disabled title="停止调试 Stop (Shift+F5)">
        <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>
        <span>停止</span>
      </button>
    </div>
  </div>

  <!-- 1. Local Variables & STL / Array Visualizer (Full-Width Card) -->
  <div class="section-card">
    <div class="section-header">
      <span>🔍 局部变量 & STL / 数组可视化 (Locals)</span>
      <span id="localsCount" class="badge-count">0 项</span>
    </div>
    <div class="section-body">
      <div id="localsContainer" class="var-list">
        <div class="empty-hint">当 GDB 在断点或 main() 入口暂停时，此处完整展示所有局部变量、STL 容器与数组元素格子</div>
      </div>
    </div>
  </div>

  <!-- Global variables from source files -->
  <div class="section-card">
    <div class="section-header">
      <span>🌐 全局变量 (Globals)</span><span id="globalsCount" class="badge-count">0 项</span>
    </div>
    <div class="section-body">
      <div id="globalsInfo" class="empty-hint">暂停时展示源文件目录中的全局变量（只读）。</div>
      <div id="globalsContainer" class="var-list"></div>
    </div>
  </div>

  <!-- 2. Watch Expressions (Full-Width Card) -->
  <div class="section-card">
    <div class="section-header">
      <span>👁 监视表达式 (Watch Expressions)</span>
      <span id="watchesCount" class="badge-count">0 项</span>
    </div>
    <div class="section-body">
      <div class="input-row">
        <input id="watchInput" class="text-input" type="text" placeholder="输入任意 C++ 表达式或数组切片（如 dp[i][j]、arr@10、fib.size()），回车添加..." />
        <button id="btnAddWatch" class="btn">＋ 添加监视</button>
      </div>
      <div id="watchesContainer" class="var-list">
        <div class="empty-hint">暂无监视表达式</div>
      </div>
    </div>
  </div>

  <!-- 3. Call Stack & Breakpoints (Side-by-Side on wide panes) -->
  <div id="stackBreakpointRow" class="two-col-row" style="margin-bottom: 14px;">
    <div class="section-card">
      <div class="section-header">
        <span>📚 调用栈 (Call Stack)</span>
        <span id="stackCount" class="badge-count">0 帧</span>
      </div>
      <div class="section-body">
        <div id="stackContainer">
          <div class="empty-hint">暂无活动调用栈</div>
        </div>
      </div>
    </div>

    <div id="breakpointCard" class="section-card">
      <div class="section-header">
        <span>🎯 断点管理 (支持条件断点)</span>
        <span id="bpCount" class="badge-count">0 个</span>
      </div>
      <div class="section-body">
        <div id="bpContainer">
          <div class="empty-hint">在左侧代码编辑器行号旁点击红点或按 F9 即可添加断点</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 4. GDB Console & CPU Registers -->
  <div id="advancedCard" class="section-card">
    <div class="section-header">
      <span>⌨️ GDB 交互命令台 & CPU 寄存器</span>
      <span class="badge-count">GDB/MI2</span>
    </div>
    <div class="section-body">
      <div class="input-row">
        <input id="gdbCmdInput" class="text-input" type="text" placeholder="输入原生 GDB 命令，如 p x、x/8xw &dp、ptype fib、bt..." />
        <button id="btnSendGdb" class="btn">发送命令</button>
      </div>
      <div id="gdbConsoleBox" class="output-box">[Dream GDB] 调试工作台就绪。</div>
      <div id="registersContainer" class="reg-grid"></div>
    </div>
  </div>

  <div id="sequenceOverlay" class="sequence-overlay" hidden>
    <section class="sequence-dialog" role="dialog" aria-modal="true" aria-labelledby="sequenceTitle">
      <div class="sequence-head"><strong id="sequenceTitle">容器元素</strong><button class="btn" id="sequenceClose">关闭</button></div>
      <div class="sequence-message" id="sequenceMessage" aria-live="polite"></div>
      <div id="sequenceCells" class="array-strip"></div>
      <div class="sequence-nav"><button class="btn" id="sequencePrev">上一页</button><span id="sequenceRange"></span><button class="btn" id="sequenceNext">下一页</button></div>
    </section>
  </div>
  <div id="vectorMenu" class="vector-menu" role="menu" aria-label="容器元素操作" hidden>
    <button role="menuitem" data-menu-action="left">左侧插入</button>
    <button role="menuitem" data-menu-action="right">右侧插入</button>
    <button role="menuitem" data-menu-action="delete">删除元素</button>
  </div>
  <script nonce="${nonce}">
    (function() {
      const vscode = typeof acquireVsCodeApi === 'function'
        ? acquireVsCodeApi()
        : { postMessage: () => {} };

      const el = {
        statusDot: document.getElementById('statusDot'),
        targetFileName: document.getElementById('targetFileName'),
        statusPill: document.getElementById('statusPill'),
        locationBanner: document.getElementById('locationBanner'),
        locationText: document.getElementById('locationText'),
        stackBreakpointRow: document.getElementById('stackBreakpointRow'),
        breakpointCard: document.getElementById('breakpointCard'),
        advancedCard: document.getElementById('advancedCard'),
        labelContinue: document.getElementById('labelContinue'),
        labelStepOver: document.getElementById('labelStepOver'),
        labelStepInto: document.getElementById('labelStepInto'),
        labelStepOut: document.getElementById('labelStepOut'),
        btnContinue: document.getElementById('btnContinue'),
        btnStepOver: document.getElementById('btnStepOver'),
        btnStepInto: document.getElementById('btnStepInto'),
        btnStepOut: document.getElementById('btnStepOut'),
        btnRestart: document.getElementById('btnRestart'),
        btnStop: document.getElementById('btnStop'),
        localsCount: document.getElementById('localsCount'),
        localsContainer: document.getElementById('localsContainer'),
        globalsCount: document.getElementById('globalsCount'),
        globalsInfo: document.getElementById('globalsInfo'),
        globalsContainer: document.getElementById('globalsContainer'),
        watchesCount: document.getElementById('watchesCount'),
        watchInput: document.getElementById('watchInput'),
        btnAddWatch: document.getElementById('btnAddWatch'),
        watchesContainer: document.getElementById('watchesContainer'),
        stackCount: document.getElementById('stackCount'),
        stackContainer: document.getElementById('stackContainer'),
        bpCount: document.getElementById('bpCount'),
        bpContainer: document.getElementById('bpContainer'),
        gdbCmdInput: document.getElementById('gdbCmdInput'),
        btnSendGdb: document.getElementById('btnSendGdb'),
        gdbConsoleBox: document.getElementById('gdbConsoleBox'),
        registersContainer: document.getElementById('registersContainer')
      };

      let currentLocation = null;

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      el.btnContinue.addEventListener('click', () => vscode.postMessage({ type: 'continue' }));
      el.btnStepOver.addEventListener('click', () => vscode.postMessage({ type: 'stepOver' }));
      el.btnStepInto.addEventListener('click', () => vscode.postMessage({ type: 'stepInto' }));
      el.btnStepOut.addEventListener('click', () => vscode.postMessage({ type: 'stepOut' }));
      el.btnRestart.addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
      el.btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

      el.locationBanner.addEventListener('click', () => {
        if (currentLocation && currentLocation.file) {
          vscode.postMessage({
            type: 'jumpToLine',
            file: currentLocation.file,
            line: currentLocation.line || 1
          });
        }
      });

      function submitWatch() {
        const expr = el.watchInput.value.trim();
        if (!expr) return;
        vscode.postMessage({ type: 'addWatch', expr });
        el.watchInput.value = '';
      }
      el.btnAddWatch.addEventListener('click', submitWatch);
      el.watchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitWatch();
      });

      function submitGdbCmd() {
        const command = el.gdbCmdInput.value.trim();
        if (!command) return;
        vscode.postMessage({ type: 'gdbCommand', command });
        el.gdbCmdInput.value = '';
      }
      el.btnSendGdb.addEventListener('click', submitGdbCmd);
      el.gdbCmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGdbCmd();
      });

      function renderVariableCard(v, options = {}) {
        const valClass =
          v.kind === 'uninitialized' ? 'uninitialized' :
          v.kind === 'string' ? 'string' :
          v.kind === 'pointer' ? 'pointer' : '';
        const varBaseName = v.name || v.expr || '';
        let arrayHtml = '';
        const seq = v.sequence;
        if (seq) {
          const cells = seq.items.map(item => {
            const editable = seq.editable && seq.elementEditable !== false;
            const vectorData = (seq.vectorOps || seq.stringOps) ? ' data-vector-index="' + item.index + '" data-vector-name="' + escapeHtml(varBaseName) + '" data-vector-char="' + (seq.isChar ? '1' : '0') + '" title="右击：删除或插入"' : '';
            return '<button class="array-cell" data-seq-index="' + item.index + '" data-seq-name="' + escapeHtml(varBaseName) + '" data-cur-val="' + escapeHtml(item.editValue) + '" data-char="' + (seq.isChar ? '1' : '0') + '" data-editable="' + (editable ? '1' : '0') + '"' + vectorData + (!editable && !(seq.vectorOps || seq.stringOps) ? ' disabled' : '') + (!editable ? ' aria-label="此元素不支持修改值；右击可插入或删除"' : '') + '>' +
              '<span class="array-idx">[' + item.index + ']</span><span class="array-v">' + escapeHtml(item.value) + '</span></button>';
          }).join('');
          const more = seq.truncated ? '<button class="array-cell" data-seq-open="' + escapeHtml(varBaseName) + '" data-offset="' + seq.items.length + '" title="分页查看剩余元素">…<span class="array-idx">查看更多</span></button>' : '';
          const empty = (seq.vectorOps || seq.stringOps) && seq.length === 0 ? '<button class="array-cell" data-vector-empty="' + escapeHtml(varBaseName) + '" data-vector-char="' + (seq.isChar ? '1' : '0') + '" title="空容器：添加第一个元素">＋<span class="array-idx">添加首个元素</span></button>' : '';
          arrayHtml = '<div class="array-strip">' + cells + more + empty + '</div>';
        } else if (Array.isArray(v.elements) && v.elements.length && v.kind === 'array') {
          arrayHtml = '<div class="array-strip">' + v.elements.map((item, idx) => '<div class="array-cell"><span class="array-idx">[' + idx + ']</span><span class="array-v">' + escapeHtml(item) + '</span></div>').join('') + '</div>';
        }
        const editableVal = Array.isArray(v.elements) && v.kind === 'array' ? '{ ' + v.elements.join(', ') + ' }' : String(v.displayValue ?? v.value ?? '');
        const actionBtn = options.isGlobal ? '' : options.isWatch
          ? '<button class="icon-action" data-remove-watch="' + escapeHtml(v.id || v.expr) + '" title="移除监视">✕ 移除</button>'
          : v.kind === 'uninitialized' || (v.kind === 'array' && (!seq || seq.truncated)) || (seq && (!seq.editable || seq.elementEditable === false || seq.kind === 'chars' || seq.fullValueUnavailable))
          ? ''
          : '<button class="icon-action" data-edit-var="' + escapeHtml(varBaseName) + '" data-cur-val="' + escapeHtml(editableVal) + '" title="修改变量值">✎ 修改值</button>';

        return (
          '<div class="var-item ' + (v.changed ? 'changed' : '') + '">' +
            '<div class="var-main">' +
              '<div class="var-left">' +
                '<span class="var-name">' + escapeHtml(v.displayName || v.name || v.expr) + '</span>' +
                (v.sourceLabel ? '<span class="var-type" title="' + escapeHtml(v.sourceLabel) + '">' + escapeHtml(v.sourceLabel) + '</span>' : '') +
                (v.type ? '<span class="var-type" title="' + escapeHtml(v.type) + '">' + escapeHtml(v.type) + '</span>' : '') +
                (v.changed ? '<span class="var-changed-tag">已更新</span>' : '') +
              '</div>' +
              '<div class="var-right">' +
                '<span class="var-val ' + valClass + '"' + (v.tooltip ? ' title="' + escapeHtml(v.tooltip) + '"' : '') + '>' + escapeHtml(v.displayValue ?? v.value) + '</span>' +
                actionBtn +
              '</div>' +
            '</div>' +
            arrayHtml +
          '</div>'
        );
      }

      let currentContext = null, sequenceState = null, sequenceRequest = 0, currentBusy = false, currentRevision = 0, menuState = null;
      const overlay = document.getElementById('sequenceOverlay');
      const sequenceMessage = document.getElementById('sequenceMessage');
      const sequenceCells = document.getElementById('sequenceCells');
      const prev = document.getElementById('sequencePrev'), next = document.getElementById('sequenceNext');
      function sameContext(a, b) { return a && b && a.sessionId === b.sessionId && a.pauseId === b.pauseId && a.frame === b.frame; }
      const vectorMenu = document.getElementById('vectorMenu');
      function closeVectorMenu() { vectorMenu.hidden = true; menuState = null; }
      function openVectorMenu(btn, x, y) {
        if (!currentContext || currentBusy) return;
        menuState = { name: btn.dataset.vectorName, index: Number(btn.dataset.vectorIndex), isChar: btn.dataset.vectorChar === '1', context: currentContext, revision: currentRevision };
        vectorMenu.hidden = false;
        vectorMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - vectorMenu.offsetWidth - 4)) + 'px';
        vectorMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - vectorMenu.offsetHeight - 4)) + 'px';
        vectorMenu.querySelector('button').focus();
      }
      document.addEventListener('contextmenu', e => {
        const btn = e.target.closest('[data-vector-index]');
        if (!btn) return;
        e.preventDefault(); openVectorMenu(btn, e.clientX, e.clientY);
      });
      document.addEventListener('keydown', e => {
        const btn = e.target.closest && e.target.closest('[data-vector-index]');
        if (btn && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault(); const rect = btn.getBoundingClientRect(); openVectorMenu(btn, rect.left, rect.bottom);
        }
        if (e.key === 'Escape' && !vectorMenu.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeVectorMenu(); }
      });
      document.addEventListener('click', e => { if (!vectorMenu.contains(e.target)) closeVectorMenu(); });
      vectorMenu.querySelectorAll('[data-menu-action]').forEach(btn => btn.addEventListener('click', () => {
        if (!menuState) return;
        const chosen = menuState;
        closeVectorMenu();
        vscode.postMessage({ type: 'vectorContextAction', mode: btn.dataset.menuAction, ...chosen, requestId: sequenceRequest });
      }));
      document.addEventListener('click', e => {
        const btn = e.target.closest('[data-vector-empty]');
        if (btn && currentContext && !currentBusy) vscode.postMessage({ type: 'vectorContextAction', mode: 'empty', name: btn.dataset.vectorEmpty, isChar: btn.dataset.vectorChar === '1', context: currentContext, revision: currentRevision, requestId: sequenceRequest });
      });
      function closeSequence() { sequenceState = null; overlay.hidden = true; sequenceRequest++; }
      document.getElementById('sequenceClose').addEventListener('click', closeSequence);
      overlay.addEventListener('click', e => { if (e.target === overlay) closeSequence(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) closeSequence(); });
      function requestSequence(offset) {
        if (!sequenceState) return;
        sequenceState.offset = offset;
        sequenceMessage.textContent = '正在读取…'; sequenceCells.innerHTML = ''; prev.disabled = true; next.disabled = true;
        vscode.postMessage({ type: 'sequencePage', name: sequenceState.name, offset, scope: sequenceState.scope || 'local', context: sequenceState.context, requestId: ++sequenceRequest });
      }
      prev.addEventListener('click', () => requestSequence(Math.max(0, sequenceState.offset - 32)));
      next.addEventListener('click', () => requestSequence(sequenceState.offset + 32));
      function editSequence(name, index, val, isChar) {
        vscode.postMessage({ type: 'editSequenceElement', name, index, currentValue: val, isChar, context: currentContext, requestId: sequenceRequest });
      }
      function renderSnapshot(snap) {
        if (!snap) return;
        const state = snap.state || 'idle';
        const isPaused = state === 'paused';
        const beginner = snap.userMode === 'beginner';
        el.breakpointCard.hidden = beginner;
        el.advancedCard.hidden = beginner;
        el.stackBreakpointRow.classList.toggle('beginner-layout', beginner);
        el.labelContinue.textContent = beginner ? '运行到下一个断点 F5' : '继续 F5';
        el.labelStepOver.textContent = beginner ? '执行下一行 F10' : '跳过 F10';
        el.labelStepInto.textContent = beginner ? '进入函数 F11' : '进入 F11';
        el.labelStepOut.textContent = beginner ? '运行完当前函数' : '跳出';
        el.btnContinue.title = beginner ? '继续执行，直到遇到断点或程序结束 (F5)' : '继续运行 Continue (F5)';
        el.btnStepOver.title = beginner ? '执行当前行；遇到函数调用时不进入函数内部 (F10)' : '单步跳过 Step Over (F10)';
        el.btnStepInto.title = beginner ? '执行当前行并尽可能进入调用的函数 (F11)' : '单步进入 Step Into (F11)';
        el.btnStepOut.title = beginner ? '继续执行到当前函数返回，或遇到断点或程序结束 (Shift+F11)' : '单步跳出 Step Out (Shift+F11)';
        currentBusy = !!snap.vectorMutationBusy;
        currentRevision = snap.vectorRevision || 0;
        if (menuState && (currentBusy || menuState.revision !== currentRevision || !sameContext(menuState.context, { sessionId: snap.sessionId, pauseId: snap.pauseId, frame: snap.currentFrame }) || !isPaused)) closeVectorMenu();
        const nextContext = isPaused ? { sessionId: snap.sessionId, pauseId: snap.pauseId, frame: snap.currentFrame } : null;
        if (sequenceState && !sameContext(sequenceState.context, nextContext)) closeSequence();
        currentContext = nextContext;
        const isRunning = state === 'running' || state === 'starting';
        const isActive = isPaused || isRunning;

        el.statusDot.className = 'brand-dot ' + (isPaused ? 'paused' : isRunning ? 'running' : '');
        el.statusPill.className = 'status-pill ' + (isPaused ? 'paused' : isRunning ? 'running' : '');

        const stateLabels = {
          idle: '就绪 Ready',
          starting: '启动中...',
          running: '运行中 Running',
          paused: '已暂停 Paused',
          exited: '已结束 Exited',
          error: '异常 Error'
        };
        el.statusPill.textContent = stateLabels[state] || state;

        if (snap.activeFileName || snap.sourceFile) {
          const fname = snap.activeFileName || snap.sourceFile.split(/[\\\\/]/).pop();
          el.targetFileName.textContent = fname + ' · GDB 调试台';
        }

        currentLocation = snap.location || null;
        if (isPaused && currentLocation) {
          el.locationBanner.classList.add('visible');
          el.locationText.textContent = '▶ ' + (currentLocation.func || 'main') + '() · 第 ' + (currentLocation.line || 1) + ' 行';
        } else {
          el.locationBanner.classList.remove('visible');
        }

        el.btnContinue.disabled = !isPaused || currentBusy;
        el.btnStepOver.disabled = !isPaused || currentBusy;
        el.btnStepInto.disabled = !isPaused || currentBusy;
        el.btnStepOut.disabled = !isPaused || currentBusy;
        el.btnStop.disabled = !isActive && !snap.isCompiling;
        el.btnRestart.disabled = !!snap.isCompiling;
        if (snap.isCompiling) el.statusPill.textContent = '正在编译…';

        // Locals
        const locals = Array.isArray(snap.locals) ? snap.locals : [];
        el.localsCount.textContent = locals.length + ' 项';
        if (locals.length === 0) {
          el.localsContainer.innerHTML = '<div class="empty-hint">' +
            (isPaused ? '当前栈帧无局部变量' : '当 GDB 在断点暂停时，此处展示局部变量与 STL/数组图形化视图') +
          '</div>';
        } else {
          el.localsContainer.innerHTML = locals.map((v) => renderVariableCard(v, { isWatch: false })).join('');
          el.localsContainer.querySelectorAll('[data-seq-open]').forEach(btn => btn.addEventListener('click', () => {
            if (!currentContext) return;
            sequenceState = { name: btn.dataset.seqOpen, context: currentContext, offset: 0 };
            document.getElementById('sequenceTitle').textContent = (btn.dataset.seqLabel || sequenceState.name) + ' 的元素';
            overlay.hidden = false; requestSequence(Number(btn.dataset.offset));
          }));
          el.localsContainer.querySelectorAll('[data-seq-index]').forEach(btn => btn.addEventListener('click', () => {
            if (currentContext && btn.dataset.editable === '1') editSequence(btn.dataset.seqName, Number(btn.dataset.seqIndex), btn.dataset.curVal, btn.dataset.char === '1');
          }));
          el.localsContainer.querySelectorAll('[data-edit-var]').forEach((btn) => {
            btn.addEventListener('click', () => {
              vscode.postMessage({
                type: 'promptEditVariable',
                name: btn.getAttribute('data-edit-var'),
                currentValue: btn.getAttribute('data-cur-val')
              });
            });
          });
        }

        // Globals are deliberately read-only; their symbol identity includes the source file.
        const globals = Array.isArray(snap.globals) && isPaused ? snap.globals : [];
        el.globalsCount.textContent = snap.globalsHasMore && Number(snap.globalsTotal) > globals.length
          ? globals.length + ' / ' + Number(snap.globalsTotal) + ' 项'
          : globals.length + ' 项';
        el.globalsInfo.textContent = !isPaused ? '暂停时展示源文件目录中的全局变量（只读）。' :
          (snap.globalsInfo || (globals.length ? '只读 · 包含当前源文件目录中的全局及文件静态变量' : '未发现可读取的全局变量。'));
        el.globalsContainer.innerHTML = globals.map(v => renderVariableCard(v, { isGlobal: true })).join('');
        if (snap.globalsHasMore) {
          const total = Number(snap.globalsTotal) || globals.length;
          const more = document.createElement('button');
          more.className = 'globals-more';
          more.id = 'globalsMore';
          more.title = '全局变量数量较多，按需向 GDB 读取下一批的当前值';
          more.textContent = '加载更多全局变量（已显示 ' + globals.length + ' / ' + total + '）';
          more.addEventListener('click', () => {
            more.disabled = true;
            more.textContent = '正在读取…';
            vscode.postMessage({ type: 'loadMoreGlobals' });
          });
          el.globalsContainer.appendChild(more);
        }
        el.globalsContainer.querySelectorAll('[data-seq-open]').forEach(btn => btn.addEventListener('click', () => {
          if (!currentContext) return;
          const variable = globals.find(v => v.name === btn.dataset.seqOpen);
          sequenceState = { name: btn.dataset.seqOpen, scope: 'global', context: currentContext, offset: 0 };
          document.getElementById('sequenceTitle').textContent = (variable ? variable.displayName : sequenceState.name) + ' 的元素（只读）';
          overlay.hidden = false; requestSequence(Number(btn.dataset.offset));
        }));

        // Watches
        const watches = Array.isArray(snap.watches) ? snap.watches : [];
        el.watchesCount.textContent = watches.length + ' 项';
        if (watches.length === 0) {
          el.watchesContainer.innerHTML = '<div class="empty-hint">暂无监视表达式</div>';
        } else {
          el.watchesContainer.innerHTML = watches.map((w) =>
            renderVariableCard({
              id: w.id,
              name: w.expr,
              type: w.type,
              kind: w.kind,
              displayValue: w.value,
              elements: w.elements,
              sequence: (locals.find(v => v.name === w.expr) || {}).sequence
            }, { isWatch: true })
          ).join('');
          el.watchesContainer.querySelectorAll('[data-seq-open]').forEach(btn => btn.addEventListener('click', () => {
            if (!currentContext) return;
            sequenceState = { name: btn.dataset.seqOpen, context: currentContext, offset: 0 };
            document.getElementById('sequenceTitle').textContent = (btn.dataset.seqLabel || sequenceState.name) + ' 的元素';
            overlay.hidden = false; requestSequence(Number(btn.dataset.offset));
          }));
          el.watchesContainer.querySelectorAll('[data-seq-index]').forEach(btn => btn.addEventListener('click', () => {
            if (currentContext && btn.dataset.editable === '1') editSequence(btn.dataset.seqName, Number(btn.dataset.seqIndex), btn.dataset.curVal, btn.dataset.char === '1');
          }));
          el.watchesContainer.querySelectorAll('[data-remove-watch]').forEach((btn) => {
            btn.addEventListener('click', () => {
              vscode.postMessage({
                type: 'removeWatch',
                id: btn.getAttribute('data-remove-watch')
              });
            });
          });
        }

        // Call Stack
        const stack = Array.isArray(snap.stack) ? snap.stack : [];
        el.stackCount.textContent = stack.length + ' 帧';
        if (stack.length === 0) {
          el.stackContainer.innerHTML = '<div class="empty-hint">暂无活动调用栈</div>';
        } else {
          el.stackContainer.innerHTML = stack.map((f) =>
            '<div class="stack-item ' + (Number(f.level) === Number(snap.currentFrame || 0) ? 'active' : '') + '" data-frame="' + f.level + '" data-file="' + escapeHtml(f.fullname) + '" data-line="' + (f.line || 1) + '">' +
              '<div class="var-left">' +
                '<span class="frame-badge">#' + f.level + '</span>' +
                '<span class="var-name">' + escapeHtml(f.func) + '()</span>' +
              '</div>' +
              '<span class="mono-loc">' + escapeHtml(f.file || '') + (f.line ? ':' + f.line : '') + '</span>' +
            '</div>'
          ).join('');
          el.stackContainer.querySelectorAll('.stack-item').forEach((row) => {
            row.addEventListener('click', () => {
              vscode.postMessage({
                type: 'selectFrame',
                level: Number(row.getAttribute('data-frame')),
                file: row.getAttribute('data-file'),
                line: Number(row.getAttribute('data-line'))
              });
            });
          });
        }

        // Breakpoints
        const bps = Array.isArray(snap.breakpoints) ? snap.breakpoints : [];
        el.bpCount.textContent = bps.length + ' 个';
        if (bps.length === 0) {
          el.bpContainer.innerHTML = '<div class="empty-hint">在代码行号左侧点击红点或按 F9 即可添加断点</div>';
        } else {
          el.bpContainer.innerHTML = bps.map((bp) =>
            '<div class="bp-item" data-file="' + escapeHtml(bp.file) + '" data-line="' + bp.line + '">' +
              '<div class="var-left">' +
                '<input type="checkbox" class="bp-toggle" ' + (bp.enabled !== false ? 'checked' : '') + ' />' +
                '<span class="mono-loc" style="color: var(--fg-main);">' + escapeHtml(bp.fileName || bp.file) + ':' + bp.line + '</span>' +
                (bp.condition ? '<span class="cond-pill">if ' + escapeHtml(bp.condition) + '</span>' : '') +
              '</div>' +
              '<div class="var-right">' +
                '<span class="mono-loc" title="命中次数">×' + (bp.hitCount || 0) + '</span>' +
                '<button class="icon-action bp-cond-btn" title="设置条件断点">⚙ 条件</button>' +
                '<button class="icon-action bp-del-btn" title="删除断点">✕</button>' +
              '</div>' +
            '</div>'
          ).join('');

          el.bpContainer.querySelectorAll('.bp-item').forEach((row) => {
            const file = row.getAttribute('data-file');
            const line = Number(row.getAttribute('data-line'));
            row.addEventListener('click', (e) => {
              if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
              vscode.postMessage({ type: 'jumpToLine', file, line });
            });
            const checkbox = row.querySelector('.bp-toggle');
            if (checkbox) {
              checkbox.addEventListener('change', () => {
                vscode.postMessage({ type: 'toggleBreakpointEnabled', file, line, enabled: checkbox.checked });
              });
            }
            const condBtn = row.querySelector('.bp-cond-btn');
            if (condBtn) {
              condBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'promptBreakpointCondition', file, line });
              });
            }
            const delBtn = row.querySelector('.bp-del-btn');
            if (delBtn) {
              delBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'removeBreakpoint', file, line });
              });
            }
          });
        }

        // Registers
        const regs = Array.isArray(snap.registers) ? snap.registers : [];
        if (regs.length === 0) {
          el.registersContainer.innerHTML = '';
        } else {
          el.registersContainer.innerHTML = regs.map((r) =>
            '<div class="reg-cell">' +
              '<span class="reg-name">' + escapeHtml(r.name) + '</span>' +
              '<span class="reg-val">' + escapeHtml(r.value) + '</span>' +
            '</div>'
          ).join('');
        }
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'snapshot') {
          renderSnapshot(msg.snapshot);
        } else if (msg.type === 'sequencePage' && sequenceState && msg.requestId === sequenceRequest && sameContext(sequenceState.context, currentContext)) {
          const page = msg.page;
          sequenceMessage.textContent = sequenceState.scope === 'global' ? '只读；字符类型按字节索引。' : page.isChar ? '按字节索引；UTF-8 多字节字符会显示为多个字节。右击可插入或删除（仅支持 string 和 vector）。' : ((page.vectorOps || page.stringOps) ? '左键修改，右键删除或在两侧插入。' : '点击元素修改。');
          document.getElementById('sequenceRange').textContent = page.length ? (page.offset + 1) + '–' + (page.offset + page.items.length) + ' / ' + page.length : '空容器';
          prev.disabled = page.offset === 0; next.disabled = page.offset + page.items.length >= page.length;
          sequenceCells.innerHTML = page.items.map(item => '<button class="array-cell" data-index="' + item.index + '" data-value="' + escapeHtml(item.editValue) + '"' + ((page.vectorOps || page.stringOps) ? ' data-vector-index="' + item.index + '" data-vector-name="' + escapeHtml(page.name) + '" data-vector-char="' + (page.isChar ? '1' : '0') + '" title="右击：删除或插入"' : '') + (!page.editable && !(page.vectorOps || page.stringOps) ? ' disabled' : '') + '><span class="array-idx">[' + item.index + ']</span><span class="array-v">' + escapeHtml(item.value) + '</span></button>').join('');
          sequenceCells.querySelectorAll('[data-index]').forEach(btn => btn.addEventListener('click', () => { if (page.editable) editSequence(page.name, Number(btn.dataset.index), btn.dataset.value, page.isChar); }));
        } else if (msg.type === 'sequenceEdited' && sequenceState && msg.requestId === sequenceRequest) {
          const offset = msg.name === sequenceState.name && Number.isSafeInteger(msg.length) ? Math.min(sequenceState.offset, Math.max(0, msg.length - 1)) : sequenceState.offset;
          requestSequence(offset);
        } else if (msg.type === 'sequenceError' && sequenceState && msg.requestId === sequenceRequest) {
          sequenceMessage.textContent = msg.message;
        } else if (msg.type === 'consoleOutput') {
          el.gdbConsoleBox.textContent = (el.gdbConsoleBox.textContent + '\\n' + msg.text).slice(-1048576);
          el.gdbConsoleBox.scrollTop = el.gdbConsoleBox.scrollHeight;
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

module.exports = { getDashboardHtml };
