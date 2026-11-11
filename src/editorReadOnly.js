'use strict';

// VS Code exposes only active-editor read-only commands (no resource argument or
// API for reading a pre-existing session override). Never alter disk permissions.
class EditorReadOnly {
  constructor(vscode) {
    this.vscode = vscode;
    this.enabled = false;
    this.locked = new Map();
    this.pending = Promise.resolve();
    this.cleaning = false;
  }

  isSource(editor) {
    const doc = editor && editor.document;
    return !!(doc && doc.uri && doc.uri.scheme === 'file' &&
      (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(doc.fileName) || ['c', 'cpp'].includes(doc.languageId)));
  }

  enqueue(task) {
    const next = this.pending.catch(() => {}).then(task);
    this.pending = next.catch(err => {
      this.vscode.window.showWarningMessage('无法切换编辑器只读状态：' + err.message);
    });
    return next;
  }

  async applyActive() {
    const editor = this.vscode.window.activeTextEditor;
    if (!this.isSource(editor)) return;
    const key = editor.document.uri.toString();
    if (this.enabled && !this.locked.has(key)) {
      await this.vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
      this.locked.set(key, { uri: editor.document.uri, viewColumn: editor.viewColumn });
    } else if (!this.enabled && this.locked.has(key)) {
      await this.vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
      this.locked.delete(key);
    }
  }

  enable() { this.enabled = true; return this.enqueue(() => this.applyActive()); }
  onActiveEditorChanged() {
    if (!this.cleaning) return this.enqueue(() => this.applyActive());
    return this.pending;
  }
  disable() {
    this.enabled = false;
    return this.enqueue(async () => {
      if (this.enabled) return;
      this.cleaning = true;
      const original = this.vscode.window.activeTextEditor;
      try {
        for (const [key, entry] of Array.from(this.locked)) {
          if (this.enabled) break;
          let current = this.vscode.window.activeTextEditor;
          if (!current || current.document.uri.toString() !== key) {
            try {
              const doc = await this.vscode.workspace.openTextDocument(entry.uri);
              current = await this.vscode.window.showTextDocument(doc, { viewColumn: entry.viewColumn, preview: false });
            } catch (_) { continue; }
          }
          // Do not reset an unrelated file if focus changed during the await.
          if (!this.enabled && this.vscode.window.activeTextEditor && this.vscode.window.activeTextEditor.document.uri.toString() === key) {
            await this.vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
            this.locked.delete(key);
          }
        }
        if (!this.enabled && original && this.vscode.window.activeTextEditor !== original) {
          await this.vscode.window.showTextDocument(original.document, { viewColumn: original.viewColumn, preview: false });
        }
      } finally { this.cleaning = false; }
      if (this.enabled) await this.applyActive();
    });
  }
}
module.exports = { EditorReadOnly };
