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
    put: (k, v) => { _cache[k] = v; },
    remove: k => { delete _cache[k]; },
    removeAll: ks => ks.forEach(k => delete _cache[k])
  })
};
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
