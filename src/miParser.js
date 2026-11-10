/**
 * Dream C++ Debugger — GDB/MI2 Protocol Parser & C++ Value Unpacker
 * Pure Node.js module (zero external dependencies)
 */
'use strict';

/**
 * Unescape a GDB MI C-string (excluding surrounding quotes),
 * decoding octal UTF-8 sequences (e.g. \344\270\255) into proper UTF-8 strings.
 */
function unescapeMIString(str) {
  if (typeof str !== 'string') return '';
  const bytes = [];
  let i = 0;
  const len = str.length;

  while (i < len) {
    const ch = str[i];
    if (ch !== '\\') {
      const code = str.codePointAt(i);
      const encoded = Buffer.from(String.fromCodePoint(code), 'utf8');
      for (const b of encoded) bytes.push(b);
      i += code > 0xffff ? 2 : 1;
      continue;
    }
    i++;
    if (i >= len) {
      bytes.push(0x5c);
      break;
    }
    const esc = str[i];
    if (esc >= '0' && esc <= '7') {
      let oct = esc;
      i++;
      if (i < len && str[i] >= '0' && str[i] <= '7') {
        oct += str[i++];
        if (i < len && str[i] >= '0' && str[i] <= '7') {
          oct += str[i++];
        }
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    i++;
    switch (esc) {
      case 'n': bytes.push(0x0a); break;
      case 'r': bytes.push(0x0d); break;
      case 't': bytes.push(0x09); break;
      case 'b': bytes.push(0x08); break;
      case 'f': bytes.push(0x0c); break;
      case 'v': bytes.push(0x0b); break;
      case 'a': bytes.push(0x07); break;
      case '\\': bytes.push(0x5c); break;
      case '"': bytes.push(0x22); break;
      case '\'': bytes.push(0x27); break;
      case 'x': {
        const hex = str.slice(i, i + 2);
        if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += hex.length;
        } else {
          bytes.push(0x78);
        }
        break;
      }
      default: {
        const encoded = Buffer.from(esc, 'utf8');
        for (const b of encoded) bytes.push(b);
        break;
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Recursive descent parser for GDB/MI result payloads
 */
class MIValueParser {
  constructor(input) {
    this.input = input;
    this.pos = 0;
    this.len = input.length;
  }

  skipWhitespace() {
    while (this.pos < this.len && (this.input[this.pos] === ' ' || this.input[this.pos] === '\t')) {
      this.pos++;
    }
  }

  parseResults() {
    const out = {};
    while (this.pos < this.len) {
      this.skipWhitespace();
      if (this.input[this.pos] === ',') {
        this.pos++;
        this.skipWhitespace();
      }
      if (this.pos >= this.len || this.input[this.pos] === '}' || this.input[this.pos] === ']') {
        break;
      }
      const pair = this.parseResultOrValue();
      if (!pair) break;
      if (pair.key !== null) {
        if (Object.prototype.hasOwnProperty.call(out, pair.key)) {
          if (!Array.isArray(out[pair.key])) {
            out[pair.key] = [out[pair.key]];
          }
          out[pair.key].push(pair.value);
        } else {
          out[pair.key] = pair.value;
        }
      }
    }
    return out;
  }

  parseResultOrValue() {
    this.skipWhitespace();
    const start = this.pos;
    while (
      this.pos < this.len &&
      this.input[this.pos] !== '=' &&
      this.input[this.pos] !== ',' &&
      this.input[this.pos] !== '}' &&
      this.input[this.pos] !== ']' &&
      this.input[this.pos] !== '"' &&
      this.input[this.pos] !== '{' &&
      this.input[this.pos] !== '['
    ) {
      this.pos++;
    }
    if (this.pos > start && this.input[this.pos] === '=') {
      const key = this.input.slice(start, this.pos).trim();
      this.pos++; // skip '='
      const value = this.parseValue();
      return { key, value };
    }
    this.pos = start;
    const value = this.parseValue();
    return { key: null, value };
  }

  parseValue() {
    this.skipWhitespace();
    if (this.pos >= this.len) return '';
    const ch = this.input[this.pos];
    if (ch === '"') return this.parseCString();
    if (ch === '{') return this.parseTuple();
    if (ch === '[') return this.parseList();
    return '';
  }

  parseCString() {
    if (this.input[this.pos] !== '"') return '';
    this.pos++; // skip opening '"'
    const start = this.pos;
    while (this.pos < this.len) {
      const ch = this.input[this.pos];
      if (ch === '\\') {
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        const raw = this.input.slice(start, this.pos);
        this.pos++; // skip closing '"'
        return unescapeMIString(raw);
      }
      this.pos++;
    }
    return unescapeMIString(this.input.slice(start));
  }

  parseTuple() {
    if (this.input[this.pos] !== '{') return {};
    this.pos++; // skip '{'
    this.skipWhitespace();
    if (this.input[this.pos] === '}') {
      this.pos++;
      return {};
    }
    const obj = this.parseResults();
    this.skipWhitespace();
    if (this.input[this.pos] === '}') {
      this.pos++;
    }
    return obj;
  }

  parseList() {
    if (this.input[this.pos] !== '[') return [];
    this.pos++; // skip '['
    const arr = [];
    while (this.pos < this.len) {
      this.skipWhitespace();
      if (this.input[this.pos] === ',') {
        this.pos++;
        this.skipWhitespace();
      }
      if (this.pos >= this.len || this.input[this.pos] === ']') {
        break;
      }
      const item = this.parseResultOrValue();
      if (!item) break;
      arr.push(item.value);
    }
    this.skipWhitespace();
    if (this.input[this.pos] === ']') {
      this.pos++;
    }
    return arr;
  }
}

/**
 * Parse a single line of GDB/MI2 output.
 */
function parseMILine(rawLine) {
  if (typeof rawLine !== 'string') return null;
  const line = rawLine.replace(/\r?\n$/, '').trim();
  if (!line) return null;

  if (line === '(gdb)' || line.startsWith('(gdb)')) {
    return { type: 'prompt', token: null };
  }

  let idx = 0;
  while (idx < line.length && line[idx] >= '0' && line[idx] <= '9') {
    idx++;
  }
  const token = idx > 0 ? parseInt(line.slice(0, idx), 10) : null;
  const prefix = line[idx];
  const rest = line.slice(idx + 1);

  if (prefix === '~' || prefix === '@' || prefix === '&') {
    const parser = new MIValueParser(rest);
    const content = parser.parseCString();
    const streamType = prefix === '~' ? 'console' : prefix === '@' ? 'target' : 'log';
    return { type: streamType, token, content };
  }

  if (prefix === '^' || prefix === '*' || prefix === '+' || prefix === '=') {
    const recordType =
      prefix === '^' ? 'result' :
      prefix === '*' ? 'exec' :
      prefix === '+' ? 'status' : 'notify';

    const commaIdx = rest.indexOf(',');
    const recordClass = commaIdx === -1 ? rest.trim() : rest.slice(0, commaIdx).trim();
    const payload = commaIdx === -1 ? '' : rest.slice(commaIdx + 1);
    const parser = new MIValueParser(payload);
    const results = payload ? parser.parseResults() : {};
    return {
      type: recordType,
      token,
      class: recordClass,
      results
    };
  }

  return { type: 'output', token: null, content: line };
}

/**
 * Check if a GDB value string represents an uninitialized or unreadable memory error
 * (e.g. `std::vector of length 3850240, capacity 3855324 = {<error reading variable: Cannot access memory at address 0x0>}`).
 */
function isUninitializedOrCorruptGdbValue(rawVal) {
  if (typeof rawVal !== 'string') return false;
  if (
    rawVal.includes('<error reading variable') ||
    rawVal.includes('Cannot access memory at address') ||
    rawVal.includes('<address of value unknown>')
  ) {
    return true;
  }

  // Check pretty-printed std::vector length/capacity sanity
  const vecHeader = rawVal.match(/^std::vector of length (-?\d+),\s*capacity (-?\d+)/);
  if (vecHeader) {
    const len = parseInt(vecHeader[1], 10);
    const cap = parseInt(vecHeader[2], 10);
    if (len < 0 || cap < 0 || cap < len || len > 1000000) {
      return true;
    }
  }
  return false;
}

/**
 * Detect raw libstdc++ std::vector internal pointers when Python pretty-printing is unavailable.
 * Also validates pointer invariants so uninitialized stack garbage is detected immediately.
 * Returns { startHex, finishHex, capacityHex, uninitialized } or null.
 */
function extractStdVectorPointers(rawVal) {
  if (typeof rawVal !== 'string' || !rawVal.includes('_M_start') || !rawVal.includes('_M_finish')) {
    return null;
  }
  const startMatch = rawVal.match(/_M_start\s*=\s*(0x[0-9a-fA-F]+)/);
  const finishMatch = rawVal.match(/_M_finish\s*=\s*(0x[0-9a-fA-F]+)/);
  const capMatch = rawVal.match(/_M_end_of_storage\s*=\s*(0x[0-9a-fA-F]+)/);
  if (!startMatch || !finishMatch) return null;

  const startHex = startMatch[1];
  const finishHex = finishMatch[1];
  const capacityHex = capMatch ? capMatch[1] : null;

  try {
    const start = BigInt(startHex);
    const finish = BigInt(finishHex);
    const cap = capacityHex ? BigInt(capacityHex) : finish;

    // Uninitialized stack memory check:
    // 1. start == 0 but finish != 0 (or cap != 0)
    // 2. finish < start or cap < finish
    // 3. byte span > 16 MB or misaligned strange addresses
    const byteSpan = finish - start;
    const capSpan = cap - start;
    if (
      (start === 0n && (finish !== 0n || cap !== 0n)) ||
      finish < start ||
      cap < finish ||
      byteSpan > 0x1000000n ||
      capSpan > 0x4000000n ||
      (start > 0n && start < 0x1000n)
    ) {
      return { startHex, finishHex, capacityHex, uninitialized: true };
    }
  } catch (_) {}

  return {
    startHex,
    finishHex,
    capacityHex,
    uninitialized: false
  };
}

/**
 * Detect raw libstdc++ std::string internal buffer when Python pretty-printing is unavailable.
 */
function extractStdStringValue(rawVal) {
  if (typeof rawVal !== 'string' || !rawVal.includes('_M_dataplus')) {
    return null;
  }
  const lenMatch = rawVal.match(/_M_string_length\s*=\s*(\d+)/);
  if (lenMatch) {
    const strLen = parseInt(lenMatch[1], 10);
    if (strLen > 100000) {
      return '__UNINITIALIZED__';
    }
  }
  if (rawVal.includes('<error reading variable') || rawVal.includes('Cannot access memory')) {
    return '__UNINITIALIZED__';
  }
  const m = rawVal.match(/_M_p\s*=\s*0x[0-9a-fA-F]+\s+"((?:\\.|[^"\\])*)"/);
  if (m) {
    return `"${m[1]}"`;
  }
  return null;
}

/**
 * Parse top-level C/C++ brace list `{10, 20, 30}` into an array of element strings.
 */
function parseBraceElements(rawVal) {
  if (typeof rawVal !== 'string') return null;
  if (isUninitializedOrCorruptGdbValue(rawVal)) return null;

  let trimmed = rawVal.trim();
  // Support empty pretty-printed std::vector: `std::vector of length 0, capacity 0`
  if (/^std::vector of length 0,\s*capacity \d+\s*$/.test(trimmed)) {
    return [];
  }

  // Support pretty-printed std::vector: `std::vector of length 3, capacity 4 = {10, 20, 30}`
  const eqBrace = trimmed.match(/=\s*(\{[\s\S]*\})$/);
  if (eqBrace) {
    trimmed = eqBrace[1].trim();
  }
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let depth = 0;
  let inQuotes = false;
  let current = '';

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inQuotes) {
      current += ch + (inner[i + 1] || '');
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === '{' || ch === '(' || ch === '<' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === '>' || ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        items.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) {
    items.push(current.trim());
  }

  // Handle GDB `<repeats N times>` syntax inside arrays (e.g., `0 <repeats 12 times>`)
  const expanded = [];
  for (const item of items) {
    const rep = item.match(/^(.*?)\s*<repeats\s+(\d+)\s+times>$/);
    if (rep) {
      const val = rep[1].trim();
      const count = Math.min(parseInt(rep[2], 10), 64);
      for (let k = 0; k < count; k++) expanded.push(val);
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}

/**
 * Format and classify a C++ variable/expression value for rich UI display.
 */
function formatCppVariable(name, rawValue, rawType = '') {
  const valStr = String(rawValue ?? '').trim();
  const typeStr = String(rawType ?? '').trim();

  // 0. Check for uninitialized / corrupt GDB memory errors first
  if (isUninitializedOrCorruptGdbValue(valStr)) {
    return {
      name,
      type: typeStr || 'auto',
      kind: 'uninitialized',
      displayValue: '⏳ 尚未初始化 (未执行到构造语句)',
      elements: null,
      raw: valStr
    };
  }

  // 1. Check raw std::string
  const stdStr = extractStdStringValue(valStr);
  if (stdStr === '__UNINITIALIZED__') {
    return {
      name,
      type: typeStr || 'std::string',
      kind: 'uninitialized',
      displayValue: '⏳ 尚未初始化 (未执行到构造语句)',
      elements: null,
      raw: valStr
    };
  }
  if (stdStr !== null) {
    return {
      name,
      type: typeStr || 'std::string',
      kind: 'string',
      displayValue: stdStr,
      elements: null,
      raw: valStr
    };
  }

  // 2. Check quoted string or char*
  if (/^".*"$/.test(valStr) || /^0x[0-9a-fA-F]+\s+".*"$/.test(valStr)) {
    return {
      name,
      type: typeStr || 'string',
      kind: 'string',
      displayValue: valStr,
      elements: null,
      raw: valStr
    };
  }

  // 3. Check brace list (arrays, vectors, structs)
  const elements = parseBraceElements(valStr);
  if (elements !== null) {
    const isStruct = elements.some((e) => /^[a-zA-Z_]\w*\s*=/.test(e));
    if (!isStruct) {
      const isVec = typeStr.includes('vector') || valStr.startsWith('std::vector');
      const prefixLabel = isVec ? `vector[${elements.length}]` : `[${elements.length}]`;
      return {
        name,
        type: typeStr || (isVec ? `std::vector[${elements.length}]` : `array[${elements.length}]`),
        kind: 'array',
        displayValue: elements.length === 0
          ? `${prefixLabel} {}`
          : `${prefixLabel} { ${elements.slice(0, 12).join(', ')}${elements.length > 12 ? ', ...' : ''} }`,
        elements,
        raw: valStr
      };
    }
    return {
      name,
      type: typeStr || 'struct',
      kind: 'struct',
      displayValue: `{ ${elements.join(', ')} }`,
      elements,
      raw: valStr
    };
  }

  // 4. Pointer
  if (/^0x[0-9a-fA-F]+(\s+<.*>)?$/.test(valStr) || typeStr.endsWith('*')) {
    return {
      name,
      type: typeStr || 'pointer',
      kind: 'pointer',
      displayValue: valStr,
      elements: null,
      raw: valStr
    };
  }

  // 5. Primitive / scalar
  return {
    name,
    type: typeStr || (/^-?\d+$/.test(valStr) ? 'int' : /^-?\d+\.\d+/.test(valStr) ? 'double' : 'scalar'),
    kind: 'scalar',
    displayValue: valStr,
    elements: null,
    raw: valStr
  };
}

module.exports = {
  unescapeMIString,
  parseMILine,
  isUninitializedOrCorruptGdbValue,
  extractStdVectorPointers,
  extractStdStringValue,
  parseBraceElements,
  formatCppVariable
};
