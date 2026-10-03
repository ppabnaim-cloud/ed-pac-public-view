/**
 * ED / PAC OPERATIONAL & PUBLIC DASHBOARD  —  SERVER LAYER
 * Hospital Tengku Permaisuri Norashikin (HTPN), Kajang
 * Jabatan Kecemasan (ED) & Pusat Penilaian Pesakit (PAC)
 *
 * Google Apps Script web app. Deploy as: Execute as ME, Access ANYONE.
 * See README.md for deployment and for the Script Properties this reads.
 *
 * Design constraints honoured here:
 *   - Four scopes (ED WCC, ED BU, PAC WCC, Administrative) computed independently
 *     so each tab ships only the payload it renders.
 *   - Every aggregate carries its own n, so the client can suppress or caveat
 *     any statistic resting on too few observations instead of drawing it anyway.
 */

// ── CONFIGURATION ──────────────────────────────────────────
var SHEET_NAME = 'Sheet1';
var HEADER_ROW = 2;
var FIRST_DATA_ROW = 3;
var N_COLS = 20;
var N_COLS_MAX = 21;           // column 21 (Discharge Date/Time) is optional

var CACHE_SECS = 900;          // 15 minutes, matching the page's refresh cadence.
                               // Longer than it needs to be for freshness, but
                               // each miss re-reads and re-aggregates the whole
                               // register, so a short window buys nothing a
                               // waiting family can perceive.
var ADMIT_WINDOW_H = 24;       // admitted patients stay visible this long
var FORECAST_HORIZON = 4;      // hours projected forward
var MIN_N_WAIT = 10;
var GZ_AVERAGE_WINDOW = 10;   // green-zone average uses the last N patients called           // below this, waiting-time statistics are suppressed
/**
 * Public patient search is OFF unless the Script Property PUBLIC_SEARCH is
 * set to 'on'.
 *
 * Switched off at the hospital's direction. It was the only path by which the
 * public interface could reach an identifiable record; with it off, everything
 * the public side holds is a count. The implementation below is kept, masking
 * and rate limiting intact, so it can be restored with one property rather
 * than rewritten.
 */
var MIN_SEARCH_CHARS = 6;      // raised from 4: 4 characters permits enumeration
var MAX_SEARCH_RESULTS = 5;    // caps bulk extraction through the public search
var SEARCH_RATE_LIMIT = 20;    // searches per user per 10 minutes

// Column indices (1-based, matching the register's column order)
var COL = {
  location: 1, triageDT: 2, fullName: 3, initial: 4, ic: 5, mrn: 6,
  age: 7, gender: 8, zoneCode: 9, bedCode: 10, currentZone: 11, status: 12,
  referredTo: 13, qmsg: 14, callingGZ: 15, preadmitDT: 16, admitDT: 17,
  bwt: 18, twt: 19, gzwt: 20, dischargeDT: 21
};

/**
 * The bed establishment — the single source of truth for capacity, shared with
 * SetupSheet.gs (which generates the register) and with the bed board.
 *
 *   funded    normal capacity; the denominator for occupancy
 *   crisisTo  highest numbered escalation bed, so escalation = crisisTo - funded
 *   waiting   places in the waiting area; a queue position, never a bed
 *
 * Beds coded '...crisis' in the register are escalation capacity over and above
 * `funded`, counted separately and never folded into the denominator.
 * Override a funded figure with a Script Property, e.g. CAP_ED_BU_yz = 17.
 *
 * Yellow zone, main building: 16 funded, escalation 17-50. The departmental
 * specification begins its escalation list at buyz18 and omits 17; the
 * arithmetic of the full-capacity scenario (16 + 34 = 50 yellow-zone patients)
 * settles it as an escalation bed.
 */
var ESTABLISHMENT = [
  { location: 'ED WCC',  zone: 'rz',  prefix: 'wccrz',  funded: 4,  crisisTo: 10, unit: 'bed' },
  { location: 'ED WCC',  zone: 'yz',  prefix: 'wccyz',  funded: 4,  crisisTo: 12, unit: 'bed' },
  { location: 'ED WCC',  zone: 'ob',  prefix: 'wccob',  funded: 8,  crisisTo: 10, unit: 'bed' },
  { location: 'ED WCC',  zone: 'ab',  prefix: 'wccab',  funded: 4,  crisisTo: 4,  unit: 'sofa' },
  { location: 'ED WCC',  zone: 'gz',  prefix: 'wccgz',  funded: 2,  crisisTo: 2,  unit: 'room', waiting: 50 },
  { location: 'ED BU',   zone: 'rz',  prefix: 'burz',   funded: 6,  crisisTo: 12, unit: 'bed' },
  { location: 'ED BU',   zone: 'yz',  prefix: 'buyz',   funded: 16, crisisTo: 50, unit: 'bed' },
  { location: 'ED BU',   zone: 'gz',  prefix: 'bugz',   funded: 2,  crisisTo: 2,  unit: 'room', waiting: 50 },
  { location: 'PAC WCC', zone: 'pac', prefix: 'wccpac', funded: 8,  crisisTo: 15, unit: 'bed' }
];

/** Establishment row for a location and zone, or null. */
function establishmentFor_(location, zone) {
  for (var i = 0; i < ESTABLISHMENT.length; i++) {
    if (ESTABLISHMENT[i].location === location && ESTABLISHMENT[i].zone === zone) {
      return ESTABLISHMENT[i];
    }
  }
  return null;
}

// Zones whose 'beds' are in fact consultation rooms, and which run a queue.
var ROOM_ZONES = { gz: true };

// Physically present and under ED/PAC care.
var ACTIVE_STATUSES = ['ongoingtreatment', 'referred', 'preadmit'];
// Still occupying their bed or chair. An 'admitted' patient has physically
// moved to the ward, so is retained for family lookup but frees the bed;
// a 'discharge' patient is waiting for family to collect them and does not.
var BED_OCCUPYING_STATUSES = ['ongoingtreatment', 'referred', 'preadmit', 'discharge', 'discharged'];
var RETAINED_STATUSES = ['admitted', 'discharge', 'discharged'];
var DEATH_STATUSES  = ['death', 'deceased', 'bid', 'dead', 'mati'];

var SCOPES = {
  wcc:   { locations: ['ED WCC'] },
  bu:    { locations: ['ED BU'] },
  pac:   { locations: ['PAC WCC'] },
  admin: { locations: ['ED WCC', 'ED BU', 'PAC WCC'] }
};

var AGE_BANDS = [
  { label: '0-4',  lo: 0,  hi: 4 },   { label: '5-12', lo: 5,  hi: 12 },
  { label: '13-17',lo: 13, hi: 17 },  { label: '18-29',lo: 18, hi: 29 },
  { label: '30-44',lo: 30, hi: 44 },  { label: '45-59',lo: 45, hi: 59 },
  { label: '60-74',lo: 60, hi: 74 },  { label: '75+',  lo: 75, hi: 200 }
];

// ── ENTRY POINT ────────────────────────────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.api === 'status') return apiStatus_(p.key);
  var t = HtmlService.createTemplateFromFile('Index');
  t.bootScope = bootScope_(p.tab);
  t.bootMode = bootMode_(p.mode);
  t.bootSearch = searchEnabled_() ? '1' : '';
  t.bootData = bootData_();
  return t.evaluate()
    .setTitle('Status Pesakit — Jabatan Kecemasan & PAC | HTPN Kajang')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function prop_(key) {
  try { return PropertiesService.getScriptProperties().getProperty(key); }
  catch (err) { return null; }
}

// -- BOOT PAYLOAD ------------------------------------------
/**
 * Serialises an object for embedding straight into a <script> block. The
 * angle brackets and the ampersand are escaped so that no value can close the
 * script element early, and U+2028/9 because they are line terminators to a
 * JavaScript parser but legal inside a JSON string.
 */
function jsonForScript_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function bootScope_(v) { return (v && SCOPES[v]) ? v : 'wcc'; }

/** Public patient search: off unless PUBLIC_SEARCH is explicitly 'on'. */
function searchEnabled_() {
  return String(prop_('PUBLIC_SEARCH') || '').trim().toLowerCase() === 'on';
}

/** 'tv' turns on the wall-display layout and the health-promotion rail. */
function bootMode_(v) { return v === 'tv' ? 'tv' : ''; }

/**
 * The public payloads inlined into the page, taken from the cache ONLY.
 *
 * Deliberately never builds. doGet has to return the HTML as fast as it can,
 * and a cold cache here would make every visitor wait on a full register read
 * before a single pixel appeared. With warmCache running on its trigger the
 * cache is always warm, so this is a cache read and the page arrives with its
 * figures already in it -- no first round trip at all. When the cache is cold
 * this returns {} and the page fetches exactly as it used to.
 */
function bootData_() {
  try { return jsonForScript_(cachedPublicPayloads_()); }
  catch (err) { return '{}'; }
}

// -- JSON API ----------------------------------------------
/**
 * The aggregates, as JSON, for a front end hosted elsewhere.
 *
 * Returns exactly what the dashboard renders: counts, capacities and waiting
 * averages. It carries no name, IC or MRN by construction, and
 * tests/test_server.js asserts that against the real register rather than
 * trusting the construction.
 *
 * Optional shared key: set the Script Property API_TOKEN and callers must
 * pass ?key=<token>. Left unset the endpoint is open, which is the same
 * exposure as the HTML page it mirrors. Its purpose is not secrecy -- the
 * figures are published on a wall -- but keeping a scraper from spending the
 * script's daily execution quota and taking the dashboard down with it.
 */
function apiStatus_(key) {
  var want = prop_('API_TOKEN');
  if (want && String(key || '') !== String(want)) {
    return jsonOut_({ ok: false, error: 'UNAUTHORISED' });
  }
  try {
    var units = getPublicDashboards();
    if (units && units.error) return jsonOut_({ ok: false, error: units.error });
    return jsonOut_({
      ok: true,
      generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
      search: searchEnabled_(),
      units: units
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: 'SERVER_ERROR' });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── DATA ACCESS ────────────────────────────────────────────
/**
 * Reads the register. Prefers the bound spreadsheet; falls back to the
 * published CSV (Script Property CSV_URL) so the script also works when
 * deployed standalone.
 */
function readRegister_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { ss = null; }

  if (ss) {
    var sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    if (sh) {
      var lastRow = sh.getLastRow();
      if (lastRow < FIRST_DATA_ROW) return [];
      var width = Math.min(N_COLS_MAX, Math.max(N_COLS, sh.getLastColumn()));
      return sh.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, width).getValues();
    }
  }

  var url = prop_('CSV_URL');
  if (!url) throw new Error('NO_SOURCE');
  var csv = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText();
  var parsed = Utilities.parseCsv(csv);
  var out = [];
  for (var i = HEADER_ROW; i < parsed.length; i++) {
    var row = parsed[i], rec = [];
    for (var c = 0; c < N_COLS_MAX; c++) rec.push(row[c] === undefined ? '' : row[c]);
    out.push(rec);
  }
  return out;
}

function toDate_(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[, ]+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 'h:mm' or 'hh:mm' duration → minutes. */
function hhmmToMin_(v) {
  if (!v && v !== 0) return null;
  var s = String(v).trim();
  var m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) return (+m[1]) * 60 + (+m[2]);
  var n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 24 * 60);
}

function minToHhmm_(mins) {
  if (mins === null || mins === undefined || isNaN(mins)) return null;
  var m = Math.max(0, Math.round(mins));
  return Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2);
}

/**
 * Bed / position code grammar:
 *   <site><zone><NN>          funded bed          e.g. wccpac01, buyz17
 *   <site><zone><NN>crisis    escalation bed      e.g. buyz18crisis
 *   <site><zone>-waiting      queue slot, no bed  e.g. bugz-waiting
 */
function parseBed_(code) {
  var s = String(code || '').toLowerCase().trim();
  var m = s.match(/^(bu|wcc)(rz|yz|gz|ob|ab|pac)(?:(-waiting)|(\d+)(crisis)?)$/);
  if (!m) return { site: null, zone: null, waiting: false, crisis: false, num: null, valid: false };
  return {
    site: m[1], zone: m[2],
    waiting: !!m[3],
    crisis: !!m[5],
    num: m[4] ? parseInt(m[4], 10) : null,
    valid: true
  };
}

function capacityFor_(location, zone) {
  var override = prop_('CAP_' + String(location).replace(/\s+/g, '_') + '_' + zone);
  if (override !== null && override !== '' && !isNaN(parseInt(override, 10))) {
    return parseInt(override, 10);
  }
  var e = establishmentFor_(location, zone);
  return e ? e.funded : 0;
}

/** Escalation places configured for a zone (not how many are in use). */
function crisisCapacityFor_(location, zone) {
  var e = establishmentFor_(location, zone);
  return e ? Math.max(0, e.crisisTo - e.funded) : 0;
}

/** Normalises the raw sheet into typed records, once per request. */
function buildRecords_() {
  var raw = readRegister_();
  var recs = [];
  for (var i = 0; i < raw.length; i++) {
    var r = raw[i];
    var location = String(r[COL.location - 1] || '').trim();
    var triage = toDate_(r[COL.triageDT - 1]);
    if (!location && !triage) continue;               // blank spacer row

    var bed = parseBed_(r[COL.bedCode - 1]);
    var status = String(r[COL.status - 1] || '').toLowerCase().trim().replace(/\s+/g, '');
    var age = parseFloat(r[COL.age - 1]);

    recs.push({
      row: FIRST_DATA_ROW + i,
      location: location,
      triage: triage,
      fullName: String(r[COL.fullName - 1] || ''),
      ic: String(r[COL.ic - 1] || '').trim(),
      mrn: String(r[COL.mrn - 1] || '').trim(),
      age: isNaN(age) ? null : age,
      gender: String(r[COL.gender - 1] || '').trim(),
      zone: String(r[COL.zoneCode - 1] || '').toLowerCase().trim(),
      currentZone: String(r[COL.currentZone - 1] || '').toLowerCase().trim(),
      bedRaw: String(r[COL.bedCode - 1] || '').trim(),
      bed: bed,
      status: status,
      referredTo: String(r[COL.referredTo - 1] || '').trim(),
      queueNo: String(r[COL.qmsg - 1] || '').trim(),
      calledGZ: toDate_(r[COL.callingGZ - 1]),
      preadmit: toDate_(r[COL.preadmitDT - 1]),
      admit: toDate_(r[COL.admitDT - 1]),
      bwtMin: hhmmToMin_(r[COL.bwt - 1]),
      twtMin: hhmmToMin_(r[COL.twt - 1]),
      gzwtMin: hhmmToMin_(r[COL.gzwt - 1]),
      discharged: toDate_(r[COL.dischargeDT - 1])
    });
  }
  return recs;
}

/**
 * Reference clock. Live data → the real current time. A historical extract
 * (nothing in the last 24 h) → the latest recorded event, so elapsed times and
 * the "current hour" remain meaningful. The client labels which applies.
 */
function resolveRefTime_(recs) {
  var now = new Date();
  var latest = null;
  for (var i = 0; i < recs.length; i++) {
    var cands = [recs[i].triage, recs[i].preadmit, recs[i].admit, recs[i].calledGZ, recs[i].discharged];
    for (var j = 0; j < cands.length; j++) {
      if (cands[j] && (!latest || cands[j] > latest)) latest = cands[j];
    }
  }
  if (!latest) return { ref: now, isSnapshot: false, latest: null };
  var ageH = (now - latest) / 3600000;
  if (ageH > ADMIT_WINDOW_H) return { ref: latest, isSnapshot: true, latest: latest };
  return { ref: now, isSnapshot: false, latest: latest };
}

function isActive_(rec) { return ACTIVE_STATUSES.indexOf(rec.status) >= 0; }

/** True when the record still holds a bed, chair or consultation room. */
function occupiesBed_(rec) { return BED_OCCUPYING_STATUSES.indexOf(rec.status) >= 0; }

/**
 * Whether the record is still shown. Admitted and discharged patients are
 * retained for 24 hours so that family arriving late can still find them.
 * The register holds no discharge timestamp, so for discharged patients the
 * clock runs from admit time where present and otherwise from triage - see
 * the data-gap note in README.
 */
function countsInCensus_(rec, refTime) {
  if (isActive_(rec)) return true;
  if (RETAINED_STATUSES.indexOf(rec.status) < 0) return false;
  var stamp = rec.discharged || rec.admit || rec.triage;
  if (!stamp) return true;
  return (refTime - stamp) < ADMIT_WINDOW_H * 3600000;
}

// ── DESCRIPTIVE STATISTICS ─────────────────────────────────
function mean_(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }

function quantile_(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  var idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarise_(values) {
  var a = values.filter(function (v) { return v !== null && v !== undefined && !isNaN(v); })
                .slice().sort(function (x, y) { return x - y; });
  if (!a.length) return { n: 0 };
  return {
    n: a.length, min: a[0], max: a[a.length - 1], mean: mean_(a),
    p25: quantile_(a, 0.25), median: quantile_(a, 0.5), p75: quantile_(a, 0.75),
    p90: quantile_(a, 0.90)
  };
}

/** Fixed-width histogram. Values above the last edge collapse into an overflow bin. */
function histogram_(values, binWidth, maxEdge) {
  var a = values.filter(function (v) { return v !== null && !isNaN(v); });
  var nBins = Math.max(1, Math.ceil(maxEdge / binWidth));
  var bins = [];
  for (var i = 0; i < nBins; i++) {
    bins.push({ lo: i * binWidth, hi: (i + 1) * binWidth, count: 0, overflow: false });
  }
  bins.push({ lo: maxEdge, hi: null, count: 0, overflow: true });
  for (var k = 0; k < a.length; k++) {
    var v = a[k];
    if (v >= maxEdge) { bins[bins.length - 1].count++; continue; }
    var b = Math.min(nBins - 1, Math.floor(v / binWidth));
    bins[b].count++;
  }
  // Drop a trailing empty overflow bin so the axis is not padded for nothing.
  if (bins[bins.length - 1].count === 0) bins.pop();
  return { bins: bins, n: a.length, binWidth: binWidth };
}

/** Generic count matrix → { rows, cols, cells[r][c], max, total }. */
function matrix_(pairs) {
  var rowKeys = [], colKeys = [], map = {};
  for (var i = 0; i < pairs.length; i++) {
    var r = pairs[i][0], c = pairs[i][1];
    if (r === null || r === undefined || r === '' || c === null || c === undefined || c === '') continue;
    if (rowKeys.indexOf(r) < 0) rowKeys.push(r);
    if (colKeys.indexOf(c) < 0) colKeys.push(c);
    var k = r + '\u0000' + c;
    map[k] = (map[k] || 0) + 1;
  }
  rowKeys.sort(); colKeys.sort();
  var cells = [], max = 0, total = 0;
  for (var ri = 0; ri < rowKeys.length; ri++) {
    var line = [];
    for (var ci = 0; ci < colKeys.length; ci++) {
      var v = map[rowKeys[ri] + '\u0000' + colKeys[ci]] || 0;
      line.push(v); if (v > max) max = v; total += v;
    }
    cells.push(line);
  }
  return { rows: rowKeys, cols: colKeys, cells: cells, max: max, total: total };
}

function tally_(values) {
  var map = {}, order = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v === null || v === undefined || v === '') continue;
    if (!(v in map)) { map[v] = 0; order.push(v); }
    map[v]++;
  }
  var out = order.map(function (k) { return { key: k, count: map[k] }; });
  out.sort(function (a, b) { return b.count - a.count; });
  return out;
}

// ── FORECASTING ────────────────────────────────────────────
var Z80 = 1.2816, Z95 = 1.9600;

/**
 * Damped Holt linear trend (double exponential smoothing).
 * Damping keeps a 4-hour extrapolation from a short intraday series plausible.
 */
function dampedHolt_(y, alpha, beta, phi, h) {
  var n = y.length;
  if (n < 2) return null;
  var level = y[0], trend = y[1] - y[0], fitted = [];
  for (var t = 1; t < n; t++) {
    var oneStep = level + phi * trend;
    fitted.push(oneStep);
    var prevLevel = level;
    level = alpha * y[t] + (1 - alpha) * oneStep;
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  var point = [], cum = 0;
  for (var i = 1; i <= h; i++) {
    cum += Math.pow(phi, i);
    point.push(Math.max(0, level + cum * trend));
  }
  return { point: point, fitted: fitted, level: level, trend: trend };
}

/** Additive Holt-Winters, seasonal period m. Used once >= 3 full cycles exist. */
function holtWinters_(y, alpha, beta, gamma, m, h) {
  var n = y.length;
  if (n < 2 * m) return null;
  var cycles = Math.floor(n / m);
  var seasonal = [], i, j;
  var cycleMeans = [];
  for (i = 0; i < cycles; i++) {
    var s = 0;
    for (j = 0; j < m; j++) s += y[i * m + j];
    cycleMeans.push(s / m);
  }
  for (j = 0; j < m; j++) {
    var acc = 0;
    for (i = 0; i < cycles; i++) acc += y[i * m + j] - cycleMeans[i];
    seasonal.push(acc / cycles);
  }
  var level = cycleMeans[0];
  var trend = (cycleMeans[cycles - 1] - cycleMeans[0]) / Math.max(1, (cycles - 1) * m);
  var fitted = [];
  for (var t = 0; t < n; t++) {
    var si = t % m;
    var oneStep = level + trend + seasonal[si];
    if (t > 0) fitted.push(oneStep);
    var prevLevel = level;
    level = alpha * (y[t] - seasonal[si]) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[si] = gamma * (y[t] - level) + (1 - gamma) * seasonal[si];
  }
  var point = [];
  for (var k = 1; k <= h; k++) {
    point.push(Math.max(0, level + k * trend + seasonal[(n + k - 1) % m]));
  }
  return { point: point, fitted: fitted };
}

/**
 * Forecasts hourly arrivals. Counts, so a Poisson error structure
 * (variance = mean) supplies the prediction intervals.
 * Returns the model actually used and its in-sample one-step accuracy.
 */
function forecastArrivals_(series, horizon, skipSteps, startHour) {
  var y = series.map(function (p) { return p.count; });
  skipSteps = Math.max(0, skipSteps || 0);
  if (y.length < 2) {
    return { available: false, reason: 'INSUFFICIENT_HISTORY', n: y.length, horizon: horizon };
  }
  // Project far enough ahead to step over any recording gap, then keep only
  // the points that fall after the reference hour.
  var totalSteps = skipSteps + horizon;

  var m = 24, fit, modelKey, params;
  if (y.length >= 3 * m) {
    params = { alpha: 0.30, beta: 0.05, gamma: 0.30, m: m };
    fit = holtWinters_(y, params.alpha, params.beta, params.gamma, m, totalSteps);
    modelKey = 'holtWintersAdditive';
  }
  if (!fit) {
    params = { alpha: 0.40, beta: 0.15, phi: 0.85 };
    fit = dampedHolt_(y, params.alpha, params.beta, params.phi, totalSteps);
    modelKey = 'dampedHolt';
  }
  if (!fit) return { available: false, reason: 'FIT_FAILED', n: y.length, horizon: horizon };

  // One-step-ahead in-sample accuracy.
  var absErr = 0, sqErr = 0, cnt = 0;
  for (var i = 0; i < fit.fitted.length; i++) {
    var e = y[i + 1] - fit.fitted[i];
    absErr += Math.abs(e); sqErr += e * e; cnt++;
  }

  var baseHour = (startHour === null || startHour === undefined)
    ? (series[series.length - 1].hour + skipSteps + 1) % 24
    : startHour % 24;

  var points = [];
  for (var p = skipSteps; p < fit.point.length; p++) {
    var v = fit.point[p];
    var sd = Math.sqrt(Math.max(v, 0.5));   // floor avoids a zero-width band at yhat=0
    points.push({
      hour: (baseHour + (p - skipSteps)) % 24,
      step: p + 1,
      yhat: Math.round(v * 10) / 10,
      lo80: Math.max(0, Math.round((v - Z80 * sd) * 10) / 10),
      hi80: Math.round((v + Z80 * sd) * 10) / 10,
      lo95: Math.max(0, Math.round((v - Z95 * sd) * 10) / 10),
      hi95: Math.round((v + Z95 * sd) * 10) / 10
    });
  }

  return {
    available: true,
    model: modelKey,
    params: params,
    horizon: horizon,
    n: y.length,
    points: points,
    accuracy: cnt ? { mae: absErr / cnt, rmse: Math.sqrt(sqErr / cnt), n: cnt } : { n: 0 },
    errorStructure: 'poisson',
    skipSteps: skipSteps,
    stale: skipSteps >= 3
  };
}

/**
 * Deterministic census projection.
 *   C(t+1) = C(t) + A(t+1) - C(t)*(1 - exp(-1/Lbar))
 * Exponential length-of-stay assumption; Lbar from observed total waiting time.
 * The 80% arrival bounds are propagated to give a band rather than a single
 * line, and no probability of breach is quoted - with the observation counts
 * involved, a stated probability would imply precision the data cannot support.
 *
 * Headcount and bed demand are reported separately. Total census includes
 * patients queueing for a consultation room, who occupy no bed, so comparing
 * it against bed capacity would overstate occupancy several-fold.
 */
function projectCensus_(opts) {
  var forecast = opts.forecast;
  if (!forecast || !forecast.available) return { available: false };

  var lam = 1 - Math.exp(-1 / Math.max(0.5, opts.meanLosHours));
  function run(pick) {
    var c = opts.census, out = [];
    for (var i = 0; i < forecast.points.length; i++) {
      c = Math.max(0, c + pick(forecast.points[i]) - c * lam);
      out.push(Math.round(c * 10) / 10);
    }
    return out;
  }
  var mid = run(function (p) { return p.yhat; });
  var lo  = run(function (p) { return p.lo80; });
  var hi  = run(function (p) { return p.hi80; });

  var present = opts.bedded + opts.waiting;
  var beddedShare = present > 0 ? opts.bedded / present : 1;
  var beddedMid = mid.map(function (v) { return Math.round(v * beddedShare * 10) / 10; });
  var beddedHi  = hi.map(function (v) { return Math.round(v * beddedShare * 10) / 10; });

  var peakHead = Math.max.apply(null, hi);
  var peakBedded = Math.max.apply(null, beddedHi);
  var totalBeds = opts.fundedCapacity + opts.crisisOpen;

  return {
    available: true,
    hours: forecast.points.map(function (p) { return p.hour; }),
    mid: mid, lo80: lo, hi80: hi,
    beddedMid: beddedMid, beddedHi80: beddedHi,
    current: opts.census,
    beddedNow: opts.bedded,
    waitingNow: opts.waiting,
    beddedSharePct: Math.round(beddedShare * 1000) / 10,
    fundedCapacity: opts.fundedCapacity,
    crisisOpen: opts.crisisOpen,
    bedsAvailable: totalBeds,
    meanLosHours: Math.round(opts.meanLosHours * 100) / 100,
    losIsDefault: opts.losIsDefault,
    hourlyDischargeRate: Math.round(lam * 1000) / 1000,
    projectedPeakHeadcount: peakHead,
    projectedPeakBedded: peakBedded,
    projectedPeakBeddedPctOfFunded: opts.fundedCapacity > 0
      ? Math.round((peakBedded / opts.fundedCapacity) * 1000) / 10 : null,
    projectedPeakBeddedIsUpperBound: true,
    crisisBedsImplied: Math.max(0, Math.round(Math.max.apply(null, beddedMid) - opts.fundedCapacity))
  };
}


/**
 * Builds the plain-language narrative shown at the top of each public tab.
 * Deterministic and template-driven on purpose: a generative model writing
 * unreviewed clinical text onto a public hospital display is a governance
 * risk this dashboard does not take. See README, "Narrative generation".
 */
function buildNarrative_(k, occ, gz, forecast) {
  var out = [];

  var load = k.loadPct;
  var state = 'normal';
  if (k.crisisBeds > 0) state = 'crisis';
  else if (load !== null && load >= 100) state = 'full';
  else if (load !== null && load >= 80) state = 'busy';
  out.push({ key: 'narrCapacity', params: {
    state: state, pct: load, beds: k.fundedOccupied + k.crisisBeds, capacity: k.capacity
  } });

  if (k.crisisBeds > 0) {
    out.push({ key: 'narrCrisis', params: { crisis: k.crisisBeds } });
  }

  // Only worth saying when escalation beds are not already open — otherwise
  // the crisis line above has told the reader the same thing.
  if (k.crisisBeds === 0) {
    var fullZones = occ.filter(function (z) {
      return !z.isRoomZone && z.capacity > 0 && z.occupied >= z.capacity;
    }).map(function (z) { return z.zone.toUpperCase(); });
    if (fullZones.length) out.push({ key: 'narrZonesFull', params: { zones: fullZones } });
  }

  if (k.gzQueue > 0) {
    out.push({ key: 'narrGzQueue', params: {
      queue: k.gzQueue, rooms: k.gzRoomCapacity,
      avgMin: (gz && !gz.suppressed) ? gz.averageMin : null
    } });
  }

  if (k.preadmit > 0) out.push({ key: 'narrPreadmit', params: { n: k.preadmit } });

  if (forecast && forecast.available && forecast.points.length) {
    var next = forecast.points[0].yhat;
    var recent = k.lastHourArrivals;
    var dir = 'steady';
    if (recent !== null && recent !== undefined) {
      if (next > recent * 1.2) dir = 'rising';
      else if (next < recent * 0.8) dir = 'falling';
    }
    out.push({ key: 'narrForecast', params: {
      dir: dir, next: Math.round(next), hour: forecast.points[0].hour, stale: !!forecast.stale
    } });
  }

  out.push({ key: 'narrReassure', params: {} });
  return out;
}

// ── SCOPE AGGREGATION ──────────────────────────────────────
function occupancyFor_(recs, locations, refTime) {
  var zones = {};
  function ensure(loc, zone) {
    var key = loc + '|' + zone;
    if (!zones[key]) {
      zones[key] = {
        key: key, location: loc, zone: zone,
        capacity: capacityFor_(loc, zone),
        funded: 0, crisis: 0, waiting: 0,
        isRoomZone: !!ROOM_ZONES[zone]
      };
    }
    return zones[key];
  }
  // Seed every configured zone so an empty zone still renders a bar.
  for (var li = 0; li < locations.length; li++) {
    for (var ei = 0; ei < ESTABLISHMENT.length; ei++) {
      if (ESTABLISHMENT[ei].location === locations[li]) {
        ensure(locations[li], ESTABLISHMENT[ei].zone);
      }
    }
  }

  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (locations.indexOf(r.location) < 0) continue;
    if (!countsInCensus_(r, refTime)) continue;
    if (!occupiesBed_(r)) continue;              // admitted: gone to the ward
    var zone = r.bed.valid ? r.bed.zone : r.zone;
    if (!zone) continue;
    var slot = ensure(r.location, zone);
    if (r.bed.waiting) slot.waiting++;
    else if (r.bed.crisis) slot.crisis++;
    else slot.funded++;
  }

  var out = [];
  for (var k in zones) {
    if (!zones.hasOwnProperty(k)) continue;
    var s = zones[k];
    s.occupied = s.funded + s.crisis;
    s.occupancyPct = s.capacity > 0 ? Math.round((s.funded / s.capacity) * 1000) / 10 : null;
    s.loadPct = s.capacity > 0 ? Math.round((s.occupied / s.capacity) * 1000) / 10 : null;
    s.overCapacity = s.funded > s.capacity;   // config drift or uncoded escalation
    s.freeFunded = Math.max(0, s.capacity - s.funded);
    // Escalation beds in use while funded beds stand empty: the patients in
    // them can usually be stepped down, so surface it rather than hide it.
    s.stepDownCandidate = s.crisis > 0 && s.freeFunded > 0;
    out.push(s);
  }
  var order = ['rz', 'yz', 'ob', 'ab', 'gz', 'pac'];
  out.sort(function (a, b) {
    if (a.location !== b.location) return a.location < b.location ? -1 : 1;
    return order.indexOf(a.zone) - order.indexOf(b.zone);
  });
  return out;
}

/**
 * Arrivals per clock hour, zero-filled from the first arrival to the reference
 * hour so that quiet hours are visible rather than absent.
 *
 * A trailing run of zero-arrival hours before the reference hour almost always
 * means arrival recording has stopped, not that arrivals have stopped. The
 * model is therefore fitted only up to the last hour that recorded an arrival,
 * and the gap is reported so the client can say so on the chart.
 */
function arrivalSeries_(recs, refTime) {
  var byHour = {}, minH = null;
  for (var i = 0; i < recs.length; i++) {
    var t = recs[i].triage;
    if (!t) continue;
    var h = t.getHours();
    byHour[h] = (byHour[h] || 0) + 1;
    if (minH === null || h < minH) minH = h;
  }
  if (minH === null) {
    return { series: [], fitSeries: [], currentHour: null, trailingGapHours: 0, lastArrivalHour: null };
  }

  var currentHour = refTime.getHours();
  // Guard against a register that spans midnight or sits ahead of the clock.
  var spanEnd = currentHour >= minH ? currentHour : minH;
  var observedMax = minH;
  for (var k in byHour) { if (byHour.hasOwnProperty(k) && +k > observedMax) observedMax = +k; }
  if (observedMax > spanEnd) spanEnd = observedMax;

  var series = [];
  for (var h2 = minH; h2 <= spanEnd; h2++) {
    series.push({
      hour: h2,
      count: byHour[h2] || 0,
      partial: (h2 === currentHour && refTime.getMinutes() < 59)
    });
  }

  var complete = series.filter(function (p) { return !p.partial; });
  var lastNonZero = -1;
  for (var n = complete.length - 1; n >= 0; n--) {
    if (complete[n].count > 0) { lastNonZero = n; break; }
  }
  var fitSeries = lastNonZero >= 0 ? complete.slice(0, lastNonZero + 1) : [];
  var trailingGapHours = lastNonZero >= 0 ? (complete.length - 1 - lastNonZero) : 0;

  return {
    series: series,
    fitSeries: fitSeries,
    currentHour: currentHour,
    trailingGapHours: trailingGapHours,
    lastArrivalHour: lastNonZero >= 0 ? complete[lastNonZero].hour : null
  };
}

/**
 * Green-zone waiting time: triage to being called into a consultation room.
 * Derived from the two timestamps, which are more reliably populated than the
 * pre-computed GZWT column, and averaged over the most recent callsN patients
 * so the figure shown to waiting families reflects the current pace.
 */
function gzWaitStats_(recs, locations, callsN) {
  var called = [];
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (locations.indexOf(r.location) < 0) continue;
    var zone = r.bed.valid ? r.bed.zone : r.zone;
    if (zone !== 'gz') continue;
    if (!r.calledGZ || !r.triage) continue;
    var mins = (r.calledGZ - r.triage) / 60000;
    if (mins < 0 || mins > 24 * 60) continue;
    called.push({ at: r.calledGZ, mins: mins });
  }
  called.sort(function (a, b) { return a.at - b.at; });
  var recent = called.slice(-callsN).map(function (c) { return c.mins; });
  var all = called.map(function (c) { return c.mins; });
  return {
    nCalled: called.length,
    window: callsN,
    recentN: recent.length,
    averageMin: recent.length ? Math.round(mean_(recent)) : null,
    medianMin: all.length ? Math.round(quantile_(all.slice().sort(function (a, b) { return a - b; }), 0.5)) : null,
    summary: summarise_(all),
    suppressed: called.length < MIN_N_WAIT,
    lastCalledAt: called.length ? called[called.length - 1].at : null
  };
}

function elapsedMinutes_(rec, refTime) {
  if (!rec.triage) return null;
  var end = rec.admit || rec.discharged || refTime;
  var mins = (end - rec.triage) / 60000;
  return (mins >= 0 && mins < 72 * 60) ? mins : null;
}

function ageBand_(age) {
  if (age === null || age === undefined || isNaN(age)) return null;
  for (var i = 0; i < AGE_BANDS.length; i++) {
    if (age >= AGE_BANDS[i].lo && age <= AGE_BANDS[i].hi) return AGE_BANDS[i].label;
  }
  return null;
}

function pct_(num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : null; }

/**
 * Bed board: every bed position in the establishment, whether it is occupied,
 * and how long its occupant has been in the department.
 *
 * This is the operational view of bed management. It enumerates beds that do
 * NOT appear in the register as well as those that do, because an empty bed is
 * exactly what a bed manager is looking for, and a register only ever lists
 * occupied ones. Green-zone waiting places are excluded: a queue position is
 * not a bed, and mixing the two would misstate capacity.
 */
function bedBoard_(recs, locations, refTime) {
  // Index the occupants by bed code. Admitted patients have moved to the ward
  // and so release their bed, per occupiesBed_.
  var byCode = {};
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (locations.indexOf(r.location) < 0) continue;
    if (!countsInCensus_(r, refTime) || !occupiesBed_(r)) continue;
    if (!r.bed.valid || r.bed.waiting) continue;
    var code = r.bedRaw.toLowerCase();
    // Two records on one bed is a data error, not a fuller bed; keep the
    // longer-standing occupant and count the clash for the quality panel.
    var existing = byCode[code];
    if (!existing || (r.triage && existing.triage && r.triage < existing.triage)) {
      byCode[code] = r;
    }
  }

  var rows = [], maxBeds = 0, maxDwell = 0;
  var totals = { places: 0, occupied: 0, empty: 0, crisisPlaces: 0, crisisOccupied: 0 };

  for (var e = 0; e < ESTABLISHMENT.length; e++) {
    var est = ESTABLISHMENT[e];
    if (locations.indexOf(est.location) < 0) continue;

    var funded = capacityFor_(est.location, est.zone);
    var crisisPlaces = crisisCapacityFor_(est.location, est.zone);
    var beds = [];

    for (var n = 1; n <= funded + crisisPlaces; n++) {
      var isCrisis = n > funded;
      var code = est.prefix + ('0' + n).slice(-2) + (isCrisis ? 'crisis' : '');
      var occ = byCode[code] || null;
      var dwell = occ ? elapsedMinutes_(occ, refTime) : null;
      if (dwell !== null && dwell > maxDwell) maxDwell = dwell;

      beds.push({
        n: n, code: code, crisis: isCrisis,
        occupied: !!occ,
        dwellMin: dwell === null ? null : Math.round(dwell),
        status: occ ? occ.status : null,
        referredTo: occ ? occ.referredTo : ''
      });

      totals.places++;
      if (isCrisis) totals.crisisPlaces++;
      if (occ) { totals.occupied++; if (isCrisis) totals.crisisOccupied++; }
      else totals.empty++;
    }

    if (beds.length > maxBeds) maxBeds = beds.length;
    rows.push({
      location: est.location, zone: est.zone, unit: est.unit,
      funded: funded, crisisPlaces: crisisPlaces,
      occupiedFunded: beds.filter(function (b) { return b.occupied && !b.crisis; }).length,
      occupiedCrisis: beds.filter(function (b) { return b.occupied && b.crisis; }).length,
      emptyFunded: beds.filter(function (b) { return !b.occupied && !b.crisis; }).length,
      beds: beds
    });
  }

  var order = ['rz', 'yz', 'ob', 'ab', 'gz', 'pac'];
  rows.sort(function (a, b) {
    if (a.location !== b.location) return a.location < b.location ? -1 : 1;
    return order.indexOf(a.zone) - order.indexOf(b.zone);
  });

  return {
    rows: rows, maxBeds: maxBeds,
    maxDwellMin: Math.round(maxDwell),
    totals: totals,
    occupancyPct: totals.places > 0 ? Math.round((totals.occupied / totals.places) * 1000) / 10 : null
  };
}

/** Builds the full payload for one scope. */
function buildScope_(scopeKey, recs, refInfo) {
  var cfg = SCOPES[scopeKey];
  if (!cfg) throw new Error('BAD_SCOPE');
  var refTime = refInfo.ref;
  var locs = cfg.locations;

  var scoped = recs.filter(function (r) { return locs.indexOf(r.location) >= 0; });
  var inCensus = scoped.filter(function (r) { return countsInCensus_(r, refTime); });
  var active = scoped.filter(isActive_);

  var attendances = scoped.length;
  var admitted = scoped.filter(function (r) { return r.status === 'admitted'; }).length;
  var preadmitN = scoped.filter(function (r) { return r.status === 'preadmit'; }).length;
  var referredN = scoped.filter(function (r) { return r.status === 'referred'; }).length;
  var deaths = scoped.filter(function (r) { return DEATH_STATUSES.indexOf(r.status) >= 0; }).length;

  var occ = occupancyFor_(recs, locs, refTime);
  var totalCapacity = 0, totalFunded = 0, totalCrisis = 0, totalWaiting = 0;
  for (var i = 0; i < occ.length; i++) {
    totalCapacity += occ[i].capacity; totalFunded += occ[i].funded;
    totalCrisis += occ[i].crisis;     totalWaiting += occ[i].waiting;
  }

  // Waiting-time measures, each with its own n so the client can suppress.
  var elapsed = inCensus.map(function (r) { return elapsedMinutes_(r, refTime); })
                        .filter(function (v) { return v !== null; });
  var twt = scoped.map(function (r) { return r.twtMin; }).filter(function (v) { return v !== null; });
  var bwt = scoped.map(function (r) { return r.bwtMin; }).filter(function (v) { return v !== null; });
  var gzwt = scoped.map(function (r) { return r.gzwtMin; }).filter(function (v) { return v !== null; });

  var arrivals = arrivalSeries_(scoped, refTime);
  var forecast = forecastArrivals_(
    arrivals.fitSeries, FORECAST_HORIZON,
    arrivals.trailingGapHours, (refTime.getHours() + 1) % 24);
  if (forecast.available) forecast.trailingGapHours = arrivals.trailingGapHours;

  var twtSummary = summarise_(twt);
  var losIsDefault = twtSummary.n < 5;
  var meanLos = losIsDefault ? 4.0 : twtSummary.mean / 60;
  var projection = projectCensus_({
    census: inCensus.length,
    bedded: totalFunded + totalCrisis,
    waiting: totalWaiting,
    forecast: forecast,
    meanLosHours: meanLos,
    losIsDefault: losIsDefault,
    fundedCapacity: totalCapacity,
    crisisOpen: totalCrisis
  });

  // Heatmap 1 — arrival intensity, hour x zone.
  var hmHourZone = matrix_(scoped.map(function (r) {
    return [r.triage ? ('0' + r.triage.getHours()).slice(-2) + ':00' : null, (r.bed.valid ? r.bed.zone : r.zone).toUpperCase()];
  }));

  // Heatmap 2 — referral routes, zone x discipline.
  var hmZoneRef = matrix_(scoped.filter(function (r) { return r.referredTo; })
    .map(function (r) { return [(r.bed.valid ? r.bed.zone : r.zone).toUpperCase(), r.referredTo]; }));

  // Scatter — age against time already spent in the department (available for
  // every active record, unlike TWT which exists only for the admitted subset).
  var scatter = inCensus.map(function (r) {
    var e = elapsedMinutes_(r, refTime);
    if (r.age === null || e === null) return null;
    return {
      x: r.age, y: Math.round(e), z: (r.bed.valid ? r.bed.zone : r.zone),
      unit: r.location, admitted: r.status === 'admitted'
    };
  }).filter(function (v) { return v; });

  var gzZones = occ.filter(function (s) { return s.zone === 'gz'; });
  var gzQueue = 0, gzRooms = 0, gzRoomCap = 0;
  for (var g = 0; g < gzZones.length; g++) {
    gzQueue += gzZones[g].waiting; gzRooms += gzZones[g].funded; gzRoomCap += gzZones[g].capacity;
  }

  var gzStats = gzWaitStats_(recs, locs, GZ_AVERAGE_WINDOW);

  var unitCost = parseFloat(prop_('UNIT_COST_PER_ATTENDANCE'));
  var costConfigured = !isNaN(unitCost) && unitCost > 0;

  // Arrivals in the most recently completed hour, for the narrative's trend line.
  var lastHourArrivals = arrivals.fitSeries.length
    ? arrivals.fitSeries[arrivals.fitSeries.length - 1].count : null;

  var payload = {
    scope: scopeKey,
    locations: locs,
    refTime: Utilities.formatDate(refTime, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'),
    isSnapshot: refInfo.isSnapshot,

    kpi: {
      census: inCensus.length,
      attendances: attendances,
      active: active.length,
      admitted: admitted,
      preadmit: preadmitN,
      referred: referredN,
      deaths: deaths,
      deathFieldPresent: deaths > 0,
      capacity: totalCapacity,
      fundedOccupied: totalFunded,
      crisisBeds: totalCrisis,
      waiting: totalWaiting,
      occupancyPct: pct_(totalFunded, totalCapacity),
      loadPct: pct_(totalFunded + totalCrisis, totalCapacity),
      freeFundedBeds: Math.max(0, totalCapacity - totalFunded),
      admissionRatePct: pct_(admitted + preadmitN, attendances),
      referralRatePct: pct_(referredN, attendances),
      mortalityRatePct: pct_(deaths, attendances),
      gzQueue: gzQueue,
      gzRooms: gzRooms,
      gzRoomCapacity: gzRoomCap,
      medianElapsedMin: summarise_(elapsed).median,
      gzAverageWaitMin: gzStats.suppressed ? null : gzStats.averageMin,
      medianBwtMin: summarise_(bwt).n >= 5 ? summarise_(bwt).median : null,
      medianTwtMin: twtSummary.n >= 5 ? twtSummary.median : null,
      lastHourArrivals: lastHourArrivals,
      discharge: scoped.filter(function (r) {
        return r.status === 'discharge' || r.status === 'discharged';
      }).length,
      cost: costConfigured ? Math.round(attendances * unitCost) : null,
      costConfigured: costConfigured
    },

    occupancy: occ,
    gzWait: gzStats,
    statusMix: tally_(scoped.map(function (r) { return r.status; })),
    genderMix: tally_(scoped.map(function (r) { return r.gender; })),
    zoneMix: tally_(scoped.map(function (r) { return (r.bed.valid ? r.bed.zone : r.zone).toUpperCase(); })),
    referralMix: tally_(scoped.map(function (r) { return r.referredTo; })),
    ageBands: AGE_BANDS.map(function (b) {
      return { key: b.label, count: scoped.filter(function (r) { return ageBand_(r.age) === b.label; }).length };
    }),
    locationMix: tally_(scoped.map(function (r) { return r.location; })),
    statusByLocation: matrix_(scoped.map(function (r) { return [r.location, r.status]; })),

    arrivals: arrivals,
    forecast: forecast,
    projection: projection,

    waits: {
      elapsed:  { summary: summarise_(elapsed), histogram: histogram_(elapsed, 60, 720), suppressed: elapsed.length < MIN_N_WAIT },
      twt:      { summary: twtSummary,          histogram: histogram_(twt, 60, 480),     suppressed: twt.length < MIN_N_WAIT },
      bwt:      { summary: summarise_(bwt),     histogram: histogram_(bwt, 30, 240),     suppressed: bwt.length < MIN_N_WAIT },
      gzwt:     { summary: summarise_(gzwt),    suppressed: gzwt.length < MIN_N_WAIT },
      minN: MIN_N_WAIT
    },

    ageSummary: summarise_(scoped.map(function (r) { return r.age; })),
    heatmaps: { hourZone: hmHourZone, zoneReferral: hmZoneRef },
    bedBoard: bedBoard_(recs, locs, refTime),
    scatter: scatter,
    narrative: null
  };

  payload.narrative = buildNarrative_(payload.kpi, occ, gzStats, forecast);
  return payload;
}

// ── DATA QUALITY ───────────────────────────────────────────
function dataQuality_(recs, refTime) {
  var n = recs.length;
  var fields = [
    { key: 'triage',     n: recs.filter(function (r) { return r.triage; }).length },
    { key: 'age',        n: recs.filter(function (r) { return r.age !== null; }).length },
    { key: 'gender',     n: recs.filter(function (r) { return r.gender; }).length },
    { key: 'zone',       n: recs.filter(function (r) { return r.zone; }).length },
    { key: 'bedCode',    n: recs.filter(function (r) { return r.bed.valid; }).length },
    { key: 'status',     n: recs.filter(function (r) { return r.status; }).length },
    { key: 'referredTo', n: recs.filter(function (r) { return r.referredTo; }).length },
    { key: 'queueNo',    n: recs.filter(function (r) { return r.queueNo; }).length },
    { key: 'calledGZ',   n: recs.filter(function (r) { return r.calledGZ; }).length },
    { key: 'preadmit',   n: recs.filter(function (r) { return r.preadmit; }).length },
    { key: 'admit',      n: recs.filter(function (r) { return r.admit; }).length },
    { key: 'bwt',        n: recs.filter(function (r) { return r.bwtMin !== null; }).length },
    { key: 'twt',        n: recs.filter(function (r) { return r.twtMin !== null; }).length },
    { key: 'gzwt',       n: recs.filter(function (r) { return r.gzwtMin !== null; }).length }
  ].map(function (f) { f.pct = pct_(f.n, n); f.total = n; return f; });

  var flags = [];
  function flag(key, count, sample) {
    if (count > 0) flags.push({ key: key, count: count, sample: sample || null });
  }

  flag('badBedCode', recs.filter(function (r) { return r.bedRaw && !r.bed.valid; }).length);
  flag('zoneMismatch', recs.filter(function (r) {
    return r.bed.valid && r.zone && r.bed.zone !== r.zone;
  }).length);
  flag('currentZoneMismatch', recs.filter(function (r) {
    return r.zone && r.currentZone && r.zone !== r.currentZone;
  }).length);
  flag('pacNonFemale', recs.filter(function (r) {
    return r.location === 'PAC WCC' && r.gender && r.gender.toLowerCase() !== 'female';
  }).length);
  flag('honorificGenderMismatch', recs.filter(function (r) {
    var nm = ' ' + r.fullName.toLowerCase() + ' ';
    var g = r.gender.toLowerCase();
    if (nm.indexOf(' bin ') >= 0 && g === 'female') return true;
    if (nm.indexOf(' binti ') >= 0 && g === 'male') return true;
    return false;
  }).length);
  flag('admitBeforeTriage', recs.filter(function (r) {
    return r.admit && r.triage && r.admit < r.triage;
  }).length);
  flag('admittedNoAdmitTime', recs.filter(function (r) {
    return r.status === 'admitted' && !r.admit;
  }).length);
  flag('admittedNoPreadmit', recs.filter(function (r) {
    return r.status === 'admitted' && !r.preadmit;
  }).length);
  flag('queueNoOutsideGZ', recs.filter(function (r) {
    return r.queueNo && r.bed.valid && r.bed.zone !== 'gz';
  }).length);
  flag('futureTriage', recs.filter(function (r) {
    return r.triage && r.triage > new Date(refTime.getTime() + 60000);
  }).length);
  flag('duplicateMrn', (function () {
    var seen = {}, dup = 0;
    for (var i = 0; i < recs.length; i++) {
      if (!recs[i].mrn) continue;
      if (seen[recs[i].mrn]) dup++; else seen[recs[i].mrn] = 1;
    }
    return dup;
  })());

  // Zones where funded occupancy exceeds declared capacity — either the
  // capacity constant is stale or escalation beds are not coded 'crisis'.
  var capFlags = [];
  var occAll = occupancyFor_(recs, SCOPES.admin.locations, refTime);
  for (var i = 0; i < occAll.length; i++) {
    if (occAll[i].overCapacity) {
      capFlags.push({ location: occAll[i].location, zone: occAll[i].zone, funded: occAll[i].funded, capacity: occAll[i].capacity });
    }
  }

  var stepDown = [];
  for (var d = 0; d < occAll.length; d++) {
    if (occAll[d].stepDownCandidate) {
      stepDown.push({
        location: occAll[d].location, zone: occAll[d].zone,
        crisis: occAll[d].crisis, freeFunded: occAll[d].freeFunded
      });
    }
  }

  return { records: n, fields: fields, flags: flags, capacityFlags: capFlags, stepDown: stepDown };
}

// ── CLIENT API ─────────────────────────────────────────────
var PUBLIC_SCOPES = ['wcc', 'bu', 'pac'];
var DASH_CACHE_V = 'dash_v3_';

function dashKey_(scopeKey) { return DASH_CACHE_V + scopeKey; }

/**
 * Builds every public scope from ONE register read and caches each separately.
 *
 * The register is the expensive part: reading and parsing it costs the same
 * whether one tab or three are wanted, so doing it once for all three is very
 * nearly free compared with three separate invocations. Each payload is cached
 * under its own key because CacheService refuses a single entry over 100 KB.
 */
function buildPublicPayloads_() {
  var recs = buildRecords_();
  var refInfo = resolveRefTime_(recs);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss');
  var out = {}, store = {};
  for (var i = 0; i < PUBLIC_SCOPES.length; i++) {
    var k = PUBLIC_SCOPES[i];
    var payload = buildScope_(k, recs, refInfo);
    payload.generatedAt = stamp;
    out[k] = payload;
    store[dashKey_(k)] = JSON.stringify(payload);
  }
  try {
    CacheService.getScriptCache().putAll(store, CACHE_SECS);
  } catch (err) { /* oversize entry: serve this call uncached */ }
  return out;
}

/**
 * Reads whatever public payloads are already cached. Returns only the ones
 * present, so the caller can tell a warm cache from a cold one without paying
 * for a register read to find out.
 */
function cachedPublicPayloads_() {
  var out = {};
  try {
    var keys = [];
    for (var i = 0; i < PUBLIC_SCOPES.length; i++) keys.push(dashKey_(PUBLIC_SCOPES[i]));
    var hit = CacheService.getScriptCache().getAll(keys) || {};
    for (var j = 0; j < PUBLIC_SCOPES.length; j++) {
      var raw = hit[dashKey_(PUBLIC_SCOPES[j])];
      if (raw) out[PUBLIC_SCOPES[j]] = JSON.parse(raw);
    }
  } catch (err) { /* treat any cache fault as a cold cache */ }
  return out;
}

/**
 * All three public tabs in one call.
 *
 * Every google.script.run call is a cold server invocation — the runtime starts
 * and the whole script is parsed before a line of this runs — so the round trip
 * dominates, not the work. Shipping all three tabs together means the page
 * switches tabs with no further server call at all.
 */
function getPublicDashboards() {
  var cached = cachedPublicPayloads_();
  if (Object.keys(cached).length === PUBLIC_SCOPES.length) return cached;
  try {
    return buildPublicPayloads_();
  } catch (err) {
    return { error: 'SERVER_ERROR', message: String(err && err.message || err) };
  }
}

/** One public tab. Retained for the page's per-tab refresh path. */
function getDashboard(scopeKey) {
  scopeKey = SCOPES[scopeKey] ? scopeKey : 'wcc';
  if (scopeKey === 'admin') return { error: 'ADMIN_REQUIRES_TOKEN' };
  var cached = cachedPublicPayloads_();
  if (cached[scopeKey]) return cached[scopeKey];
  try {
    var all = buildPublicPayloads_();
    return all[scopeKey];
  } catch (err) {
    return { error: 'SERVER_ERROR', message: String(err && err.message || err) };
  }
}

/** Administrative payload. Requires a token from verifyAdmin(). */
function getAdminDashboard(token) {
  if (!checkAdminToken_(token)) return { error: 'UNAUTHORISED' };
  try {
    var recs = buildRecords_();
    var refInfo = resolveRefTime_(recs);
    var payload = buildScope_('admin', recs, refInfo);
    payload.dataQuality = dataQuality_(recs, refInfo.ref);
    payload.units = ['ED WCC', 'ED BU', 'PAC WCC'].map(function (loc) {
      var sub = recs.filter(function (r) { return r.location === loc; });
      var inC = sub.filter(function (r) { return countsInCensus_(r, refInfo.ref); });
      var occ = occupancyFor_(recs, [loc], refInfo.ref);
      var cap = 0, fund = 0, cris = 0;
      for (var i = 0; i < occ.length; i++) { cap += occ[i].capacity; fund += occ[i].funded; cris += occ[i].crisis; }
      return {
        location: loc,
        attendances: sub.length,
        census: inC.length,
        capacity: cap, funded: fund, crisis: cris,
        occupancyPct: pct_(fund, cap),
        admitted: sub.filter(function (r) { return r.status === 'admitted'; }).length,
        referred: sub.filter(function (r) { return r.status === 'referred'; }).length,
        preadmit: sub.filter(function (r) { return r.status === 'preadmit'; }).length,
        ongoing: sub.filter(function (r) { return r.status === 'ongoingtreatment'; }).length,
        medianAge: summarise_(sub.map(function (r) { return r.age; })).median
      };
    });
    payload.method = methodMetadata_(payload);
    payload.generatedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss');
    return payload;
  } catch (err) {
    return { error: 'SERVER_ERROR', message: String(err && err.message || err) };
  }
}

function methodMetadata_(payload) {
  var f = payload.forecast || {};
  return {
    forecastModel: f.model || null,
    forecastParams: f.params || null,
    forecastN: f.n || 0,
    horizon: FORECAST_HORIZON,
    errorStructure: 'Poisson (variance = mean); 80% = +/-1.2816*sqrt(yhat), 95% = +/-1.9600*sqrt(yhat)',
    accuracy: f.accuracy || null,
    censusModel: 'Deterministic flow C(t+1)=C(t)+A(t+1)-C(t)(1-exp(-1/Lbar)), exponential length-of-stay',
    meanLosHours: payload.projection && payload.projection.meanLosHours,
    losIsDefault: payload.projection && payload.projection.losIsDefault,
    excludesPartialHour: true,
    minNForWaitStats: MIN_N_WAIT,
    admitWindowHours: ADMIT_WINDOW_H
  };
}

// ── ADMIN ACCESS CONTROL ───────────────────────────────────
/**
 * Two routes. An email allow-list (ADMIN_EMAILS) is the stronger one but needs
 * the deployment to run as the accessing user. The passcode route works on an
 * anonymous deployment; it is rate-limited, but a shared passcode on a public
 * URL is inherently weaker than a separate restricted deployment. README refers.
 */
function verifyAdmin(passcode) {
  var emails = prop_('ADMIN_EMAILS');
  if (emails) {
    var me = '';
    try { me = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) { me = ''; }
    if (me) {
      var list = emails.toLowerCase().split(/[,;\s]+/).filter(function (s) { return s; });
      if (list.indexOf(me) >= 0) return { ok: true, token: issueAdminToken_(), via: 'email' };
    }
  }

  var stored = prop_('ADMIN_PASSCODE');
  if (!stored) return { ok: false, reason: 'NOT_CONFIGURED' };

  var cache = CacheService.getScriptCache();
  var idKey = 'adm_try_' + adminClientId_();
  var tries = parseInt(cache.get(idKey) || '0', 10);
  if (tries >= 5) return { ok: false, reason: 'RATE_LIMITED' };

  var given = String(passcode || '');
  if (!constantTimeEquals_(given, stored)) {
    cache.put(idKey, String(tries + 1), 900);
    return { ok: false, reason: 'BAD_CODE', remaining: Math.max(0, 4 - tries) };
  }
  cache.remove(idKey);
  return { ok: true, token: issueAdminToken_(), via: 'passcode' };
}

function adminClientId_() {
  var who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (e) { who = ''; }
  if (!who) { try { who = Session.getTemporaryActiveUserKey() || 'anon'; } catch (e2) { who = 'anon'; } }
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, who)).substring(0, 24);
}

function issueAdminToken_() {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('adm_tok_' + token, adminClientId_(), 1800);
  return token;
}

function checkAdminToken_(token) {
  if (!token) return false;
  var owner = CacheService.getScriptCache().get('adm_tok_' + String(token));
  return !!owner && owner === adminClientId_();
}

function constantTimeEquals_(a, b) {
  var sa = String(a), sb = String(b);
  var len = Math.max(sa.length, sb.length), diff = sa.length ^ sb.length;
  for (var i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ── PATIENT SEARCH (public) ────────────────────────────────
/**
 * Hardened relative to the original: a 6-character minimum, matching anchored
 * to the end of the IC or a whole MRN, a two-token requirement for name
 * searches, a hard cap on results and a per-user rate limit. Together these
 * stop the public endpoint being usable to enumerate the register.
 */
function getPatientStatus(query) {
  // Off by default. The masking, the result cap and the rate limit below all
  // still apply when it is switched back on; this is the outer gate.
  if (!searchEnabled_()) return { error: 'SEARCH_DISABLED' };
  var q = String(query || '').trim();
  if (q.length < MIN_SEARCH_CHARS) return { error: 'MIN_CHARS', minChars: MIN_SEARCH_CHARS };

  var cache = CacheService.getScriptCache();
  var rlKey = 'srch_' + adminClientId_();
  var used = parseInt(cache.get(rlKey) || '0', 10);
  if (used >= SEARCH_RATE_LIMIT) return { error: 'RATE_LIMITED' };
  cache.put(rlKey, String(used + 1), 600);

  var recs, refInfo;
  try {
    recs = buildRecords_();
    refInfo = resolveRefTime_(recs);
  } catch (err) {
    return { error: 'SERVER_ERROR' };
  }

  var lower = q.toLowerCase();
  var digits = q.replace(/\D/g, '');
  var nameTokens = lower.split(/\s+/).filter(function (s) { return s.length >= 2; });

  var matches = [];
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (!countsInCensus_(r, refInfo.ref)) continue;

    var hit = false;
    if (digits.length >= 6) {
      var icDigits = r.ic.replace(/\D/g, '');
      if (icDigits && icDigits.slice(-digits.length) === digits) hit = true;
      var mrnDigits = r.mrn.replace(/\D/g, '');
      if (!hit && mrnDigits && mrnDigits === digits) hit = true;
    }
    if (!hit && r.mrn && r.mrn.toLowerCase() === lower) hit = true;
    if (!hit && nameTokens.length >= 2) {
      var nm = r.fullName.toLowerCase();
      var all = true;
      for (var k = 0; k < nameTokens.length; k++) {
        if (nm.indexOf(nameTokens[k]) < 0) { all = false; break; }
      }
      if (all) hit = true;
    }
    if (hit) matches.push(r);
  }

  var truncated = matches.length > MAX_SEARCH_RESULTS;
  if (truncated) {
    // Too broad a query would leak a slice of the register — refuse rather than sample.
    return { error: 'TOO_MANY', found: matches.length, max: MAX_SEARCH_RESULTS };
  }

  return {
    results: matches.map(function (r) { return publicView_(r, refInfo.ref); }),
    refTime: Utilities.formatDate(refInfo.ref, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'),
    isSnapshot: refInfo.isSnapshot
  };
}

function publicView_(r, refTime) {
  var parts = r.fullName.split(/\s+/).filter(function (s) { return s; });
  var nameDisplay = parts.length > 1
    ? parts[0].charAt(0).toUpperCase() + '. ' + parts[parts.length - 1]
    : (parts[0] || '');
  var icDigits = r.ic.replace(/\D/g, '');
  return {
    nameDisplay: nameDisplay,
    icMasked: icDigits.length >= 4 ? '••••••-••-' + icDigits.slice(-4) : '••••',
    mrnMasked: r.mrn ? r.mrn.slice(0, 3) + '•••' + r.mrn.slice(-3) : '',
    location: r.location,
    zone: (r.bed.valid ? r.bed.zone : r.zone),
    status: r.status,
    isCrisisBed: !!r.bed.crisis,
    isWaiting: !!r.bed.waiting,
    referredTo: r.referredTo,
    queueNo: r.queueNo,
    triage: r.triage ? Utilities.formatDate(r.triage, Session.getScriptTimeZone(), 'dd/MM HH:mm') : '',
    calledGZ: r.calledGZ ? Utilities.formatDate(r.calledGZ, Session.getScriptTimeZone(), 'dd/MM HH:mm') : '',
    preadmit: r.preadmit ? Utilities.formatDate(r.preadmit, Session.getScriptTimeZone(), 'dd/MM HH:mm') : '',
    admitted: r.admit ? Utilities.formatDate(r.admit, Session.getScriptTimeZone(), 'dd/MM HH:mm') : '',
    elapsed: minToHhmm_(elapsedMinutes_(r, refTime)),
    bwt: minToHhmm_(r.bwtMin),
    twt: minToHhmm_(r.twtMin)
  };
}

// ── POSTER IMAGES ──────────────────────────────────────────
/** Drive file IDs come from Script Properties so they are not hard-coded. */
function getImages() {
  var out = {};
  var map = {
    iqms:   prop_('IMG_IQMS_ID')   || '1YsUupb78S4GxlyEt5vtAV6m-TG27Rm96',
    poster: prop_('IMG_POSTER_ID') || '1QCIpKNxvh1FR94MQPW8tnKjoDwFcgQ4P'
  };
  for (var k in map) {
    if (!map.hasOwnProperty(k)) continue;
    try {
      var blob = DriveApp.getFileById(map[k]).getBlob();
      out[k] = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
    } catch (err) {
      out[k] = null;
    }
  }
  return out;
}

// ── DIAGNOSTICS ────────────────────────────────────────────
/**
 * Run this from the Apps Script editor (Run > checkSetup) and read the
 * execution log. It answers, in order, the questions that actually go wrong:
 * is the access code saved, can the register be read, does it parse, and does
 * each tab build.
 *
 * Script Properties are only stored once "Save script properties" is pressed;
 * typing into the boxes and navigating away silently discards them, which
 * looks identical to having set the value.
 */
function checkSetup() {
  var out = [];
  function say(line) { out.push(line); Logger.log(line); }

  say('ED/PAC dashboard — setup check');
  say('================================');

  // 1. Access code
  var code = prop_('ADMIN_PASSCODE');
  if (code === null || code === '') {
    say('[FAIL] ADMIN_PASSCODE is NOT set.');
    say('       Project Settings > Script properties > Edit script properties');
    say('       > add ADMIN_PASSCODE > Save script properties.');
    say('       If you typed it in and did not press Save, it was not kept.');
  } else {
    say('[ ok ] ADMIN_PASSCODE is set (' + String(code).length + ' characters).');
    if (/^\s|\s$/.test(String(code))) {
      say('[WARN] It begins or ends with a space, which must be typed exactly.');
    }
  }

  var emails = prop_('ADMIN_EMAILS');
  say(emails ? '[ ok ] ADMIN_EMAILS is set: ' + emails
             : '[note] ADMIN_EMAILS not set (optional; passcode is used).');

  // 2. The register
  var rows;
  try {
    rows = readRegister_();
    say('[ ok ] Register readable — ' + rows.length + ' data rows.');
  } catch (err) {
    say('[FAIL] Cannot read the register: ' + (err && err.message || err));
    say('       The script must be bound to the spreadsheet, or CSV_URL set.');
    return out.join('\n');
  }
  if (!rows.length) {
    say('[FAIL] No data rows. Data must start on row ' + FIRST_DATA_ROW +
        ' with the header on row ' + HEADER_ROW + '.');
    return out.join('\n');
  }

  // 3. Parsing
  var recs, refInfo;
  try {
    recs = buildRecords_();
    refInfo = resolveRefTime_(recs);
    say('[ ok ] Parsed ' + recs.length + ' records.');
    say('       Reference time: ' +
        Utilities.formatDate(refInfo.ref, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') +
        (refInfo.isSnapshot ? '  (historical snapshot — nothing in the last 24 h)' : '  (live)'));
  } catch (err) {
    say('[FAIL] Could not parse the register: ' + (err && err.message || err));
    return out.join('\n');
  }

  var badBed = recs.filter(function (r) { return r.bedRaw && !r.bed.valid; });
  say(badBed.length
    ? '[WARN] ' + badBed.length + ' unrecognised bed codes, e.g. "' + badBed[0].bedRaw + '".'
    : '[ ok ] All bed codes recognised.');

  var noTriage = recs.filter(function (r) { return !r.triage; }).length;
  if (noTriage) {
    say('[WARN] ' + noTriage + ' rows have no readable triage time. Format the ' +
        'column as date-time (dd/mm/yyyy hh:mm).');
  }

  // 4. Each tab
  ['wcc', 'bu', 'pac', 'admin'].forEach(function (scope) {
    try {
      var p = buildScope_(scope, recs, refInfo);
      say('[ ok ] ' + scope + ': ' + p.kpi.census + ' present, ' +
          p.kpi.fundedOccupied + '/' + p.kpi.capacity + ' normal beds, ' +
          p.kpi.crisisBeds + ' crisis beds, ' + p.kpi.waiting + ' waiting.');
    } catch (err) {
      say('[FAIL] ' + scope + ' failed to build: ' + (err && err.message || err));
    }
  });

  say('================================');
  say(code ? 'Open the Administrative tab and enter the access code above.'
           : 'Set ADMIN_PASSCODE, then reload the web app.');
  return out.join('\n');
}

/**
 * Run this ONE function after pasting a new build: Run > repairSetup, then
 * read the execution log.
 *
 * It checks what checkSetup checks, then does the three things that are
 * actually needed to get a working deployment -- primes the cache, installs
 * the warming trigger, and prints the web app URL -- so there is no checklist
 * to follow and no URL to go hunting for. Safe to run as often as you like:
 * nothing here writes to the register.
 */
function repairSetup() {
  var out = [];
  function say(line) { out.push(line); try { Logger.log(line); } catch (e) {} }

  say('ED/PAC dashboard \u2014 repair');
  say('==================================================');

  // 1-4. Everything checkSetup already establishes.
  var check = checkSetup();
  say(check);
  say('==================================================');

  // 5. Patient search: off is the intended state.
  say(searchEnabled_()
    ? '[WARN] Patient search is ON (PUBLIC_SEARCH=on). The public interface ' +
      'can reach an identifiable record. Remove the property to switch it off.'
    : '[ ok ] Patient search is off. The public side holds counts only.');

  // 6. Prime the cache, so the first visitor does not pay for the register read.
  try {
    var t0 = new Date().getTime();
    var built = buildPublicPayloads_();
    say('[ ok ] Cache primed: ' + Object.keys(built).length + ' public payloads in ' +
        (new Date().getTime() - t0) + ' ms.');
  } catch (err) {
    say('[FAIL] Could not build the public payloads: ' + (err && err.message || err));
  }

  // 7. The warming trigger.
  if (typeof ScriptApp === 'undefined') {
    say('[FAIL] ScriptApp unavailable \u2014 the script is not authorised yet.');
    say('       Run this function again and accept the permissions prompt.');
  } else {
    try {
      var had = 0;
      var trs = ScriptApp.getProjectTriggers();
      for (var i = 0; i < trs.length; i++) if (trs[i].getHandlerFunction() === 'warmCache') had++;
      installWarmTrigger();
      say(had ? '[ ok ] Warming trigger reinstalled (every 10 minutes).'
              : '[ ok ] Warming trigger installed (every 10 minutes).');
    } catch (err) {
      say('[WARN] Could not install the warming trigger: ' + (err && err.message || err));
      say('       The dashboard still works; each visitor pays for the register read.');
    }
  }

  // 8. The link. This is the canonical /exec URL -- never the /u/N/ form the
  // editor shows while several Google accounts are signed in, which resolves
  // for nobody else and answers with a Google Drive error page.
  say('==================================================');
  var url = null;
  try { url = ScriptApp.getService().getUrl(); } catch (err) { url = null; }
  if (url) {
    say('[ ok ] Web app URL (share this one):');
    say('       ' + url);
    say('');
    say('       Wall display:  ' + url + '?mode=tv');
    say('       Public JSON:   ' + url + '?api=status');
    say('       Put that /exec URL in Vercel as APPS_SCRIPT_URL.');
    if (url.indexOf('/u/') >= 0) {
      say('[WARN] That URL contains /u/N/. Take the one from');
      say('       Deploy > Manage deployments instead.');
    }
  } else {
    say('[FAIL] This script has no active web app deployment.');
    say('       Deploy > New deployment > type: Web app');
    say('         Execute as:      Me');
    say('         Who has access:  Anyone');
    say('       Then run repairSetup again to get the URL.');
  }
  say('==================================================');
  return out.join('\n');
}

// ── MAINTENANCE ────────────────────────────────
function clearCaches() {
  var keys = [];
  for (var i = 0; i < PUBLIC_SCOPES.length; i++) keys.push(dashKey_(PUBLIC_SCOPES[i]));
  CacheService.getScriptCache().removeAll(keys);
  return 'cleared';
}

/**
 * Recomputes every public payload and puts it back in the cache.
 *
 * Driven by a time-driven trigger (see installWarmTrigger) so that no visitor
 * ever pays for the register read. With this running, a visitor's doGet finds
 * the figures already built and inlines them into the page: the first paint
 * carries real numbers and the first server round trip disappears entirely.
 */
function warmCache() {
  var t0 = new Date().getTime();
  var all = buildPublicPayloads_();
  var msg = 'warmCache: ' + Object.keys(all).length + ' public payloads rebuilt in ' +
            (new Date().getTime() - t0) + ' ms';
  try { Logger.log(msg); } catch (err) { /* no logger outside the editor */ }
  return msg;
}

/**
 * Installs the warming trigger. Run once from the editor (Run >
 * installWarmTrigger) and authorise when prompted — this needs the
 * script.scriptapp scope, which the dashboard did not previously use.
 *
 * Ten minutes against a fifteen-minute cache leaves five minutes of overlap,
 * so an entry is always replaced before it expires and the cache never goes
 * cold under a visitor.
 */
function installWarmTrigger() {
  if (typeof ScriptApp === 'undefined') {
    return 'ScriptApp is not available: authorise the script first (Run > ' +
           'repairSetup, then accept the permissions prompt).';
  }
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'warmCache') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('warmCache').timeBased().everyMinutes(10).create();
  warmCache();
  return 'warmCache installed: every 10 minutes. Cache primed now.';
}

/** Removes the warming trigger. */
function removeWarmTrigger() {
  if (typeof ScriptApp === 'undefined') return 'ScriptApp is not available.';
  var existing = ScriptApp.getProjectTriggers();
  var n = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'warmCache') { ScriptApp.deleteTrigger(existing[i]); n++; }
  }
  return 'removed ' + n + ' warming trigger(s)';
}
