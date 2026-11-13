'use strict';
/**
 * Regression tests for large global symbol tables and multi-dimensional arrays.
 * There is no display limit: every global symbol is read and shown, and
 * multi-dimensional arrays expose each scalar cell for reading and editing.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');

async function settle(session) {
  // The pause refresh runs asynchronously; wait for it plus one full window.
  for (let i = 0; i < 80; i++) {
    await session._waitPendingRefresh().catch(() => {});
    if (session.state !== 'paused' || session.globals.length > 0) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

function waitForStop(session) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { session.off('status', handler); reject(Error('global stop timeout')); }, 20000);
    function handler(event) {
      if (event.state === 'paused' || event.state === 'exited') {
        clearTimeout(timer);
        session.off('status', handler);
        resolve(event);
      }
    }
    session.on('status', handler);
  });
}

async function testLargeGlobals() {
  // ── 1. Far more than 100 global symbols: every one is displayed ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-globals-many-'));
  const source = path.join(dir, 'main.cpp');
  const declarations = Array.from({ length: 150 }, (_, i) => `int gv${i} = ${i};`).join('\n');
  fs.writeFileSync(source, [
    '#include <vector>',
    declarations,
    'int tailnums[150] = {};',
    'std::vector<int> tailbag(120, 6);',
    'int main(){',
    '  tailnums[149] = 42;',
    '  tailbag[119] = 9;',
    '  int stop = 1;',
    '  return stop;',
    '}', ''
  ].join('\n'));

  const session = new GDBSession();
  try {
    const built = await compileSourceFile(source, { vectorHelpers: true });
    assert(built.success, built.stderr);
    let stopped = waitForStop(session);
    await session.start({ executable: built.executable, sourceFile: source, cwd: dir, stopAtMain: true });
    await stopped;
    await session.setBreakpoint(source, 157); // int stop = 1; (after both writes)
    stopped = waitForStop(session);
    await session.continue();
    await stopped;
    await settle(session);

    // Everything is shown at once, with no paging and no hidden tail.
    assert.equal(session.globalsTotal, 152, session.globalsInfo);
    assert.equal(session.globals.length, 152, session.globalsInfo);
    assert.equal(session.getSnapshot().globalsHasMore, undefined);
    const nums = session.globals.find(v => v.displayName === 'tailnums');
    const bag = session.globals.find(v => v.displayName === 'tailbag');
    assert(nums && bag, 'tail globals must be visible');
    assert.equal(nums.sequence.length, 150);
    assert.equal(bag.sequence.length, 120);
    const page = await session.getSequencePage(nums.name, 144, 8, session._pauseContext(), 'global');
    assert.equal(page.length, 150);
    assert.equal(page.items[page.items.length - 1].value, '42');
    const bagPage = await session.getSequencePage(bag.name, 116, 8, session._pauseContext(), 'global');
    assert.equal(bagPage.items[bagPage.items.length - 1].value, '9');
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 2. Multi-dimensional arrays: flat cells, `[r][c]` labels, editable ──
  const gridDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-globals-2d-'));
  const gridSource = path.join(gridDir, 'main.cpp');
  fs.writeFileSync(gridSource, [
    'int grid[12][9];',
    'char names[8][16];',
    'int main(){',
    '  grid[11][8] = 7;',
    '  int table[3][4] = {{1, 2, 3, 4}, {5, 6, 7, 8}, {9, 10, 11, 12}};',
    '  char word[2][4] = {{65, 66, 67, 0}, {68, 69, 70, 0}};',
    '  int stop = 1;',
    '  return stop + table[2][3] + word[1][1];',
    '}', ''
  ].join('\n'));
  const gridSession = new GDBSession();
  try {
    const built = await compileSourceFile(gridSource, { vectorHelpers: true });
    assert(built.success, built.stderr);
    let stopped = waitForStop(gridSession);
    await gridSession.start({ executable: built.executable, sourceFile: gridSource, cwd: gridDir, stopAtMain: true });
    await stopped;
    await gridSession.setBreakpoint(gridSource, 7);
    stopped = waitForStop(gridSession);
    await gridSession.continue();
    await stopped;
    await settle(gridSession);
    const ctx = gridSession._pauseContext();

    // Global 2-D array: readable, paged as flat cells, still read-only.
    const grid = gridSession.globals.find(v => v.displayName === 'grid');
    assert(grid && grid.sequence, 'int [12][9] must stay inspectable');
    assert.deepStrictEqual(grid.sequence.dimensions, [12, 9]);
    assert.equal(grid.sequence.length, 108, 'flat element count');
    assert.equal(grid.sequence.editable, false, 'globals stay read-only');
    assert(grid.displayValue.startsWith('[12][9]'), grid.displayValue);
    assert.deepStrictEqual(grid.sequence.items.slice(0, 2).map(i => i.label), ['[0][0]', '[0][1]']);
    const gridPage = await gridSession.getSequencePage(grid.name, 106, 4, ctx, 'global');
    assert.equal(gridPage.length, 108);
    assert.equal(gridPage.items[gridPage.items.length - 1].label, '[11][8]');
    assert.match(gridPage.items[gridPage.items.length - 1].value, /^7$/);
    await assert.rejects(gridSession.setSequenceElement(grid.name, 0, '5', ctx), /不可逐项修改|只读/);

    // Local 2-D array: every cell is editable through flat indices.
    const table = gridSession.locals.find(v => v.name === 'table');
    assert(table && table.sequence, 'local int [3][4] must be inspectable');
    assert.deepStrictEqual(table.sequence.dimensions, [3, 4]);
    assert.equal(table.sequence.length, 12);
    assert.equal(table.sequence.editable, true, 'local 2-D arrays are editable');
    assert.equal(table.sequence.items[5].label, '[1][1]');
    assert.equal(table.sequence.items[5].value, '6');
    await gridSession.setSequenceElement('table', 5, '42', ctx);      // table[1][1] = 42
    await gridSession.setSequenceElement('table', 11, '99', ctx);     // table[2][3] = 99
    let localPage = await gridSession.getSequencePage('table', 4, 8, ctx);
    assert.equal(localPage.items[1].value, '42');
    assert.equal(localPage.items[7].value, '99');
    assert.equal(localPage.items[0].label, '[1][0]');
    await assert.rejects(gridSession.setSequenceElement('table', 12, '1', ctx), /越界/);
    await assert.rejects(gridSession.setSequenceElement('table', 3, '{1, 2, 3}', ctx), /元素值无效|无效/);

    // Two-dimensional char arrays stay byte-wise editable, like 1-D char arrays.
    const word = gridSession.locals.find(v => v.name === 'word');
    assert(word && word.sequence, 'local char [2][4] must be inspectable');
    assert.equal(word.sequence.isChar, true);
    assert.deepStrictEqual(word.sequence.dimensions, [2, 4]);
    assert.equal(word.sequence.length, 8);
    await gridSession.setSequenceElement('word', 5, 'Z', ctx);        // word[1][1] = 'Z'
    const wordPage = await gridSession.getSequencePage('word', 4, 4, ctx);
    assert.equal(wordPage.items[1].value, 'Z');
    assert.equal(wordPage.items[1].label, '[1][1]');

    // Element reading stays in sync with GDB after the writes.
    const rawPage = await gridSession.getSequencePage('table', 11, 1, ctx);
    assert.equal(rawPage.items[0].value, '99');
  } finally {
    await gridSession.stop();
    fs.rmSync(gridDir, { recursive: true, force: true });
  }

  // ── 3. Flat index helpers ──
  const helper = new GDBSession();
  assert.equal(helper._subscriptForIndex('a', [12, 9], 20), 'a[2][2]');
  assert.equal(helper._subscriptForIndex('a', [3, 4, 5], 0), 'a[0][0][0]');
  assert.equal(helper._subscriptForIndex('a', [3, 4, 5], 59), 'a[2][3][4]');
  assert.equal(helper._subscriptForIndex('a', [7], 3), 'a[3]');
  assert.equal(helper._elementLabel([12, 9], 20), '[2][2]');
  assert.equal(helper._elementLabel([7], 3), '[3]');
  assert.equal(helper._arrayElementCount([12, 9]), 108);
  assert.equal(helper._arrayElementCount([]), null);

  // ── 4. The dashboard has no "load more" cap any more ──
  const { JSDOM } = require('jsdom');
  const { getDashboardHtml } = require('../src/dashboardHtml');
  const messages = [];
  const dom = new JSDOM(getDashboardHtml({ nonce: 'test' }), {
    runScripts: 'dangerously',
    beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: m => messages.push(m) }); }
  });
  const doc = dom.window.document;
  const card = (name) => ({ id: name, name, displayName: name, type: 'int', kind: 'scalar', displayValue: '1', elements: null });
  const globals = Array.from({ length: 420 }, (_, i) => card('g' + i));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'snapshot', snapshot: {
      runId: 1, state: 'paused', sessionId: 1, pauseId: 2, currentFrame: 0,
      locals: [], watches: [], stack: [], breakpoints: [], registers: [],
      globals, globalsTotal: globals.length, globalsInfo: ''
    } }
  }));
  assert.equal(doc.getElementById('globalsMore'), null, 'no load-more control');
  assert.equal(doc.getElementById('globalsCount').textContent, '420 项');
  assert.equal(doc.querySelectorAll('#globalsContainer .var-item').length, 420);
}

module.exports = { testLargeGlobals };
if (require.main === module) {
  testLargeGlobals().then(() => console.log('global large tests ok')).catch((err) => { console.error(err); process.exitCode = 1; });
}
