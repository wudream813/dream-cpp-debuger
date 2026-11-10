/**
 * Dream C++ Debugger — Streamlined Left Sidebar Webview UI
 * Left sidebar focuses exclusively on:
 *   1. One-click Compile & GDB Debug / Quick Compile & Run
 *   2. Standard Input (stdin) preset & live Program Output (stdout / stderr)
 * All variables, watches, call stack, breakpoints, and GDB console live in the
 * right-side Debug Dashboard Panel (opened automatically in ViewColumn.Beside).
 */
'use strict';

function getSidebarHtml(options = {}) {
  const nonce = options.nonce || 'dream-debug-nonce';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dream C++ Sidebar</title>
  <style nonce="${nonce}">
    /* ── Dark Theme High-Contrast Palette ── */
    :root,
    body.vscode-dark,
    body.vscode-high-contrast {
      --bg-base: #121620;
      --bg-card: #1b2232;
      --bg-card-header: #232c40;
      --bg-input: #0d111a;
      --bg-hover: #2a354d;

      --fg-main: #f8fafc;
      --fg-muted: #cbd5e1;

      --border-strong: #475569;
      --border-subtle: #334155;
      --border-focus: #6366f1;

      --accent: #4f46e5;
      --accent-hover: #4338ca;
      --run-bg: #059669;
      --run-hover: #047857;

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

      --warn-bg: rgba(217, 119, 6, 0.22);
      --warn-border: #f59e0b;
      --warn-fg: #fde68a;

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
      --bg-input: #ffffff;
      --bg-hover: #dbeafe;

      --fg-main: #0f172a;
      --fg-muted: #334155;

      --border-strong: #94a3b8;
      --border-subtle: #cbd5e1;
      --border-focus: #4f46e5;

      --accent: #4f46e5;
      --accent-hover: #3730a3;
      --run-bg: #059669;
      --run-hover: #047857;

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

      --warn-bg: #fef3c7;
      --warn-border: #d97706;
      --warn-fg: #78350f;

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
      padding: 10px;
      user-select: none;
    }

    .card {
      background: var(--bg-card);
      border: 1.5px solid var(--border-strong);
      border-radius: 10px;
      margin-bottom: 12px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.14);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 12px;
      background: var(--bg-card-header);
      border-bottom: 1.5px solid var(--border-strong);
      font-weight: 700;
      font-size: 12.5px;
    }

    .card-body {
      padding: 11px 12px;
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #64748b;
      border: 1.5px solid rgba(255, 255, 255, 0.45);
      flex-shrink: 0;
    }
    .brand-dot.running {
      background: #10b981;
      box-shadow: 0 0 10px #10b981;
    }
    .brand-dot.paused {
      background: #f59e0b;
      box-shadow: 0 0 10px #f59e0b;
    }
    .brand-dot.error {
      background: #f43f5e;
      box-shadow: 0 0 10px #f43f5e;
    }

    .file-title {
      font-weight: 700;
      font-size: 13.5px;
      color: var(--fg-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-pill {
      font-size: 11.5px;
      font-weight: 700;
      padding: 2px 9px;
      border-radius: 999px;
      background: var(--bg-base);
      color: var(--fg-main);
      border: 1px solid var(--border-strong);
      white-space: nowrap;
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
    .status-pill.error {
      background: var(--error-bg);
      color: var(--error-fg);
      border-color: var(--error-border);
    }

    .btn-stack {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .btn-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1.5px solid var(--border-strong);
      background: var(--bg-card-header);
      color: var(--fg-main);
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 700;
      padding: 8px 11px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:hover:not(:disabled) {
      background: var(--bg-hover);
      border-color: var(--border-focus);
    }
    .btn-primary {
      background: var(--accent);
      color: #ffffff;
      border-color: #818cf8;
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }
    .btn-run {
      background: var(--run-bg);
      color: #ffffff;
      border-color: #34d399;
    }
    .btn-run:hover:not(:disabled) {
      background: var(--run-hover);
    }

    .small-action {
      background: var(--bg-base);
      border: 1px solid var(--border-strong);
      color: var(--fg-main);
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
    }
    .small-action:hover {
      background: var(--bg-hover);
      border-color: var(--border-focus);
    }

    .textarea-input {
      width: 100%;
      min-height: 145px;
      background: var(--bg-input);
      border: 1.5px solid var(--border-strong);
      color: var(--fg-main);
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.45;
      padding: 8px 10px;
      border-radius: 7px;
      resize: vertical;
      outline: none;
      user-select: text;
    }
    .textarea-input::placeholder {
      color: var(--fg-muted);
      opacity: 0.85;
    }
    .textarea-input:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
    }

    .output-box {
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.45;
      font-weight: 500;
      background: var(--output-bg);
      border: 1.5px solid var(--border-strong);
      border-radius: 7px;
      padding: 9px 10px;
      min-height: 140px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      user-select: text;
      color: var(--output-fg);
    }

    /* ── Compile Error (CE) vs Warning Banners ── */
    .diag-group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11.5px;
      font-weight: 700;
      margin-bottom: 5px;
    }
    .diag-item {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 600;
      padding: 6px 8px;
      border-radius: 6px;
      margin-bottom: 6px;
      cursor: pointer;
    }
    .diag-item.diag-error {
      background: var(--error-bg);
      border: 1.5px solid var(--error-border);
      color: var(--error-fg);
    }
    .diag-item.diag-warning {
      background: var(--warn-bg);
      border: 1.5px solid var(--warn-border);
      color: var(--warn-fg);
    }
    .diag-item.diag-info {
      background: var(--bg-input);
      border: 1.5px solid var(--border-strong);
      color: var(--fg-main);
    }
  </style>
</head>
<body>
  <!-- 1. Compile & Run Card -->
  <div class="card">
    <div class="card-header">
      <div class="brand-row">
        <span id="statusDot" class="brand-dot"></span>
        <span id="targetFileName" class="file-title">未选择 C/C++ 文件</span>
      </div>
      <span id="statusPill" class="status-pill">就绪 Ready</span>
    </div>
    <div class="card-body">
      <div id="compileDiagnostics"></div>

      <div class="btn-stack">
        <button id="btnStartDebug" class="btn btn-primary" title="编译并在当前窗格右半边打开 GDB 调试面板 (Ctrl+Shift+F5)">
          <span>🐞 编译并开始 GDB 调试 (右侧展开)</span>
        </button>
        <div class="btn-row">
          <button id="btnQuickRun" class="btn btn-run" title="快速编译并带入下方 stdin 直接运行">
            <span>⚡ 编译运行</span>
          </button>
          <button id="btnOpenDashboard" class="btn" title="在当前窗格右半边打开调试工作台页面">
            <span>🖥 右侧调试台</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. Standard Input (stdin) Card -->
  <div class="card">
    <div class="card-header">
      <span>📥 标准输入 (stdin)</span>
      <button id="btnClearStdin" class="small-action" title="清空输入数据">清空</button>
    </div>
    <div class="card-body">
      <textarea id="stdinTextarea" class="textarea-input" placeholder="在此粘贴测试输入样例（支持多行），点击上方「编译并调试」或「编译运行」时将自动注入 cin / scanf..."></textarea>
    </div>
  </div>

  <!-- 3. Program Output (stdout / stderr) Card -->
  <div class="card">
    <div class="card-header">
      <span>📤 程序输出 (stdout / stderr)</span>
      <div style="display:flex;gap:5px;">
        <button id="btnCopyStdout" class="small-action" title="复制输出结果">复制</button>
        <button id="btnClearStdout" class="small-action" title="清空输出">清空</button>
      </div>
    </div>
    <div class="card-body">
      <div id="programOutputBox" class="output-box">暂无程序输出</div>
    </div>
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
        compileDiagnostics: document.getElementById('compileDiagnostics'),
        btnStartDebug: document.getElementById('btnStartDebug'),
        btnQuickRun: document.getElementById('btnQuickRun'),
        btnOpenDashboard: document.getElementById('btnOpenDashboard'),
        stdinTextarea: document.getElementById('stdinTextarea'),
        btnClearStdin: document.getElementById('btnClearStdin'),
        btnCopyStdout: document.getElementById('btnCopyStdout'),
        btnClearStdout: document.getElementById('btnClearStdout'),
        programOutputBox: document.getElementById('programOutputBox')
      };

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      el.btnStartDebug.addEventListener('click', () => {
        vscode.postMessage({ type: 'startDebug', stdin: el.stdinTextarea.value });
      });

      el.btnQuickRun.addEventListener('click', () => {
        vscode.postMessage({ type: 'compileAndRun', stdin: el.stdinTextarea.value });
      });

      el.btnOpenDashboard.addEventListener('click', () => {
        vscode.postMessage({ type: 'openDashboard' });
      });

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

      el.btnCopyStdout.addEventListener('click', () => {
        if (navigator.clipboard && el.programOutputBox.textContent) {
          navigator.clipboard.writeText(el.programOutputBox.textContent);
        }
      });

      function renderDiagnostics(diags, compileSuccess) {
        if (!Array.isArray(diags) || diags.length === 0) {
          el.compileDiagnostics.innerHTML = '';
          return;
        }

        const errors = diags.filter((d) => d.severity === 'error');
        const warnings = diags.filter((d) => d.severity === 'warning');

        let html = '';
        if (errors.length > 0) {
          html += '<div class="diag-group-header" style="color: var(--error-border);">' +
            '<span>✖ 编译错误 (CE · ' + errors.length + ')</span>' +
            '<button class="small-action" id="btnDismissDiags">✕</button>' +
          '</div>';
          html += errors.map((d) =>
            '<div class="diag-item diag-error" data-file="' + escapeHtml(d.file) + '" data-line="' + d.line + '">' +
              '✖ [错误] 第 ' + d.line + ' 行: ' + escapeHtml(d.message) +
            '</div>'
          ).join('');
        }

        if (warnings.length > 0) {
          html += '<div class="diag-group-header" style="color: var(--warn-border);">' +
            '<span>⚠ 编译警告 (' + warnings.length + ' 条' + (compileSuccess !== false ? ' · 不影响调试' : '') + ')</span>' +
            (errors.length === 0 ? '<button class="small-action" id="btnDismissDiags">✕</button>' : '') +
          '</div>';
          html += warnings.map((d) =>
            '<div class="diag-item diag-warning" data-file="' + escapeHtml(d.file) + '" data-line="' + d.line + '">' +
              '⚠ [警告] 第 ' + d.line + ' 行: ' + escapeHtml(d.message) +
            '</div>'
          ).join('');
        }

        el.compileDiagnostics.innerHTML = html;

        const dismissBtn = document.getElementById('btnDismissDiags');
        if (dismissBtn) {
          dismissBtn.addEventListener('click', () => {
            el.compileDiagnostics.innerHTML = '';
          });
        }

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

      function renderSnapshot(snap) {
        if (!snap) return;
        const state = snap.state || 'idle';
        const isPaused = state === 'paused';
        const isRunning = state === 'running' || state === 'starting';

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

        if (typeof snap.stdinText === 'string' && document.activeElement !== el.stdinTextarea) {
          el.stdinTextarea.value = snap.stdinText;
        }

        if (typeof snap.programOutput === 'string' && snap.programOutput.length > 0) {
          el.programOutputBox.textContent = snap.programOutput;
          el.programOutputBox.scrollTop = el.programOutputBox.scrollHeight;
        } else if (state === 'starting') {
          el.programOutputBox.textContent = '等待程序输出...';
        }
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'snapshot') {
          renderSnapshot(msg.snapshot);
        } else if (msg.type === 'compileDiagnostics') {
          renderDiagnostics(msg.diagnostics, msg.success);
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

module.exports = { getSidebarHtml };
