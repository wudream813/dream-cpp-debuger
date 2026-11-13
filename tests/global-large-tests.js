'use strict';
/**
 * Regression tests for large global symbol tables and multi-dimensional arrays.
 * A translation unit with more than 100 globals must expose every symbol through
 * lazy windows, and arrays with more than one dimension must stay pageable.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GDBSession } = require('../src/gdbSession');
const { compileSourceFile } = require('../src/compiler');

async function settle(session) {
  // The pause refresh runs asynchronously; wait for it plus one full window.
  for (let i = 0; i < 60; i++) {
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
  // ── 1. More than 100 global symbols plus a long array and vector ──
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

  const session = new GDBSession({ globalsPageSize: 100 });
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

    // Every discovered symbol is retained, and only the first window is rendered.
    assert.equal(session.globalsTotal, 152, session.globalsInfo);
    assert.equal(session.globals.length, 100, session.globalsInfo);
    assert(session.globalsInfo.includes('已显示 100 / 共 152 项'), session.globalsInfo);
    assert.equal(session.globals.some(v => v.displayName === 'tailnums'), false);
    let snapshot = session.getSnapshot();
    assert.equal(snapshot.globalsHasMore, true);
    assert.equal(snapshot.globalsTotal, 152);

    // Loading the next window reveals the tail symbols that used to be hidden.
    assert.equal(await session.loadMoreGlobals(), true);
    snapshot = session.getSnapshot();
    assert.equal(snapshot.globalsHasMore, false);
    assert.equal(snapshot.globals.length, 152);
    const nums = session.globals.find(v => v.displayName === 'tailnums');
    const bag = session.globals.find(v => v.displayName === 'tailbag');
    assert(nums && bag, 'tail globals must be visible after loading more');
    // Arrays/vectors longer than 100 elements stay fully pageable.
    assert.equal(nums.sequence.length, 150);
    assert.equal(bag.sequence.length, 120);
    const page = await session.getSequencePage(nums.name, 144, 8, session._pauseContext(), 'global');
    assert.equal(page.length, 150);
    assert.equal(page.items[page.items.length - 1].value, '42');
    const bagPage = await session.getSequencePage(bag.name, 116, 8, session._pauseContext(), 'global');
    assert.equal(bagPage.items[bagPage.items.length - 1].value, '9');
    // Loading more is only meaningful while paused.
    const pausedState = session.state;
    session.state = 'running';
    await assert.rejects(session.loadMoreGlobals(), /暂停/);
    session.state = pausedState;
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 2. Multi-dimensional arrays page over their outermost dimension ──
  const gridDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-globals-2d-'));
  const gridSource = path.join(gridDir, 'main.cpp');
  fs.writeFileSync(gridSource, [
    'int grid[12][9];',
    'char names[8][16];',
    'int main(){',
    '  grid[11][8] = 7;',
    '  int stop = 1;',
    '  return stop;',
    '}', ''
  ].join('\n'));
  const gridSession = new GDBSession();
  try {
    const built = await compileSourceFile(gridSource, { vectorHelpers: true });
    assert(built.success, built.stderr);
    let stopped = waitForStop(gridSession);
    await gridSession.start({ executable: built.executable, sourceFile: gridSource, cwd: gridDir, stopAtMain: true });
    await stopped;
    await gridSession.setBreakpoint(gridSource, 5);
    stopped = waitForStop(gridSession);
    await gridSession.continue();
    await stopped;
    await settle(gridSession);

    const grid = gridSession.globals.find(v => v.displayName === 'grid');
    const names = gridSession.globals.find(v => v.displayName === 'names');
    assert(grid && grid.sequence, 'int [12][9] must stay inspectable');
    assert.deepStrictEqual(grid.sequence.dimensions, [12, 9]);
    assert.equal(grid.sequence.length, 12);
    assert.equal(grid.sequence.editable, false, 'a row cannot be assigned as a scalar');
    assert(grid.displayValue.startsWith('[12][9]'), grid.displayValue);

    const gridPage = await gridSession.getSequencePage(grid.name, 8, 4, gridSession._pauseContext(), 'global');
    assert.equal(gridPage.length, 12);
    assert.equal(gridPage.items[gridPage.items.length - 1].index, 11);
    assert.equal(/7\s*\}$/.test(gridPage.items[gridPage.items.length - 1].value), true, gridPage.items[gridPage.items.length - 1].value);

    // A two-dimensional char array must be treated as rows, not as single bytes.
    assert(names && names.sequence, 'char [8][16] must stay inspectable');
    assert.equal(names.sequence.kind, 'array');
    assert.equal(names.sequence.isChar, false);
    assert.deepStrictEqual(names.sequence.dimensions, [8, 16]);
    assert.equal(names.sequence.length, 8);
    const namesPage = await gridSession.getSequencePage(names.name, 0, 2, gridSession._pauseContext(), 'global');
    assert.equal(namesPage.items.length, 2);
  } finally {
    await gridSession.stop();
    fs.rmSync(gridDir, { recursive: true, force: true });
  }

  // ── 3. Dashboard renders a load-more control only while globals remain ──
  const { JSDOM } = require('jsdom');
  const { getDashboardHtml } = require('../src/dashboardHtml');
  const messages = [];
  const dom = new JSDOM(getDashboardHtml({ nonce: 'test' }), {
    runScripts: 'dangerously',
    beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: m => messages.push(m) }); }
  });
  const doc = dom.window.document;
  const card = (name) => ({ id: name, name, displayName: name, type: 'int', kind: 'scalar', displayValue: '1', elements: null });
  const globalsSnap = (globals, total, hasMore) => ({
    runId: 1, state: 'paused', sessionId: 1, pauseId: 2, currentFrame: 0,
    locals: [], watches: [], stack: [], breakpoints: [], registers: [],
    globals, globalsTotal: total, globalsHasMore: hasMore,
    globalsInfo: hasMore ? `已显示 ${globals.length} / 共 ${total} 项，点击“加载更多”继续。` : ''
  });
  const send = (snapshot) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot } }));

  send(globalsSnap([card('g0'), card('g1')], 250, true));
  const more = doc.getElementById('globalsMore');
  assert(more, 'the dashboard must offer a load-more control when globals remain');
  assert.match(more.textContent, /已显示 2 \/ 250/);
  assert.match(doc.getElementById('globalsCount').textContent, /2 \/ 250 项/);
  more.click();
  assert(messages.some(m => m.type === 'loadMoreGlobals'), 'clicking load-more must request the next window');
  assert.equal(more.disabled, true);

  send(globalsSnap([card('g0'), card('g1'), card('g2')], 3, false));
  assert.equal(doc.getElementById('globalsMore'), null, 'the control disappears once every symbol is shown');
  assert.equal(doc.getElementById('globalsCount').textContent, '3 项');

  // ── 4. Page size configuration is clamped and never zero ──
  assert.equal(new GDBSession().globalsPageSize, 100);
  assert.equal(new GDBSession({ globalsPageSize: 25 }).globalsPageSize, 25);
  assert.equal(new GDBSession({ globalsPageSize: -3 }).globalsPageSize, 100);
  assert.equal(new GDBSession({ globalsPageSize: 999999 }).globalsPageSize, 1000);
}

module.exports = { testLargeGlobals };
if (require.main === module) {
  testLargeGlobals().then(() => console.log('global large tests ok')).catch((err) => { console.error(err); process.exitCode = 1; });
}
