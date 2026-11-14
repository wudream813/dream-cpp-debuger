'use strict';
const assert = require('assert');
const path = require('path');
const { parseHeader, resolveIOConfig } = require('../src/fileIOConfig');
function testFileIOConfig() {
  const text = 'printf("workdir: /wrong");\n// useFileRedirect: yes\n/*\n * inputFile: <cppDir>/<base>.in\n * unFileInputFile: <var>.in\n * useUnFileRedirect: true\n * customVariable: data\n * WorkDir: <workdir>/test\n */\n// my_outputfile: evil\n';
  const header = parseHeader(text);
  assert.deepStrictEqual(header, { fileIO: true, inputFile: '<cppDir>/<base>.in', reverseInput: '<var>.in', reverseIO: true, customVariable: 'data', workDir: '<workdir>/test' });
  const conf = resolveIOConfig('/tmp/proj/a.cpp', header, { fileIO: false }, '/tmp/work');
  assert.strictEqual(conf.fileIO, false); assert.strictEqual(conf.reverseIO, true);
  assert.strictEqual(conf.cwd, path.resolve('/tmp/work/test')); assert.strictEqual(conf.inputFile, '/tmp/proj/a.in'); assert.strictEqual(conf.reverseInput, 'data.in');
  assert.deepStrictEqual(parseHeader('\n'.repeat(50) + '// outputFile: nope'), {});
}
module.exports = { testFileIOConfig };
