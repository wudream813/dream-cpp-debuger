'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');
const { formatCppVariable } = require('../src/miParser');

async function testVectorLoop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-vector-loop-'));
  const source = path.join(dir, 'main.cpp');
  fs.writeFileSync(source, [
    '#include<bits/stdc++.h>',
    'using namespace std;',
    '',
    'int main(){',
    '    vector<int>v;',
    '    for(int i = 0; i <= 10; i++){',
    '        v.push_back(i);',
    '    }',
    '    cout << v[0];',
    '}',
    ''
  ].join('\n'));
  const session = new GDBSession();
  const waitStop = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { session.off('status', handler); reject(new Error('vector loop stop timeout')); }, 8000);
    function handler(ev) {
      if (ev.state === 'paused' || ev.state === 'exited') {
        clearTimeout(timer); session.off('status', handler); resolve(ev);
      }
    }
    session.on('status', handler);
  });
  try {
    const decl = await session._findLocalDeclarationLines(source, 6, 'main', ['v']);
    assert.strictEqual(decl.get('v').line, 5, 'compact template declaration must be identified');
    const nestedSource = path.join(dir, 'nested.cpp');
    fs.writeFileSync(nestedSource, 'void f(Foo* obj) {\n  obj->v = 3;\n  vector<pair<int,int>>v;\n}\n');
    const nestedDecl = await session._findLocalDeclarationLines(nestedSource, 3, 'f', ['v']);
    assert.strictEqual(nestedDecl.get('v').line, 3, 'do not confuse member access with a compact declaration');
    const directSource = path.join(dir, 'direct.cpp');
    fs.writeFileSync(directSource, 'void f() {\n  v();\n  std::vector<int>v(3, 1);\n}\n');
    const directDecl = await session._findLocalDeclarationLines(directSource, 2, 'f', ['v']);
    assert.strictEqual(directDecl.get('v').line, 3, 'direct initializer is a declaration, not the earlier function call');

    const built = await compileSourceFile(source);
    assert.strictEqual(built.success, true, built.stderr);
    await session.addWatch('v');
    let waiting = waitStop();
    await session.start({ executable: built.executable, sourceFile: source, cwd: dir, stopAtMain: true });
    let ev = await waiting;
    assert.strictEqual(ev.location.line, 5);
    assert.strictEqual(session.locals.find(v => v.name === 'v').kind, 'uninitialized');

    async function next() {
      const stop = waitStop();
      await session.stepOver();
      return stop;
    }
    ev = await next();
    assert.strictEqual(ev.location.line, 6);
    assert.deepStrictEqual(session.locals.find(v => v.name === 'v').elements, []);

    for (let i = 0; i <= 10; i++) {
      ev = await next();
      assert.strictEqual(ev.location.line, 7, `before push ${i}`);
      assert.deepStrictEqual(session.locals.find(v => v.name === 'v').elements,
        Array.from({ length: i }, (_, k) => String(k)), `before push ${i}`);
      ev = await next();
      assert.strictEqual(ev.location.line, 6, `after push ${i}`);
      const v = session.locals.find(v => v.name === 'v');
      assert.strictEqual(v.kind, 'array');
      assert.deepStrictEqual(v.elements, Array.from({ length: i + 1 }, (_, k) => String(k)), `after push ${i}`);
      assert.strictEqual(v.changed, true, 'updated variable is highlighted');
      const watch = session.watches.find(w => w.expr === 'v');
      assert.deepStrictEqual(watch.elements, v.elements, 'watch refreshes with locals');
    }
    ev = await next();
    assert.strictEqual(ev.location.line, 9);
    assert.deepStrictEqual(session.locals.find(v => v.name === 'v').elements,
      Array.from({ length: 11 }, (_, k) => String(k)));

    const pretty = formatCppVariable('v', 'std::vector of length 3, capacity 4 = {0, 1, 2}', 'std::vector<int>');
    assert.deepStrictEqual(pretty.elements, ['0', '1', '2']);
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { testVectorLoop };
