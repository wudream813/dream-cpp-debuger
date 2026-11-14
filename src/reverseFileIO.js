'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { openRegularFile } = require('./safeFiles');

const same = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
const equalPath = (a, b) => { const x = path.resolve(a), y = path.resolve(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; };
const statOrNull = p => { try { return fs.lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };
const followStatOrNull = p => { try { return fs.statSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };

// Deliberately do not follow links or create parent directories. The target
// must be a relative name inside the existing working directory.
function safePath(cwd, name) {
  if (!name || typeof name !== 'string' || /[\0\r\n]/.test(name)) throw Error('反文件名必须在工作目录内');
  if (path.isAbsolute(name)) name = path.relative(cwd, name);
  const parts = name.split(/[\\/]+/);
  if (parts.some(x => !x || x === '.' || x === '..')) throw Error('反文件名不能包含 .、.. 或空路径');
  let parent = cwd;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('反文件所在目录必须已存在且不能是符号链接');
  }
  return path.join(parent, parts.at(-1));
}

async function prepareReverseFileIO({ cwd, inputName, outputName, stdinMode, stdin, stdinFile, protectedPaths = [], outputFile, onWarning = () => {} }) {
  cwd = path.resolve(cwd);
  const rootStat = fs.lstatSync(cwd);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('工作目录必须是普通目录，不能是符号链接');
  if (stdinMode === 'stream' && process.platform === 'win32' && inputName) throw Error('Windows 反文件输入暂不支持流式输入，请选择文本预设或文件输入');
  const inputPath = inputName ? safePath(cwd, inputName) : null;
  const outputPath = outputName ? safePath(cwd, outputName) : null;
  if (inputPath && outputPath && equalPath(inputPath, outputPath)) throw Error('反文件输入与输出不能使用同一路径');
  const reserved = [...protectedPaths, outputFile, stdinFile].filter(Boolean);
  for (const target of [inputPath, outputPath].filter(Boolean)) {
    const st = statOrNull(target);
    if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) throw Error(`反文件路径必须是普通文件且不能有硬链接：${target}`);
    for (const p of reserved) {
      const other = followStatOrNull(p);
      if (equalPath(p, target) || same(st, other)) throw Error(`反文件路径与源文件、程序或输出文件冲突：${target}`);
    }
  }
  let inputHandle;
  const lockPath = path.join(cwd, '.dream-gdb-file-io.lock');
  if ([inputPath, outputPath, outputFile, stdinFile].filter(Boolean).some(p => equalPath(p, lockPath))) throw Error('文件路径与反文件会话锁冲突');
  if (inputPath && stdinMode === 'file') inputHandle = (await openRegularFile(stdinFile)).handle;
  const secret = crypto.randomBytes(20).toString('hex');
  let lockFd, lockStat, cleanupResult = null, streamFd = null, outputFd = null, outputOffset = 0, previewBytes = 0, notice = false;
  const decoder = new StringDecoder('utf8'), staged = [];
  function directoryIntact() { const st = statOrNull(cwd); return same(st, rootStat) && st.isDirectory() && !st.isSymbolicLink(); }
  function snapshotParents(target) {
    const dirs = []; let parent = path.dirname(target);
    while (parent !== cwd) { const st = fs.lstatSync(parent); if (!st.isDirectory() || st.isSymbolicLink()) throw Error('反文件目录已变化'); dirs.push({ path: parent, stat: st }); parent = path.dirname(parent); }
    return dirs;
  }
  function parentsIntact(entry) {
    return directoryIntact() && entry.parents.every(p => { const st = statOrNull(p.path); return same(st, p.stat) && st.isDirectory() && !st.isSymbolicLink(); });
  }
  function stage(target, kind) {
    if (!directoryIntact()) throw Error('工作目录已改变');
    const parents = snapshotParents(target);
    const before = statOrNull(target); let backup = null;
    const entry = { target, backup: null, original: before, created: null, identityFd: null, parents, removed: false, stableInput: null };
    staged.push(entry);
    if (before) {
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error(`文件已变化，未执行替换：${target}`);
      backup = target + '.dream-backup-' + secret;
      fs.linkSync(target, backup); // exclusive creation; never overwrite a backup
      entry.backup = backup;
      const linked = fs.lstatSync(backup);
      if (!same(before, linked) || !same(before, statOrNull(target))) throw Error(`文件已变化，备份保留：${backup}`);
      fs.unlinkSync(target);
      entry.removed = true;
    }
    if (kind === 'fifo') {
      execFileSync('mkfifo', [target]);
      entry.identityFd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    } else entry.identityFd = fs.openSync(target, 'wx+', 0o600);
    entry.created = fs.fstatSync(entry.identityFd);
    if (kind === 'fifo' ? !entry.created.isFIFO() : !entry.created.isFile()) throw Error(`文件类型已变化：${target}`);
    if (!same(entry.created, fs.lstatSync(target))) throw Error(`文件创建后已被替换：${target}`);
    return entry;
  }
  function poll(sink, final = false) {
    if (outputFd === null) return '';
    const entry = staged.find(e => e.target === outputPath);
    if (!parentsIntact(entry) || !same(statOrNull(outputPath), entry.created)) throw Error(`程序输出文件已被替换；保留备份以免覆盖：${outputPath}`);
    let text = '', st = fs.fstatSync(outputFd), budget = 1024 * 1024;
    if (sink == null && previewBytes >= 65536) { outputOffset = st.size; return ''; }
    if (st.size < outputOffset) { outputOffset = 0; if (sink !== null && sink !== undefined) fs.ftruncateSync(sink, 0); }
    while (outputOffset < st.size && budget > 0) {
      const len = Math.min(65536, st.size - outputOffset, budget), b = Buffer.allocUnsafe(len);
      const n = fs.readSync(outputFd, b, 0, len, outputOffset); if (!n) break;
      if (sink !== null && sink !== undefined) {
        let pos = 0; while (pos < n) { const count = fs.writeSync(sink, b, pos, n - pos, outputOffset + pos); if (!count) throw Error('输出文件写入失败'); pos += count; }
      }
      outputOffset += n; budget -= n;
      if (previewBytes < 65536) {
        const take = Math.min(n, 65536 - previewBytes); text += decoder.write(b.subarray(0, take)); previewBytes += take;
      }
      if (previewBytes >= 65536 && !notice) { text += decoder.end() + (sink === null || sink === undefined ? '\n[输出较多，后续内容未显示]\n' : '\n[输出较多，后续内容仅写入文件]\n'); notice = true; }
    }
    if (final && !notice) { text += decoder.end(); notice = true; }
    return text;
  }
  function pending() { return outputFd !== null && fs.fstatSync(outputFd).size > outputOffset; }
  function closeIdentities() { for (const e of staged) if (e.identityFd !== null) { try { fs.closeSync(e.identityFd); } catch (_) {} e.identityFd = null; } }
  function preserve(reason) {
    if (cleanupResult !== null) return;
    cleanupResult = false;
    if (streamFd !== null) { try { fs.closeSync(streamFd); } catch (_) {} streamFd = null; }
    if (outputFd !== null) { try { fs.closeSync(outputFd); } catch (_) {} outputFd = null; }
    if (lockFd !== undefined) { try { fs.closeSync(lockFd); } catch (_) {} lockFd = undefined; }
    closeIdentities();
    onWarning(`反文件未自动恢复（${reason}）；请检查备份和锁文件：${staged.map(x => x.backup || x.target).join('、')}；锁：${lockPath}`);
  }
  function backupIntact(entry) {
    const st = entry.backup && statOrNull(entry.backup);
    return same(st, entry.original) && st.size === entry.original.size && st.mtimeMs === entry.original.mtimeMs && st.mode === entry.original.mode && st.uid === entry.original.uid && st.gid === entry.original.gid;
  }
  function cleanup() {
    if (cleanupResult !== null) return cleanupResult;
    if (streamFd !== null) { try { fs.closeSync(streamFd); } catch (_) {} streamFd = null; }
    if (outputFd !== null) { try { fs.closeSync(outputFd); } catch (_) {} outputFd = null; }
    let allRestored = true;
    for (const entry of [...staged].reverse()) {
      if (entry.done) continue;
      try {
        if (!parentsIntact(entry)) { allRestored = false; continue; }
        const current = statOrNull(entry.target);
        if (current && !entry.created && !entry.removed && same(current, entry.original)) {
          if (entry.backup) {
            if (!backupIntact(entry)) { allRestored = false; continue; }
            fs.unlinkSync(entry.backup);
          }
          entry.done = true; continue;
        }
        if (!current && entry.created) { allRestored = false; continue; }
        if (current && (!entry.created || !same(current, entry.created))) { allRestored = false; continue; }
        if (current && entry.stableInput && (current.size !== entry.stableInput.size || current.mtimeMs !== entry.stableInput.mtimeMs)) { allRestored = false; continue; }
        if (entry.backup && !backupIntact(entry)) { allRestored = false; continue; }
        if (current) fs.unlinkSync(entry.target);
        if (entry.backup) {
          if (!backupIntact(entry) || statOrNull(entry.target)) { allRestored = false; continue; }
          fs.linkSync(entry.backup, entry.target); // fails rather than overwriting a new file
          fs.unlinkSync(entry.backup);
        }
        entry.done = true;
      } catch (_) { allRestored = false; }
    }
    closeIdentities();
    if (lockFd !== undefined) { try { fs.closeSync(lockFd); } catch (_) {} lockFd = undefined; }
    if (allRestored) {
      try { if (same(statOrNull(lockPath), lockStat)) fs.unlinkSync(lockPath); }
      catch (_) { allRestored = false; }
    }
    if (!allRestored) onWarning(`反文件恢复遇到冲突，已保留备份及锁文件，请检查：${staged.filter(x => !x.done).map(x => x.backup || x.target).join('、')}`);
    cleanupResult = allRestored;
    return allRestored;
  }
  try {
    lockFd = fs.openSync(lockPath, 'wx', 0o600); fs.writeSync(lockFd, secret); lockStat = fs.fstatSync(lockFd);
    if (inputPath) {
      const inputEntry = stage(inputPath, stdinMode === 'stream' ? 'fifo' : 'file');
      if (stdinMode === 'stream') streamFd = fs.openSync(inputPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      else {
        const dest = inputEntry.identityFd;
        {
          if (stdinMode === 'file') {
            const buffer = Buffer.allocUnsafe(65536); let n, pos = 0;
            while ((n = fs.readSync(inputHandle.fd, buffer, 0, buffer.length, pos)) > 0) { let written = 0; while (written < n) { const count = fs.writeSync(dest, buffer, written, n - written, pos + written); if (!count) throw Error('写入反文件输入失败'); written += count; } pos += n; }
          } else fs.writeFileSync(dest, typeof stdin === 'string' ? stdin : '');
        }
        inputEntry.stableInput = fs.fstatSync(dest);
      }
    }
    if (outputPath) { const out = stage(outputPath, 'file'); outputFd = fs.openSync(outputPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); if (!same(fs.fstatSync(outputFd), out.created)) throw Error('输出文件已变化'); }
    return { inputPath, outputPath, streamFd, takeStreamFd() { const fd = streamFd; streamFd = null; return fd; }, poll, pending, preserve, cleanup };
  } catch (err) { cleanup(); throw err; }
  finally { if (inputHandle) await inputHandle.close(); }
}
module.exports = { prepareReverseFileIO, safePath };
