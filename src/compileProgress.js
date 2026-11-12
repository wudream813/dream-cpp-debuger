'use strict';
// DAP uses a separate launch lifecycle from the sidebar controller.
async function withCompileNotification(vscode, source, options, build) {
  const abort = new AbortController();
  const parent = options.signal;
  const parentAbort = () => abort.abort();
  if (parent) parent.addEventListener('abort', parentAbort, { once: true });
  if (parent?.aborted) abort.abort();
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在编译...', cancellable: true }, async (_progress, token) => {
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        if (abort.signal.aborted) return { success: false, cancelled: true };
        const result = await build(source, { ...options, signal: abort.signal });
        if (abort.signal.aborted) {
          if (typeof result?.cleanupBuild === 'function') result.cleanupBuild();
          return { success: false, cancelled: true };
        }
        return result;
      } finally { sub.dispose(); }
    });
  } finally { if (parent) parent.removeEventListener('abort', parentAbort); }
}
module.exports = { withCompileNotification };
