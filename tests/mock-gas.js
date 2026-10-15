/* Minimal in-memory mocks of the Google Apps Script services used by Code.gs. No dependencies. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

/* Sheets stores "'=x" as the text "=x" (the apostrophe only means "plain text"). */
function storeValue(v) {
  if (typeof v === 'string' && v.charAt(0) === "'") return { value: v.slice(1), forcedText: true, raw: v };
  return { value: v, forcedText: false, raw: v };
}

class MockRange {
  constructor(sheet, row, col, nRows, nCols) { Object.assign(this, { sheet, row, col, nRows, nCols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nRows; r++) {
      const line = [];
      for (let c = 0; c < this.nCols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    vals.forEach((line, r) => line.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  setFontWeight() { return this; }
}

class MockSheet {
  constructor(name) { this.name = name; this.cells = []; this.rawWrites = []; }
  _ensure(r) { while (this.cells.length < r) this.cells.push([]); }
  _get(r, c) { const row = this.cells[r - 1]; const cell = row && row[c - 1]; return cell === undefined ? '' : cell.value; }
  _set(r, c, v) {
    this._ensure(r);
    const s = storeValue(v);
    this.cells[r - 1][c - 1] = s;
    this.rawWrites.push(s.raw);
  }
  getName() { return this.name; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, nRows, nCols) { return new MockRange(this, row, col, nRows || 1, nCols || 1); }
  getDataRange() { return new MockRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(vals) { const r = this.cells.length + 1; vals.forEach((v, i) => this._set(r, i + 1, v)); return this; }
  setFrozenRows() {} setColumnWidth() {} setRightToLeft() {}
  /* test helpers */
  rowsAsObjects() {
    const h = (this.cells[0] || []).map(c => c && c.value);
    return this.cells.slice(1).map(row => { const o = {}; h.forEach((k, i) => { o[k] = row[i] ? row[i].value : ''; o['__raw_' + k] = row[i] ? row[i].raw : ''; }); return o; });
  }
}

class MockSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { this.sheets[n] = new MockSheet(n); return this.sheets[n]; }
}

function createEnv(opts) {
  opts = opts || {};
  const ss = new MockSpreadsheet();
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const mails = [];
  const logs = [];
  let lockHeld = 0, lockCalls = 0;

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (opts.lockFails) return false; lockHeld++; lockCalls++; return true; },
        waitLock: () => { lockHeld++; lockCalls++; },
        releaseLock: () => { lockHeld--; }
      })
    },
    CacheService: {
      getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ _text: text, _mime: null, setMimeType(m) { this._mime = m; return this; }, getContent() { return this._text; } })
    },
    MailApp: { sendEmail: m => mails.push(m) },
    Utilities: { getUuid: () => crypto.randomUUID(), sleep: () => {} },
    Logger: { log: m => logs.push(String(m)) }
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });

  const parse = out => {
    if (out._mime !== 'application/json') throw new Error('response is not JSON mime: ' + out._mime);
    return JSON.parse(out.getContent());
  };
  return {
    ss, props, mails, logs, sandbox,
    get lockHeld() { return lockHeld; }, get lockCalls() { return lockCalls; },
    post: body => parse(sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'text/plain' } })),
    get: params => parse(sandbox.doGet({ parameter: params || {} })),
    rawGet: params => sandbox.doGet({ parameter: params || {} }).getContent(),
    run: fn => sandbox[fn](),
    sheet: n => ss.getSheetByName(n)
  };
}

module.exports = { createEnv };
