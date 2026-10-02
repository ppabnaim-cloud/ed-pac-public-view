// Minimal Apps Script service stubs so Code.gs can be exercised under Node.
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'register.json'), 'utf8'));
const REGISTER = raw.map(r => r.map(v => (v && typeof v === 'object' && v.__date) ? new Date(v.__date) : v));

const _props = {};
const _cache = {};
global.PropertiesService = { getScriptProperties: () => ({ getProperty: k => (k in _props ? _props[k] : null) }) };
global.CacheService = {
  getScriptCache: () => ({
    get: k => (k in _cache ? _cache[k] : null),
    getAll: ks => { const o = {}; ks.forEach(k => { if (k in _cache) o[k] = _cache[k]; }); return o; },
    put: (k, v) => { _cache[k] = v; },
    putAll: obj => { Object.keys(obj).forEach(k => { _cache[k] = obj[k]; }); },
    remove: k => { delete _cache[k]; },
    removeAll: ks => ks.forEach(k => delete _cache[k])
  })
};
global.__CACHE__ = _cache;
const _triggers = [];
global.ScriptApp = {
  getProjectTriggers: () => _triggers.slice(),
  deleteTrigger: tr => { const i = _triggers.indexOf(tr); if (i >= 0) _triggers.splice(i, 1); },
  newTrigger: fn => {
    const tr = { getHandlerFunction: () => fn, _every: null };
    return { timeBased: () => ({ everyMinutes: m => ({ create: () => { tr._every = m; _triggers.push(tr); return tr; } }) }) };
  }
};
global.Logger = { log: () => {} };
global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: text => {
    const o = { _text: text, _mime: null,
      setMimeType(m) { o._mime = m; return o; },
      getContent: () => o._text, getMimeType: () => o._mime };
    return o;
  }
};
global.__PROPS__ = _props;
function pad(n, w) { return ('000' + n).slice(-w); }
global.Utilities = {
  formatDate: (d, tz, fmt) => fmt
    .replace('dd', pad(d.getDate(), 2)).replace('MM', pad(d.getMonth() + 1, 2))
    .replace('yyyy', d.getFullYear()).replace('HH', pad(d.getHours(), 2))
    .replace('mm', pad(d.getMinutes(), 2)).replace('ss', pad(d.getSeconds(), 2)),
  getUuid: () => 'uuid-' + Math.random().toString(36).slice(2),
  base64Encode: b => Buffer.from(b).toString('base64'),
  base64EncodeWebSafe: b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_'),
  computeDigest: (alg, s) => require('crypto').createHash('sha256').update(String(s)).digest(),
  DigestAlgorithm: { SHA_256: 'sha256' },
  parseCsv: t => t.split('\n').map(l => l.split(','))
};
global.Session = {
  getScriptTimeZone: () => 'Asia/Kuala_Lumpur',
  getActiveUser: () => ({ getEmail: () => '' }),
  getTemporaryActiveUserKey: () => 'testuser'
};
global.SpreadsheetApp = { getActiveSpreadsheet: () => null };
global.HtmlService = { createTemplateFromFile: () => ({ evaluate: () => ({}) }), createHtmlOutputFromFile: () => ({ getContent: () => '' }) };
global.DriveApp = { getFileById: () => { throw new Error('no drive in test'); } };
global.UrlFetchApp = { fetch: () => ({ getContentText: () => '' }) };

// Load Code.gs into this global scope.
const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
(0, eval)(src);

// Override the source reader to serve the fixture.
global.readRegister_ = () => REGISTER;
readRegister_ = () => REGISTER;

module.exports = { REGISTER };
