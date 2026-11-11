'use strict';
// Run in a disposable VS Code profile with the built VSIX installed.
const assert = require('assert');
const vscode = require('vscode');
exports.run = async () => {
  const ext = vscode.extensions.getExtension('wudream.dream-cpp-debuger');
  assert.ok(ext, 'built extension is installed');
  await ext.activate();
  const config = () => vscode.workspace.getConfiguration('dreamCppDebug');
  assert.strictEqual(config().inspect('interfaceMode').defaultValue, 'expert', 'setting registered by installed VSIX');
  await config().update('interfaceMode', undefined, vscode.ConfigurationTarget.Workspace);
  await config().update('interfaceMode', 'expert', vscode.ConfigurationTarget.Global);
  const pick = (next) => {
    setTimeout(async () => {
      if (next) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    }, 600);
    return vscode.commands.executeCommand('dream-cpp-debug.chooseUserMode');
  };
  await pick(false);
  assert.strictEqual(config().get('interfaceMode'), 'beginner', 'picker persists to user settings');
  await config().update('interfaceMode', 'beginner', vscode.ConfigurationTarget.Workspace);
  await pick(true);
  assert.strictEqual(config().inspect('interfaceMode').workspaceValue, 'expert', 'picker updates workspace override');
  await vscode.commands.executeCommand('dream-cpp-debug.openModeSettings');
  console.log('INSTALLED_VSCODE_MODE_PASS');
};
