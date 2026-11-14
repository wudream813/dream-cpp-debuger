'use strict';
const path = require('path');
const os = require('os');

// Match the compiler's first-50-lines comment-only header format.
function parseHeader(text) {
  const keys = { inputfile: 'inputFile', outputfile: 'outputFile', unfileinputfile: 'reverseInput', unfileoutputfile: 'reverseOutput', usefileredirect: 'fileIO', useunfileredirect: 'reverseIO', customvariable: 'customVariable', workdir: 'workDir' };
  const config = {}; let block = false;
  for (const line of String(text).split('\n').slice(0, 50)) {
    let body, end;
    if (block) { end = line.indexOf('*/'); body = line.slice(0, end < 0 ? line.length : end); if (end >= 0) block = false; }
    else {
      const m = /^[ \t]*(\/\/|\/\*)/.exec(line); if (!m) continue;
      end = m[1] === '/*' ? line.indexOf('*/', m[0].length) : -1;
      body = line.slice(m[0].length, end < 0 ? line.length : end);
      if (m[1] === '/*' && end < 0) block = true;
    }
    const colon = body.indexOf(':'); if (colon < 0) continue;
    const pre = body.slice(0, colon); const keyMatch = /([A-Za-z]+)[^A-Za-z]*$/.exec(pre);
    if (!keyMatch) continue;
    const index = keyMatch.index;
    if (index > 0 && /[0-9_]/.test(pre[index - 1])) continue;
    const lower = keyMatch[1].toLowerCase(); if (!Object.hasOwn(keys, lower)) continue;
    const key = keys[lower];
    const value = body.slice(colon + 1).trimEnd().trimStart();
    config[key] = key === 'fileIO' || key === 'reverseIO' ? /^(true|yes|y|1)$/i.test(value) : value;
  }
  return config;
}
function resolveIOConfig(sourceFile, header, overrides = {}, workspace = path.dirname(sourceFile)) {
  const base = path.basename(sourceFile, path.extname(sourceFile)), cppDir = path.dirname(sourceFile);
  const config = { fileIO: false, reverseIO: false, inputFile: '<base>.in', outputFile: '<base>.out', reverseInput: '<base>.in', reverseOutput: '<base>.out', customVariable: '', workDir: '<cppDir>', ...header, ...overrides };
  const vars = { var: config.customVariable, base, baseName: base, cppDir, workdir: workspace || cppDir, tmpDir: os.tmpdir() };
  const expand = value => String(value || '').replace(/<(var|base|baseName|cppDir|workdir|tmpDir)>/g, (_, k) => String(vars[k]));
  const dir = expand(config.workDir) || cppDir;
  return { ...config, cwd: path.resolve(cppDir, dir), inputFile: expand(config.inputFile), outputFile: expand(config.outputFile), reverseInput: expand(config.reverseInput), reverseOutput: expand(config.reverseOutput) };
}
module.exports = { parseHeader, resolveIOConfig };
