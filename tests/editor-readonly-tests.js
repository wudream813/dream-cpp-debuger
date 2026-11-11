'use strict';
const assert = require('assert');
const { EditorReadOnly } = require('../src/editorReadOnly');
async function testEditorReadOnly() {
  const calls = [], marks = new Map();
  const editor = (name, languageId = 'cpp') => ({ viewColumn: 1, document: {
    fileName: name, languageId, uri: { scheme: 'file', toString: () => 'file://' + name }
  } });
  const one = editor('/src/a.cpp'), two = editor('/src/a.hpp'), unrelated = editor('/notes.txt', 'plaintext');
  const docs = new Map([one, two, unrelated].map(e => [e.document.uri.toString(), e]));
  const vscode = {
    window: {
      activeTextEditor: one,
      showWarningMessage: m => { throw Error(m); },
      async showTextDocument(doc) { this.activeTextEditor = docs.get(doc.uri.toString()); return this.activeTextEditor; }
    },
    workspace: { async openTextDocument(uri) { return docs.get(uri.toString()).document; } },
    commands: { async executeCommand(command) {
      const key = vscode.window.activeTextEditor.document.uri.toString(); calls.push([command, key]);
      if (command.includes('setActiveEditorReadonly')) marks.set(key, true);
      if (command.includes('resetActiveEditorReadonly')) marks.delete(key);
    } }
  };
  const lock = new EditorReadOnly(vscode);
  await lock.enable();
  assert.strictEqual(marks.get(one.document.uri.toString()), true);
  vscode.window.activeTextEditor = two; await lock.onActiveEditorChanged();
  assert.strictEqual(marks.get(two.document.uri.toString()), true);
  vscode.window.activeTextEditor = unrelated; await lock.onActiveEditorChanged();
  assert.strictEqual(marks.has(unrelated.document.uri.toString()), false);
  await lock.disable();
  assert.strictEqual(marks.size, 0);
  assert.strictEqual(vscode.window.activeTextEditor, unrelated);
  assert.strictEqual(lock.locked.size, 0);
  assert.ok(calls.every(([cmd]) => !/Writeable/.test(cmd)), 'reset must preserve config-based read-only rules');
  vscode.window.activeTextEditor = one;
  await lock.enable(); await lock.disable();
  assert.strictEqual(marks.size, 0);
  // A new debug session supersedes a queued cleanup.
  await lock.enable();
  const ending = lock.disable();
  const starting = lock.enable();
  await Promise.all([ending, starting]);
  assert.strictEqual(lock.enabled, true);
  assert.strictEqual(marks.get(one.document.uri.toString()), true);
  await lock.disable();
  assert.strictEqual(marks.size, 0);
}
module.exports = { testEditorReadOnly };
