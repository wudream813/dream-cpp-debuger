'use strict';
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const PREVIEW_BYTES = 64 * 1024;
const PREVIEW_NOTICE = '\n[输出较多，后续内容仅写入文件]\n';

// Never truncate until the opened regular file and protected inputs have been
// checked. NOFOLLOW + EXCL/nonblocking prevents symlink and FIFO surprises.
async function openOutputFile(filePath, protectedPaths = [], options = {}) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('请选择本地输出文件');
  let before;
  try { before = await fs.promises.lstat(filePath); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (before && !before.isFile()) throw new Error('输出目标必须是普通文件，不能是符号链接或设备');
  const flags = fs.constants.O_RDWR | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0) |
    (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const handle = await fs.promises.open(filePath, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (before && (before.dev !== stat.dev || before.ino !== stat.ino))) throw new Error('输出文件类型或路径已变化');
    for (const protectedPath of protectedPaths.filter(Boolean)) {
      if (path.resolve(filePath) === path.resolve(protectedPath)) throw new Error('输出文件不能与源文件、可执行文件或输入文件相同');
      const inputStat = await fs.promises.stat(protectedPath).catch(() => null);
      if (inputStat && stat.dev === inputStat.dev && stat.ino === inputStat.ino) throw new Error('输出文件不能与源文件、可执行文件或输入文件相同');
    }
    // Atomic with the run-id check on the JS thread: stale async opens may
    // not truncate the output of a newer run.
    if (options.shouldProceed && !options.shouldProceed()) throw new Error('运行已取消');
    fs.ftruncateSync(handle.fd, 0);
    return new OutputFileCapture(handle, filePath);
  } catch (err) { await handle.close(); throw err; }
}

class OutputFileCapture {
  constructor(handle, filePath) {
    this.handle = handle; this.fd = handle.fd; this.path = filePath;
    this.offset = 0; this.decoder = new StringDecoder('utf8'); this.notice = false; this.closed = false;
  }
  poll(final = false) {
    if (this.closed) return '';
    const size = fs.fstatSync(this.fd).size;
    let text = '';
    const toRead = Math.max(0, Math.min(size, PREVIEW_BYTES) - this.offset);
    if (toRead) {
      const bytes = Buffer.allocUnsafe(toRead);
      const n = fs.readSync(this.fd, bytes, 0, toRead, this.offset);
      this.offset += n; text += this.decoder.write(bytes.subarray(0,n));
    }
    if (size > PREVIEW_BYTES && !this.notice) {
      text += this.decoder.end() + PREVIEW_NOTICE; this.notice = true;
    } else if (final && !this.notice) {
      text += this.decoder.end(); this.notice = true;
    }
    return text;
  }
  async close() { if (!this.closed) { this.closed = true; await this.handle.close(); } }
}
module.exports = { openOutputFile, OutputFileCapture, PREVIEW_BYTES, PREVIEW_NOTICE };
