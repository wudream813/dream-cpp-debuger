/**
 * Dream C++ Debugger — Modern Clean Sidebar Webview UI
 * Adaptive to VS Code Dark/Light themes with glassmorphic cards,
 * 1D array/vector visual strips, live variable editing, stdin/stdout panel,
 * conditional breakpoints, call stack switcher, and interactive GDB console.
 */
'use strict';

function getSidebarHtml(options = {}) {
  const nonce = options.nonce || 'dream-debug-nonce';
  const demoMode = Boolean(options.demoMode);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dream C++ Debugger</title>
  <style nonce="${nonce}">
    :root {
      --bg-base: var(--vscode-sideBar-background, #0f141f);
      --bg-card: var(--vscode-editorWidget-background, rgba(30, 41, 59, 0.52));
      --bg-elevated: var(--vscode-input-background, rgba(15, 23, 42, 0.68));
      --bg-hover: var(--vscode-list-hoverBackground, rgba(99, 102, 241, 0.12));
      --fg-main: var(--vscode-sideBar-foreground, #e2e8f0);
      --fg-muted: var(--vscode-descriptionForeground, #94a3b8);
      --border-color: var(--vscode-sideBarSectionHeader-border, rgba(148, 163, 184, 0.16));
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-glow: rgba(99, 102, 241, 0.24);
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
      --sky: #38bdf8;
      --violet: #a855f7;
      --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
      --font-mono: var(--vscode-editor-font-family, "JetBrains Mono", "Fira Code", Consolas, monospace);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-sans);
      font-size: 12.5px;
      line-height: 1.45;
      color: var(--fg-main);
      background: var(--bg-base);
      padding: 10px;
      user-select: none;
      overflow-x: hidden;
    }

    /* ── Top Hero / Target Status Card ── */
    .hero-card {
      background: linear-gradient(145deg, rgba(99, 102, 241, 0.13) 0%, rgba(16, 185, 129, 0.06) 100%), var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 11px 12px;
      margin-bottom: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    }

    .hero-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .brand-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #64748b;
      flex-shrink: 0;
      transition: all 0.25s ease;
    }
    .brand-dot.running {
      background: var(--emerald);
      box-shadow: 0 0 10px var(--emerald);
      animation: pulseDot 1.4s infinite;
    }
    .brand-dot.paused {
      background: var(--amber);
      box-shadow: 0 0 10px var(--amber);
    }
    .brand-dot.error {
      background: var(--rose);
      box-shadow: 0 0 10px var(--rose);
    }

    @keyframes pulseDot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.7; }
    }

    .file-title {
      font-weight: 600;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(100, 116, 139, 0.2);
      color: var(--fg-muted);
      white-space: nowrap;
      border: 1px solid rgba(148, 163, 184, 0.18);
    }
    .status-pill.paused {
      background: rgba(245, 158, 11, 0.16);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.35);
    }
    .status-pill.running {
      background: rgba(16, 185, 129, 0.16);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.35);
    }
    .status-pill.error {
      background: rgba(244, 63, 94, 0.16);
      color: #fb7185;
      border-color: rgba(244, 63, 94, 0.35);
    }

    .location-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-family: var(--font-mono);
      font-size: 11.5px;
      background: rgba(245, 158, 11, 0.11);
      border: 1px solid rgba(245, 158, 11, 0.28);
      color: #fcd34d;
      padding: 5px 8px;
      border-radius: 6px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    .location-banner.visible {
      display: flex;
    }

    .primary-actions {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      border: 1px solid var(--border-color);
      background: var(--bg-elevated);
      color: var(--fg-main);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 10px;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: rgba(99, 102, 241, 0.45);
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.15);
      font-weight: 600;
      box-shadow: 0 2px 10px var(--accent-glow);
    }
    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);
      border-color: rgba(255, 255, 255, 0.28);
    }

    /* ── Transport Step Controls Toolbar ── */
    .transport-bar {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 4px;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 9px;
      padding: 5px;
      margin-bottom: 10px;
    }

    .ctrl-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      padding: 5px 2px;
      border-radius: 6px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--fg-main);
      cursor: pointer;
      font-size: 10px;
      transition: all 0.14s ease;
    }
    .ctrl-btn svg {
      width: 15px;
      height: 15px;
    }
    .ctrl-btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: rgba(99, 102, 241, 0.3);
    }
    .ctrl-btn:disabled {
      opacity: 0.32;
      cursor: not-allowed;
    }
    .ctrl-btn.danger:hover:not(:disabled) {
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
      border-color: rgba(244, 63, 94, 0.35);
    }
    .ctrl-btn.continue-btn:not(:disabled) {
      color: var(--emerald);
    }

    /* ── Collapsible Section Cards ── */
    .section-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 9px;
      margin-bottom: 9px;
      overflow: hidden;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.015);
      border-bottom: 1px solid transparent;
      transition: background 0.15s ease;
    }
    .section-card.open .section-header {
      border-bottom-color: var(--border-color);
    }
    .section-header:hover {
      background: var(--bg-hover);
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 11.5px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--fg-main);
    }

    .chevron {
      font-size: 10px;
      color: var(--fg-muted);
      transition: transform 0.18s ease;
    }
    .section-card.open .chevron {
      transform: rotate(90deg);
    }

    .badge-count {
      font-family: var(--font-mono);
      font-size: 10.5px;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(99, 102, 241, 0.18);
      color: #a5b4fc;
    }

    .section-body {
      display: none;
      padding: 8px 10px;
    }
    .section-card.open .section-body {
      display: block;
    }

    /* ── Variables & Array Visualizer ── */
    .var-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .var-item {
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      border-radius: 7px;
      padding: 6px 8px;
      transition: all 0.2s ease;
    }
    .var-item.changed {
      border-color: rgba(245, 158, 11, 0.55);
      background: rgba(245, 158, 11, 0.08);
    }

    .var-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .var-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .var-name {
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--sky);
      font-size: 12px;
    }

    .var-type {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(148, 163, 184, 0.14);
      color: var(--fg-muted);
      white-space: nowrap;
    }

    .var-changed-tag {
      font-size: 9.5px;
      font-weight: 700;
      padding: 0 4px;
      border-radius: 3px;
      background: rgba(245, 158, 11, 0.22);
      color: #fbbf24;
    }

    .var-right {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }

    .var-val {
      font-family: var(--font-mono);
      font-size: 12px;
      color: #34d399;
      word-break: break-all;
      user-select: text;
    }
    .var-val.string { color: #fb923c; }
    .var-val.pointer { color: #c084fc; }

    .icon-action {
      background: transparent;
      border: none;
      color: var(--fg-muted);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 11px;
    }
    .icon-action:hover {
      color: var(--fg-main);
      background: rgba(255, 255, 255, 0.08);
    }

    /* 1D Visual Array Strip */
    .array-strip {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      margin-top: 6px;
      padding-bottom: 3px;
    }
    .array-cell {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 34px;
      border: 1px solid rgba(99, 102, 241, 0.28);
      border-radius: 5px;
      background: rgba(99, 102, 241, 0.08);
      padding: 2px 5px;
      font-family: var(--font-mono);
    }
    .array-idx {
      font-size: 9px;
      color: var(--fg-muted);
      border-bottom: 1px solid rgba(148, 163, 184, 0.15);
      width: 100%;
      text-align: center;
      margin-bottom: 1px;
    }
    .array-v {
      font-size: 11px;
      font-weight: 600;
      color: #e2e8f0;
    }

    /* ── Input Row (Watch / GDB Console / Stdin) ── */
    .input-row {
      display: flex;
      gap: 5px;
      margin-bottom: 7px;
    }
    .text-input, .textarea-input {
      width: 100%;
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      color: var(--fg-main);
      font-family: var(--font-mono);
      font-size: 11.5px;
      padding: 5px 8px;
      border-radius: 6px;
      outline: none;
    }
    .text-input:focus, .textarea-input:focus {
      border-color: var(--accent);
    }
    .textarea-input {
      min-height: 58px;
      resize: vertical;
      user-select: text;
    }

    /* ── Call Stack & Breakpoints ── */
    .stack-item, .bp-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 5px 7px;
      border-radius: 6px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      margin-bottom: 5px;
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .stack-item:hover, .bp-item:hover {
      border-color: rgba(99, 102, 241, 0.45);
      background: var(--bg-hover);
    }
    .stack-item.active {
      border-color: rgba(245, 158, 11, 0.55);
      background: rgba(245, 158, 11, 0.1);
    }

    .frame-badge {
      font-family: var(--font-mono);
      font-size: 10.5px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
    }

    .mono-loc {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--fg-muted);
    }

    .cond-pill {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(168, 85, 247, 0.18);
      color: #d8b4fe;
    }

    /* ── Output & Console Box ── */
    .output-box {
      font-family: var(--font-mono);
      font-size: 11.5px;
      background: rgba(9, 13, 22, 0.65);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 7px 8px;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      user-select: text;
      color: #cbd5e1;
    }

    .reg-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
      margin-top: 6px;
    }
    .reg-cell {
      display: flex;
      justify-content: space-between;
      background: var(--bg-elevated);
      border: 1px solid var(--border-color);
      padding: 3px 6px;
      border-radius: 5px;
      font-family: var(--font-mono);
      font-size: 11px;
    }
    .reg-name { color: var(--violet); font-weight: 600; }
    .reg-val { color: var(--fg-main); }

    .empty-hint {
      font-size: 11.5px;
      color: var(--fg-muted);
      text-align: center;
      padding: 8px 4px;
    }

    .sub-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--fg-muted);
      margin-bottom: 4px;
      font-weight: 500;
    }

    .diag-item {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 5px 7px;
      border-radius: 6px;
      background: rgba(244, 63, 94, 0.12);
      border: 1px solid rgba(244, 63, 94, 0.35);
      color: #fda4af;
      margin-bottom: 5px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <!-- 1. Hero Target & Status Header -->
  <div class="hero-card">
    <div class="hero-top">
      <div class="brand-row">
        <span id="statusDot" class="brand-dot"></span>
        <span id="targetFileName" class="file-title">未选择 C/C++ 文件</span>
      </div>
      <span id="statusPill" class="status-pill">就绪 Ready</span>
    </div>

    <div id="locationBanner" class="location-banner" title="点击跳转到当前断点位置">
      <span id="locationText">▶ main() · line 1</span>
      <span>跳转 ↗</span>
    </div>

    <div id="compileDiagnostics"></div>

    <div class="primary-actions">
      <button id="btnStartDebug" class="btn btn-primary" title="自动使用 g++ -g 编译并启动 GDB 调试 (Ctrl+Shift+F5)">
        <span>▶ 编译并 GDB 调试</span>
      </button>
      <button id="btnQuickRun" class="btn" title="快速编译并带入下方 stdin 运行">
        <span>⚡ 运行</span>
      </button>
    </div>
  </div>

  <!-- 2. Transport Step Controls -->
  <div class="transport-bar">
    <button id="btnContinue" class="ctrl-btn continue-btn" disabled title="继续运行 Continue (F5)">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 3v10l9-5-9-5z"/></svg>
      <span>继续</span>
    </button>
    <button id="btnStepOver" class="ctrl-btn" disabled title="单步跳过 Step Over (F10)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 10a5 5 0 0 1 10 0"/><polyline points="11 7 13.5 10 10.5 11"/><circle cx="8" cy="12" r="1.5" fill="currentColor"/></svg>
      <span>跳过</span>
    </button>
    <button id="btnStepInto" class="ctrl-btn" disabled title="单步进入 Step Into (F11)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="8" y1="2" x2="8" y2="10"/><polyline points="5 7.5 8 10.5 11 7.5"/><circle cx="8" cy="13.5" r="1.5" fill="currentColor"/></svg>
      <span>进入</span>
    </button>
    <button id="btnStepOut" class="ctrl-btn" disabled title="单步跳出 Step Out (Shift+F11)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="8" y1="10" x2="8" y2="2"/><polyline points="5 5 8 2 11 5"/><circle cx="8" cy="13.5" r="1.5" fill="currentColor"/></svg>
      <span>跳出</span>
    </button>
    <button id="btnRestart" class="ctrl-btn" disabled title="重新编译并调试 Restart">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13 8a5 5 0 1 1-1.4-3.5"/><polyline points="13 2 13 5.5 9.5 5.5"/></svg>
      <span>重启</span>
    </button>
    <button id="btnStop" class="ctrl-btn danger" disabled title="停止调试 Stop (Shift+F5)">
      <svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>
      <span>停止</span>
    </button>
  </div>

  <!-- 3. Local Variables & Array Visualizer -->
  <div class="section-card open" data-section="locals">
    <div class="section-header">
      <div class="section-title">
        <span class="chevron">▶</span>
        <span>局部变量 & 数组可视化</span>
      </div>
      <span id="localsCount" class="badge-count">0</span>
    </div>
    <div class="section-body">
      <div id="localsContainer" class="var-list">
        <div class="empty-hint">启动调试并在断点暂停后，此处实时展示变量与 STL/数组图形化视图</div>
      </div>
    </div>
  </div>

  <!-- 4. Watch Expressions -->
  <div class="section-card open" data-section="watches">
    <div class="section-header">
      <div class="section-title">
        <span class="chevron">▶</span>
        <span>监视表达式 (Watch)</span>
      </div>
      <span id="watchesCount" class="badge-count">0</span>
    </div>
    <div class="section-body">
      <div class="input-row">
        <input id="watchInput" class="text-input" type="text" placeholder="添加表达式，如 dp[i]、arr@8、v.size()..." />
        <button id="btnAddWatch" class="btn" style="padding: 4px 9px;">＋</button>
      </div>
      <div id="watchesContainer" class="var-list">
        <div class="empty-hint">暂无监视表达式</div>
      </div>
    </div>
  </div>

  <!-- 5. Standard Input (stdin) & Program Output (stdout) -->
  <div class="section-card open" data-section="io">
    <div class="section-header">
      <div class="section-title">
        <span class="chevron">▶</span>
        <span>程序输入 / 输出 (stdin & stdout)</span>
      </div>
      <span id="ioBadge" class="badge-count">I/O</span>
    </div>
    <div class="section-body">
      <div class="sub-label">
        <span>测试输入 (stdin 自动注入 cin/scanf)</span>
        <button id="btnClearStdin" class="icon-action" title="清空输入">清空</button>
      </div>
      <textarea id="stdinTextarea" class="textarea-input" placeholder="在此粘贴测试样例输入（支持多行），启动调试或运行时自动重定向到 stdin..."></textarea>

      <div class="sub-label" style="margin-top: 8px;">
        <span>程序输出 (stdout / stderr)</span>
        <button id="btnClearStdout" class="icon-action" title="清空输出">清空</button>
      </div>
      <div id="programOutputBox" class="output-box">暂无程序输出</div>
    </div>
  </div>

  <!-- 6. Call Stack -->
  <div class="section-card open" data-section="stack">
    <div class="section-header">
      <div class="section-title">
        <span class="chevron">▶</span>
        <span>调用栈 (Call Stack)</span>
      </div>
      <span id="stackCount" class="badge-count">0</span>
    </div>
    <div class="section-body">
      <div id="stackContainer">
        <div class="empty-hint">暂无活动调用栈</div>
      </div>
    </div>
  </div>

  <!-- 7. Breakpoints & Conditional Breakpoints -->
  <div class="section-card open" data-section="breakpoints">
    <div class="section-header">
      <div class="section-title">
        <span class="chevron">▶</span>
        <span>断点管理 (支持条件断点)</span>
      </div>
      <span id="bpCount" class="badge-count">0</span>
    </div>
    <div class="section-body">
      <div id="bpContainer">
        <div class="empty-hint">在代码行号左侧点击或按 F9 即可添加断点</div>
      </div>
    </div>
  </div>

  <!-- 8. GDB Console & CPU Registers -->
  <div class="section-card" data-section="console">
    <div class="section-header">
      <div class="section-title">
        <span class="chevron">▶</span>
        <span>GDB 命令台 & CPU 寄存器</span>
      </div>
      <span class="badge-count">MI2</span>
    </div>
    <div class="section-body">
      <div class="input-row">
        <input id="gdbCmdInput" class="text-input" type="text" placeholder="输入 GDB 命令，如 p x、x/8xw &arr、bt..." />
        <button id="btnSendGdb" class="btn" style="padding: 4px 9px;">发送</button>
      </div>
      <div id="gdbConsoleBox" class="output-box" style="max-height: 120px;">[Dream GDB] 准备就绪。</div>
      <div class="sub-label" style="margin-top: 8px;">
        <span>CPU 寄存器 (Registers)</span>
      </div>
      <div id="registersContainer" class="reg-grid"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = typeof acquireVsCodeApi === 'function'
        ? acquireVsCodeApi()
        : {
            postMessage: (msg) => {
              if (window.__dreamDemoHandler) window.__dreamDemoHandler(msg);
            }
          };

      const DEMO_MODE = ${demoMode ? 'true' : 'false'};

      // Collapsible card headers
      document.querySelectorAll('.section-header').forEach((header) => {
        header.addEventListener('click', () => {
          header.parentElement.classList.toggle('open');
        });
      });

      const el = {
        statusDot: document.getElementById('statusDot'),
        targetFileName: document.getElementById('targetFileName'),
        statusPill: document.getElementById('statusPill'),
        locationBanner: document.getElementById('locationBanner'),
        locationText: document.getElementById('locationText'),
        compileDiagnostics: document.getElementById('compileDiagnostics'),
        btnStartDebug: document.getElementById('btnStartDebug'),
        btnQuickRun: document.getElementById('btnQuickRun'),
        btnContinue: document.getElementById('btnContinue'),
        btnStepOver: document.getElementById('btnStepOver'),
        btnStepInto: document.getElementById('btnStepInto'),
        btnStepOut: document.getElementById('btnStepOut'),
        btnRestart: document.getElementById('btnRestart'),
        btnStop: document.getElementById('btnStop'),
        localsCount: document.getElementById('localsCount'),
        localsContainer: document.getElementById('localsContainer'),
        watchesCount: document.getElementById('watchesCount'),
        watchInput: document.getElementById('watchInput'),
        btnAddWatch: document.getElementById('btnAddWatch'),
        watchesContainer: document.getElementById('watchesContainer'),
        stdinTextarea: document.getElementById('stdinTextarea'),
        btnClearStdin: document.getElementById('btnClearStdin'),
        btnClearStdout: document.getElementById('btnClearStdout'),
        programOutputBox: document.getElementById('programOutputBox'),
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

      // Action buttons
      el.btnStartDebug.addEventListener('click', () => {
        vscode.postMessage({ type: 'startDebug', stdin: el.stdinTextarea.value });
      });

      el.btnQuickRun.addEventListener('click', () => {
        vscode.postMessage({ type: 'compileAndRun', stdin: el.stdinTextarea.value });
      });

      el.btnContinue.addEventListener('click', () => vscode.postMessage({ type: 'continue' }));
      el.btnStepOver.addEventListener('click', () => vscode.postMessage({ type: 'stepOver' }));
      el.btnStepInto.addEventListener('click', () => vscode.postMessage({ type: 'stepInto' }));
      el.btnStepOut.addEventListener('click', () => vscode.postMessage({ type: 'stepOut' }));
      el.btnRestart.addEventListener('click', () => {
        vscode.postMessage({ type: 'restart', stdin: el.stdinTextarea.value });
      });
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

      // Stdin sync
      el.stdinTextarea.addEventListener('input', () => {
        vscode.postMessage({ type: 'updateStdin', stdin: el.stdinTextarea.value });
      });
      el.btnClearStdin.addEventListener('click', () => {
        el.stdinTextarea.value = '';
        vscode.postMessage({ type: 'updateStdin', stdin: '' });
      });
      el.btnClearStdout.addEventListener('click', () => {
        el.programOutputBox.textContent = '';
      });

      // Watch input
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

      // GDB Console input
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
        const valClass = v.kind === 'string' ? 'string' : v.kind === 'pointer' ? 'pointer' : '';
        let arrayHtml = '';
        if (Array.isArray(v.elements) && v.elements.length > 0 && v.kind === 'array') {
          const cells = v.elements.slice(0, 16).map((item, idx) =>
            '<div class="array-cell">' +
              '<span class="array-idx">[' + idx + ']</span>' +
              '<span class="array-v">' + escapeHtml(item) + '</span>' +
            '</div>'
          ).join('');
          arrayHtml = '<div class="array-strip">' + cells + '</div>';
        }

        const actionBtn = options.isWatch
          ? '<button class="icon-action" data-remove-watch="' + escapeHtml(v.id || v.expr) + '" title="移除监视">✕</button>'
          : '<button class="icon-action" data-edit-var="' + escapeHtml(v.name) + '" data-cur-val="' + escapeHtml(v.displayValue) + '" title="修改变量值">✎</button>';

        return (
          '<div class="var-item ' + (v.changed ? 'changed' : '') + '">' +
            '<div class="var-main">' +
              '<div class="var-left">' +
                '<span class="var-name">' + escapeHtml(v.name || v.expr) + '</span>' +
                (v.type ? '<span class="var-type">' + escapeHtml(v.type) + '</span>' : '') +
                (v.changed ? '<span class="var-changed-tag">已更新</span>' : '') +
              '</div>' +
              '<div class="var-right">' +
                '<span class="var-val ' + valClass + '">' + escapeHtml(v.displayValue ?? v.value) + '</span>' +
                actionBtn +
              '</div>' +
            '</div>' +
            arrayHtml +
          '</div>'
        );
      }

      function renderSnapshot(snap) {
        if (!snap) return;
        const state = snap.state || 'idle';
        const isPaused = state === 'paused';
        const isRunning = state === 'running' || state === 'starting';
        const isActive = isPaused || isRunning;

        // Update hero status
        el.statusDot.className = 'brand-dot ' + (isPaused ? 'paused' : isRunning ? 'running' : state === 'error' ? 'error' : '');
        el.statusPill.className = 'status-pill ' + (isPaused ? 'paused' : isRunning ? 'running' : state === 'error' ? 'error' : '');

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
          el.targetFileName.textContent = fname;
        }

        // Location banner
        currentLocation = snap.location || null;
        if (isPaused && currentLocation) {
          el.locationBanner.classList.add('visible');
          el.locationText.textContent = '▶ ' + (currentLocation.func || 'main') + '() · 第 ' + (currentLocation.line || 1) + ' 行';
        } else {
          el.locationBanner.classList.remove('visible');
        }

        // Transport buttons
        el.btnContinue.disabled = !isPaused;
        el.btnStepOver.disabled = !isPaused;
        el.btnStepInto.disabled = !isPaused;
        el.btnStepOut.disabled = !isPaused;
        el.btnRestart.disabled = !isActive;
        el.btnStop.disabled = !isActive;

        // Locals
        const locals = Array.isArray(snap.locals) ? snap.locals : [];
        el.localsCount.textContent = String(locals.length);
        if (locals.length === 0) {
          el.localsContainer.innerHTML = '<div class="empty-hint">' +
            (isPaused ? '当前栈帧无局部变量' : '启动调试并在断点暂停后展示局部变量与数组视图') +
          '</div>';
        } else {
          el.localsContainer.innerHTML = locals.map((v) => renderVariableCard(v, { isWatch: false })).join('');
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

        // Watches
        const watches = Array.isArray(snap.watches) ? snap.watches : [];
        el.watchesCount.textContent = String(watches.length);
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
              elements: w.elements
            }, { isWatch: true })
          ).join('');
          el.watchesContainer.querySelectorAll('[data-remove-watch]').forEach((btn) => {
            btn.addEventListener('click', () => {
              vscode.postMessage({
                type: 'removeWatch',
                id: btn.getAttribute('data-remove-watch')
              });
            });
          });
        }

        // Program Output
        if (typeof snap.programOutput === 'string' && snap.programOutput.length > 0) {
          el.programOutputBox.textContent = snap.programOutput;
          el.programOutputBox.scrollTop = el.programOutputBox.scrollHeight;
        } else if (state === 'starting') {
          el.programOutputBox.textContent = '等待程序输出...';
        }

        // Call Stack
        const stack = Array.isArray(snap.stack) ? snap.stack : [];
        el.stackCount.textContent = String(stack.length);
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
        el.bpCount.textContent = String(bps.length);
        if (bps.length === 0) {
          el.bpContainer.innerHTML = '<div class="empty-hint">在代码行号左侧点击或按 F9 即可添加断点</div>';
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
                '<button class="icon-action bp-cond-btn" title="设置条件断点">⚙</button>' +
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
          el.registersContainer.innerHTML = '<div class="empty-hint" style="grid-column: span 2;">暂停时显示通用寄存器</div>';
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
        } else if (msg.type === 'consoleOutput') {
          el.gdbConsoleBox.textContent += '\\n' + msg.text;
          el.gdbConsoleBox.scrollTop = el.gdbConsoleBox.scrollHeight;
        } else if (msg.type === 'compileDiagnostics') {
          const diags = Array.isArray(msg.diagnostics) ? msg.diagnostics : [];
          if (diags.length === 0) {
            el.compileDiagnostics.innerHTML = '';
          } else {
            el.compileDiagnostics.innerHTML = diags.map((d) =>
              '<div class="diag-item" data-file="' + escapeHtml(d.file) + '" data-line="' + d.line + '">' +
                '✖ 第 ' + d.line + ' 行: ' + escapeHtml(d.message) +
              '</div>'
            ).join('');
            el.compileDiagnostics.querySelectorAll('.diag-item').forEach((item) => {
              item.addEventListener('click', () => {
                vscode.postMessage({
                  type: 'jumpToLine',
                  file: item.getAttribute('data-file'),
                  line: Number(item.getAttribute('data-line'))
                });
              });
            });
          }
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

module.exports = { getSidebarHtml };
