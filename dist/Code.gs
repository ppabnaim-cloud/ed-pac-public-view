/**
 * ============================================================================
 * ED / PAC REAL-TIME DASHBOARD  —  SINGLE-FILE BUILD
 * Jabatan Kecemasan & Pusat Penilaian Pesakit
 * Hospital Tengku Permaisuri Norashikin (HTPN), Kajang
 * ============================================================================
 *
 * GENERATED FILE — do not edit by hand.
 * Built from Code.gs, SetupSheet.gs, Illustrations.gs and the five page files
 * by build/bundle.js. Edit those and rebuild; edits made here are lost.
 *
 * TO DEPLOY
 *   1. Open the script bound to your tracking spreadsheet.
 *   2. Select everything in Code.gs and paste this over it. Save.
 *   3. Project Settings -> Script Properties -> add ADMIN_PASSCODE
 *      (without it the Administrative tab will not open).
 *   4. Deploy -> Manage deployments -> edit the existing deployment ->
 *      Version: New version -> Deploy.
 *      Editing the existing deployment KEEPS the same /exec URL.
 *   5. Re-authorise when prompted; the required scopes have changed.
 *
 * READS your existing Sheet1 as it stands: 20 columns, header on row 2, data
 * from row 3. Column 21 (Discharge Date/Time) is used if present and ignored
 * if not. You do NOT need to rebuild the sheet to deploy this.
 *
 * The "ED/PAC Register" menu can generate a fresh register and a demonstration
 * scenario. Those items CLEAR Sheet1 — run them on a copy, never on live data.
 *
 * Built 2026-10-03 05:27 UTC
 * ============================================================================
 */


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
  var scope = bootScope_(p.tab);
  var mode = bootMode_(p.mode);
  var search = searchEnabled_() ? '1' : '';
  var posters = jsonForScript_(getPosters());
  var data = bootData_();
  // Function replacements, because a dollar sign followed by a quote or an
  // ampersand in the payload would otherwise be read as a back-reference.
  var html = PAGE_HTML
    .replace('__BOOT_SCOPE__', function () { return scope; })
    .replace('__BOOT_MODE__', function () { return mode; })
    .replace('__BOOT_SEARCH__', function () { return search; })
    .replace('__BOOT_POSTERS__', function () { return posters; })
    .replace('__BOOT_DATA__', function () { return data; });
  return HtmlService.createHtmlOutput(html)
    .setTitle('Status Pesakit \u2014 Jabatan Kecemasan & PAC | HTPN Kajang')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get('dash_v3_admin');
    if (hit) return JSON.parse(hit);
  } catch (err) { /* cache miss or oversize entry: rebuild below */ }
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
    try { cache.put('dash_v3_admin', JSON.stringify(payload), CACHE_SECS); }
    catch (e2) { /* over 100 KB: serve uncached */ }
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

/**
 * Who a session token belongs to.
 *
 * This used to fall back to Session.getTemporaryActiveUserKey() when no email
 * was available, which is the normal case on a deployment set to "Anyone".
 * That key is documented as TEMPORARY: it rotates, so a token issued under one
 * value stopped validating under the next and the Administrative tab locked
 * itself out at random, mid-session, with the correct passcode.
 *
 * On an anonymous deployment the token is a bearer credential and nothing
 * else: an unguessable UUID held in the script cache for thirty minutes.
 * Binding it to a value that changes underneath it bought no security --
 * whoever held the token would have been issued the rotating key too -- and
 * cost reliability. Where a real identity IS available the binding stays.
 */
function adminClientId_() {
  var who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (e) { who = ''; }
  if (!who) return 'anon';
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
/**
 * The hospital's own posters, by tab.
 *
 * Served as Drive image URLs rather than base64 through this script. The
 * originals are 2.4 MB and 21 MB; inlining the second would be some 28 MB of
 * base64 in a single response, which Apps Script will not carry and no phone
 * on hospital wifi should be asked to download. The Drive CDN resizes on
 * request, so the page asks for the width it needs.
 *
 * BOTH FILES MUST BE SHARED "Anyone with the link can view", or the image
 * will not load for the public. Override either with a Script Property.
 */
function posterIds_() {
  return {
    // "Banting iQMS2.jpg"
    iqms:   prop_('IMG_IQMS_ID')   || '1QCIpKNxvh1FR94MQPW8tnKjoDwFcgQ4P',
    // "Poster Size HOSPITAL TENGKU PERMAISURI NORASHIKIN.png"
    triage: prop_('IMG_TRIAGE_ID') || prop_('IMG_POSTER_ID') ||
            '1YsUupb78S4GxlyEt5vtAV6m-TG27Rm96'
  };
}

/**
 * The hospital's live queue page, as printed on the iQMS poster. Anyone
 * reading this on a phone already has a browser open, so give them the link
 * rather than a QR code to photograph off their own screen.
 */
function iqmsUrl_() {
  return prop_('IQMS_URL') || 'https://jknselangor.moh.gov.my/htpn/qms';
}

/** Drive's image CDN, which resizes to the requested width. */
function posterUrl_(id, width) {
  return 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(id) + '=w' + (width || 1600);
}

/**
 * The poster URLs the page needs, at two widths: one for a phone, one for a
 * wall display. No image data passes through this script.
 */
function getPosters() {
  var ids = posterIds_(), out = {};
  for (var k in ids) {
    if (!ids.hasOwnProperty(k)) continue;
    out[k] = ids[k] ? { id: ids[k], src: posterUrl_(ids[k], 1600), srcLarge: posterUrl_(ids[k], 2400) }
                    : null;
  }
  out.iqmsUrl = iqmsUrl_();
  return out;
}

/** Retained for Illustrations.gs, which composes with the posters offline. */
function getImages() {
  var ids = posterIds_();
  var out = {};
  for (var k in ids) {
    if (!ids.hasOwnProperty(k)) continue;
    try {
      var blob = DriveApp.getFileById(ids[k]).getBlob();
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
    say('[ ok ] Web app URL (share this one, exactly as printed):');
    say('       ' + url);
    say('');
    say('       Wall display:  ' + url + '?mode=tv');
    say('       Public JSON:   ' + url + '?api=status');
    say('       Put that /exec URL in Vercel as APPS_SCRIPT_URL.');
    // A Google Workspace account deploys to a domain-scoped address. Dropping
    // the /a/macros/<domain>/ segment, or assuming the consumer
    // script.google.com/macros/s/<id>/exec shape, gives a URL that 404s with a
    // Google Drive "unable to open the file" page and looks like a broken app.
    if (url.indexOf('/a/macros/') >= 0) {
      var dom = url.split('/a/macros/')[1].split('/')[0];
      say('');
      say('[note] This is a Google Workspace deployment on ' + dom + '.');
      say('       Its address MUST keep the /a/macros/' + dom + '/ part.');
      say('       script.google.com/macros/s/<id>/exec is the personal-account');
      say('       form and will not resolve for this script.');
      say('       Check with your Workspace admin that external sharing is');
      say('       allowed, or people outside ' + dom + ' will be asked to sign in.');
    }
    if (url.indexOf('/u/') >= 0) {
      say('[WARN] That URL contains /u/N/, which resolves only in a browser');
      say('       where that account slot matches. Take the one from');
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
  var keys = ['dash_v3_admin'];
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



// ============================================================
//  REGISTER BUILDER
// ============================================================

/**
 * REGISTER BUILDER — creates and populates the tracking sheet the dashboard reads.
 *
 * Run once from the Apps Script editor (or the "ED/PAC Register" menu the
 * onOpen trigger installs):
 *   setupRegister()          build Sheet1 + Reference, dropdowns, formulas
 *   generateFullScenario()   fill the all-zones-full demonstration scenario
 *   clearRegisterData()      wipe data rows, keep the structure
 *
 * Bed / position code grammar (per the departmental specification):
 *   <site><zone><NN>        funded bed, chair or consultation room
 *   <site><zone><NN>crisis  escalation capacity beyond the funded establishment
 *   <site>gz-waiting        green-zone waiting area, a queue position not a bed
 */

var REF_SHEET = 'Reference';

var LOCATIONS = ['ED WCC', 'ED BU', 'PAC WCC'];
var GENDERS = ['Male', 'Female'];
var ZONE_CODES = ['rz', 'yz', 'gz', 'ob', 'ab', 'pac'];
var STATUSES = ['ongoingtreatment', 'referred', 'preadmit', 'admitted', 'discharge'];
var DISCIPLINES = ['Medical', 'Surgical', 'Orthopedic', 'O&G', 'Paediatric',
                   'Paediatric Dental', 'OMFS', 'Psychiatry', 'Special Needs Dental'];

var ZONE_NAMES = {
  rz: 'Red Zone', yz: 'Yellow Zone', gz: 'Green Zone',
  ob: 'Observation Bay', ab: 'Asthma Bay', pac: 'Patient Assessment Centre'
};

var HEADERS = [
  'Location', 'Triage Date/Time', 'Full Name', 'Initial', 'IC / Passport', 'MRN',
  'Age', 'Gender', 'Zone Code', 'Bed / Position Code', 'Current Zone', 'Status',
  'Referred To', 'Queue No. (GZ only)', 'Called into GZ Room',
  'Pre-admit Date/Time', 'Admit Date/Time', 'BWT (hh:mm)', 'TWT (hh:mm)',
  'GZWT (hh:mm)', 'Discharge Date/Time'
];

/**
 * The bed establishment lives in Code.gs as ESTABLISHMENT, so the register
 * generator, the capacity figures and the bed board cannot drift apart. All
 * .gs files in an Apps Script project share one global scope, so it is
 * referenced directly here.
 */

function pad2_(n) { return ('0' + n).slice(-2); }

/** Every valid position code, in establishment order, with its metadata. */
function bedInventory_() {
  var out = [];
  for (var i = 0; i < ESTABLISHMENT.length; i++) {
    var e = ESTABLISHMENT[i];
    for (var n = 1; n <= e.funded; n++) {
      out.push({
        code: e.prefix + pad2_(n), location: e.location, zone: e.zone,
        kind: 'funded', unit: e.unit,
        description: e.location + ' ' + ZONE_NAMES[e.zone] + ' ' + e.unit + ' ' + pad2_(n)
      });
    }
    for (var c = e.funded + 1; c <= e.crisisTo; c++) {
      out.push({
        code: e.prefix + pad2_(c) + 'crisis', location: e.location, zone: e.zone,
        kind: 'crisis', unit: e.unit,
        description: e.location + ' ' + ZONE_NAMES[e.zone] + ' ' + e.unit + ' ' + pad2_(c) +
                     ' — escalation capacity, crisis mode active'
      });
    }
    if (e.waiting) {
      out.push({
        code: e.prefix + '-waiting', location: e.location, zone: e.zone,
        kind: 'waiting', unit: 'queue position',
        description: e.location + ' ' + ZONE_NAMES[e.zone] + ' waiting area — holds a queue number, not a bed'
      });
    }
  }
  return out;
}

// ── MENU ───────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ED/PAC Register')
    .addItem('\u26A0 Rebuild sheet structure (CLEARS Sheet1)', 'setupRegister')
    .addItem('\u26A0 Generate demo scenario (REPLACES all data)', 'generateFullScenario')
    .addSeparator()
    .addItem('\u26A0 Clear data rows', 'clearRegisterData')
    .addItem('Refresh dashboard cache', 'clearCaches')
    .addToUi();
}

// ── STRUCTURE ──────────────────────────────────────────────
function setupRegister() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  buildReferenceSheet_(ss);

  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sh.clear();
  sh.clearConditionalFormatRules();

  // Row 1 — title band.
  sh.getRange(1, 1, 1, HEADERS.length).merge()
    .setValue('EMERGENCY DEPARTMENT & PAC — PATIENT TRACKING REGISTER   |   Hospital Tengku Permaisuri Norashikin, Kajang')
    .setFontSize(12).setFontWeight('bold')
    .setBackground('#055257').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(1, 32);

  // Row 2 — headers.
  sh.getRange(2, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#e0f5f6').setFontColor('#055257')
    .setWrap(true).setVerticalAlignment('middle');
  sh.setRowHeight(2, 42);
  sh.setFrozenRows(2);
  sh.setFrozenColumns(1);

  var widths = [82, 128, 168, 88, 118, 96, 48, 66, 74, 150, 92, 122, 132, 96, 128, 128, 128, 84, 84, 84, 128];
  for (var w = 0; w < widths.length; w++) sh.setColumnWidth(w + 1, widths[w]);

  var maxRows = Math.max(sh.getMaxRows(), 1200);
  if (sh.getMaxRows() < maxRows) sh.insertRowsAfter(sh.getMaxRows(), maxRows - sh.getMaxRows());
  var n = maxRows - FIRST_DATA_ROW + 1;

  // Formats.
  var dateFmt = 'dd/mm/yyyy hh:mm';
  [COL.triageDT, COL.callingGZ, COL.preadmitDT, COL.admitDT, COL.dischargeDT].forEach(function (c) {
    sh.getRange(FIRST_DATA_ROW, c, n, 1).setNumberFormat(dateFmt);
  });
  sh.getRange(FIRST_DATA_ROW, COL.age, n, 1).setNumberFormat('0');
  [COL.bwt, COL.twt, COL.gzwt].forEach(function (c) {
    sh.getRange(FIRST_DATA_ROW, c, n, 1).setNumberFormat('@').setHorizontalAlignment('center');
  });
  sh.getRange(FIRST_DATA_ROW, COL.ic, n, 1).setNumberFormat('@');
  sh.getRange(FIRST_DATA_ROW, COL.qmsg, n, 1).setNumberFormat('@').setHorizontalAlignment('center');

  applyValidation_(sh, ss, n);
  applyDurationFormulas_(sh, n);
  applyConditionalFormats_(sh, n);

  sh.getRange(2, 1, 1, HEADERS.length).createDeveloperMetadata
    ? null : null;   // no-op: metadata API varies by runtime

  SpreadsheetApp.flush();
  return 'Register structure built. Next: generateFullScenario().';
}

function applyValidation_(sh, ss, n) {
  function listRule(values) {
    return SpreadsheetApp.newDataValidation()
      .requireValueInList(values, true).setAllowInvalid(false).build();
  }
  sh.getRange(FIRST_DATA_ROW, COL.location, n, 1).setDataValidation(listRule(LOCATIONS));
  sh.getRange(FIRST_DATA_ROW, COL.gender, n, 1).setDataValidation(listRule(GENDERS));
  sh.getRange(FIRST_DATA_ROW, COL.zoneCode, n, 1).setDataValidation(listRule(ZONE_CODES));
  sh.getRange(FIRST_DATA_ROW, COL.currentZone, n, 1).setDataValidation(listRule(ZONE_CODES));
  sh.getRange(FIRST_DATA_ROW, COL.status, n, 1).setDataValidation(listRule(STATUSES));
  sh.getRange(FIRST_DATA_ROW, COL.referredTo, n, 1).setDataValidation(listRule(DISCIPLINES));

  // Bed codes are too many for an inline list, so validate against the
  // Reference sheet range — which keeps the two in step automatically.
  var ref = ss.getSheetByName(REF_SHEET);
  var codeRange = ref.getRange(2, 1, bedInventory_().length, 1);
  sh.getRange(FIRST_DATA_ROW, COL.bedCode, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(codeRange, true)
      .setAllowInvalid(false).build());

  sh.getRange(FIRST_DATA_ROW, COL.age, n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberBetween(0, 120)
      .setAllowInvalid(false).build());
}

/**
 * Duration columns are live formulas so they cannot drift from the timestamps.
 *   BWT  pre-admit  → admit            (how long the patient boarded)
 *   TWT  triage     → admit or discharge (total time in the department)
 *   GZWT triage     → called into room  (green-zone wait)
 */
function applyDurationFormulas_(sh, n) {
  var r = FIRST_DATA_ROW;
  sh.getRange(r, COL.bwt, n, 1).setFormulaR1C1(
    '=IF(OR(RC[-2]="",RC[-3]=""),"",TEXT(RC[-2]-RC[-3],"[h]:mm"))');
  sh.getRange(r, COL.twt, n, 1).setFormulaR1C1(
    '=IF(RC[-17]="","",IF(RC[-2]<>"",TEXT(RC[-2]-RC[-17],"[h]:mm"),' +
    'IF(RC[2]<>"",TEXT(RC[2]-RC[-17],"[h]:mm"),"")))');
  sh.getRange(r, COL.gzwt, n, 1).setFormulaR1C1(
    '=IF(OR(RC[-5]="",RC[-18]=""),"",TEXT(RC[-5]-RC[-18],"[h]:mm"))');
}

function applyConditionalFormats_(sh, n) {
  var rules = [];
  function rule(range, formula, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(formula)
      .setBackground(bg).setFontColor(fg || '#1a202c')
      .setRanges([range]).build();
  }
  var bedRange = sh.getRange(FIRST_DATA_ROW, COL.bedCode, n, 1);
  rules.push(rule(bedRange, '=AND($J3<>"",ISNUMBER(SEARCH("crisis",$J3)))', '#fde8e6', '#c0392b'));
  rules.push(rule(bedRange, '=AND($J3<>"",ISNUMBER(SEARCH("waiting",$J3)))', '#e6f7ee', '#1a7c4a'));

  var statusRange = sh.getRange(FIRST_DATA_ROW, COL.status, n, 1);
  var statusColours = {
    ongoingtreatment: ['#e0f5f6', '#055257'],
    referred:         ['#e6f0fa', '#1a4c82'],
    preadmit:         ['#fff4e0', '#8a4b00'],
    admitted:         ['#e6f7ee', '#1a7c4a'],
    discharge:        ['#f3eeff', '#6b3ea0']
  };
  for (var k in statusColours) {
    if (!statusColours.hasOwnProperty(k)) continue;
    rules.push(rule(statusRange, '=$L3="' + k + '"', statusColours[k][0], statusColours[k][1]));
  }

  // A whole row flagged when the record is internally inconsistent.
  var allRange = sh.getRange(FIRST_DATA_ROW, 1, n, HEADERS.length);
  rules.push(rule(allRange,
    '=AND($B3<>"",$Q3<>"",$Q3<$B3)', '#ffe0e0', '#8a1f14'));

  sh.setConditionalFormatRules(rules);
}

function buildReferenceSheet_(ss) {
  var ref = ss.getSheetByName(REF_SHEET) || ss.insertSheet(REF_SHEET);
  ref.clear();
  var inv = bedInventory_();

  ref.getRange(1, 1, 1, 6).setValues([[
    'Position Code', 'Location', 'Zone', 'Zone Name', 'Kind', 'Description'
  ]]).setFontWeight('bold').setBackground('#e0f5f6').setFontColor('#055257');

  var rows = inv.map(function (b) {
    return [b.code, b.location, b.zone, ZONE_NAMES[b.zone], b.kind, b.description];
  });
  ref.getRange(2, 1, rows.length, 6).setValues(rows);

  // Establishment summary, to the right.
  var summaryCol = 8;
  ref.getRange(1, summaryCol, 1, 6).setValues([[
    'Location', 'Zone', 'Unit', 'Funded capacity', 'Escalation beds', 'Waiting places'
  ]]).setFontWeight('bold').setBackground('#fff4e0').setFontColor('#8a4b00');
  var sum = ESTABLISHMENT.map(function (e) {
    return [e.location, ZONE_NAMES[e.zone], e.unit, e.funded,
            Math.max(0, e.crisisTo - e.funded), e.waiting || 0];
  });
  ref.getRange(2, summaryCol, sum.length, 6).setValues(sum);

  var totalRow = 2 + sum.length;
  ref.getRange(totalRow, summaryCol, 1, 6).setValues([['TOTAL', '', '',
    sum.reduce(function (a, r) { return a + r[3]; }, 0),
    sum.reduce(function (a, r) { return a + r[4]; }, 0),
    sum.reduce(function (a, r) { return a + r[5]; }, 0)]])
    .setFontWeight('bold').setBackground('#f0f4f8');

  [1, 2, 3, 4, 5, 6].forEach(function (c) { ref.setColumnWidth(c, c === 6 ? 380 : 120); });
  for (var c2 = summaryCol; c2 < summaryCol + 6; c2++) ref.setColumnWidth(c2, 130);
  ref.setFrozenRows(1);
  return ref;
}

// ── SCENARIO GENERATION ────────────────────────────────────
var MALAY_FIRST = ['Ahmad', 'Aisyah', 'Amirah', 'Anis', 'Azman', 'Danial', 'Faizal',
  'Farah', 'Hafiz', 'Hafizah', 'Hamizan', 'Hasnah', 'Helmi', 'Izzuddin', 'Mohamed',
  'Nizam', 'Norizan', 'Norliza', 'Nurul', 'Rizal', 'Rohani', 'Shahril', 'Siti',
  'Suraya', 'Syed', 'Zainab', 'Zulkifli', 'Zuraidah'];
var MALAY_LAST = ['Abdullah', 'Ahmad', 'Hamid', 'Hassan', 'Ibrahim', 'Ismail',
  'Mohamed', 'Omar', 'Osman', 'Rahman', 'Salleh', 'Yusof', 'Zakaria'];
var IC_STATE_CODES = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14'];

function rnd_(n) { return Math.floor(Math.random() * n); }
function pick_(a) { return a[rnd_(a.length)]; }

/**
 * Builds the demonstration scenario the specification asks for: every funded
 * and escalation bed occupied across all zones, plus 50 patients waiting in
 * each green-zone waiting area. Yields 217 records.
 *
 * Triage times are spread across an eight-hour operating window ending at the
 * scenario clock, so arrival-by-hour, waiting-time and forecast panels all have
 * something real to work with.
 */
function generateFullScenario(opts) {
  opts = opts || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Run setupRegister() first.');

  var clock = opts.clock ? new Date(opts.clock) : new Date();
  clock.setMinutes(0, 0, 0);
  var windowH = opts.windowHours || 8;
  var openFrom = new Date(clock.getTime() - windowH * 3600000);

  var inv = bedInventory_();
  var slots = [];
  for (var i = 0; i < inv.length; i++) {
    var b = inv[i];
    if (b.kind === 'waiting') {
      var q = 0;
      var est = ESTABLISHMENT.filter(function (e) {
        return e.prefix === b.code.replace('-waiting', '');
      })[0];
      for (q = 1; q <= (est ? est.waiting : 0); q++) {
        slots.push({ bed: b, queueNo: q });
      }
    } else {
      slots.push({ bed: b, queueNo: null });
    }
  }

  var usedIc = {}, rows = [];
  for (var s = 0; s < slots.length; s++) {
    rows.push(buildRecordRow_(slots[s], openFrom, clock, usedIc));
  }

  // Order by triage time so the register reads like a working day.
  rows.sort(function (a, b) { return a[COL.triageDT - 1] - b[COL.triageDT - 1]; });

  clearRegisterData();
  sh.getRange(FIRST_DATA_ROW, 1, rows.length, HEADERS.length).setValues(rows);
  applyDurationFormulas_(sh, Math.max(rows.length, sh.getMaxRows() - FIRST_DATA_ROW + 1));
  SpreadsheetApp.flush();
  try { clearCaches(); } catch (e) { /* dashboard cache may not exist yet */ }

  return 'Generated ' + rows.length + ' records; scenario clock ' +
    Utilities.formatDate(clock, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
}

function buildRecordRow_(slot, openFrom, clock, usedIc) {
  var bed = slot.bed;
  var isWaiting = bed.kind === 'waiting';
  var isRoom = bed.unit === 'consultation room';

  // Triage time: waiting-area patients skew later, bedded patients earlier,
  // which is what produces a realistic queue at the scenario clock.
  var span = clock - openFrom;
  var frac = isWaiting ? (0.35 + Math.random() * 0.65) : Math.random();
  var triage = new Date(openFrom.getTime() + Math.floor(frac * span));
  triage.setSeconds(0, 0);

  var first = pick_(MALAY_FIRST), last = pick_(MALAY_LAST);
  var isFemale = bed.location === 'PAC WCC' ? true : (Math.random() < 0.52);
  var particle = isFemale ? 'binti' : 'bin';
  var fullName = first + ' ' + particle + ' ' + last;

  // Age profile follows the zone: PAC is antenatal, WCC skews paediatric.
  var age;
  if (bed.location === 'PAC WCC') age = 18 + rnd_(24);
  else if (bed.location === 'ED WCC') age = Math.random() < 0.55 ? 1 + rnd_(17) : 18 + rnd_(50);
  else age = 16 + rnd_(70);

  var ic;
  do {
    var yy = pad2_((new Date().getFullYear() - age) % 100);
    ic = yy + pad2_(1 + rnd_(12)) + pad2_(1 + rnd_(28)) + '-' +
         pick_(IC_STATE_CODES) + '-' + ('000' + rnd_(10000)).slice(-4);
  } while (usedIc[ic]);
  usedIc[ic] = true;

  var row = [];
  for (var c = 0; c < HEADERS.length; c++) row.push('');
  row[COL.location - 1]    = bed.location;
  row[COL.triageDT - 1]    = triage;
  row[COL.fullName - 1]    = fullName;
  row[COL.initial - 1]     = first;
  row[COL.ic - 1]          = ic;
  row[COL.mrn - 1]         = 'MRN' + (100000 + rnd_(900000));
  row[COL.age - 1]         = age;
  row[COL.gender - 1]      = isFemale ? 'Female' : 'Male';
  row[COL.zoneCode - 1]    = bed.zone;
  row[COL.bedCode - 1]     = bed.code;
  row[COL.currentZone - 1] = bed.zone;

  if (isWaiting) {
    // Waiting for a green-zone room: no disposition yet, holds a queue number.
    row[COL.status - 1] = 'ongoingtreatment';
    row[COL.qmsg - 1] = String(slot.queueNo);
    return row;
  }

  if (isRoom) {
    // In a consultation room: has been called in.
    row[COL.status - 1] = 'ongoingtreatment';
    row[COL.qmsg - 1] = String(1 + rnd_(200));
    var called = new Date(triage.getTime() + (20 + rnd_(120)) * 60000);
    if (called < clock) row[COL.callingGZ - 1] = called;
    return row;
  }

  // Bedded patient: sample a disposition, then make the timestamps agree with it.
  var roll = Math.random();
  var status;
  if (roll < 0.56)      status = 'ongoingtreatment';
  else if (roll < 0.72) status = 'referred';
  else if (roll < 0.86) status = 'preadmit';
  else if (roll < 0.96) status = 'admitted';
  else                  status = 'discharge';

  row[COL.status - 1] = status;

  if (status === 'referred' || status === 'preadmit' || status === 'admitted') {
    row[COL.referredTo - 1] = pick_(DISCIPLINES);
  }
  if (status === 'preadmit' || status === 'admitted') {
    var pre = new Date(triage.getTime() + (60 + rnd_(240)) * 60000);
    if (pre > clock) pre = new Date(clock.getTime() - 10 * 60000);
    row[COL.preadmitDT - 1] = pre;
    if (status === 'admitted') {
      var adm = new Date(pre.getTime() + (40 + rnd_(140)) * 60000);
      if (adm > clock) adm = clock;
      row[COL.admitDT - 1] = adm;
    }
  }
  if (status === 'discharge') {
    var dis = new Date(triage.getTime() + (90 + rnd_(200)) * 60000);
    if (dis > clock) dis = clock;
    row[COL.dischargeDT - 1] = dis;
  }
  return row;
}

function clearRegisterData() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) return 'No sheet.';
  var last = sh.getLastRow();
  if (last >= FIRST_DATA_ROW) {
    sh.getRange(FIRST_DATA_ROW, 1, last - FIRST_DATA_ROW + 1, HEADERS.length).clearContent();
  }
  return 'Cleared.';
}



// ============================================================
//  ILLUSTRATIONS
// ============================================================

/**
 * ILLUSTRATIONS — friendly explanatory images for the public view,
 * generated with Google's Gemini image model ("Nano Banana").
 *
 * The generation step is deliberately OFF the request path. A public
 * dashboard must not call a generative model while a family is waiting for
 * the page: it would be slow, it would bill per view, and it would put
 * unreviewed output in front of patients. Instead an administrator runs
 * generateIllustrations() once, reviews what comes back in the Drive folder,
 * and the dashboard then serves those reviewed, cached images.
 *
 * Setup (Script Properties):
 *   GEMINI_API_KEY        required to generate; without it nothing is called
 *   GEMINI_IMAGE_MODEL    optional, defaults below — confirm the current
 *                         model id against Google's documentation, as these
 *                         identifiers change
 *   ILLUSTRATION_FOLDER   optional Drive folder id to write into
 *   ILLUSTRATION_IDS      written by the generator; read by the dashboard
 *
 * If no key is configured the dashboard falls back to the department's own
 * poster images, and failing that to the built-in inline diagrams. The public
 * page never shows a broken panel because a model was unavailable.
 */

var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
var DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
var ILLUSTRATION_CACHE_KEY = 'illustrations_v1';

/**
 * The image set. Prompts are written for a Malaysian public hospital waiting
 * area: warm, plain, and free of anything that could be read as clinical
 * instruction. No text is requested inside the images — captions are rendered
 * by the page, so they stay translatable and legible at any size.
 */
var ILLUSTRATION_SPECS = [
  {
    key: 'triage',
    captionMs: 'Kenapa ada pesakit didahulukan?',
    captionEn: 'Why are some patients seen first?',
    prompt: 'A warm, friendly flat vector illustration for a Malaysian public ' +
      'hospital waiting area. Three groups of patients waiting in a bright, calm ' +
      'emergency department, gently colour-coded by area: one area red, one amber, ' +
      'one green. A nurse in a light blue uniform with a tudung guides a patient ' +
      'towards the red area. Diverse Malaysian families of different ages, modest ' +
      'everyday clothing. Soft teal and cream palette, rounded shapes, no text, ' +
      'no logos, no gore, no medical equipment detail. Reassuring and calm.'
  },
  {
    key: 'queue',
    captionMs: 'Nombor giliran Zon Hijau',
    captionEn: 'How the Green Zone queue works',
    prompt: 'A warm, friendly flat vector illustration for a Malaysian public ' +
      'hospital. A family sitting comfortably in a bright green-zone waiting area, ' +
      'looking at a large blank display board on the wall and at a blank paper ' +
      'slip in hand. A consultation room door is open nearby with a doctor ' +
      'welcoming someone in. Soft teal and cream palette, rounded shapes, ' +
      'no text or numbers anywhere, no logos. Patient and hopeful mood.'
  },
  {
    key: 'when',
    captionMs: 'Bila perlu ke Jabatan Kecemasan?',
    captionEn: 'When to come to the Emergency Department',
    prompt: 'A warm, friendly flat vector illustration, split into two calm halves ' +
      'for a Malaysian public hospital. On one side a person clutching their chest ' +
      'being helped urgently by a paramedic. On the other side a person with a ' +
      'minor scrape sitting calmly at a community clinic reception. Soft teal and ' +
      'cream palette, rounded shapes, diverse Malaysian people, modest clothing, ' +
      'no text, no logos, no blood, nothing frightening.'
  },
  {
    key: 'wait',
    captionMs: 'Sementara menunggu',
    captionEn: 'While you are waiting',
    prompt: 'A warm, friendly flat vector illustration for a Malaysian public ' +
      'hospital waiting area. An elderly woman in a tudung and her adult daughter ' +
      'sitting together on waiting-room chairs, sharing a flask of water, with a ' +
      'nurse passing by and smiling. Large windows, plants, warm daylight. Soft ' +
      'teal and cream palette, rounded shapes, no text, no logos. Calm, dignified, ' +
      'unhurried mood.'
  }
];

/**
 * Generates the illustration set and stores the Drive file ids.
 * Run this from the editor, then open the folder and review every image
 * before the public deployment is refreshed.
 */
function generateIllustrations(opts) {
  opts = opts || {};
  var key = prop_('GEMINI_API_KEY');
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set in Script Properties. ' +
      'Without it the dashboard falls back to the department posters.');
  }
  var model = prop_('GEMINI_IMAGE_MODEL') || DEFAULT_IMAGE_MODEL;
  var folder = illustrationFolder_();

  var only = opts.only || null;
  var ids = readIllustrationIds_();
  var report = [];

  for (var i = 0; i < ILLUSTRATION_SPECS.length; i++) {
    var spec = ILLUSTRATION_SPECS[i];
    if (only && only.indexOf(spec.key) < 0) continue;
    try {
      var blob = requestImage_(key, model, spec.prompt, spec.key);
      // Replace rather than accumulate, so the folder stays reviewable.
      var existing = folder.getFilesByName(spec.key + '.png');
      while (existing.hasNext()) existing.next().setTrashed(true);
      var file = folder.createFile(blob);
      file.setDescription('ED/PAC dashboard illustration "' + spec.key +
        '" generated ' + new Date().toISOString() + ' with ' + model +
        '. Review before publishing.');
      ids[spec.key] = file.getId();
      report.push(spec.key + ': ok (' + file.getId() + ')');
    } catch (err) {
      report.push(spec.key + ': FAILED — ' + (err && err.message || err));
    }
  }

  PropertiesService.getScriptProperties()
    .setProperty('ILLUSTRATION_IDS', JSON.stringify(ids));
  try { CacheService.getScriptCache().remove(ILLUSTRATION_CACHE_KEY); } catch (e) { /* not cached yet */ }

  return 'Model: ' + model + '\nFolder: ' + folder.getUrl() + '\n' + report.join('\n') +
    '\n\nReview every image in that folder before relying on it publicly.';
}

function requestImage_(apiKey, model, prompt, name) {
  var url = GEMINI_ENDPOINT + encodeURIComponent(model) + ':generateContent';
  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    throw new Error('HTTP ' + code + ' from ' + model + ': ' + body.slice(0, 300));
  }

  var json = JSON.parse(body);
  var cands = json.candidates || [];
  for (var i = 0; i < cands.length; i++) {
    var parts = (cands[i].content && cands[i].content.parts) || [];
    for (var j = 0; j < parts.length; j++) {
      var inline = parts[j].inlineData || parts[j].inline_data;
      if (inline && inline.data) {
        var mime = inline.mimeType || inline.mime_type || 'image/png';
        var ext = mime.indexOf('jpeg') >= 0 ? '.jpg' : '.png';
        return Utilities.newBlob(Utilities.base64Decode(inline.data), mime, name + ext);
      }
    }
  }
  // A safety block returns 200 with no image part; say so plainly.
  var reason = cands.length && cands[0].finishReason ? cands[0].finishReason : 'no image in response';
  throw new Error('No image returned (' + reason + ')');
}

function illustrationFolder_() {
  var id = prop_('ILLUSTRATION_FOLDER');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* fall through and create */ }
  }
  var name = 'ED-PAC Dashboard Illustrations';
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  PropertiesService.getScriptProperties().setProperty('ILLUSTRATION_FOLDER', folder.getId());
  return folder;
}

function readIllustrationIds_() {
  var raw = prop_('ILLUSTRATION_IDS');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

/**
 * Serves the reviewed illustrations to the page, with the department's own
 * posters as the fallback. Cached, because these are large and unchanging.
 */
function getIllustrations() {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(ILLUSTRATION_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* oversize or cold cache — rebuild below */ }

  var ids = readIllustrationIds_();
  var out = { items: [], source: 'none' };

  for (var i = 0; i < ILLUSTRATION_SPECS.length; i++) {
    var spec = ILLUSTRATION_SPECS[i];
    if (!ids[spec.key]) continue;
    try {
      var blob = DriveApp.getFileById(ids[spec.key]).getBlob();
      out.items.push({
        key: spec.key, captionMs: spec.captionMs, captionEn: spec.captionEn,
        dataUri: 'data:' + blob.getContentType() + ';base64,' +
                 Utilities.base64Encode(blob.getBytes())
      });
    } catch (err) { /* a deleted or unshared file simply drops out of the set */ }
  }
  if (out.items.length) out.source = 'generated';

  if (!out.items.length) {
    var posters = getImages();
    if (posters.iqms) {
      out.items.push({ key: 'iqms', captionMs: 'iQMS — semakan nombor giliran',
        captionEn: 'iQMS — check your queue number online', dataUri: posters.iqms });
    }
    if (posters.poster) {
      out.items.push({ key: 'poster', captionMs: 'Kes kecemasan vs bukan kecemasan',
        captionEn: 'Emergency vs non-emergency', dataUri: posters.poster });
    }
    if (out.items.length) out.source = 'posters';
  }

  // Only cache what comfortably fits; large data URIs are served uncached.
  try {
    var json = JSON.stringify(out);
    if (json.length < 90000) cache.put(ILLUSTRATION_CACHE_KEY, json, 21600);
  } catch (e) { /* serve uncached */ }
  return out;
}

/** Clears the cached set after regenerating or replacing an image. */
function clearIllustrationCache() {
  CacheService.getScriptCache().remove(ILLUSTRATION_CACHE_KEY);
  return 'cleared';
}


// ── THE PAGE ────────────────────────────────────────────────
// The full interface: styles, chart library, bilingual strings and app logic.
// Generated — see the header.
var PAGE_HTML = `<!DOCTYPE html>
<html lang="ms">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<meta name="color-scheme" content="light"/>
<title>Status Pesakit — Jabatan Kecemasan &amp; PAC | HTPN Kajang</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet"/>
<style>
/* ============================================================
   ED / PAC DASHBOARD — LAYOUT AND DESIGN TOKENS

   Light mode only, deliberately. This page runs on dedicated
   tablets and wall screens in brightly lit waiting areas, and
   the data palette below was validated against a white chart
   surface. Shipping a dark variant would mean shipping colours
   that have not cleared the same colour-vision gates, so the
   page pins itself to light rather than letting an operating
   system setting produce an unvalidated rendering.

   Nothing on any screen scrolls: the shell is a fixed grid of
   viewport height, and sections that hold more than fits are
   split into numbered steps reached by the pager.
   ============================================================ */

:root {
  color-scheme: light;

  /* Surfaces and ink */
  --page:      #eef2f5;
  --surface:   #ffffff;
  --surface-2: #f6f9fa;
  --ink:       #14202a;
  --ink-2:     #4a5763;
  --ink-3:     #77848f;
  --line:      #d7dee4;
  --line-soft: #e8edf1;

  /* Brand chrome — identity only, never a data encoding */
  --brand:     #0a7c82;
  --brand-dk:  #055257;
  --brand-lt:  #e0f5f6;
  --accent:    #b35c00;

  /* Triage zone identity. Red / yellow / green are a patient-safety
     convention and are not ours to re-map; observation, asthma and PAC
     are functional areas and take validated categorical slots.
     Passes the adjacent pairlist on a white surface. Yellow and PAC sit
     below 3:1 against the surface, so every zone mark carries a visible
     text label — colour never works alone here. */
  --zone-rz:  #c0392b;
  --zone-yz:  #e08b00;
  --zone-gz:  #1a7c4a;
  --zone-ob:  #2a78d6;
  --zone-ab:  #4a3aa7;
  --zone-pac: #e87ba4;

  /* Categorical slots for everything that is not a zone, in fixed order */
  --cat-1: #2a78d6;  --cat-2: #eb6834;  --cat-3: #1baf7a;  --cat-4: #eda100;
  --cat-5: #e87ba4;  --cat-6: #008300;  --cat-7: #4a3aa7;  --cat-8: #e34948;

  /* Sequential ramp for heatmaps — one hue, light to dark */
  --seq-1: #cde2fb; --seq-2: #9ec5f4; --seq-3: #6da7ec; --seq-4: #3987e5;
  --seq-5: #256abf; --seq-6: #184f95; --seq-7: #0d366b;
  --seq-0: #f4f7fa;              /* exactly zero — reads as empty, not low */

  /* Status — always shipped with an icon and a word */
  --ok:       #0ca30c;
  --warn:     #fab219;
  --serious:  #ec835a;
  --critical: #d03b3b;

  --radius: 10px;
  --shadow: 0 1px 2px rgba(20,32,42,.06), 0 4px 14px rgba(20,32,42,.05);

  /* Set by JS from the viewport so a 1024px-tall tablet and a 1280px-tall
     one both fill their screen without overflowing it. */
  --s: 1;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  overflow: hidden;                /* the no-scroll guarantee */
  background: var(--page);
  -webkit-text-size-adjust: 100%;
}

body {
  font-family: 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--ink);
  font-size: calc(14px * var(--s));
  line-height: 1.35;
  overscroll-behavior: none;
}

.mono { font-family: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace; }

/* Narrow screens shed the optional header furniture rather than overflow. */
@media (max-width: 880px) { #demoChip { display: none } }
@media (max-width: 720px) {
  #searchBtnLabel, #langLabel { display: none }
  .hdr-btn { padding: calc(6px * var(--s)) calc(10px * var(--s)) }
}
@media (max-width: 620px) { #stampPrefix { display: none } }

/* ── SHELL ───────────────────────────────────────────────── */
#app {
  height: 100vh;
  height: 100dvh;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  /* minmax(0,1fr), not the implicit \`auto\`: an auto track resolves to the
     widest item's max-content, which let the header stretch the shell past
     the viewport and put the whole page into horizontal overflow. */
  grid-template-columns: minmax(0, 1fr);
  /* Rows are named and children pinned to them. With implicit placement,
     hiding the narrative strip (as the administrative tab does) shifted every
     later child up one row, handing the 1fr track to the pager and collapsing
     the content area to auto height. */
  grid-template-areas: "hdr" "narr" "tabs" "content" "pager";
  overflow: hidden;
}
#app > * { min-width: 0; }
.hdr     { grid-area: hdr }
.narr    { grid-area: narr }
.tabs    { grid-area: tabs }
.content { grid-area: content }
.pager   { grid-area: pager }

/* ── WALL-DISPLAY MODE (?mode=tv) ─────────────────────────
   A vertical rail of rotating public-health cards beside the zone board.
   Only ever on a wide screen: a hall display has an audience with forty
   minutes of nothing else to look at, whereas a family member on a phone
   wants one answer and health promotion beside it reads as the hospital
   changing the subject. Hidden below 1000px for that reason, which is the
   same threshold the type scale treats as a wall display. */
.rail { display: none }

body.is-tv #app {
  grid-template-columns: minmax(0, 1fr) clamp(320px, 23vw, 480px);
  grid-template-areas:
    "hdr     rail"
    "narr    rail"
    "tabs    rail"
    "content rail"
    "pager   rail";
}
body.is-tv .rail {
  grid-area: rail;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: calc(10px * var(--s));
  padding: calc(14px * var(--s));
  background: var(--surface-2);
  border-left: 1px solid var(--line);
  overflow: hidden;
}

/* Below the wall-display threshold the rail is dropped and the shell
   returns to its single column, so ?mode=tv degrades rather than breaks. */
@media (max-width: 999px) {
  body.is-tv #app {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "hdr" "narr" "tabs" "content" "pager";
  }
  body.is-tv .rail { display: none }
}

.rail-card {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--s));
  background: var(--surface);
  border: 1px solid var(--line);
  border-top: calc(6px * var(--s)) solid var(--rail-tone, var(--brand));
  border-radius: var(--radius);
  padding: calc(16px * var(--s));
  overflow: hidden;
  opacity: 0;
  transform: translateY(calc(8px * var(--s)));
  transition: opacity .5s ease, transform .5s ease;
}
.rail-card.is-in { opacity: 1; transform: none }

/* Tones are deliberately drawn from outside the triage palette. Red, amber
   and green mean a clinical acuity on this screen and must not also mean
   "health promotion topic" two hundred millimetres away. */
.rail-card.is-intro { --rail-tone: var(--brand) }
.rail-card.is-move  { --rail-tone: #2a78d6 }
.rail-card.is-sugar { --rail-tone: #4a3aa7 }
.rail-card.is-meds  { --rail-tone: #8a3fa8 }
.rail-card.is-smoke { --rail-tone: #4a5763 }
.rail-card.is-screen { --rail-tone: var(--brand-dk) }

.rail-top { display: flex; align-items: center; gap: calc(10px * var(--s)); flex: none }
.rail-icon { font-size: calc(30px * var(--s)); line-height: 1 }
.rail-no {
  font-size: calc(13px * var(--s)); font-weight: 800; letter-spacing: .08em;
  text-transform: uppercase; color: var(--rail-tone, var(--brand));
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 999px; padding: calc(3px * var(--s)) calc(10px * var(--s));
}
.rail-title {
  flex: none; margin: 0;
  font-size: calc(27px * var(--s)); line-height: 1.14; font-weight: 800;
  color: var(--ink); letter-spacing: -.01em;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  overflow: hidden;
}
.rail-lead {
  flex: none; margin: 0;
  font-size: calc(17px * var(--s)); line-height: 1.38; font-weight: 700;
  color: var(--ink-2);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5;
  overflow: hidden;
}
.rail-pts {
  margin: 0; padding: 0; list-style: none;
  display: flex; flex-direction: column; gap: calc(8px * var(--s));
  min-height: 0; overflow: hidden;
}
.rail-pts li {
  position: relative;
  padding-left: calc(18px * var(--s));
  font-size: calc(15.5px * var(--s)); line-height: 1.4; font-weight: 600;
  color: var(--ink);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4;
  overflow: hidden;
}
.rail-pts li::before {
  content: ''; position: absolute;
  left: 0; top: calc(9px * var(--s));
  width: calc(7px * var(--s)); height: calc(7px * var(--s));
  border-radius: 50%; background: var(--rail-tone, var(--brand));
}
.rail-action {
  /* margin-top:auto drops this and the source line to the foot of the card,
     so a short card reads as composed rather than as one that ran out. */
  flex: none; margin: auto 0 0;
  background: var(--surface-2);
  border-left: calc(4px * var(--s)) solid var(--rail-tone, var(--brand));
  border-radius: calc(6px * var(--s));
  padding: calc(10px * var(--s)) calc(12px * var(--s));
  font-size: calc(16px * var(--s)); line-height: 1.36; font-weight: 700;
  color: var(--ink);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5;
  overflow: hidden;
}
.rail-src {
  flex: none; margin: 0;
  font-size: calc(12px * var(--s)); line-height: 1.3; font-weight: 600;
  color: var(--ink-3);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}
.rail-dots { flex: none; display: flex; justify-content: center; gap: calc(7px * var(--s)) }
.rail-dot {
  width: calc(8px * var(--s)); height: calc(8px * var(--s));
  border-radius: 50%; background: var(--line);
}
.rail-dot.is-on { background: var(--brand) }

/* ── HEADER ──────────────────────────────────────────────── */
.hdr {
  background: linear-gradient(135deg, var(--brand-dk), var(--brand));
  color: #fff;
  display: flex; align-items: center; gap: calc(10px * var(--s));
  padding: 0 calc(14px * var(--s));
  height: calc(52px * var(--s));
  box-shadow: 0 1px 6px rgba(5,82,87,.28);
  overflow: hidden;
}
.hdr-chip, .hdr-btn { flex: 0 0 auto; }
.hdr-id { min-width: 0; flex: 1; }
.hdr-id h1 {
  font-size: calc(14px * var(--s)); font-weight: 800; letter-spacing: -.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hdr-id p {
  font-size: calc(10.5px * var(--s)); opacity: .82; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hdr-chip {
  display: inline-flex; align-items: center; gap: calc(5px * var(--s));
  background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.28);
  border-radius: 999px; padding: calc(4px * var(--s)) calc(10px * var(--s));
  font-size: calc(10.5px * var(--s)); font-weight: 700; white-space: nowrap;
  color: #fff;
}
.hdr-btn {
  display: inline-flex; align-items: center; gap: calc(5px * var(--s));
  background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.3);
  color: #fff; font: inherit; font-size: calc(11px * var(--s)); font-weight: 700;
  border-radius: 999px; padding: calc(6px * var(--s)) calc(12px * var(--s));
  cursor: pointer; white-space: nowrap;
  min-height: calc(32px * var(--s));
}
.hdr-btn:hover { background: rgba(255,255,255,.26); }
.hdr-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.dot {
  width: calc(7px * var(--s)); height: calc(7px * var(--s)); border-radius: 50%;
  background: #6ee7a0; flex: none;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none } }

/* ── NARRATIVE STRIP — the plain-language line for families ─ */
.narr {
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  padding: calc(7px * var(--s)) calc(14px * var(--s));
  display: flex; align-items: center; gap: calc(9px * var(--s));
  min-height: calc(44px * var(--s));
  overflow: hidden;
}
.narr-icon { font-size: calc(17px * var(--s)); flex: none; line-height: 1; }
.narr-text {
  font-size: calc(14px * var(--s)); color: var(--ink-2); font-weight: 600;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.narr-text strong { color: var(--ink); font-weight: 800; }

.help-fig { margin-bottom: calc(12px * var(--s)) }
.help-fig img {
  width: 100%; height: auto; display: block;
  border-radius: var(--radius); border: 1px solid var(--line);
}
.help-fig figcaption {
  font-size: calc(11px * var(--s)); font-weight: 700; color: var(--ink-2);
  padding-top: calc(5px * var(--s));
}
.narr.is-crisis { background: #fdf0ee; border-bottom-color: #f3c4bd; }
.narr.is-crisis .narr-text strong { color: var(--critical); }

/* ── TABS ────────────────────────────────────────────────── */
.tabs {
  /* Columns follow the number of tabs. It was hard-coded to four, so adding
     a fifth pushed it onto a second row and cut the strip in half. */
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  background: var(--surface); border-bottom: 1px solid var(--line);
  /* Six tabs share this strip, and the longest unit name needs three lines
     once each has only a sixth of a tablet's width. */
  height: calc(56px * var(--s));
}
.tab {
  border: 0; background: none; font: inherit; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: calc(1px * var(--s)); padding: calc(4px * var(--s)) calc(3px * var(--s));
  color: var(--ink-3); border-bottom: 3px solid transparent; min-width: 0;
}
.tab-name {
  font-size: calc(11px * var(--s)); font-weight: 700; line-height: 1.15;
  text-align: center; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
}
.tab-sub {
  font-size: calc(9px * var(--s)); font-weight: 600; opacity: .85;
  line-height: 1.15; text-align: center; max-width: 100%;
  /* Clamped like the name above it. Unclamped, a long sub-label was simply
     cut mid-word once six tabs had to share the strip. */
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tab[aria-selected="true"] {
  color: var(--brand-dk); border-bottom-color: var(--brand);
  background: var(--brand-lt);
}
.tab:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

/* ── CONTENT ─────────────────────────────────────────────── */
.content {
  min-height: 0; overflow: hidden; position: relative;
  padding: calc(10px * var(--s));
}
.step { height: 100%; min-height: 0; display: none; }
.step.is-active { display: grid; gap: calc(9px * var(--s)); min-width: 0; }
.step.is-active > * { min-width: 0; min-height: 0; }

/* ── PANELS ──────────────────────────────────────────────── */
.panel {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow);
  display: flex; flex-direction: column; min-height: 0; min-width: 0;
  overflow: hidden;
}
.panel-hd {
  display: flex; align-items: baseline; gap: calc(7px * var(--s));
  padding: calc(7px * var(--s)) calc(10px * var(--s)) calc(3px * var(--s));
  flex: none;
}
.panel-hd h2 {
  font-size: calc(11.5px * var(--s)); font-weight: 800; color: var(--ink);
  letter-spacing: -.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.panel-hd .sub {
  font-size: calc(9.5px * var(--s)); color: var(--ink-3); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;
}
.panel-tbl {
  border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-2);
  border-radius: 5px; font: inherit; font-size: calc(9px * var(--s)); font-weight: 700;
  padding: calc(2px * var(--s)) calc(6px * var(--s)); cursor: pointer; flex: none;
  min-height: calc(20px * var(--s));
}
.panel-tbl:hover { background: var(--brand-lt); color: var(--brand-dk); }
.panel-bd { flex: 1; min-height: 0; position: relative; }
.panel-bd > svg { display: block; width: 100%; height: 100%; }
.panel-note {
  flex: none; padding: calc(2px * var(--s)) calc(10px * var(--s)) calc(6px * var(--s));
  font-size: calc(9px * var(--s)); color: var(--ink-3); line-height: 1.3;
  /* Capped at three lines: the heatmap legend sentences are long, and without
     a ceiling they collapse the plot area they are meant to describe. The
     full wording stays available in the table view. */
  max-height: calc(9px * var(--s) * 1.3 * 3 + 8px * var(--s));
  overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
}
.panel-bd { min-height: calc(90px * var(--s)); }

/* ── KPI TILES ───────────────────────────────────────────── */
.kpis { display: grid; gap: calc(8px * var(--s)); min-height: 0; min-width: 0; }
@media (max-width: 700px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)) !important }
}
.kpi {
  background: var(--surface); border: 1px solid var(--line);
  border-left: 4px solid var(--brand); border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: calc(7px * var(--s)) calc(9px * var(--s));
  display: flex; flex-direction: column; justify-content: center;
  min-width: 0; min-height: 0; overflow: hidden;
}
.kpi-label {
  font-size: calc(9.5px * var(--s)); font-weight: 700; color: var(--ink-3);
  text-transform: uppercase; letter-spacing: .04em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kpi-val {
  font-size: calc(27px * var(--s)); font-weight: 800; line-height: 1.05;
  letter-spacing: -.02em; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kpi-val .unit { font-size: calc(13px * var(--s)); font-weight: 700; color: var(--ink-3); }
.kpi-sub {
  font-size: calc(9.5px * var(--s)); color: var(--ink-3); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kpi.t-ok       { border-left-color: var(--ok) }
.kpi.t-warn     { border-left-color: var(--warn) }
.kpi.t-serious  { border-left-color: var(--serious) }
.kpi.t-critical { border-left-color: var(--critical) }
.kpi.t-critical .kpi-val { color: var(--critical) }
.kpi-flag {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: calc(9px * var(--s)); font-weight: 800;
}
.kpi-na { font-size: calc(13px * var(--s)); font-weight: 700; color: var(--ink-3); }

/* ── STEP PAGER ──────────────────────────────────────────── */
.pager {
  display: flex; align-items: center; gap: calc(8px * var(--s));
  background: var(--surface); border-top: 1px solid var(--line);
  padding: 0 calc(12px * var(--s)); height: calc(44px * var(--s));
}
.pager-btn {
  border: 1px solid var(--line); background: var(--surface-2); color: var(--ink);
  border-radius: 8px; font: inherit; font-size: calc(11px * var(--s)); font-weight: 700;
  padding: calc(6px * var(--s)) calc(12px * var(--s)); cursor: pointer;
  min-height: calc(32px * var(--s)); min-width: calc(44px * var(--s));
}
.pager-btn:hover:not(:disabled) { background: var(--brand-lt); border-color: var(--brand); color: var(--brand-dk) }
.pager-btn:disabled { opacity: .35; cursor: default }
.pager-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px }
.pager-mid { flex: 1; min-width: 0; text-align: center }
.pager-title {
  font-size: calc(11.5px * var(--s)); font-weight: 800; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pager-dots { display: flex; gap: calc(5px * var(--s)); justify-content: center; margin-top: 3px }
.pager-dot {
  width: calc(18px * var(--s)); height: calc(4px * var(--s)); border-radius: 2px;
  background: var(--line); border: 0; padding: 0; cursor: pointer;
}
.pager-dot[aria-current="true"] { background: var(--brand) }

/* ── OVERLAYS (search, table view, admin gate) ───────────── */
.ov {
  position: fixed; inset: 0; z-index: 90; display: none;
  background: rgba(15,28,36,.55);
  align-items: center; justify-content: center; padding: calc(16px * var(--s));
}
.ov.is-open { display: flex }
.ov-card {
  background: var(--surface); border-radius: calc(14px * var(--s));
  width: 100%; max-width: calc(560px * var(--s));
  max-height: calc(100% - 8px); display: flex; flex-direction: column;
  overflow: hidden; box-shadow: 0 18px 48px rgba(15,28,36,.32);
}
.ov-card.is-wide { max-width: calc(760px * var(--s)) }
.ov-hd {
  display: flex; align-items: center; gap: calc(8px * var(--s));
  padding: calc(12px * var(--s)) calc(14px * var(--s));
  border-bottom: 1px solid var(--line); flex: none;
}
.ov-hd h2 { font-size: calc(14px * var(--s)); font-weight: 800; flex: 1; min-width: 0 }
.ov-x {
  border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-2);
  width: calc(32px * var(--s)); height: calc(32px * var(--s)); border-radius: 8px;
  font-size: calc(15px * var(--s)); cursor: pointer; flex: none; line-height: 1;
}
.ov-x:hover { background: #fdf0ee; color: var(--critical); border-color: #f3c4bd }
.ov-bd { padding: calc(14px * var(--s)); overflow: auto; min-height: 0; flex: 1 }
.ov-ft {
  padding: calc(10px * var(--s)) calc(14px * var(--s));
  border-top: 1px solid var(--line); flex: none;
  display: flex; align-items: center; gap: calc(8px * var(--s));
  font-size: calc(10px * var(--s)); color: var(--ink-3);
}

.field {
  display: flex; gap: calc(8px * var(--s)); align-items: stretch;
}
.field input {
  flex: 1; min-width: 0; font: inherit; font-size: calc(14px * var(--s));
  padding: calc(11px * var(--s)) calc(12px * var(--s));
  border: 1.5px solid var(--line); border-radius: 9px; color: var(--ink);
  background: var(--surface);
}
.field input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-lt) }
.btn-go {
  border: 0; background: var(--brand); color: #fff; font: inherit;
  font-size: calc(13px * var(--s)); font-weight: 800; border-radius: 9px;
  padding: 0 calc(18px * var(--s)); cursor: pointer; white-space: nowrap;
  min-height: calc(44px * var(--s));
}
.btn-go:hover { background: var(--brand-dk) }
.hint { font-size: calc(10.5px * var(--s)); color: var(--ink-3); margin-top: calc(8px * var(--s)); line-height: 1.4 }

/* Patient result card */
.res {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: calc(11px * var(--s)); margin-bottom: calc(9px * var(--s));
  background: var(--surface-2);
}
.res-hd { display: flex; align-items: center; gap: calc(8px * var(--s)); flex-wrap: wrap; margin-bottom: calc(8px * var(--s)) }
.res-name { font-size: calc(14px * var(--s)); font-weight: 800 }
.res-id { font-size: calc(10px * var(--s)); color: var(--ink-3) }
.res-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(calc(110px * var(--s)), 1fr)); gap: calc(8px * var(--s)) }
.res-k { font-size: calc(9px * var(--s)); text-transform: uppercase; letter-spacing: .04em; color: var(--ink-3); font-weight: 700 }
.res-v { font-size: calc(11.5px * var(--s)); font-weight: 700 }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: calc(3px * var(--s)) calc(9px * var(--s)); border-radius: 999px;
  font-size: calc(10px * var(--s)); font-weight: 800; white-space: nowrap;
}
.queue {
  margin-top: calc(9px * var(--s)); border-radius: 9px;
  background: var(--brand-lt); border: 1px solid #b8dfe1;
  padding: calc(10px * var(--s)); display: flex; align-items: center; gap: calc(11px * var(--s));
}
.queue-n { font-size: calc(26px * var(--s)); font-weight: 800; color: var(--brand-dk); line-height: 1; font-variant-numeric: tabular-nums }
.queue-t { font-size: calc(10.5px * var(--s)); color: var(--ink-2); font-weight: 600 }

/* Data table (the accessibility relief for every chart) */
table.dt { width: 100%; border-collapse: collapse; font-size: calc(11px * var(--s)) }
table.dt caption { text-align: left; font-size: calc(10px * var(--s)); color: var(--ink-3); padding-bottom: calc(6px * var(--s)) }
table.dt th, table.dt td {
  border-bottom: 1px solid var(--line-soft); padding: calc(5px * var(--s)) calc(7px * var(--s));
  text-align: right; font-variant-numeric: tabular-nums;
}
table.dt th:first-child, table.dt td:first-child { text-align: left; font-variant-numeric: normal }
table.dt thead th { background: var(--surface-2); font-weight: 800; color: var(--ink-2); position: sticky; top: 0 }
table.dt tbody tr:hover { background: var(--brand-lt) }

/* ── CHART TOOLTIP ───────────────────────────────────────── */
#tip {
  position: fixed; z-index: 120; pointer-events: none; display: none;
  background: #14202a; color: #fff; border-radius: 7px;
  padding: calc(6px * var(--s)) calc(9px * var(--s));
  font-size: calc(10.5px * var(--s)); font-weight: 600; line-height: 1.4;
  box-shadow: 0 5px 18px rgba(0,0,0,.3); max-width: calc(240px * var(--s));
}
#tip .tip-k { color: #9fb2c0; font-weight: 700 }
#tip b { font-variant-numeric: tabular-nums }

/* ── LEGEND (HTML, beneath a chart) ──────────────────────── */
.legend {
  display: flex; flex-wrap: wrap; gap: calc(3px * var(--s)) calc(9px * var(--s));
  padding: calc(3px * var(--s)) calc(10px * var(--s)) calc(6px * var(--s));
  flex: none;
}
.legend-item { display: inline-flex; align-items: center; gap: calc(4px * var(--s)); font-size: calc(9.5px * var(--s)); font-weight: 700; color: var(--ink-2) }
.legend-sw { width: calc(9px * var(--s)); height: calc(9px * var(--s)); border-radius: 2px; flex: none }
.legend-sw.is-line { height: calc(3px * var(--s)); border-radius: 2px }
.legend-sw.is-band { height: calc(9px * var(--s)); opacity: .3 }


/* ── PUBLIC VIEW ─────────────────────────────────────────── */
/* Tabs 1-3 are read by families: from across a waiting room on a wall
   television, and at arm's length on a phone. Type is therefore a size up
   from the staff view, and the whole screen is laid out as a grid rather
   than a stack of full-width bands, which read as clutter at this size. */

.seek {
  background: linear-gradient(135deg, var(--brand-dk), var(--brand));
  color: #fff; border-radius: var(--radius);
  padding: calc(10px * var(--s)) calc(14px * var(--s));
  display: flex; align-items: center; gap: calc(12px * var(--s));
  box-shadow: var(--shadow); min-width: 0; overflow: hidden;
}
.seek-copy { flex: 1; min-width: 0 }
.seek-copy h2 {
  font-size: calc(18px * var(--s)); font-weight: 800; line-height: 1.2;
  margin-bottom: calc(2px * var(--s));
}
.seek-copy p {
  font-size: calc(12.5px * var(--s)); opacity: .9; font-weight: 500; line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.seek-btn {
  flex: none; border: 0; cursor: pointer; font: inherit;
  background: var(--accent); color: #fff;
  font-size: calc(15px * var(--s)); font-weight: 800;
  border-radius: 999px; padding: calc(11px * var(--s)) calc(20px * var(--s));
  white-space: nowrap; min-height: calc(44px * var(--s));
  box-shadow: 0 2px 10px rgba(0,0,0,.18);
}
.seek-btn:hover { background: #8f4a00 }
.seek-btn:focus-visible { outline: 3px solid #fff; outline-offset: 2px }

/* The counter panel that stands where the search used to. No button: there is
   nothing to click, only somewhere to go, so the icon leads instead. */
.seek.is-counter { align-items: flex-start }
.seek-ic {
  flex: none; font-size: calc(30px * var(--s)); line-height: 1.1;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.25));
}
.seek.is-counter .seek-copy p { -webkit-line-clamp: 4; opacity: .94 }

/* ── ZONE CARDS ──────────────────────────────────────────── */
/* One row, left to right, in escalation order. Columns are set from the
   zone count in App.html so the row never wraps onto a second layer. */
.zone-grid {
  display: grid; gap: calc(10px * var(--s));
  min-height: 0; min-width: 0; overflow: hidden;
}
.zone-card {
  background: var(--surface); border: 1px solid var(--line);
  border-top: 7px solid var(--ink-3); border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: calc(10px * var(--s)) calc(11px * var(--s));
  display: flex; flex-direction: column; align-items: flex-start;
  justify-content: flex-start;
  gap: calc(6px * var(--s)); min-width: 0; min-height: 0; overflow: hidden;
}
/* The status badge sits at the foot of the card, so a row of cards reads as
   a row of numbers with a row of states beneath it. */
.zone-card > .zc-badge { margin-top: auto }
.zone-card.z-rz  { border-top-color: var(--zone-rz) }
.zone-card.z-yz  { border-top-color: var(--zone-yz) }
.zone-card.z-gz  { border-top-color: var(--zone-gz) }
.zone-card.z-ob  { border-top-color: var(--zone-ob) }
.zone-card.z-ab  { border-top-color: var(--zone-ab) }
.zone-card.z-pac { border-top-color: var(--zone-pac) }
.zone-card.is-full { background: #fffaf9 }

.zc-name {
  flex: none;
  font-size: calc(15.5px * var(--s)); font-weight: 800; width: 100%;
  line-height: 1.2; color: var(--ink);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.zc-nums { flex: none; display: flex; align-items: baseline; gap: calc(7px * var(--s)); min-width: 0 }
.zc-big {
  font-size: calc(46px * var(--s)); font-weight: 800; line-height: .95;
  letter-spacing: -.035em; font-variant-numeric: tabular-nums; color: var(--ink);
}
.zc-cap {
  font-size: calc(13px * var(--s)); color: var(--ink-2); font-weight: 700;
  line-height: 1.2; min-width: 0;
}
.zc-bar {
  width: 100%; background: #eef2f5; border-radius: 999px;
  height: calc(8px * var(--s)); overflow: hidden; flex: none;
}
.zc-bar > span { display: block; height: 100%; border-radius: 999px }
.zone-card.z-rz  .zc-bar > span { background: var(--zone-rz) }
.zone-card.z-yz  .zc-bar > span { background: var(--zone-yz) }
.zone-card.z-gz  .zc-bar > span { background: var(--zone-gz) }
.zone-card.z-ob  .zc-bar > span { background: var(--zone-ob) }
.zone-card.z-ab  .zc-bar > span { background: var(--zone-ab) }
.zone-card.z-pac .zc-bar > span { background: var(--zone-pac) }

.zc-badge {
  flex: none; max-width: 100%; font-size: calc(11px * var(--s)); font-weight: 800;
  border-radius: 999px; padding: calc(4px * var(--s)) calc(10px * var(--s));
  line-height: 1.25; text-align: center;
}
.zc-badge.is-ok     { background: #e7f6e9; color: #14691a }
.zc-badge.is-busy   { background: #fff4e0; color: #8a4b00 }
.zc-badge.is-full   { background: #fde8e6; color: #a32b1d }
.zc-badge.is-crisis { background: var(--critical); color: #fff }

/* Green zone: the queue and the wait, the two figures families ask about. */
.zc-gz {
  flex: none;
  width: 100%; margin-top: auto; padding-top: calc(8px * var(--s));
  border-top: 1px dashed var(--line); min-width: 0;
}
.zc-gz-row { display: flex; align-items: baseline; gap: calc(6px * var(--s)); min-width: 0 }
.zc-gz-n {
  font-size: calc(30px * var(--s)); font-weight: 800; color: var(--zone-gz);
  line-height: 1; font-variant-numeric: tabular-nums;
}
.zc-gz-l {
  font-size: calc(11.5px * var(--s)); font-weight: 700; color: var(--ink-2);
  line-height: 1.2; min-width: 0;
}
.zc-gz-wait {
  font-size: calc(11.5px * var(--s)); color: var(--ink-2); margin-top: calc(3px * var(--s));
  line-height: 1.3;
}
.zc-gz-wait strong { color: var(--brand-dk) }
.zc-muted { color: var(--ink-3); font-style: italic }

/* ── POSTER TABS ─────────────────────────────────────────── */
/* One image, fitted to the box, nothing else competing with it. */
.poster-tab {
  min-width: 0; min-height: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow);
  padding: calc(8px * var(--s));
}
.poster-img { max-width: 100%; max-height: 100%; object-fit: contain; display: block }
/* Written guidance, shown only when the poster cannot be loaded. */
.poster-fallback {
  min-width: 0; min-height: 0; overflow: hidden;
  display: grid; gap: calc(10px * var(--s));
  grid-auto-rows: minmax(0, auto);
}

.poster-cta {
  display: flex; align-items: center; gap: calc(14px * var(--s)); flex-wrap: wrap;
  background: linear-gradient(135deg, #5b1a8f, #7b2fb5);
  color: #fff; border-radius: var(--radius); box-shadow: var(--shadow);
  padding: calc(12px * var(--s)) calc(16px * var(--s)); min-width: 0;
}
.cta-copy { flex: 1; min-width: 0; display: flex; flex-direction: column }
.cta-copy strong { font-size: calc(16px * var(--s)); font-weight: 800; line-height: 1.2 }
.cta-copy span { font-size: calc(12.5px * var(--s)); font-weight: 600; opacity: .9; line-height: 1.3 }
.cta-btn {
  flex: none; text-decoration: none; background: #fff; color: #5b1a8f;
  font-size: calc(15px * var(--s)); font-weight: 800;
  border-radius: 999px; padding: calc(11px * var(--s)) calc(22px * var(--s));
  min-height: calc(44px * var(--s)); display: inline-flex; align-items: center; gap: calc(7px * var(--s));
  white-space: nowrap; box-shadow: 0 2px 10px rgba(0,0,0,.2);
}
.cta-btn:hover { background: #f3e9fb }
.cta-btn:focus-visible { outline: 3px solid #fff; outline-offset: 2px }
@media (max-width: 620px) {
  .poster-cta { flex-direction: column; align-items: stretch; text-align: center }
  .cta-btn { justify-content: center }
}

/* ── IQMS & TRIAGE TAB ───────────────────────────────────── */
.iq-lead {
  font-size: calc(13.5px * var(--s)); line-height: 1.45; color: var(--ink-2);
  font-weight: 600;
}
.iq-lead + .iq-lead { margin-top: calc(7px * var(--s)) }
.iq-alert {
  margin-top: calc(9px * var(--s));
  background: #fff4e0; border-left: calc(4px * var(--s)) solid var(--accent);
  border-radius: calc(5px * var(--s));
  padding: calc(8px * var(--s)) calc(11px * var(--s));
  font-size: calc(13px * var(--s)); line-height: 1.38; font-weight: 800; color: #6b3d00;
}
.iq-warn {
  margin-top: calc(9px * var(--s));
  font-size: calc(12.5px * var(--s)); line-height: 1.4; font-weight: 800;
  color: var(--critical);
}
.iq-madani {
  margin-top: calc(5px * var(--s));
  font-size: calc(12px * var(--s)); line-height: 1.35; font-weight: 700; color: var(--ink-2);
}

/* The two columns are a triage decision, so they carry the triage colours --
   with a word and an icon beside them, never colour alone. */
.panel.is-emerg { border-top: calc(4px * var(--s)) solid var(--zone-rz) }
.panel.is-non   { border-top: calc(4px * var(--s)) solid var(--zone-gz) }

.cklist { list-style: none; display: flex; flex-direction: column; gap: calc(6px * var(--s)) }
.cklist li {
  position: relative; padding-left: calc(20px * var(--s));
  font-size: calc(13.5px * var(--s)); line-height: 1.38; font-weight: 700; color: var(--ink);
}
.cklist li::before {
  position: absolute; left: 0; top: 0;
  font-size: calc(13px * var(--s)); line-height: 1.4;
}
.cklist.is-emerg li::before { content: '\\2192'; color: var(--zone-rz); font-weight: 900 }
.cklist.is-ok li::before    { content: '\\2713'; color: var(--zone-gz); font-weight: 900 }
.cklist.is-num { counter-reset: ck }
.cklist.is-num li { padding-left: calc(24px * var(--s)); counter-increment: ck }
.cklist.is-num li::before {
  content: counter(ck); color: #fff; background: var(--brand);
  width: calc(17px * var(--s)); height: calc(17px * var(--s));
  border-radius: 50%; text-align: center;
  font-size: calc(11px * var(--s)); line-height: calc(17px * var(--s)); font-weight: 800;
}

/* ── NON-EMERGENCY NOTICE ────────────────────────────────── */
/* The one message on this screen that can shorten the queue. */
.klinik {
  display: flex; align-items: flex-start; gap: calc(10px * var(--s));
  background: #fff8e8; border: 1.5px solid #f0dcae; border-left: 7px solid var(--warn);
  border-radius: var(--radius); box-shadow: var(--shadow);
  padding: calc(12px * var(--s)) calc(14px * var(--s));
  min-width: 0; overflow: hidden;
}
.klinik-ic { font-size: calc(22px * var(--s)); flex: none; line-height: 1.1 }
.klinik > div { min-width: 0 }
.klinik strong {
  display: block; font-size: calc(14.5px * var(--s)); font-weight: 800; color: #7a5200;
  margin-bottom: calc(3px * var(--s)); line-height: 1.25;
}
.klinik p {
  font-size: calc(12px * var(--s)); color: var(--ink-2); line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.klinik-madani {
  margin-top: calc(4px * var(--s)); font-weight: 700; color: #7a5200;
  -webkit-line-clamp: 2;
}

/* ── FAMILY GUIDANCE ─────────────────────────────────────── */
/* Capped at three columns. Left to its own devices on a wide screen the grid
   stretched into a single band of seven narrow strips, which is unreadable. */
.guide {
  height: 100%; overflow: hidden;
  padding: calc(4px * var(--s)) calc(14px * var(--s)) calc(10px * var(--s));
  display: grid; gap: calc(10px * var(--s)) calc(22px * var(--s));
  align-content: space-evenly;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (min-width: 1100px) { .guide { grid-template-columns: repeat(3, minmax(0, 1fr)) } }
@media (max-width: 700px)  { .guide { grid-template-columns: 1fr } }

.guide-row { display: flex; gap: calc(11px * var(--s)); min-width: 0; align-items: flex-start }
.guide-ic { font-size: calc(23px * var(--s)); flex: none; line-height: 1.15 }
.guide-row > div { min-width: 0 }
.guide-row strong {
  font-size: calc(14.5px * var(--s)); font-weight: 800; display: block;
  margin-bottom: calc(2px * var(--s)); line-height: 1.25;
}
.guide-row p {
  font-size: calc(13px * var(--s)); color: var(--ink-2); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.guide.is-compact {
  gap: calc(6px * var(--s)) calc(16px * var(--s)); align-content: start;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.guide.is-compact .guide-ic { font-size: calc(17px * var(--s)) }
.guide.is-compact .guide-row { gap: calc(8px * var(--s)) }
.guide.is-compact .guide-row strong { font-size: calc(12.5px * var(--s)); line-height: 1.2 }
.guide.is-compact .guide-row p { font-size: calc(11.5px * var(--s)); -webkit-line-clamp: 4; line-height: 1.35 }
@media (min-width: 1100px) { .guide.is-compact { grid-template-columns: repeat(3, minmax(0, 1fr)) } }
/* On a wall display four columns puts the seven entries on two rows instead
   of three, which buys the height the larger type needs. At this width each
   column is still some 450px, so it is not the narrow strip a fully fluid
   grid would produce. */
@media (min-width: 1500px) { .guide.is-compact { grid-template-columns: repeat(4, minmax(0, 1fr)) } }
/* These thresholds measure the viewport, but in wall-display mode the rail
   takes some 440px off the content column before the guide ever sees it. On a
   1080p television that left four columns sharing 1478px and cost two entries
   their last line. Shift the threshold by the rail's width instead. */
@media (min-width: 1500px) and (max-width: 1959px) {
  body.is-tv .guide.is-compact { grid-template-columns: repeat(3, minmax(0, 1fr)) }
}

/* Phones: the cards stack in the same order, top to bottom. */
@media (max-width: 620px) {
  .content { overflow-y: auto; -webkit-overflow-scrolling: touch }
  /* One narrow column, and the area scrolls, so nothing needs clamping. */
  .guide.is-compact .guide-row p { -webkit-line-clamp: 6 }
  .klinik p, .seek-copy p { -webkit-line-clamp: 6 }
  .step.is-active { grid-template-columns: 1fr !important; grid-template-areas: none !important }
  .step.is-active > * { grid-area: auto !important }
  /* The guidance tab is prose, and prose that is cut off is useless. Only
     there do the panels grow to their content and the area scroll; the status
     board keeps its fixed tracks so it still fits a screen exactly. */
  .step.is-active.is-guide {
    grid-template-rows: none !important;
    grid-auto-rows: max-content !important;
  }
  .step.is-active.is-guide .panel { min-height: 0 }
  .zone-grid { grid-template-columns: 1fr !important; grid-auto-rows: max-content }
  .zone-card { flex-direction: row; align-items: center; flex-wrap: wrap }
  .zc-name { width: auto; flex: 1 }
  .zc-bar { order: 10 }
  .zc-gz { margin-top: 0 }
  .zc-big { font-size: calc(40px * var(--s)) }
  .cklist li { font-size: calc(14px * var(--s)) }
  /* A poster is read by pinching in, so let it have the full width. */
  .poster-tab { padding: 0; border: 0; box-shadow: none; background: none }
  .poster-img { max-height: none; width: 100% }
  .seek { flex-direction: column; align-items: stretch; text-align: center }
  .seek-btn { width: 100% }
}

/* Phones: six tabs across 390px leaves 60px each, which fits no label in any
   language. The strip scrolls sideways instead, with tabs wide enough to read
   — the standard answer, and the only one that does not abbreviate a
   department into something nobody recognises. */
@media (max-width: 620px) {
  .tabs {
    display: flex; overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity;
    height: calc(54px * var(--s));
  }
  .tabs::-webkit-scrollbar { height: 0 }
  /* A fade at the right edge, so it is visible that there are more tabs than
     fit. A scroller with no affordance is a scroller nobody scrolls. */
  .tabs {
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent 100%);
    mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent 100%);
  }
  .tab {
    flex: 0 0 auto; min-width: 46vw; scroll-snap-align: start;
    padding-inline: calc(10px * var(--s));
  }
  .tab-name { -webkit-line-clamp: 2 }
}

/* ── CREDIT ──────────────────────────────────────────────── */
/* Bottom right, quiet, and never in the way of anything: it is an attribution,
   not a control, so it does not take clicks. */
.credit-mark {
  position: fixed; right: calc(8px * var(--s)); bottom: calc(5px * var(--s));
  z-index: 5; pointer-events: none;
  font-size: calc(9.5px * var(--s)); font-weight: 700; letter-spacing: .01em;
  color: var(--ink-3); opacity: .75;
  background: rgba(255, 255, 255, .72); border-radius: 999px;
  padding: calc(2px * var(--s)) calc(8px * var(--s));
}
@media (max-width: 620px) { .credit-mark { font-size: calc(9px * var(--s)); opacity: .6 } }

/* ── STATES ──────────────────────────────────────────────── */
.state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; gap: calc(7px * var(--s)); text-align: center;
  padding: calc(12px * var(--s)); color: var(--ink-3); font-size: calc(10.5px * var(--s));
  font-weight: 600; line-height: 1.4;
}
.state-icon { font-size: calc(21px * var(--s)); opacity: .6 }
.spin {
  width: calc(26px * var(--s)); height: calc(26px * var(--s));
  border: 3px solid var(--brand-lt); border-top-color: var(--brand);
  border-radius: 50%; animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg) } }
.banner {
  display: flex; align-items: center; gap: calc(9px * var(--s));
  border-radius: var(--radius); padding: calc(9px * var(--s)) calc(11px * var(--s));
  font-size: calc(11px * var(--s)); font-weight: 700; line-height: 1.35;
}
.banner.is-critical { background: #fdf0ee; border: 1px solid #f3c4bd; color: #8c261a }
.banner.is-warn { background: #fff8e8; border: 1px solid #f0dcae; color: #7a5200 }
.banner.is-info { background: var(--brand-lt); border: 1px solid #b8dfe1; color: var(--brand-dk) }

.sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
</style>

</head>
<body>

<div id="app">

  <!-- HEADER -->
  <header class="hdr">
    <div class="hdr-id">
      <h1 id="appTitle">Jabatan Kecemasan &amp; PAC</h1>
      <p id="appSub">Hospital Tengku Permaisuri Norashikin, Kajang</p>
    </div>
    <span class="hdr-chip" id="demoChip" title="Demo">
      <span id="demoTag">DEMO</span>
      <span style="opacity:.6">·</span>
      <span id="demoNote">Data rekaan</span>
    </span>
    <span class="hdr-chip">
      <span class="dot"></span>
      <span id="stampPrefix"></span>
      <span id="stamp" class="mono">—</span>
    </span>
    <button class="hdr-btn" id="langBtn" type="button">
      <span id="langFlag">🇬🇧</span><span id="langLabel">English</span>
    </button>
    <button class="hdr-btn" id="searchBtn" type="button">
      <span aria-hidden="true">🔍</span><span id="searchBtnLabel">Cari pesakit</span>
    </button>
  </header>

  <!-- One standing message for families. Static: the guidance it used to
       open now has its own place on every public tab. -->
  <div class="narr" id="narr">
    <span class="narr-icon" id="narrIcon" aria-hidden="true">ℹ️</span>
    <p class="narr-text" id="narrText"></p>
  </div>

  <!-- TABS -->
  <nav class="tabs" id="tabs" role="tablist" aria-label="Sections"></nav>

  <!-- CONTENT: exactly one step visible, never scrolled -->
  <main class="content" id="content" role="tabpanel"></main>

  <!-- HEALTH-PROMOTION RAIL: wall-display mode only, never on a phone -->
  <aside class="rail" id="rail" aria-label="Peranan Rakyat ke arah Negara Sehat"></aside>

  <!-- STEP PAGER -->
  <footer class="pager" id="pager">
    <button class="pager-btn" id="pgPrev" type="button">‹</button>
    <div class="pager-mid">
      <div class="pager-title" id="pgTitle"></div>
      <div class="pager-dots" id="pgDots"></div>
    </div>
    <button class="pager-btn" id="pgNext" type="button">›</button>
  </footer>
</div>

<!-- SEARCH OVERLAY -->
<div class="ov" id="ovSearch" role="dialog" aria-modal="true" aria-labelledby="searchTitle">
  <div class="ov-card">
    <div class="ov-hd">
      <h2 id="searchTitle">Semak status ahli keluarga anda</h2>
      <button class="ov-x" type="button" aria-label="Tutup">✕</button>
    </div>
    <div class="ov-bd">
      <div class="field">
        <input type="text" id="searchInput" maxlength="60" autocomplete="off"
               inputmode="text" spellcheck="false"/>
        <button class="btn-go" id="searchGo" type="button">Cari</button>
      </div>
      <p class="hint" id="searchHint"></p>
      <div id="searchResults" style="margin-top:calc(12px * var(--s))"></div>
    </div>
    <div class="ov-ft">
      <span>🔒</span>
      <span id="footerText"></span>
    </div>
  </div>
</div>

<!-- POSTER OVERLAY: the reviewed illustrations, when any exist -->
<div class="ov" id="ovHelp" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
  <div class="ov-card">
    <div class="ov-hd">
      <h2 id="helpTitle">Maklumat</h2>
      <button class="ov-x" type="button" aria-label="Tutup">✕</button>
    </div>
    <div class="ov-bd">
      <div id="helpImages"></div>
    </div>
    <div class="ov-ft"><span id="helpCredit"></span></div>
  </div>
</div>

<!-- TABLE VIEW OVERLAY — the accessible equivalent of every chart -->
<div class="ov" id="ovTable" role="dialog" aria-modal="true" aria-labelledby="tblTitle">
  <div class="ov-card is-wide">
    <div class="ov-hd">
      <h2 id="tblTitle">Jadual</h2>
      <button class="ov-x" type="button" aria-label="Tutup">✕</button>
    </div>
    <div class="ov-bd" id="tblBody"></div>
  </div>
</div>

<!-- ADMIN GATE -->
<div class="ov" id="ovGate" role="dialog" aria-modal="true" aria-labelledby="gateTitle">
  <div class="ov-card">
    <div class="ov-hd">
      <h2 id="gateTitle">Papan pemuka pentadbiran</h2>
      <button class="ov-x" type="button" aria-label="Tutup">✕</button>
    </div>
    <div class="ov-bd">
      <p class="hint" id="gateBody" style="margin:0 0 calc(10px * var(--s))"></p>
      <div class="field">
        <input type="password" id="gateInput" autocomplete="off"/>
        <button class="btn-go" id="gateGo" type="button">Masuk</button>
      </div>
      <p class="hint" id="gateMsg" style="color:var(--critical);font-weight:700"></p>
    </div>
  </div>
</div>

<!-- Attribution, bottom right on every screen -->
<div class="credit-mark" id="creditMark"></div>

<div id="tip" role="status" aria-live="polite"></div>

<script>
window.BOOT_SCOPE = '__BOOT_SCOPE__';
window.BOOT_MODE = '__BOOT_MODE__';
window.BOOT_SEARCH = '__BOOT_SEARCH__';
/* The hospital's own posters, as Drive image URLs. No image data goes
   through the script: the originals are 2.4 MB and 21 MB. */
window.BOOT_POSTERS = __BOOT_POSTERS__;
/* Public figures, already built, inlined by doGet from the warm cache. Saves
   the page a cold server round trip before it can show a single number. */
window.BOOT_DATA = __BOOT_DATA__;
</script>
<script>
/* ============================================================
   BILINGUAL STRINGS — Bahasa Malaysia (default) and English.

   Malay is the default because the primary readers are families
   waiting in the department. The public wording is deliberately
   plain: short sentences, no clinical abbreviations, and no
   number presented without saying what it counts.
   ============================================================ */
var I18N = {

  ms: {
    /* chrome */
    appTitle:    'Jabatan Kecemasan & PAC',
    appSub:      'Hospital Tengku Permaisuri Norashikin, Kajang',
    demoTag:     'DEMO',
    demoNote:    'Data rekaan',
    langLabel:   'English',
    langFlag:    '🇬🇧',
    searchBtn:   'Cari pesakit',
    updated:     'Dikemas kini',
    snapshot:    'Rekod pada',
    loading:     'Sedang memuatkan…',
    retry:       'Cuba semula',
    prev:        'Sebelum',
    next:        'Seterusnya',
    stepOf:      function (a, b) { return 'Langkah ' + a + ' daripada ' + b; },
    tableView:   'Jadual',
    closeLbl:    'Tutup',
    errTitle:    'Maklumat tidak dapat dipaparkan',
    errBody:     'Sistem tidak dapat dihubungi. Sila cuba semula sebentar lagi, atau tanya di kaunter jururawat.',
    errTimeout:  'Pelayan mengambil masa terlalu lama untuk menjawab. Sila cuba semula.',
    errNoResponse: 'Pelayan tidak memberikan jawapan. Sila cuba semula.',

    /* IQMS & triage tab — shared guidance, not unit-specific */
    iqms: {
      whyTitle:  'Mengapa pesakit lain mungkin didahulukan?',
      whyBody1:  'Pesakit di Jabatan Kecemasan dirawat mengikut tahap kecemasan, bukan mengikut masa ketibaan. Setiap pesakit dinilai di kaunter triaj oleh anggota klinikal terlatih dan ditempatkan di zon keutamaan mengikut keseriusan keadaannya.',
      whyBody2:  'Oleh itu, pesakit yang tiba selepas anda mungkin dipanggil lebih dahulu. Ini tidak bermakna anda dilupakan atau masalah anda tidak penting. Ia bermakna pesakit itu dinilai berada dalam risiko yang lebih mendesak.',
      whyAlert:  'Jika keadaan anda bertambah teruk semasa menunggu, beritahu kaunter triaj dengan SEGERA supaya anda dinilai semula.',

      emergTitle: 'Kes kecemasan — terus ke Jabatan Kecemasan',
      emergList: [
        'Sakit dada atau sesak nafas',
        'Kelemahan sebelah badan, mulut herot, pertuturan pelat (tanda strok)',
        'Pendarahan yang tidak berhenti',
        'Tidak sedarkan diri, sawan atau kekeliruan mengejut',
        'Kecederaan berat, kemalangan atau patah tulang',
        'Demam tinggi pada bayi bawah 3 bulan'
      ],

      nonTitle: 'Bukan kecemasan — Klinik Kesihatan atau GP',
      nonList: [
        'Sakit tekak, selesema, batuk ringan',
        'Demam ringan tanpa sesak nafas',
        'Luka kecil dan calar',
        'Ruam kulit yang ringan',
        'Mengambil ubat berulang atau surat sakit'
      ],
      nonWarn: 'Kehadiran untuk kes bukan kecemasan mengalihkan sumber klinikal daripada pesakit yang nyawanya bergantung kepadanya.',
      nonMadani: 'Dilindungi Skim Perubatan MADANI? Sila ke klinik GP yang berdaftar.',

      ctaTitle:   'Semak nombor giliran anda dalam talian',
      ctaSub:     'Tidak perlu imbas kod QR \\u2014 tekan butang ini terus.',
      ctaBtn:     'Buka iQMS',
      queueTitle: 'IQMS — nombor giliran masa nyata',
      queueList: [
        'Pesakit Zon Hijau diberi nombor giliran dan dipanggil ke bilik rawatan mengikut giliran.',
        'Pesakit Zon Merah dan Zon Kuning TIDAK diberi nombor giliran kerana mereka dirawat serta-merta.',
        'Nombor giliran semasa dipaparkan pada skrin IQMS di ruang menunggu.',
        'Jangan tinggalkan ruang menunggu tanpa memberitahu kaunter — giliran anda boleh terlepas.'
      ]
    },

    /* landing page — the Vercel front door, which may scroll */
    landing: {
      kicker:      'Perkhidmatan Awam',
      title:       'Status Jabatan Kecemasan & PAC',
      lead:        'Lihat sesibuk mana jabatan kami pada waktu ini, dan ke mana anda sepatutnya pergi.',
      liveNow:     'Keadaan sekarang',
      unitsSub:    'Pilih lokasi untuk melihat status setiap zon.',
      viewBoard:   'Lihat papan status',
      patients:    'pesakit',
      waitingHere: 'menunggu di ruang legar',
      offline:     'Maklumat tidak dapat dimuatkan sekarang. Sila cuba semula sebentar lagi.',
      perananTitle:'5 Peranan Rakyat ke arah Negara Sehat',
      perananLead: 'Setiap satu mengurangkan kesesakan hospital — dan memanjangkan hayat anda.',
      role:        'Peranan',
      tvTitle:     'Paparan dewan menunggu',
      tvBody:      'Papan status bersaiz besar untuk televisyen di ruang legar, lengkap dengan paparan Peranan Rakyat.',
      tvLink:      'Buka paparan TV',
      posterTitle: 'Poster untuk dicetak',
      posterBody:  'Poster A4 dengan kod QR ke papan status ini, untuk ditampal di kaunter dan ruang menunggu.',
      posterLink:  'Buka poster',
      kkmTitle:    'Poster kesihatan KKM',
      kkmBody:     'Bahan pendidikan kesihatan terbitan Kementerian Kesihatan Malaysia, disusun mengikut 5 Peranan Rakyat.',
      kkmLink:     'Lihat poster KKM',
      scanMe:      'Imbas untuk melihat status zon'
    },

    /* public view — tabs 1 to 3 */
    public: {
      seekSub:     'Masukkan nombor kad pengenalan, passport atau MRN pesakit.',
      counterTitle: 'Untuk status pesakit, sila ke kaunter jururawat',
      counterSub:  'Demi menjaga kerahsiaan maklumat pesakit, status individu tidak dipaparkan di sini. Jururawat di kaunter akan membantu anda.',
      tapTitle:    'Pesakit paling kritikal didahulukan.',
      tapBody:     'Pesakit dipanggil mengikut tahap kecemasan, bukan mengikut masa pendaftaran.',
      stepNow:     'Status zon sekarang',
      stepGuide:   'Panduan untuk keluarga',
      beds:        'katil',
      rooms:       'bilik doktor',
      crisisBeds:  'katil krisis diaktifkan',
      waitingNow:  'sedang menunggu',
      avgWait:     'Purata masa dipanggil:',
      avgWaitNone: 'Purata masa belum dapat dikira',
      state: { ok: 'Ada ruang', busy: 'Sibuk', full: 'Penuh', crisis: 'Krisis diaktifkan' },
      crisisTitle: 'Jabatan sangat sibuk.',
      crisisBody:  function (n) {
        return 'Kami telah mengaktifkan ' + n + ' katil krisis supaya semua pesakit dapat dirawat. ' +
               'Kami memohon maaf atas sebarang kelewatan.';
      },
      guideTitle:  'Perkara yang perlu anda tahu',
      posterBtn:   'Lihat poster',
      klinikTitle: 'Bukan kecemasan? Ke Klinik Kesihatan atau klinik GP',
      klinikBody:  'Sakit tekak, demam ringan, hidung berair, batuk ringan dan luka kecil bukan kes kecemasan. Sila ke Klinik Kesihatan atau klinik GP berdekatan.',
      klinikMadani:'Jika anda dilindungi Skim Perubatan MADANI, sila ke klinik GP yang berdaftar.',
      guide: [
        { icon: '🚑', title: 'Pesakit paling kritikal didahulukan',
          body: 'Pesakit dipanggil mengikut tahap kecemasan, bukan masa pendaftaran. Pesakit yang tiba selepas anda mungkin dipanggil dahulu.' },
        { icon: '🟥', title: 'Zon Merah & Zon Kuning',
          body: 'Zon ini untuk kes kecemasan dan kes yang mengancam nyawa. Pesakit dirawat serta-merta dan tidak diberikan nombor giliran.' },
        { icon: '🟩', title: 'Zon Hijau',
          body: 'Untuk kes kurang kritikal. Pesakit diberi nombor giliran dan menunggu sehingga dipanggil ke bilik rawatan.' },
        { icon: '🛏️', title: 'Menunggu katil wad',
          body: 'Setelah pegawai perubatan atau pakar memutuskan pesakit perlu dimasukkan ke wad, pesakit menunggu di sini sehingga katil wad tersedia.' },
        { icon: '🏠', title: 'Selepas discaj',
          body: 'Nama pesakit kekal dalam sistem selama 24 jam selepas discaj, supaya keluarga masih boleh menyemak status.' },
        { icon: '💬', title: 'Keadaan pesakit bertambah teruk?',
          body: 'Terus ke kaunter jururawat dengan segera. Jangan menunggu di luar.' }
      ]
    },
    /* tabs */
    tabs: {
      wcc:   { name: 'Kecemasan — Wanita & Kanak-Kanak', sub: 'WCC' },
      bu:    { name: 'Kecemasan — Bangunan Utama',        sub: 'Bangunan Utama' },
      pac:   { name: 'Pusat Penilaian Pesakit — O&G',     sub: 'Ibu Mengandung' },
      iqms:   { name: 'iQMS — Nombor Giliran',            sub: 'Semakan dalam talian' },
      triage: { name: 'Kecemasan atau Bukan?',            sub: 'Panduan pesakit' },
      admin: { name: 'Pentadbiran',                       sub: 'Staf sahaja' }
    },

    /* step titles */
    steps: {
      now:       'Keadaan sekarang',
      flow:      'Kemasukan & ramalan',
      waits:     'Masa menunggu',
      pattern:   'Pola & ramalan',
      overview:  'Gambaran keseluruhan',
      casemix:   'Campuran kes & rujukan',
      beds:      'Pengurusan katil',
      quality:   'Kualiti data & kaedah'
    },

    /* zones */
    zone: {
      rz: 'Zon Merah', yz: 'Zon Kuning', gz: 'Zon Hijau',
      ob: 'Bilik Pemerhatian', ab: 'Bilik Asma', pac: 'PAC'
    },
    zoneShort: { rz: 'MERAH', yz: 'KUNING', gz: 'HIJAU', ob: 'OBS', ab: 'ASMA', pac: 'PAC' },

    /* statuses */
    status: {
      ongoingtreatment: 'Sedang dirawat',
      referred:         'Dirujuk kepada pakar',
      preadmit:         'Menunggu katil wad',
      admitted:         'Sudah masuk wad',
      discharge:        'Menunggu untuk pulang',
      discharged:       'Menunggu untuk pulang'
    },

    /* units */
    units: { 'ED WCC': 'Kecemasan WCC', 'ED BU': 'Kecemasan Bangunan Utama', 'PAC WCC': 'PAC (O&G)' },
    unitsShort: { 'ED WCC': 'WCC', 'ED BU': 'Bgn Utama', 'PAC WCC': 'PAC' },

    /* KPI labels */
    kpi: {
      census:      'Pesakit dalam jabatan',
      load:        'Beban katil',
      crisis:      'Katil krisis dibuka',
      gzQueue:     'Menunggu di Zon Hijau',
      gzAvg:       'Purata masa dipanggil',
      medianWait:  'Masa dalam jabatan',
      preadmit:    'Menunggu katil wad',
      referred:    'Dirujuk kepada pakar',
      attendances: 'Jumlah kehadiran',
      admitted:    'Masuk wad',
      deaths:      'Kematian',
      admitRate:   'Kadar kemasukan wad',
      referRate:   'Kadar rujukan',
      medianTwt:   'Masa rawatan penuh',
      medianBwt:   'Menunggu katil wad',
      cost:        'Anggaran kos',
      freeBeds:    'Katil biasa kosong'
    },

    /* panel titles */
    panel: {
      capacity:     'Katil dan bilik setiap zon',
      capacitySub:  'Bar penuh = katil biasa penuh. Garisan hitam = kapasiti biasa.',
      statusMix:    'Status pesakit',
      arrivals:     'Kemasukan setiap jam & ramalan',
      waitDist:     'Berapa lama pesakit sudah menunggu',
      heatHourZone: 'Kesibukan mengikut jam dan zon',
      scatter:      'Umur berbanding masa dalam jabatan',
      forecastCard: 'Ramalan 4 jam akan datang',
      unitCompare:  'Perbandingan antara unit',
      referrals:    'Rujukan mengikut disiplin',
      ageBands:     'Kumpulan umur',
      gender:       'Jantina',
      heatZoneRef:  'Zon berbanding disiplin rujukan',
      bedBoard:     'Papan katil — semua zon',
      completeness: 'Kelengkapan data',
      flags:        'Isu kualiti data',
      method:       'Kaedah statistik',
      projection:   'Unjuran bilangan pesakit'
    },

    /* chart chrome */
    chart: {
      hour: 'Jam', arrivals: 'Kemasukan', projected: 'Ramalan',
      pi80: 'Selang 80%', pi95: 'Selang 95%', partialHour: 'Jam belum tamat',
      zone: 'Zon', funded: 'Katil biasa', crisis: 'Katil krisis', queueShort: 'menunggu',
      range: 'Julat', patients: 'Pesakit', median: 'Pertengahan:',
      group: 'Kumpulan', age: 'Umur', years: 'tahun', elapsed: 'Dalam jabatan',
      unit: 'Unit', row: 'Baris', col: 'Lajur', populated: 'Ada data',
      observed: 'Direkodkan', forecastLbl: 'Ramalan',
      axisAge: 'Umur (tahun)',
      legendFunded: 'Katil biasa', legendCrisis: 'Katil krisis (tambahan)',
      legendCapacity: 'Kapasiti biasa',
      bed: 'Katil', free: 'Kosong', crisisBed: 'Katil krisis',
      dwell: 'Sudah di jabatan', dwellUnit: 'jam di jabatan',
      occupied: 'Digunakan', places: 'Jumlah tempat'
    },

    /* heatmap legends — scale, unit, and what dark versus bright means */
    heat: {
      unitPatients:  'pesakit',
      unitReferrals: 'rujukan',
      bedNote:       'Setiap petak = satu katil. Unit: jam di jabatan, 0 hingga yang terlama. Gelap = sudah lama di katil itu; cerah = baru masuk; putih putus-putus = kosong. Garisan hitam = had kapasiti biasa.',
      hourZoneNote:  'Unit: bilangan pesakit, skala 0 hingga nilai tertinggi. Petak gelap = ramai masuk pada jam dan zon itu; petak cerah = sedikit.',
      zoneRefNote:   'Unit: bilangan rujukan, skala 0 hingga nilai tertinggi. Petak gelap = laluan rujukan kerap; petak cerah = jarang.',
      bedSummary:    function (p) {
        return p.occupied + ' daripada ' + p.places + ' tempat digunakan (' + p.pct + '%). ' +
               p.empty + ' katil kosong. ' + p.crisisOccupied + ' daripada ' +
               p.crisisPlaces + ' katil krisis dibuka.';
      }
    },

    /* narrative — the plain-language line for families */
    narr: {
      narrCapacity: function (p) {
        var m = {
          normal: 'Jabatan beroperasi seperti biasa.',
          busy:   'Jabatan agak sibuk sekarang.',
          full:   'Semua katil biasa sudah penuh.',
          crisis: 'Jabatan sedang <strong>sangat sibuk</strong>.'
        };
        var t = m[p.state] || m.normal;
        if (p.pct !== null && p.capacity > 0) {
          t += ' Kami sedang merawat <strong>' + p.beds + ' pesakit</strong> di ruang yang biasanya untuk ' + p.capacity + ' katil.';
        }
        return t;
      },
      narrCrisis: function (p) {
        return 'Kami telah membuka <strong>' + p.crisis + ' katil tambahan</strong> supaya semua pesakit dapat dirawat.';
      },
      narrZonesFull: function (p) { return 'Zon penuh: ' + p.zones.join(', ') + '.'; },
      narrGzQueue: function (p) {
        var t = '<strong>' + p.queue + ' orang</strong> sedang menunggu di ruang tunggu Zon Hijau (' + p.rooms + ' bilik doktor dibuka).';
        if (p.avgMin) t += ' Purata masa menunggu untuk dipanggil kira-kira ' + p.avgMin + ' minit.';
        return t;
      },
      narrPreadmit: function (p) {
        return '<strong>' + p.n + ' pesakit</strong> sudah diputuskan untuk masuk wad dan sedang menunggu katil.';
      },
      narrForecast: function (p) {
        var m = { rising: 'Kami menjangka kemasukan meningkat', falling: 'Kami menjangka kemasukan berkurangan', steady: 'Kami menjangka kemasukan kekal sama' };
        var t = (m[p.dir] || m.steady) + ' pada jam ' + ('0' + p.hour).slice(-2) + ':00, kira-kira ' + p.next + ' pesakit.';
        if (p.stale) t += ' (Anggaran sahaja — rekod kemasukan terkini belum lengkap.)';
        return t;
      },
      narrReassure: function () {
        return 'Pesakit yang paling kritikal dirawat terlebih dahulu, bukan mengikut giliran sampai. Terima kasih atas kesabaran anda.';
      }
    },

    /* search */
    search: {
      title:      'Semak status ahli keluarga anda',
      placeholder:'No. kad pengenalan, no. passport, atau MRN',
      hint:       'Masukkan sekurang-kurangnya 6 angka daripada nombor kad pengenalan (atau nombor MRN penuh). Untuk carian nama, masukkan nama pertama dan nama keluarga. Nombor kad pengenalan dipaparkan separa tersembunyi untuk melindungi privasi pesakit.',
      minChars:   function (n) { return 'Sila masukkan sekurang-kurangnya ' + n + ' aksara.'; },
      none:       'Tiada rekod dijumpai. Sila pastikan nombor yang dimasukkan betul, atau tanya di kaunter jururawat.',
      tooMany:    function (n) { return 'Carian anda terlalu umum (' + n + ' rekod sepadan). Sila masukkan nombor kad pengenalan atau MRN yang lebih lengkap.'; },
      rateLimit:  'Terlalu banyak carian dibuat. Sila tunggu beberapa minit.',
      error:      'Ralat sistem. Sila cuba sebentar lagi.',
      resultsFor: 'Keputusan carian',
      fields: {
        location: 'Lokasi', zone: 'Zon', status: 'Status', triage: 'Masa tiba',
        referredTo: 'Dirujuk kepada', preadmit: 'Diputuskan masuk wad',
        admitted: 'Masuk wad pada', elapsed: 'Sudah di jabatan', bwt: 'Menunggu katil',
        twt: 'Jumlah masa', queueNo: 'Nombor giliran anda',
        calledIn: 'Dipanggil masuk pada', crisisBed: 'Katil tambahan',
        waitingArea: 'Di ruang tunggu'
      },
      queueWait: 'Sedang menunggu panggilan masuk ke bilik doktor'
    },

    /* admin gate */
    admin: {
      gateTitle:  'Papan pemuka pentadbiran',
      gateBody:   'Bahagian ini untuk kegunaan staf. Sila masukkan kod akses.',
      passcode:   'Kod akses',
      enter:      'Masuk',
      badCode:    function (n) { return 'Kod tidak sah. Tinggal ' + n + ' cubaan.'; },
      rateLimited:'Terlalu banyak cubaan. Sila tunggu 15 minit.',
      notConfig:  'Kod akses belum ditetapkan. Dalam editor Apps Script: Project Settings → Script Properties → tambah ADMIN_PASSCODE, kemudian tekan Save script properties.',
      lockedBody: 'Bahagian ini untuk kegunaan staf sahaja.',
      openGate:   'Masukkan kod akses',
      unauth:     'Sesi tamat. Sila masukkan kod akses semula.'
    },

    /* method / notes */
    note: {
      suppressed:   function (n) { return 'Tidak dipaparkan — kurang daripada ' + n + ' rekod, terlalu sedikit untuk dipercayai.'; },
      admittedOnly: 'Pesakit masuk wad sahaja',
      modelDamped:  'Model: Holt linear terlembap (pelicinan eksponen berganda), selang ramalan Poisson.',
      modelHW:      'Model: Holt–Winters tambahan, kitaran 24 jam, selang ramalan Poisson.',
      accuracy:     function (mae, rmse) { return 'Ketepatan dalam-sampel satu jam ke hadapan: MAE ' + mae + ', RMSE ' + rmse + '.'; },
      staleForecast:'Rekod kemasukan terkini belum lengkap, jadi ramalan ini adalah anggaran kasar.',
      partialExcluded:'Jam yang belum tamat tidak dipaparkan kerana belum lengkap.',
      notConfigured:'Belum ditetapkan',
      costModelled: 'Anggaran: kos seunit × kehadiran',
      noDeathField: 'Medan tiada dalam daftar',
      losDefault:   'Tempoh rawatan lalai 4 jam digunakan — rekod masa tamat terlalu sedikit.',
      stepDown:     function (n) { return n + ' zon mempunyai katil krisis dibuka sedangkan katil biasa masih kosong — pertimbangkan pemindahan.'; },
      icProxy:      'Negeri pendaftaran lahir, bukan tempat tinggal.'
    },

    dq: {
      badBedCode: 'Kod katil tidak dikenali',
      zoneMismatch: 'Zon tidak sepadan dengan kod katil',
      currentZoneMismatch: 'Zon semasa berbeza daripada zon triaj',
      pacNonFemale: 'Rekod PAC bukan wanita',
      honorificGenderMismatch: 'Nama (bin/binti) tidak sepadan dengan jantina',
      admitBeforeTriage: 'Masa masuk wad sebelum triaj',
      admittedNoAdmitTime: 'Status masuk wad tanpa masa',
      admittedNoPreadmit: 'Masuk wad tanpa keputusan pra-kemasukan',
      queueNoOutsideGZ: 'Nombor giliran di luar Zon Hijau',
      futureTriage: 'Masa triaj pada masa hadapan',
      duplicateMrn: 'MRN berulang',
      clean: 'Tiada isu kualiti data dikesan.'
    },

    field: {
      triage: 'Masa triaj', age: 'Umur', gender: 'Jantina', zone: 'Zon',
      bedCode: 'Kod katil', status: 'Status', referredTo: 'Dirujuk kepada',
      queueNo: 'No. giliran', calledGZ: 'Dipanggil ke bilik', preadmit: 'Pra-kemasukan',
      admit: 'Masa masuk wad', bwt: 'BWT', twt: 'TWT', gzwt: 'GZWT'
    },

    footer: 'Data dikemas kini setiap 15 minit. Untuk pertanyaan segera, sila ke kaunter jururawat.',
    credit: 'Prototaip dibangunkan oleh Dr Naim, HTPN'
  },

  en: {
    appTitle:    'Emergency Department & PAC',
    appSub:      'Hospital Tengku Permaisuri Norashikin, Kajang',
    demoTag:     'DEMO',
    demoNote:    'Synthetic data',
    langLabel:   'Bahasa Malaysia',
    langFlag:    '🇲🇾',
    searchBtn:   'Find a patient',
    updated:     'Updated',
    snapshot:    'Records as at',
    loading:     'Loading…',
    retry:       'Try again',
    prev:        'Back',
    next:        'Next',
    stepOf:      function (a, b) { return 'Step ' + a + ' of ' + b; },
    tableView:   'Table',
    closeLbl:    'Close',
    errTitle:    'This information cannot be shown',
    errBody:     'The system could not be reached. Please try again shortly, or ask at the nursing counter.',
    errTimeout:  'The server took too long to answer. Please try again.',
    errNoResponse: 'The server gave no answer. Please try again.',

    /* IQMS & triage tab — shared guidance, not unit-specific */
    iqms: {
      whyTitle:  'Why someone else may be seen first',
      whyBody1:  'Patients in the Emergency Department are attended to according to clinical urgency, not order of arrival. Every patient is assessed at triage by a trained clinician and assigned to a priority zone based on the severity of their condition.',
      whyBody2:  'Consequently, a patient who arrives after you may be seen before you. This does not indicate that you have been overlooked, nor that your concern is unimportant. It indicates that another patient has been assessed as being at greater immediate risk.',
      whyAlert:  'Should your condition change while waiting, please inform the triage counter IMMEDIATELY so that you can be reassessed.',

      emergTitle: 'An emergency — come straight here',
      emergList: [
        'Chest pain or difficulty breathing',
        'Weakness on one side, facial droop or slurred speech (signs of stroke)',
        'Bleeding that will not stop',
        'Loss of consciousness, fits or sudden confusion',
        'Serious injury, a road accident or a broken bone',
        'High fever in a baby under 3 months old'
      ],

      nonTitle: 'Not an emergency — Klinik Kesihatan or GP',
      nonList: [
        'Sore throat, cold or a mild cough',
        'Mild fever without breathlessness',
        'Minor cuts and grazes',
        'A mild skin rash',
        'Repeat prescriptions or a medical certificate'
      ],
      nonWarn: 'Attendance for non-emergency conditions diverts clinical resources away from patients whose lives depend on them.',
      nonMadani: 'Covered by Skim Perubatan MADANI? Please go to a registered GP clinic.',

      ctaTitle:   'Check your queue number online',
      ctaSub:     'No need to scan the QR code \\u2014 just tap here.',
      ctaBtn:     'Open iQMS',
      queueTitle: 'IQMS — your queue number in real time',
      queueList: [
        'Green Zone patients are given a queue number and called to a consultation room in turn.',
        'Red and Yellow Zone patients are NOT given a queue number, because they are treated immediately.',
        'The current number is shown on the IQMS screen in the waiting area.',
        'Do not leave the waiting area without telling the counter — you may miss your turn.'
      ]
    },

    /* landing page — the Vercel front door, which may scroll */
    landing: {
      kicker:      'Public Service',
      title:       'Emergency Department & PAC status',
      lead:        'See how busy our departments are right now, and where you should go.',
      liveNow:     'Right now',
      unitsSub:    'Choose a location to see the status of each zone.',
      viewBoard:   'View the status board',
      patients:    'patients',
      waitingHere: 'waiting in the hall',
      offline:     'The figures cannot be loaded at the moment. Please try again shortly.',
      perananTitle:'Five Roles Towards a Healthier Nation',
      perananLead: 'Each one eases hospital crowding — and lengthens your own life.',
      role:        'Role',
      tvTitle:     'Waiting-hall display',
      tvBody:      'A large-format status board for a television in the hall, with the public-health panel alongside.',
      tvLink:      'Open the TV display',
      posterTitle: 'Printable poster',
      posterBody:  'An A4 poster with a QR code to this status board, for the counter and the waiting area.',
      posterLink:  'Open the poster',
      kkmTitle:    'MOH health posters',
      kkmBody:     'Health-education material published by the Ministry of Health, grouped by the five public roles.',
      kkmLink:     'View the MOH posters',
      scanMe:      'Scan to see zone status'
    },

    /* public view — tabs 1 to 3 */
    public: {
      seekSub:     "Enter the patient's IC, passport number or MRN.",
      counterTitle: "For a patient's status, please ask at the nurses' counter",
      counterSub:  'To protect patient confidentiality, individual details are not shown here. The nurse at the counter will help you.',
      tapTitle:    'The most seriously ill are seen first.',
      tapBody:     'Patients are seen in order of clinical urgency, not order of arrival.',
      stepNow:     'Zone status now',
      stepGuide:   'Guidance for families',
      beds:        'beds',
      rooms:       'consultation rooms',
      crisisBeds:  'bed crisis activated',
      waitingNow:  'waiting now',
      avgWait:     'Average time to be called:',
      avgWaitNone: 'Average not yet available',
      state: { ok: 'Space available', busy: 'Busy', full: 'Full', crisis: 'Crisis activated' },
      crisisTitle: 'The department is very busy.',
      crisisBody:  function (n) {
        return 'We have activated ' + n + ' crisis beds so that everyone can be treated. ' +
               'We apologise for any delay.';
      },
      guideTitle:  'What you need to know',
      posterBtn:   'View posters',
      klinikTitle: 'Not an emergency? Go to a Klinik Kesihatan or GP clinic',
      klinikBody:  'Sore throat, mild fever, runny nose, mild cough and minor wounds are not emergencies. Please go to your nearest Klinik Kesihatan or GP clinic.',
      klinikMadani:'If you are covered by Skim Perubatan MADANI, please go to a registered GP clinic.',
      guide: [
        { icon: '🚑', title: 'The most seriously ill are seen first',
          body: 'Patients are seen in order of clinical urgency, not arrival. Someone who arrives after you may be seen first.' },
        { icon: '🟥', title: 'Red and Yellow Zones',
          body: 'These zones are for emergencies and life-threatening conditions. Patients are attended to immediately and are not given a queue number.' },
        { icon: '🟩', title: 'Green Zone',
          body: 'For less urgent conditions. Patients are given a queue number and wait until called to a consultation room.' },
        { icon: '🛏️', title: 'Waiting for a ward bed',
          body: 'Once a medical officer or specialist decides that admission is required, the patient waits here until a ward bed becomes available.' },
        { icon: '🏠', title: 'After discharge',
          body: 'The patient remains listed here for 24 hours after discharge, so that family can still check their status.' },
        { icon: '💬', title: 'Is the patient getting worse?',
          body: 'Go to the nursing counter immediately. Do not wait outside.' }
      ]
    },
    tabs: {
      wcc:   { name: 'Emergency — Women & Children', sub: 'WCC' },
      bu:    { name: 'Emergency — Main Building',    sub: 'Main Building' },
      pac:   { name: 'Patient Assessment Centre — O&G', sub: 'Antenatal' },
      iqms:   { name: 'iQMS — Queue Number',           sub: 'Check it online' },
      triage: { name: 'Emergency or Not?',             sub: 'Patient guidance' },
      admin: { name: 'Administrative',               sub: 'Staff only' }
    },

    steps: {
      now: 'Current status', flow: 'Arrivals & forecast', waits: 'Waiting times',
      pattern: 'Patterns & forecast',
      overview: 'Whole-service overview', casemix: 'Case-mix & referrals',
      beds: 'Bed management', quality: 'Data quality & method'
    },

    zone: {
      rz: 'Red Zone', yz: 'Yellow Zone', gz: 'Green Zone',
      ob: 'Observation Bay', ab: 'Asthma Bay', pac: 'PAC'
    },
    zoneShort: { rz: 'RED', yz: 'YELLOW', gz: 'GREEN', ob: 'OBS', ab: 'ASTHMA', pac: 'PAC' },

    status: {
      ongoingtreatment: 'Under treatment',
      referred:         'Referred to specialist',
      preadmit:         'Awaiting a ward bed',
      admitted:         'Admitted to ward',
      discharge:        'Waiting to go home',
      discharged:       'Waiting to go home'
    },

    units: { 'ED WCC': 'Emergency WCC', 'ED BU': 'Emergency Main Building', 'PAC WCC': 'PAC (O&G)' },
    unitsShort: { 'ED WCC': 'WCC', 'ED BU': 'Main Bldg', 'PAC WCC': 'PAC' },

    kpi: {
      census: 'Patients in department', load: 'Load against normal beds',
      crisis: 'Escalation beds open', gzQueue: 'Waiting in Green Zone',
      gzAvg: 'Average time to be called', medianWait: 'Time in department (median)',
      preadmit: 'Awaiting a ward bed', referred: 'Referred to specialist',
      attendances: 'Total attendances', admitted: 'Admitted', deaths: 'Deaths',
      admitRate: 'Admission rate', referRate: 'Referral rate',
      medianTwt: 'Total treatment time', medianBwt: 'Bed wait (median)',
      cost: 'Modelled cost', freeBeds: 'Normal beds free'
    },

    panel: {
      capacity: 'Beds and rooms by zone',
      capacitySub: 'A full bar means normal beds are full. The black rule marks normal capacity.',
      statusMix: 'Patient status', arrivals: 'Arrivals per hour & forecast',
      waitDist: 'How long patients have been waiting',
      heatHourZone: 'Busyness by hour and zone',
      scatter: 'Age against time in department',
      forecastCard: 'Next four hours', unitCompare: 'Comparison across units',
      referrals: 'Referrals by discipline', ageBands: 'Age groups', gender: 'Sex',
      heatZoneRef: 'Zone against referral discipline',
      bedBoard: 'Bed board — all zones',
      completeness: 'Field completeness', flags: 'Data quality issues',
      method: 'Statistical method', projection: 'Projected patient numbers'
    },

    chart: {
      hour: 'Hour', arrivals: 'Arrivals', projected: 'Forecast',
      pi80: '80% interval', pi95: '95% interval', partialHour: 'Hour not yet complete',
      zone: 'Zone', funded: 'Normal beds', crisis: 'Escalation beds', queueShort: 'waiting',
      range: 'Range', patients: 'Patients', median: 'Median:',
      group: 'Group', age: 'Age', years: 'years', elapsed: 'In department',
      unit: 'Unit', row: 'Row', col: 'Column', populated: 'Populated',
      observed: 'Recorded', forecastLbl: 'Forecast',
      axisAge: 'Age (years)',
      legendFunded: 'Normal beds', legendCrisis: 'Escalation beds',
      legendCapacity: 'Normal capacity',
      bed: 'Bed', free: 'Free', crisisBed: 'Escalation bed',
      dwell: 'In department', dwellUnit: 'hours in department',
      occupied: 'In use', places: 'Total places'
    },

    heat: {
      unitPatients: 'patients', unitReferrals: 'referrals',
      bedNote: 'Each cell is one bed. Unit: hours in the department, 0 to the longest. Dark = longest in that bed; bright = just arrived; white dashed = empty. The black rule marks normal capacity.',
      hourZoneNote: 'Unit: patients, scale 0 to the highest value. Darker cells carry more arrivals in that hour and zone; brighter cells carry fewer.',
      zoneRefNote: 'Unit: referrals, scale 0 to the highest value. Darker cells are frequently used referral routes; brighter cells are rare.',
      bedSummary: function (p) {
        return p.occupied + ' of ' + p.places + ' places in use (' + p.pct + '%). ' +
               p.empty + ' beds free. ' + p.crisisOccupied + ' of ' +
               p.crisisPlaces + ' escalation beds open.';
      }
    },

    narr: {
      narrCapacity: function (p) {
        var m = {
          normal: 'The department is running normally.',
          busy:   'The department is busy at the moment.',
          full:   'All normal beds are now full.',
          crisis: 'The department is <strong>very busy</strong>.'
        };
        var t = m[p.state] || m.normal;
        if (p.pct !== null && p.capacity > 0) {
          t += ' We are caring for <strong>' + p.beds + ' patients</strong> in a space normally holding ' + p.capacity + ' beds.';
        }
        return t;
      },
      narrCrisis: function (p) {
        return 'We have opened <strong>' + p.crisis + ' extra beds</strong> so that everyone can be treated.';
      },
      narrZonesFull: function (p) { return 'Zones full: ' + p.zones.join(', ') + '.'; },
      narrGzQueue: function (p) {
        var t = '<strong>' + p.queue + ' people</strong> are waiting in the Green Zone waiting area (' + p.rooms + ' consultation rooms open).';
        if (p.avgMin) t += ' Average wait to be called is about ' + p.avgMin + ' minutes.';
        return t;
      },
      narrPreadmit: function (p) {
        return '<strong>' + p.n + ' patients</strong> have been accepted for admission and are waiting for a ward bed.';
      },
      narrForecast: function (p) {
        var m = { rising: 'We expect arrivals to rise', falling: 'We expect arrivals to fall', steady: 'We expect arrivals to stay about the same' };
        var t = (m[p.dir] || m.steady) + ' at ' + ('0' + p.hour).slice(-2) + ':00, to around ' + p.next + ' patients.';
        if (p.stale) t += ' (An estimate only — the most recent arrival records are incomplete.)';
        return t;
      },
      narrReassure: function () {
        return 'The most seriously ill patients are seen first, not in order of arrival. Thank you for your patience.';
      }
    },

    search: {
      title: "Check a family member's status",
      placeholder: 'IC number, passport number, or MRN',
      hint: 'Enter at least 6 digits of the IC number (or the full MRN). To search by name, give both a first name and a family name. IC numbers are shown partly masked to protect patient privacy.',
      minChars: function (n) { return 'Please enter at least ' + n + ' characters.'; },
      none: 'No record found. Please check the number entered, or ask at the nursing counter.',
      tooMany: function (n) { return 'That search is too broad (' + n + ' records match). Please enter more of the IC or MRN number.'; },
      rateLimit: 'Too many searches. Please wait a few minutes.',
      error: 'System error. Please try again shortly.',
      resultsFor: 'Search results',
      fields: {
        location: 'Location', zone: 'Zone', status: 'Status', triage: 'Arrived',
        referredTo: 'Referred to', preadmit: 'Accepted for admission',
        admitted: 'Admitted at', elapsed: 'Time in department', bwt: 'Bed wait',
        twt: 'Total time', queueNo: 'Your queue number',
        calledIn: 'Called in at', crisisBed: 'Escalation bed', waitingArea: 'In the waiting area'
      },
      queueWait: 'Waiting to be called into a consultation room'
    },

    admin: {
      gateTitle: 'Administrative dashboard',
      gateBody: 'This section is for staff use. Please enter the access code.',
      passcode: 'Access code', enter: 'Enter',
      badCode: function (n) { return 'Incorrect code. ' + n + ' attempts remaining.'; },
      rateLimited: 'Too many attempts. Please wait 15 minutes.',
      notConfig: 'No access code has been set. In the Apps Script editor: Project Settings → Script Properties → add ADMIN_PASSCODE, then press Save script properties.',
      lockedBody: 'This section is for staff use only.',
      openGate:  'Enter access code',
      unauth: 'Session expired. Please enter the access code again.'
    },

    note: {
      suppressed: function (n) { return 'Not shown — fewer than ' + n + ' records, too few to be reliable.'; },
      admittedOnly: 'Admitted patients only',
      modelDamped: 'Model: damped Holt linear trend (double exponential smoothing), Poisson prediction intervals.',
      modelHW: 'Model: additive Holt–Winters, 24-hour seasonal period, Poisson prediction intervals.',
      accuracy: function (mae, rmse) { return 'In-sample one-hour-ahead accuracy: MAE ' + mae + ', RMSE ' + rmse + '.'; },
      staleForecast: 'The most recent arrival records are incomplete, so this forecast is a rough estimate.',
      partialExcluded: 'The hour in progress is not plotted, as it is not yet complete.',
      notConfigured: 'Not configured',
      costModelled: 'Modelled: unit cost × attendances',
      noDeathField: 'Field absent from the register',
      losDefault: 'A default 4-hour length of stay is used — too few completed episodes to estimate one.',
      stepDown: function (n) { return n + ' zones have escalation beds open while normal beds stand empty — consider stepping down.'; },
      icProxy: 'State of registration at birth, not current residence.'
    },

    dq: {
      badBedCode: 'Unrecognised bed code',
      zoneMismatch: 'Zone disagrees with the bed code',
      currentZoneMismatch: 'Current zone differs from triage zone',
      pacNonFemale: 'PAC record not female',
      honorificGenderMismatch: 'Name particle (bin/binti) disagrees with sex',
      admitBeforeTriage: 'Admission recorded before triage',
      admittedNoAdmitTime: 'Admitted status with no admission time',
      admittedNoPreadmit: 'Admitted with no pre-admission decision',
      queueNoOutsideGZ: 'Queue number outside the Green Zone',
      futureTriage: 'Triage time in the future',
      duplicateMrn: 'Duplicate MRN',
      clean: 'No data quality issues detected.'
    },

    field: {
      triage: 'Triage time', age: 'Age', gender: 'Sex', zone: 'Zone',
      bedCode: 'Bed code', status: 'Status', referredTo: 'Referred to',
      queueNo: 'Queue no.', calledGZ: 'Called into room', preadmit: 'Pre-admission',
      admit: 'Admission time', bwt: 'BWT', twt: 'TWT', gzwt: 'GZWT'
    },

    footer: 'Data refreshes every 15 minutes. For urgent enquiries please go to the nursing counter.',
    credit: 'Prototype developed by Dr Naim, HTPN'
  }
};
</script>

<script>
/* ============================================================
   HEALTH-PROMOTION RAIL  —  "5 Peranan Rakyat ke arah Negara Sehat"

   Shown only in wall-display mode (?mode=tv) and hidden on phones. A
   waiting hall is captive, high-dwell attention, which is exactly what
   health promotion normally cannot buy; a family member checking a
   relative on their own phone wants one answer and nothing else.

   Editorial rules applied to this content, deliberately:
     - No third-party embeds. Nothing here loads from Instagram, Threads
       or any other site: a hospital display must not render content that
       can be edited by someone else after the hospital has endorsed it,
       and must not track the people standing in front of it. Facts are
       restated in our own words and the source is named as plain text.
     - Every clinical claim has to survive a clinician reading it. Claims
       that cannot be supported were dropped rather than softened, because
       one indefensible line discredits the defensible ones beside it.
     - Each card ends in something a member of the public can do today.
       Advocacy aimed at other parties does not belong on this screen.
   ============================================================ */
var Banner = (function () {
  'use strict';

  var PERIOD_MS = 12000;   // long enough to read a card from across a hall

  var ITEMS = [
    {
      id: 'intro', tone: 'intro', icon: '\\ud83c\\uddf2\\ud83c\\uddfe', no: '',
      title: { ms: '5 Peranan Rakyat ke arah Negara Sehat',
               en: 'Five Roles Towards a Healthier Nation' },
      lead:  { ms: 'Setiap satu mengurangkan kesesakan hospital \\u2014 dan memanjangkan hayat anda.',
               en: 'Each one eases hospital crowding \\u2014 and lengthens your own life.' },
      points: [],
      action: { ms: 'Paparan ini bertukar setiap beberapa saat.',
                en: 'This panel changes every few seconds.' },
      source: { ms: 'Jabatan Kecemasan & PAC, HTPN Kajang',
                en: 'Emergency Department & PAC, HTPN Kajang' }
    },
    {
      id: 'p1', tone: 'move', icon: '\\ud83d\\udc5f', no: '1',
      title: { ms: 'Bergerak setiap hari', en: 'Move every day' },
      lead:  { ms: 'Cabaran Langkah Sehat. Mula dari paras anda, bukan paras orang lain.',
               en: 'The healthy-steps challenge. Start from where you are.' },
      points: [
        { ms: '5,000 langkah untuk permulaan. 7,000\\u20138,000 untuk manfaat penuh.',
          en: '5,000 steps to start. 7,000\\u20138,000 for the full benefit.' },
        { ms: '29.9% rakyat Malaysia tidak cukup bergerak (NHMS 2023).',
          en: '29.9% of Malaysians are physically inactive (NHMS 2023).' },
        { ms: 'Manfaat terbesar pada yang paling kurang bergerak.',
          en: 'The biggest gains go to those who move least.' },
        { ms: 'Menurunkan risiko kencing manis, darah tinggi dan strok.',
          en: 'Lowers the risk of diabetes, high blood pressure and stroke.' },
        { ms: 'Mengurangkan beban pada sendi.',
          en: 'Eases the load on your joints.' }
      ],
      action: { ms: 'Jadikan langkah harian KPI jabatan anda. Mula hari ini.',
                en: 'Make daily steps your department\\u2019s KPI. Start today.' },
      source: { ms: 'NHMS 2023, IKU KKM; garis panduan aktiviti fizikal WHO, 2020',
                en: 'NHMS 2023, IPH Malaysia; WHO physical activity guidelines, 2020' }
    },
    {
      id: 'p2', tone: 'sugar', icon: '\\ud83e\\udd64', no: '2',
      title: { ms: 'Kurangkan gula', en: 'Cut down on sugar' },
      lead:  { ms: 'Manis itu membunuh. Kencing manis yang tidak terkawal memusnahkan organ satu demi satu.',
               en: 'Sweetness kills. Uncontrolled diabetes destroys the organs one by one.' },
      points: [
        { ms: 'Mata: retinopati, punca utama kebutaan.',
          en: 'Eyes: retinopathy, a leading cause of blindness.' },
        { ms: 'Buah pinggang: punca utama dialisis di Malaysia.',
          en: 'Kidneys: the leading cause of dialysis in Malaysia.' },
        { ms: 'Kaki: luka yang tidak sembuh, lalu potong kaki.',
          en: 'Feet: wounds that will not heal, then amputation.' },
        { ms: 'Jantung: serangan jantung dan strok lebih awal.',
          en: 'Heart: heart attack and stroke, earlier in life.' }
      ],
      action: { ms: 'Baca label; cari Logo Pilihan Lebih Sihat KKM. Berat turun hanya apabila kalori digunakan melebihi yang dimakan.',
                en: 'Read the label; look for the MOH Healthier Choice Logo. Weight falls only when calories used exceed calories eaten.' },
      source: { ms: 'CPG Pengurusan Obesiti (MEMS, 2023); Logo Pilihan Lebih Sihat, KKM',
                en: 'CPG Management of Obesity (MEMS, 2023); Healthier Choice Logo, MOH' }
    },
    {
      id: 'p3', tone: 'screen', icon: '\\ud83e\\ude7a', no: '3',
      title: { ms: 'Jalani saringan kesihatan awal', en: 'Get screened early' },
      lead:  { ms: 'Penyakit kronik tidak menunggu simptom. Saringan menjumpainya sebelum ia merosakkan organ.',
               en: 'Chronic disease does not wait for symptoms. Screening finds it before it damages organs.' },
      points: [
        { ms: 'Periksa tekanan darah, gula dalam darah dan BMI di Klinik Kesihatan.',
          en: 'Have your blood pressure, blood glucose and BMI checked at a Klinik Kesihatan.' },
        { ms: 'Hadir setiap temujanji susulan \\u2014 yang dilangkau sering berakhir di sini.',
          en: 'Keep every follow-up appointment \\u2014 a missed one often ends up here.' },
        { ms: 'Bawa senarai ubat anda setiap kali datang.',
          en: 'Bring your list of medicines every time you come.' }
      ],
      action: { ms: 'Klinik Kesihatan juga tempat yang betul untuk kes bukan kecemasan.',
                en: 'A Klinik Kesihatan is also the right place for anything that is not an emergency.' },
      source: { ms: 'Jabatan Kecemasan & PAC, HTPN Kajang',
                en: 'Emergency Department & PAC, HTPN Kajang' }
    },
    {
      id: 'p4', tone: 'meds', icon: '\\u26a0\\ufe0f', no: '4',
      title: { ms: 'Berhenti suplemen terlebih janji',
               en: 'Stop over-claimed supplements' },
      lead:  { ms: '\\u201cSemula jadi\\u201d bukan bermakna selamat. Wad dialisis kami menanggung akibatnya.',
               en: '\\u201cNatural\\u201d does not mean safe. Our dialysis wards carry the cost.' },
      points: [
        { ms: 'Kecederaan buah pinggang akut, lalu dialisis seumur hidup.',
          en: 'Acute kidney injury, then lifelong dialysis.' },
        { ms: 'Kecederaan hati akibat herba tidak berdaftar.',
          en: 'Liver injury from unregistered herbal products.' },
        { ms: 'Steroid tersembunyi: nampak pulih, penyakit bertambah buruk.',
          en: 'Hidden steroids: looks better, gets worse.' },
        { ms: 'Jangan berhenti ubat doktor kerana pujukan penjual.',
          en: 'Never stop a prescribed medicine on a seller\\u2019s word.' }
      ],
      action: { ms: 'Semak nombor MAL dan hologram Meditag di portal NPRA sebelum membeli. Lapor produk tanpa pendaftaran.',
                en: 'Check the MAL number and Meditag hologram on the NPRA portal before buying. Report unregistered products.' },
      source: { ms: 'Bahagian Regulatori Farmasi Negara (NPRA), KKM',
                en: 'National Pharmaceutical Regulatory Agency (NPRA), MOH' }
    },
    {
      id: 'p5', tone: 'smoke', icon: '\\ud83d\\udead', no: '5',
      title: { ms: 'Lapor merokok di kawasan larangan',
               en: 'Report smoking where it is banned' },
      lead:  { ms: 'Asap orang lain adalah masalah kesihatan anda.',
               en: 'Someone else\\u2019s smoke is your health problem.' },
      points: [
        { ms: 'Asap tangan kedua mencetuskan asma pada kanak-kanak.',
          en: 'Second-hand smoke triggers asthma in children.' },
        { ms: 'Punca utama penyakit paru-paru, kanser dan serangan jantung.',
          en: 'A leading cause of lung disease, cancer and heart attack.' },
        { ms: 'Klinik Berhenti Merokok: di Klinik Kesihatan, tanpa bayaran.',
          en: 'Quit clinics: at any Klinik Kesihatan, free of charge.' }
      ],
      action: { ms: 'Ambil gambar sebagai bukti, kemudian lapor kepada Pejabat Kesihatan Daerah.',
                en: 'Photograph it as evidence, then report it to your District Health Office.' },
      source: { ms: 'Akta Kawalan Produk Merokok untuk Kesihatan Awam 2024',
                en: 'Control of Smoking Products for Public Health Act 2024' }
    },
  ];

  var st = { i: 0, timer: null, el: null, langFn: null };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function pick(v, lang) {
    if (!v) return '';
    return v[lang] || v.ms || '';
  }
  function lang() { return (st.langFn && st.langFn()) || 'ms'; }

  function cardHtml(it, lg) {
    var pts = (it.points || []).map(function (p) {
      return '<li>' + esc(pick(p, lg)) + '</li>';
    }).join('');
    var head = it.no
      ? '<span class="rail-no">' + esc(lg === 'ms' ? 'Peranan ' + it.no : 'Role ' + it.no) + '</span>'
      : '';
    return '' +
      '<div class="rail-card is-' + esc(it.tone) + '">' +
        '<div class="rail-top">' +
          '<span class="rail-icon" aria-hidden="true">' + esc(it.icon) + '</span>' +
          head +
        '</div>' +
        '<h3 class="rail-title">' + esc(pick(it.title, lg)) + '</h3>' +
        '<p class="rail-lead">' + esc(pick(it.lead, lg)) + '</p>' +
        (pts ? '<ul class="rail-pts">' + pts + '</ul>' : '') +
        '<p class="rail-action">' + esc(pick(it.action, lg)) + '</p>' +
        '<p class="rail-src">' + esc(pick(it.source, lg)) + '</p>' +
      '</div>';
  }

  function dotsHtml() {
    var out = '';
    for (var i = 0; i < ITEMS.length; i++) {
      out += '<span class="rail-dot' + (i === st.i ? ' is-on' : '') + '"></span>';
    }
    return '<div class="rail-dots">' + out + '</div>';
  }

  /** Draws the current card. Safe to call at any time, including on a
      language change, without disturbing the rotation. */
  function render() {
    if (!st.el) return;
    var lg = lang();
    st.el.innerHTML = cardHtml(ITEMS[st.i], lg) + dotsHtml();
    // Restart the fade so a newly drawn card reads as a new card.
    var card = st.el.querySelector('.rail-card');
    if (card) {
      card.classList.remove('is-in');
      /* jshint -W030 */
      void card.offsetWidth;
      card.classList.add('is-in');
    }
  }

  function next() { st.i = (st.i + 1) % ITEMS.length; render(); }

  function mount(el, langFn) {
    if (!el) return;
    st.el = el;
    st.langFn = langFn || null;
    st.i = 0;
    render();
    if (st.timer) clearInterval(st.timer);
    st.timer = setInterval(next, PERIOD_MS);
  }

  function stop() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  return {
    mount: mount, render: render, next: next, stop: stop,
    items: ITEMS, count: ITEMS.length,
    index: function () { return st.i; },
    period: PERIOD_MS
  };
})();
</script>

<script>
/* ============================================================
   CHARTS — hand-written inline SVG, no external library.

   Why no chart library: this page must load over a slow hospital
   connection, render inside an Apps Script iframe, and fit an exact
   pixel box with no scrollbar. Every chart therefore measures its own
   container and draws to that box, so nothing can overflow.

   House rules applied throughout:
     - one value axis per chart, never two
     - hairline solid grid, one shade off the surface
     - 2px surface gap between adjacent or stacked fills
     - >=8px markers with a 2px surface ring where marks overlap
     - a legend whenever two or more series are present
     - selective direct labels, never a number on every point
     - a hover tooltip on every mark, and a table view for every chart
   ============================================================ */
var Charts = (function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var GRID = '#e8edf1', AXIS = '#d7dee4';
  var INK = '#14202a', INK2 = '#4a5763', INK3 = '#77848f';
  var SURFACE = '#ffffff';

  var ZONE = { rz: '#c0392b', yz: '#e08b00', gz: '#1a7c4a',
               ob: '#2a78d6', ab: '#4a3aa7', pac: '#e87ba4' };
  var CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
             '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  var SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  var SEQ_ZERO = '#f4f7fa';
  var STATUS = { ok: '#0ca30c', warn: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

  var _mctx = null;
  /** Measured width of a label, used to size label gutters. */
  function textW(str, px, weight) {
    if (!_mctx) {
      var c = document.createElement('canvas');
      _mctx = c.getContext('2d');
    }
    if (!_mctx) return String(str).length * px * 0.58;
    _mctx.font = (weight || 700) + ' ' + px + 'px "Plus Jakarta Sans", system-ui, sans-serif';
    return _mctx.measureText(String(str)).width;
  }
  function widestW(list, px, weight) {
    var w = 0;
    for (var i = 0; i < list.length; i++) w = Math.max(w, textW(list[i], px, weight));
    return w;
  }
  /** Truncates to fit a pixel budget, adding an ellipsis. */
  function fitText(str, budget, px, weight) {
    str = String(str);
    if (textW(str, px, weight) <= budget) return str;
    for (var n = str.length - 1; n > 1; n--) {
      var cand = str.slice(0, n) + '…';
      if (textW(cand, px, weight) <= budget) return cand;
    }
    return '…';
  }

  function scale() {
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s'));
    return isNaN(v) ? 1 : v;
  }

  // ── string helpers ───────────────────────────────────────
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v, dp) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var f = Math.pow(10, dp || 0);
    return String(Math.round(v * f) / f);
  }
  function attrs(o) {
    var s = '';
    for (var k in o) {
      if (!o.hasOwnProperty(k) || o[k] === null || o[k] === undefined) continue;
      s += ' ' + k + '="' + esc(o[k]) + '"';
    }
    return s;
  }
  function tag(name, o, inner) {
    return '<' + name + attrs(o) + (inner === undefined || inner === null
      ? '/>' : '>' + inner + '</' + name + '>');
  }
  function txt(x, y, s, o) {
    var a = { x: x, y: y, fill: INK2, 'font-size': 10 };
    for (var k in (o || {})) if (o.hasOwnProperty(k)) a[k] = o[k];
    return tag('text', a, esc(s));
  }
  /** Tooltip payload, read back by the delegated hover handler. */
  function tip(rows) {
    return rows.map(function (r) {
      return r.length === 1 ? '<span class="tip-k">' + esc(r[0]) + '</span>'
        : '<span class="tip-k">' + esc(r[0]) + '</span> <b>' + esc(r[1]) + '</b>';
    }).join('<br>');
  }

  // ── axis ticks ───────────────────────────────────────────
  function niceTicks(lo, hi, want) {
    if (hi <= lo) hi = lo + 1;
    var span = hi - lo, raw = span / Math.max(1, want);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag, step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5; else if (norm <= 5) step = 5; else step = 10;
    step *= mag;
    var start = Math.ceil(lo / step) * step, out = [];
    for (var v = start; v <= hi + step * 0.001; v += step) {
      out.push(Math.round(v * 1e6) / 1e6);
    }
    return out;
  }

  // ── frame: measure the box, reserve the plot area ─────────
  function frame(el, pad) {
    var w = Math.max(80, Math.round(el.clientWidth));
    var h = Math.max(60, Math.round(el.clientHeight));
    var p = { t: 8, r: 8, b: 18, l: 26 };
    for (var k in (pad || {})) if (pad.hasOwnProperty(k)) p[k] = pad[k];
    return {
      w: w, h: h, p: p,
      iw: Math.max(10, w - p.l - p.r),
      ih: Math.max(10, h - p.t - p.b)
    };
  }
  function open(f, label) {
    return '<svg xmlns="' + NS + '" width="' + f.w + '" height="' + f.h +
      '" viewBox="0 0 ' + f.w + ' ' + f.h + '" role="img"' +
      (label ? ' aria-label="' + esc(label) + '"' : '') + '>';
  }
  function empty(el, msg) {
    el.innerHTML = '<div class="state"><span class="state-icon">◦</span><span>' +
      esc(msg) + '</span></div>';
  }

  // ── grid + value axis (horizontal rules) ─────────────────
  function yGrid(f, ticks, yOf, fmt) {
    var s = '';
    for (var i = 0; i < ticks.length; i++) {
      var y = yOf(ticks[i]);
      s += tag('line', { x1: f.p.l, y1: y, x2: f.p.l + f.iw, y2: y,
                         stroke: GRID, 'stroke-width': 1 });
      s += txt(f.p.l - 4, y + 3, fmt ? fmt(ticks[i]) : num(ticks[i]),
               { 'text-anchor': 'end', 'font-size': 9, fill: INK3 });
    }
    return s;
  }

  /* ══════════════════════════════════════════════════════════
     CAPACITY BARS — horizontal, funded and escalation stacked
     against the funded establishment. One bar per zone.
     ══════════════════════════════════════════════════════════ */
  function capacityBars(el, spec) {
    var rows = spec.rows || [];
    if (!rows.length) return empty(el, spec.emptyMsg || 'No zones configured');
    var sc = scale();
    var fsLabel = Math.round(10 * sc), fsVal = Math.round(10 * sc);
    var box = Math.max(80, Math.round(el.clientWidth));
    var labelW = Math.min(Math.round(box * 0.28),
      Math.ceil(widestW(rows.map(function (r) { return r.label; }), fsLabel, 800)) + Math.round(7 * sc));
    var valueTexts = rows.map(function (r) { return (r.funded + r.crisis) + '/' + r.capacity; });
    var hasQueue = rows.some(function (r) { return r.waiting > 0; });
    if (hasQueue) {
      rows.forEach(function (r) {
        if (r.waiting > 0) valueTexts.push('+' + r.waiting + ' ' + spec.t.queueShort);
      });
    }
    var valueW = Math.min(Math.round(box * 0.3),
      Math.ceil(widestW(valueTexts, fsVal, 800)) + Math.round(8 * sc));
    var f = frame(el, { t: Math.round(6 * sc), r: valueW, b: Math.round(4 * sc), l: labelW });

    var maxVal = 1;
    rows.forEach(function (r) { maxVal = Math.max(maxVal, r.capacity, r.funded + r.crisis); });

    var gap = Math.round(7 * sc);
    var bh = Math.max(9, Math.floor((f.ih - gap * (rows.length - 1)) / rows.length));
    var bhMax = Math.round(30 * sc);
    if (bh > bhMax) {
      bh = bhMax;
      f.p.t += Math.round((f.ih - (bh * rows.length + gap * (rows.length - 1))) / 2);
    }
    var xOf = function (v) { return f.p.l + (v / maxVal) * f.iw; };
    var s = open(f, spec.aria);

    // Establishment marker: where funded capacity sits on each bar.
    rows.forEach(function (r, i) {
      var y = f.p.t + i * (bh + gap);
      var mid = y + bh / 2;
      var colour = ZONE[r.zone] || CAT[0];

      // Track
      s += tag('rect', { x: f.p.l, y: y, width: f.iw, height: bh, rx: 4, fill: '#f2f5f8' });

      var wFunded = Math.max(0, xOf(r.funded) - f.p.l);
      var wCrisis = Math.max(0, xOf(r.crisis) - f.p.l);

      if (r.funded > 0) {
        s += tag('rect', {
          x: f.p.l, y: y, width: wFunded, height: bh, rx: 4, fill: colour,
          'data-tip': tip([[spec.t.zone, r.label], [spec.t.funded, r.funded + ' / ' + r.capacity]])
        });
      }
      if (r.crisis > 0) {
        // 2px surface gap separates the two fills instead of a border.
        s += tag('rect', {
          x: f.p.l + wFunded + 2, y: y, width: Math.max(2, wCrisis - 2), height: bh, rx: 4,
          fill: colour, 'fill-opacity': 0.34,
          'data-tip': tip([[spec.t.zone, r.label], [spec.t.crisis, r.crisis]])
        });
        s += tag('rect', {
          x: f.p.l + wFunded + 2, y: y, width: Math.max(2, wCrisis - 2), height: bh, rx: 4,
          fill: 'url(#hatch)'
        });
      }
      // Funded-establishment rule — the line the department is staffed for.
      var cx = xOf(r.capacity);
      s += tag('line', { x1: cx, y1: y - 2, x2: cx, y2: y + bh + 2,
                         stroke: INK, 'stroke-width': 1.5 });

      // Direct label — colour never carries zone identity alone.
      s += txt(f.p.l - Math.round(5 * sc), mid + 3,
               fitText(r.label, labelW - Math.round(6 * sc), fsLabel, 800), {
        'text-anchor': 'end', 'font-size': fsLabel, 'font-weight': 800, fill: INK2
      });
      var vLabel = (r.funded + r.crisis) + '/' + r.capacity;
      var vy = r.waiting > 0 ? mid - Math.round(2 * sc) : mid + 3;
      s += txt(f.p.l + f.iw + Math.round(5 * sc), vy, vLabel, {
        'font-size': fsVal, 'font-weight': 800, fill: INK,
        'font-family': 'IBM Plex Mono, monospace'
      });
      if (r.waiting > 0) {
        s += txt(f.p.l + f.iw + Math.round(5 * sc), mid + Math.round(9 * sc),
                 fitText('+' + r.waiting + ' ' + spec.t.queueShort,
                         valueW - Math.round(6 * sc), Math.round(8.5 * sc), 700), {
          'font-size': Math.round(8.5 * sc), 'font-weight': 700, fill: ZONE.gz
        });
      }
    });

    s += '<defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
         '<line x1="0" y1="0" x2="0" y2="6" stroke="' + SURFACE + '" stroke-width="2.2"/></pattern></defs>';
    s += '</svg>';
    el.innerHTML = s;
  }

  /* ══════════════════════════════════════════════════════════
     DONUT — part-to-whole at a glance, <=6 segments
     ══════════════════════════════════════════════════════════ */
  function donut(el, spec) {
    var data = (spec.data || []).filter(function (d) { return d.count > 0; });
    if (!data.length) return empty(el, spec.emptyMsg || 'Nothing to show');
    var sc = scale();
    var f = frame(el, { t: 4, r: 4, b: 4, l: 4 });
    var total = data.reduce(function (a, d) { return a + d.count; }, 0);

    var cx = f.p.l + f.iw / 2, cy = f.p.t + f.ih / 2;
    var R = Math.max(14, Math.min(f.iw, f.ih) / 2 - Math.round(4 * sc));
    var r0 = R * 0.58;
    var s = open(f, spec.aria);
    var a0 = -Math.PI / 2;
    var GAPRAD = data.length > 1 ? 0.018 : 0;   // the 2px surface gap, in radians

    data.forEach(function (d, i) {
      var sweep = (d.count / total) * Math.PI * 2;
      var a1 = a0 + sweep;
      var sa = a0 + GAPRAD, ea = a1 - GAPRAD;
      if (ea <= sa) { sa = a0; ea = a1; }
      var large = (ea - sa) > Math.PI ? 1 : 0;
      var p = [
        'M', cx + R * Math.cos(sa), cy + R * Math.sin(sa),
        'A', R, R, 0, large, 1, cx + R * Math.cos(ea), cy + R * Math.sin(ea),
        'L', cx + r0 * Math.cos(ea), cy + r0 * Math.sin(ea),
        'A', r0, r0, 0, large, 0, cx + r0 * Math.cos(sa), cy + r0 * Math.sin(sa), 'Z'
      ].join(' ');
      s += tag('path', {
        d: p, fill: d.colour || CAT[i % CAT.length],
        'data-tip': tip([[d.label, d.count + ' (' + num(d.count / total * 100, 1) + '%)']])
      });
      a0 = a1;
    });

    // Centre carries the total — the one number the reader wants.
    s += txt(cx, cy + Math.round(2 * sc), String(total), {
      'text-anchor': 'middle', 'font-size': Math.round(Math.min(21, R * 0.52)),
      'font-weight': 800, fill: INK
    });
    if (spec.centreLabel) {
      s += txt(cx, cy + Math.round(14 * sc), spec.centreLabel, {
        'text-anchor': 'middle', 'font-size': Math.round(8.5 * sc), 'font-weight': 700, fill: INK3
      });
    }
    s += '</svg>';
    el.innerHTML = s;
  }

  /* ══════════════════════════════════════════════════════════
     ARRIVALS + FORECAST — one axis, patients per hour.
     Observed is solid; the projection is dashed with 95% and 80%
     prediction bands behind it.
     ══════════════════════════════════════════════════════════ */
  function forecastLine(el, spec) {
    var obs = spec.observed || [], fc = spec.forecast || [];
    if (obs.length < 1) return empty(el, spec.emptyMsg || 'No arrivals recorded');
    var sc = scale();
    var f = frame(el, { t: Math.round(10 * sc), r: Math.round(8 * sc),
                        b: Math.round(18 * sc), l: Math.round(24 * sc) });

    var all = obs.map(function (p) { return p.count; });
    fc.forEach(function (p) { all.push(p.hi95, p.lo95, p.yhat); });
    var hi = Math.max.apply(null, all.concat([1]));
    var ticks = niceTicks(0, hi, 4);
    var top = Math.max(hi, ticks[ticks.length - 1] || hi);

    var n = obs.length + fc.length;
    var stepX = f.iw / Math.max(1, n - 1);
    var xAt = function (i) { return f.p.l + i * stepX; };
    var yOf = function (v) { return f.p.t + f.ih - (v / top) * f.ih; };

    var s = open(f, spec.aria);
    s += yGrid(f, ticks, yOf);

    // Bands first, so the lines sit on top.
    function band(lo, hi_, opacity) {
      if (!fc.length) return '';
      var startI = obs.length - 1;
      var up = [], dn = [];
      up.push([xAt(startI), yOf(obs[obs.length - 1].count)]);
      dn.push([xAt(startI), yOf(obs[obs.length - 1].count)]);
      fc.forEach(function (p, i) {
        up.push([xAt(obs.length + i), yOf(p[hi_])]);
        dn.push([xAt(obs.length + i), yOf(p[lo])]);
      });
      var d = 'M' + up.map(function (q) { return q[0] + ',' + q[1]; }).join(' L') +
              ' L' + dn.reverse().map(function (q) { return q[0] + ',' + q[1]; }).join(' L') + ' Z';
      return tag('path', { d: d, fill: CAT[0], 'fill-opacity': opacity });
    }
    s += band('lo95', 'hi95', 0.12);
    s += band('lo80', 'hi80', 0.2);

    // Observed line
    var obsPts = obs.map(function (p, i) { return [xAt(i), yOf(p.count)]; });
    s += tag('path', {
      d: 'M' + obsPts.map(function (q) { return q[0] + ',' + q[1]; }).join(' L'),
      fill: 'none', stroke: CAT[0], 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    });

    // Projection line, dashed to say "not observed"
    if (fc.length) {
      var fcPts = [[xAt(obs.length - 1), yOf(obs[obs.length - 1].count)]].concat(
        fc.map(function (p, i) { return [xAt(obs.length + i), yOf(p.yhat)]; }));
      s += tag('path', {
        d: 'M' + fcPts.map(function (q) { return q[0] + ',' + q[1]; }).join(' L'),
        fill: 'none', stroke: CAT[1], 'stroke-width': 2,
        'stroke-dasharray': '5 4', 'stroke-linecap': 'round'
      });
      // Boundary between recorded and projected.
      s += tag('line', { x1: xAt(obs.length - 1), y1: f.p.t, x2: xAt(obs.length - 1),
                         y2: f.p.t + f.ih, stroke: AXIS, 'stroke-width': 1 });
    }

    // Markers: >=8px, with a 2px surface ring where they overlap the line.
    var rM = Math.max(3.2, Math.min(4.6, stepX / 3.2));
    obs.forEach(function (p, i) {
      s += tag('circle', {
        cx: xAt(i), cy: yOf(p.count), r: rM, fill: CAT[0],
        stroke: SURFACE, 'stroke-width': 2,
        'data-tip': tip([[spec.t.hour, pad2(p.hour) + ':00'],
                         [spec.t.arrivals, String(p.count)],
                         p.partial ? [spec.t.partialHour] : null].filter(Boolean))
      });
    });
    fc.forEach(function (p, i) {
      s += tag('circle', {
        cx: xAt(obs.length + i), cy: yOf(p.yhat), r: rM, fill: CAT[1],
        stroke: SURFACE, 'stroke-width': 2,
        'data-tip': tip([[spec.t.hour, pad2(p.hour) + ':00'],
                         [spec.t.projected, num(p.yhat, 1)],
                         [spec.t.pi80, num(p.lo80, 1) + ' – ' + num(p.hi80, 1)],
                         [spec.t.pi95, num(p.lo95, 1) + ' – ' + num(p.hi95, 1)]])
      });
    });

    // Hour axis — label about six, never all of them.
    var every = Math.max(1, Math.ceil(n / 6));
    for (var i2 = 0; i2 < n; i2 ++) {
      if (i2 % every !== 0 && i2 !== n - 1) continue;
      var pt = i2 < obs.length ? obs[i2] : fc[i2 - obs.length];
      s += txt(xAt(i2), f.p.t + f.ih + Math.round(11 * sc), pad2(pt.hour), {
        'text-anchor': 'middle', 'font-size': Math.round(8.5 * sc), fill: INK3
      });
    }
    s += '</svg>';
    el.innerHTML = s;
  }
  function pad2(n) { return ('0' + n).slice(-2); }

  /* ══════════════════════════════════════════════════════════
     HISTOGRAM — distribution of a duration, fixed-width bins
     ══════════════════════════════════════════════════════════ */
  function histogram(el, spec) {
    var bins = spec.bins || [];
    if (!bins.length || !bins.some(function (b) { return b.count > 0; })) {
      return empty(el, spec.emptyMsg || 'No completed episodes yet');
    }
    var sc = scale();
    var f = frame(el, { t: Math.round(12 * sc), r: Math.round(6 * sc),
                        b: Math.round(20 * sc), l: Math.round(24 * sc) });
    var hi = Math.max.apply(null, bins.map(function (b) { return b.count; }).concat([1]));
    var ticks = niceTicks(0, hi, 3);
    var top = Math.max(hi, ticks[ticks.length - 1] || hi);
    var yOf = function (v) { return f.p.t + f.ih - (v / top) * f.ih; };

    var bw = f.iw / bins.length;
    var s = open(f, spec.aria);
    s += yGrid(f, ticks, yOf);

    // Median marker, where it is meaningful.
    if (spec.medianValue !== null && spec.medianValue !== undefined && spec.binWidth) {
      var mIdx = spec.medianValue / spec.binWidth;
      var mx = f.p.l + Math.min(bins.length, mIdx) * bw;
      s += tag('line', { x1: mx, y1: f.p.t - 3, x2: mx, y2: f.p.t + f.ih,
                         stroke: INK, 'stroke-width': 1.5 });
      s += txt(Math.min(mx + 3, f.p.l + f.iw - Math.round(26 * sc)), f.p.t - Math.round(4 * sc),
               spec.t.median + ' ' + spec.fmt(spec.medianValue),
               { 'font-size': Math.round(8.5 * sc), 'font-weight': 800, fill: INK });
    }

    bins.forEach(function (b, i) {
      var h = b.count > 0 ? Math.max(2, f.p.t + f.ih - yOf(b.count)) : 0;
      if (h <= 0) return;
      var label = b.overflow ? spec.fmt(b.lo) + '+' : spec.fmt(b.lo) + '–' + spec.fmt(b.hi);
      // 2px surface gap between adjacent bars; 4px rounded top on the data end.
      s += tag('rect', {
        x: f.p.l + i * bw + 1, y: yOf(b.count), width: Math.max(1, bw - 2), height: h,
        rx: Math.min(4, Math.max(1, (bw - 2) / 2)),
        fill: b.overflow ? STATUS.serious : CAT[0],
        'data-tip': tip([[spec.t.range, label], [spec.t.patients, String(b.count)]])
      });
    });

    // Axis: first, last and a couple between.
    var every2 = Math.max(1, Math.ceil(bins.length / 5));
    bins.forEach(function (b, i) {
      if (i % every2 !== 0 && i !== bins.length - 1) return;
      s += txt(f.p.l + i * bw + bw / 2, f.p.t + f.ih + Math.round(12 * sc),
               b.overflow ? spec.fmt(b.lo) + '+' : spec.fmt(b.lo),
               { 'text-anchor': 'middle', 'font-size': Math.round(8.5 * sc), fill: INK3 });
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  /* ══════════════════════════════════════════════════════════
     SCATTER — age against time in the department.
     Capped at three colour classes: past three, colour-vision
     separation cannot be guaranteed across every pair, so acuity
     collapses to Red / Yellow / Other rather than one hue per zone.
     ══════════════════════════════════════════════════════════ */
  function scatter(el, spec) {
    var pts = spec.points || [];
    if (!pts.length) return empty(el, spec.emptyMsg || 'No patients to plot');
    var sc = scale();
    var f = frame(el, { t: Math.round(8 * sc), r: Math.round(10 * sc),
                        b: Math.round(20 * sc), l: Math.round(30 * sc) });

    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var xHi = Math.max.apply(null, xs), yHi = Math.max.apply(null, ys);
    var xTicks = niceTicks(0, Math.max(xHi, 10), 4);
    var yTicks = niceTicks(0, Math.max(yHi, 60), 4);
    var xTop = xTicks[xTicks.length - 1], yTop = yTicks[yTicks.length - 1];

    var clampX = function (v) { return Math.max(0, Math.min(xTop, v)); };
    var clampY = function (v) { return Math.max(0, Math.min(yTop, v)); };
    var xOf = function (v) { return f.p.l + (clampX(v) / xTop) * f.iw; };
    var yOf = function (v) { return f.p.t + f.ih - (clampY(v) / yTop) * f.ih; };

    var s = open(f, spec.aria);
    s += yGrid(f, yTicks, yOf, spec.yFmt);
    xTicks.forEach(function (t) {
      s += tag('line', { x1: xOf(t), y1: f.p.t, x2: xOf(t), y2: f.p.t + f.ih,
                         stroke: GRID, 'stroke-width': 1 });
      s += txt(xOf(t), f.p.t + f.ih + Math.round(12 * sc), num(t),
               { 'text-anchor': 'middle', 'font-size': Math.round(8.5 * sc), fill: INK3 });
    });

    var r = Math.max(4, Math.round(4.4 * sc));    // >=8px diameter
    // Inset the plot by the marker radius so no circle straddles the edge.
    f.p.l += r; f.p.r += r; f.iw = Math.max(10, f.iw - 2 * r);
    f.p.t += r; f.ih = Math.max(10, f.ih - r);
    pts.forEach(function (p) {
      s += tag('circle', {
        cx: xOf(p.x), cy: yOf(p.y), r: r,
        fill: p.colour, 'fill-opacity': 0.82,
        stroke: SURFACE, 'stroke-width': 2,       // surface ring for overlaps
        'data-tip': tip([[spec.t.group, p.groupLabel],
                         [spec.t.age, num(p.x) + ' ' + spec.t.years],
                         [spec.t.elapsed, spec.yFmt(p.y)]])
      });
    });

    s += '</svg>';
    el.innerHTML = s;
  }

  /* ══════════════════════════════════════════════════════════
     GROUPED BAR — a measure compared across units
     ══════════════════════════════════════════════════════════ */
  function groupedBars(el, spec) {
    var groups = spec.groups || [], series = spec.series || [];
    if (!groups.length || !series.length) return empty(el, spec.emptyMsg || 'Nothing to compare');
    var sc = scale();
    var f = frame(el, { t: Math.round(8 * sc), r: Math.round(6 * sc),
                        b: Math.round(24 * sc), l: Math.round(26 * sc) });

    var hi = 1;
    groups.forEach(function (g) { g.values.forEach(function (v) { hi = Math.max(hi, v); }); });
    var ticks = niceTicks(0, hi, 4);
    var top = ticks[ticks.length - 1];
    var yOf = function (v) { return f.p.t + f.ih - (v / top) * f.ih; };

    var gw = f.iw / groups.length;
    var inner = Math.min(gw * 0.78, Math.round(52 * sc) * series.length);
    var bw = inner / series.length;

    var s = open(f, spec.aria);
    s += yGrid(f, ticks, yOf);

    groups.forEach(function (g, gi) {
      var gx = f.p.l + gi * gw + (gw - inner) / 2;
      g.values.forEach(function (v, si) {
        var h = v > 0 ? Math.max(2, f.p.t + f.ih - yOf(v)) : 0;
        if (h <= 0) return;
        s += tag('rect', {
          x: gx + si * bw + 1, y: yOf(v), width: Math.max(1, bw - 2), height: h,
          rx: Math.min(4, Math.max(1, (bw - 2) / 2)),
          fill: series[si].colour || CAT[si % CAT.length],
          'data-tip': tip([[spec.t.unit, g.label], [series[si].label, String(v)]])
        });
      });
      s += txt(f.p.l + gi * gw + gw / 2, f.p.t + f.ih + Math.round(12 * sc), g.short || g.label,
               { 'text-anchor': 'middle', 'font-size': Math.round(9 * sc),
                 'font-weight': 700, fill: INK2 });
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  /* ══════════════════════════════════════════════════════════
     MATRIX HEATMAP — one hue, light to dark, with a scale legend
     that states the unit and says what dark and bright mean.
     ══════════════════════════════════════════════════════════ */
  function seqColour(v, max) {
    if (!v) return SEQ_ZERO;
    if (max <= 0) return SEQ_ZERO;
    var idx = Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length));
    if (idx < 0) idx = 0;
    return SEQ[idx];
  }
  function inkOn(v, max) {
    return (max > 0 && v / max > 0.55) ? '#ffffff' : INK;
  }

  function heatmap(el, spec) {
    var m = spec.matrix;
    if (!m || !m.rows.length || !m.cols.length) {
      return empty(el, spec.emptyMsg || 'Not enough data for a heatmap');
    }
    var sc = scale();
    var fsRow = Math.round(8.5 * sc);
    var boxW2 = Math.max(80, Math.round(el.clientWidth));
    var rowTexts = m.rows.map(function (r) { return spec.rowLabel ? spec.rowLabel(r) : r; });
    var rowLabelW = Math.min(Math.round(boxW2 * 0.26),
      Math.ceil(widestW(rowTexts, fsRow, 700)) + Math.round(6 * sc));
    var colLabelH = Math.round((spec.colLabelHeight || 14) * sc);
    var legendH = Math.round(15 * sc);
    var f = frame(el, { t: colLabelH, r: Math.round(4 * sc),
                        b: legendH + Math.round(4 * sc), l: rowLabelW });

    var cw = f.iw / m.cols.length, ch = f.ih / m.rows.length;
    var s = open(f, spec.aria);

    // Column headers, rotated when they cannot fit flat.
    var rotate = cw < Math.round(34 * sc);
    m.cols.forEach(function (c, ci) {
      var cx = f.p.l + ci * cw + cw / 2;
      var label = spec.colLabel ? spec.colLabel(c) : c;
      if (rotate) {
        s += tag('text', {
          x: cx, y: colLabelH - Math.round(3 * sc), fill: INK3,
          'font-size': Math.round(8 * sc), 'font-weight': 700, 'text-anchor': 'start',
          transform: 'rotate(-58 ' + cx + ' ' + (colLabelH - Math.round(3 * sc)) + ')'
        }, esc(short(label, 9)));
      } else {
        s += txt(cx, colLabelH - Math.round(4 * sc), short(label, 8), {
          'text-anchor': 'middle', 'font-size': Math.round(8.5 * sc), 'font-weight': 700, fill: INK3
        });
      }
    });

    m.rows.forEach(function (rk, ri) {
      var y = f.p.t + ri * ch;
      s += txt(f.p.l - Math.round(4 * sc), y + ch / 2 + 3,
               fitText(spec.rowLabel ? spec.rowLabel(rk) : rk,
                       rowLabelW - Math.round(5 * sc), fsRow, 700),
               { 'text-anchor': 'end', 'font-size': fsRow, 'font-weight': 700, fill: INK2 });
      m.cols.forEach(function (ck, ci) {
        var v = m.cells[ri][ci];
        var x = f.p.l + ci * cw;
        s += tag('rect', {
          x: x + 1, y: y + 1, width: Math.max(1, cw - 2), height: Math.max(1, ch - 2),
          rx: 2, fill: seqColour(v, m.max),
          'data-tip': tip([[spec.t.row, spec.rowLabel ? spec.rowLabel(rk) : rk],
                           [spec.t.col, spec.colLabel ? spec.colLabel(ck) : ck],
                           [spec.unit, String(v)]])
        });
        // Print the value when the cell is big enough to hold it legibly.
        if (cw > Math.round(24 * sc) && ch > Math.round(15 * sc) && v > 0) {
          s += txt(x + cw / 2, y + ch / 2 + 3, String(v), {
            'text-anchor': 'middle', 'font-size': Math.round(8.5 * sc),
            'font-weight': 700, fill: inkOn(v, m.max)
          });
        }
      });
    });

    // Scale legend: swatches, the range, and the unit.
    var lw = Math.min(f.iw, Math.round(120 * sc));
    var lx = f.p.l, ly = f.h - legendH + Math.round(2 * sc);
    var swW = lw / SEQ.length;
    for (var i = 0; i < SEQ.length; i++) {
      s += tag('rect', { x: lx + i * swW, y: ly, width: swW - 1,
                         height: Math.round(6 * sc), fill: SEQ[i] });
    }
    s += txt(lx, ly + Math.round(14 * sc), '0', { 'font-size': Math.round(8 * sc), fill: INK3 });
    s += txt(lx + lw, ly + Math.round(14 * sc), String(m.max),
             { 'text-anchor': 'end', 'font-size': Math.round(8 * sc), fill: INK3 });
    s += txt(lx + lw + Math.round(8 * sc), ly + Math.round(6 * sc), spec.unit,
             { 'font-size': Math.round(8.5 * sc), 'font-weight': 700, fill: INK2 });
    s += '</svg>';
    el.innerHTML = s;
  }
  function short(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /* ══════════════════════════════════════════════════════════
     BED BOARD — every bed position in the establishment, shaded by
     how long its current occupant has been in the department.

     A heatmap rather than a table because the question a bed manager
     asks is spatial: where are the free beds, and where are the
     patients who have been waiting longest. Empty beds are drawn, not
     omitted - an empty bed is the thing being looked for, and a
     register only ever lists occupied ones.
     ══════════════════════════════════════════════════════════ */
  function bedBoard(el, spec) {
    var board = spec.board;
    if (!board || !board.rows.length) {
      return empty(el, spec.emptyMsg || 'No bed establishment configured');
    }
    var sc = scale();
    var fsRow = Math.round(8.5 * sc), fsNum = Math.round(8.5 * sc);
    var boxW = Math.max(120, Math.round(el.clientWidth));

    var rowTexts = board.rows.map(function (r) { return spec.rowLabel(r); });
    var labelW = Math.min(Math.round(boxW * 0.24),
      Math.ceil(widestW(rowTexts, fsRow, 700)) + Math.round(7 * sc));
    var countTexts = board.rows.map(function (r) {
      return (r.occupiedFunded + r.occupiedCrisis) + '/' + (r.funded + r.crisisPlaces);
    });
    var countW = Math.ceil(widestW(countTexts, fsNum, 800)) + Math.round(9 * sc);

    var axisH = Math.round(11 * sc);
    var legendH = Math.round(16 * sc);
    var f = frame(el, { t: axisH, r: countW, b: legendH + Math.round(3 * sc), l: labelW });

    var cols = Math.max(1, board.maxBeds);
    var gapY = Math.max(1, Math.round(2 * sc));
    var rh = Math.min(Math.round((board.rows.length <= 6 ? 54 : 34) * sc),
                      Math.floor((f.ih - gapY * (board.rows.length - 1)) / board.rows.length));
    rh = Math.max(6, rh);
    // Keep cells roughly bed-shaped. A board of five rows in a wide panel
    // would otherwise stretch each bed into a long slab.
    var cw = Math.min(f.iw / cols, rh * 1.8);
    var usedH = rh * board.rows.length + gapY * (board.rows.length - 1);
    var offY = f.p.t + Math.max(0, Math.round((f.ih - usedH) / 2));

    var maxD = Math.max(1, board.maxDwellMin);
    var s2 = open(f, spec.aria);

    // Bed-number axis: every tenth position, so 50 columns stay readable.
    // Anchored just above the first row, which is vertically centred.
    var tickEvery = cols > 30 ? 10 : cols > 12 ? 5 : cols > 6 ? 2 : 1;
    var axisY = Math.max(Math.round(8 * sc), offY - Math.round(3 * sc));
    for (var c = tickEvery; c <= cols; c += tickEvery) {
      s2 += txt(f.p.l + (c - 0.5) * cw, axisY, String(c),
                { 'text-anchor': 'middle', 'font-size': Math.round(7.5 * sc), fill: INK3 });
    }

    board.rows.forEach(function (row, ri) {
      var y = offY + ri * (rh + gapY);
      var mid = y + rh / 2;

      s2 += txt(f.p.l - Math.round(5 * sc), mid + 3,
                fitText(spec.rowLabel(row), labelW - Math.round(6 * sc), fsRow, 700),
                { 'text-anchor': 'end', 'font-size': fsRow, 'font-weight': 700, fill: INK2 });

      row.beds.forEach(function (bed, bi) {
        var x = f.p.l + bi * cw;
        var w = Math.max(1, cw - 1.5);
        var h = Math.max(3, rh - 1.5);
        var tipRows = [
          [spec.t.bed, bed.code],
          [spec.t.zone, spec.zoneName(row.zone) + ' · ' + row.location]
        ];
        if (bed.occupied) {
          tipRows.push([spec.t.dwell, spec.fmtDwell(bed.dwellMin)]);
          tipRows.push([spec.t.status, spec.statusName(bed.status)]);
          if (bed.referredTo) tipRows.push([spec.t.referredTo, bed.referredTo]);
        } else {
          tipRows.push([spec.t.free]);
        }
        if (bed.crisis) tipRows.push([spec.t.crisisBed]);

        s2 += tag('rect', {
          x: x, y: y, width: w, height: h, rx: 2,
          fill: bed.occupied ? seqColour(bed.dwellMin, maxD) : '#ffffff',
          stroke: bed.occupied ? 'none' : AXIS,
          'stroke-width': bed.occupied ? 0 : 1,
          'stroke-dasharray': bed.occupied ? null : '2 2',
          'data-tip': tip(tipRows)
        });
        if (bed.crisis && bed.occupied) {
          s2 += tag('rect', { x: x, y: y, width: w, height: h, rx: 2,
                              fill: 'url(#bbhatch)', 'pointer-events': 'none' });
        }
      });

      // Where funded capacity ends and escalation begins, for this row.
      if (row.crisisPlaces > 0) {
        var bx = f.p.l + row.funded * cw;
        s2 += tag('line', { x1: bx, y1: y - 1, x2: bx, y2: y + rh + 1,
                            stroke: INK, 'stroke-width': 1.5 });
      }

      s2 += txt(f.p.l + cw * cols + Math.round(5 * sc), mid + 3,
                (row.occupiedFunded + row.occupiedCrisis) + '/' + (row.funded + row.crisisPlaces),
                { 'font-size': fsNum, 'font-weight': 800,
                  fill: row.emptyFunded === 0 ? STATUS.critical : INK,
                  'font-family': 'IBM Plex Mono, monospace' });
    });

    // Scale legend: the ramp, its range, and its unit.
    var lw = Math.min(Math.round(f.iw * 0.45), Math.round(110 * sc));
    var lx = f.p.l, ly = f.h - legendH + Math.round(3 * sc);
    var swW = lw / SEQ.length;
    for (var k = 0; k < SEQ.length; k++) {
      s2 += tag('rect', { x: lx + k * swW, y: ly, width: swW - 1,
                          height: Math.round(6 * sc), fill: SEQ[k] });
    }
    s2 += txt(lx, ly + Math.round(14 * sc), '0',
              { 'font-size': Math.round(7.5 * sc), fill: INK3 });
    s2 += txt(lx + lw, ly + Math.round(14 * sc), spec.fmtDwell(maxD),
              { 'text-anchor': 'end', 'font-size': Math.round(7.5 * sc), fill: INK3 });
    s2 += txt(lx + lw + Math.round(7 * sc), ly + Math.round(6 * sc), spec.t.dwellUnit,
              { 'font-size': Math.round(8 * sc), 'font-weight': 700, fill: INK2 });

    // Keys for the two states colour alone cannot carry.
    var kx = lx + lw + Math.round(10 * sc) + Math.ceil(textW(spec.t.dwellUnit, Math.round(8 * sc), 700));
    var sq = Math.round(7 * sc);
    s2 += tag('rect', { x: kx, y: ly, width: sq, height: sq, rx: 1.5,
                        fill: '#ffffff', stroke: AXIS, 'stroke-width': 1, 'stroke-dasharray': '2 2' });
    s2 += txt(kx + sq + Math.round(3 * sc), ly + Math.round(6.5 * sc), spec.t.free,
              { 'font-size': Math.round(8 * sc), 'font-weight': 700, fill: INK2 });

    var kx2 = kx + sq + Math.round(6 * sc) + Math.ceil(textW(spec.t.free, Math.round(8 * sc), 700));
    s2 += tag('rect', { x: kx2, y: ly, width: sq, height: sq, rx: 1.5, fill: SEQ[3] });
    s2 += tag('rect', { x: kx2, y: ly, width: sq, height: sq, rx: 1.5, fill: 'url(#bbhatch)' });
    s2 += txt(kx2 + sq + Math.round(3 * sc), ly + Math.round(6.5 * sc), spec.t.crisisBed,
              { 'font-size': Math.round(8 * sc), 'font-weight': 700, fill: INK2 });

    s2 += '<defs><pattern id="bbhatch" width="5" height="5" patternTransform="rotate(45)" ' +
          'patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="5" stroke="' +
          SURFACE + '" stroke-width="1.8"/></pattern></defs>';
    s2 += '</svg>';
    el.innerHTML = s2;
  }

  /* ══════════════════════════════════════════════════════════
     PROJECTED CENSUS — observed "now" then four projected hours,
     with the 80% band carried through the flow equation.
     ══════════════════════════════════════════════════════════ */
  function projection(el, spec) {
    var j = spec.projection;
    if (!j || !j.available) return empty(el, spec.emptyMsg || 'No projection available');
    var sc = scale();
    var f = frame(el, { t: Math.round(14 * sc), r: Math.round(10 * sc),
                        b: Math.round(18 * sc), l: Math.round(26 * sc) });

    var series = [j.current].concat(j.mid);
    var his = [j.current].concat(j.hi80);
    var los = [j.current].concat(j.lo80);
    var hi = Math.max.apply(null, his.concat([j.bedsAvailable || 0, 1]));
    var ticks = niceTicks(0, hi, 4);
    var top = ticks[ticks.length - 1];

    var n = series.length;
    var stepX = f.iw / Math.max(1, n - 1);
    var xAt = function (i) { return f.p.l + i * stepX; };
    var yOf = function (v) { return f.p.t + f.ih - (Math.min(v, top) / top) * f.ih; };

    var s2 = open(f, spec.aria);
    s2 += yGrid(f, ticks, yOf);

    // Band
    var up = his.map(function (v, i) { return [xAt(i), yOf(v)]; });
    var dn = los.map(function (v, i) { return [xAt(i), yOf(v)]; }).reverse();
    s2 += tag('path', {
      d: 'M' + up.map(function (q) { return q[0] + ',' + q[1]; }).join(' L') +
         ' L' + dn.map(function (q) { return q[0] + ',' + q[1]; }).join(' L') + ' Z',
      fill: CAT[0], 'fill-opacity': 0.18
    });

    // Bed-availability reference: total places that exist right now.
    if (j.bedsAvailable > 0 && j.bedsAvailable <= top) {
      var by = yOf(j.bedsAvailable);
      s2 += tag('line', { x1: f.p.l, y1: by, x2: f.p.l + f.iw, y2: by,
                          stroke: STATUS.critical, 'stroke-width': 1.5 });
      s2 += txt(f.p.l + f.iw, by - Math.round(4 * sc), spec.t.bedsAvailable + ' ' + j.bedsAvailable,
                { 'text-anchor': 'end', 'font-size': Math.round(8.5 * sc),
                  'font-weight': 800, fill: STATUS.critical });
    }

    s2 += tag('path', {
      d: 'M' + series.map(function (v, i) { return xAt(i) + ',' + yOf(v); }).join(' L'),
      fill: 'none', stroke: CAT[0], 'stroke-width': 2,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });

    var rM = Math.max(3.2, Math.min(4.6, stepX / 3.4));
    series.forEach(function (v, i) {
      var label = i === 0 ? spec.t.now : Charts_pad(j.hours[i - 1]) + ':00';
      s2 += tag('circle', {
        cx: xAt(i), cy: yOf(v), r: rM, fill: i === 0 ? INK : CAT[0],
        stroke: SURFACE, 'stroke-width': 2,
        'data-tip': tip([[spec.t.hour, label], [spec.t.patients, num(v, 1)],
          i === 0 ? null : [spec.t.pi80, num(los[i], 1) + ' – ' + num(his[i], 1)]].filter(Boolean))
      });
      s2 += txt(xAt(i), f.p.t + f.ih + Math.round(12 * sc), label,
                { 'text-anchor': 'middle', 'font-size': Math.round(8 * sc), fill: INK3 });
    });

    // Direct-label the endpoint only.
    s2 += txt(xAt(n - 1), yOf(series[n - 1]) - Math.round(7 * sc), num(series[n - 1], 0),
              { 'text-anchor': 'end', 'font-size': Math.round(10 * sc),
                'font-weight': 800, fill: INK });
    s2 += '</svg>';
    el.innerHTML = s2;
  }
  function Charts_pad(n) { return ('0' + n).slice(-2); }

  /* ══════════════════════════════════════════════════════════
     COMPLETENESS BARS — how much of each field is populated
     ══════════════════════════════════════════════════════════ */
  function completeness(el, spec) {
    var rows = spec.rows || [];
    if (!rows.length) return empty(el, 'No fields');
    var sc = scale();
    var fsL = Math.round(8.5 * sc);
    var boxW = Math.max(80, Math.round(el.clientWidth));
    var gutter = Math.min(Math.round(boxW * 0.42),
      Math.ceil(widestW(rows.map(function (r) { return r.label; }), fsL, 700)) + Math.round(6 * sc));
    var f = frame(el, { t: Math.round(4 * sc), r: Math.round(34 * sc),
                        b: Math.round(4 * sc), l: gutter });
    var gap = Math.max(1, Math.round(2 * sc));
    var bh = Math.max(5, Math.floor((f.ih - gap * (rows.length - 1)) / rows.length));

    var s = open(f, spec.aria);
    rows.forEach(function (r, i) {
      var y = f.p.t + i * (bh + gap);
      var pctv = r.pct === null ? 0 : r.pct;
      var colour = pctv >= 95 ? STATUS.ok : pctv >= 50 ? STATUS.warn : STATUS.critical;
      s += tag('rect', { x: f.p.l, y: y, width: f.iw, height: bh, rx: 2, fill: '#f2f5f8' });
      s += tag('rect', {
        x: f.p.l, y: y, width: Math.max(1, f.iw * pctv / 100), height: bh, rx: 2, fill: colour,
        'data-tip': tip([[r.label], [spec.t.populated, r.n + ' / ' + r.total + ' (' + num(pctv, 1) + '%)']])
      });
      s += txt(f.p.l - Math.round(4 * sc), y + bh / 2 + 3,
               fitText(r.label, gutter - Math.round(5 * sc), fsL, 700), {
        'text-anchor': 'end', 'font-size': fsL, 'font-weight': 700, fill: INK2
      });
      s += txt(f.p.l + f.iw + Math.round(4 * sc), y + bh / 2 + 3, num(pctv, 0) + '%', {
        'font-size': Math.round(8.5 * sc), 'font-weight': 800, fill: INK,
        'font-family': 'IBM Plex Mono, monospace'
      });
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  /* ══════════════════════════════════════════════════════════
     TABLE VIEW — every chart's accessible equivalent. Also the
     documented relief for the palette slots that sit below 3:1
     against the surface.
     ══════════════════════════════════════════════════════════ */
  function tableHtml(spec) {
    if (!spec || !spec.head || !spec.body) return '<p>No table available.</p>';
    var h = '<table class="dt">';
    if (spec.caption) h += '<caption>' + esc(spec.caption) + '</caption>';
    h += '<thead><tr>' + spec.head.map(function (c) {
      return '<th scope="col">' + esc(c) + '</th>';
    }).join('') + '</tr></thead><tbody>';
    h += spec.body.map(function (row) {
      return '<tr>' + row.map(function (c, i) {
        return i === 0 ? '<th scope="row">' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return h + '</tbody></table>';
  }

  // ── dispatcher ───────────────────────────────────────────
  var RENDERERS = {
    capacityBars: capacityBars, donut: donut, forecastLine: forecastLine,
    histogram: histogram, scatter: scatter, groupedBars: groupedBars,
    heatmap: heatmap, bedBoard: bedBoard, completeness: completeness,
    projection: projection
  };

  function render(el, spec) {
    if (!el || !spec) return;
    var fn = RENDERERS[spec.type];
    if (!fn) { empty(el, 'Unknown chart type: ' + spec.type); return; }
    try {
      fn(el, spec);
    } catch (err) {
      empty(el, 'Chart could not be drawn');
      if (window.console) console.error('chart ' + spec.type, err);
    }
  }

  // ── hover tooltip, delegated once for the whole page ─────
  function initTooltip() {
    var tipEl = document.getElementById('tip');
    if (!tipEl) return;
    function hide() { tipEl.style.display = 'none'; }
    function show(target, x, y) {
      tipEl.innerHTML = target.getAttribute('data-tip');
      tipEl.style.display = 'block';
      var r = tipEl.getBoundingClientRect();
      var left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
      var top = y - r.height - 12;
      if (top < 8) top = y + 18;
      tipEl.style.left = left + 'px';
      tipEl.style.top = top + 'px';
    }
    document.addEventListener('mousemove', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) show(t, e.clientX, e.clientY); else hide();
    }, { passive: true });
    document.addEventListener('touchstart', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) { hide(); return; }
      var touch = e.touches[0];
      show(t, touch.clientX, touch.clientY);
      setTimeout(hide, 2600);
    }, { passive: true });
    document.addEventListener('scroll', hide, { passive: true });
  }

  return {
    render: render, tableHtml: tableHtml, initTooltip: initTooltip,
    ZONE: ZONE, CAT: CAT, SEQ: SEQ, STATUS: STATUS,
    seqColour: seqColour, esc: esc, num: num, pad2: pad2
  };
})();
</script>

<script>
/* ============================================================
   APPLICATION — tab and step routing, panel composition,
   search, and the administrative gate.

   The no-scroll rule is enforced structurally: each step declares
   a CSS grid whose rows are fractions of the content box, and every
   panel clips its own overflow. Charts measure the box they land in
   and draw to it, so adding data can never lengthen the page.
   ============================================================ */
(function () {
  'use strict';

  var S = {
    lang: 'ms',
    tab: (window.BOOT_SCOPE && ['wcc', 'bu', 'pac', 'admin'].indexOf(window.BOOT_SCOPE) >= 0)
           ? window.BOOT_SCOPE : 'wcc',
    mode: window.BOOT_MODE === 'tv' ? 'tv' : '',
    /* Public patient search is off unless the server says otherwise. It was
       the only path by which this interface could reach an identifiable
       record, so the default is the safe one and the server has to opt in. */
    search: window.BOOT_SEARCH === '1' || window.BOOT_SEARCH === true,
    posters: window.BOOT_POSTERS || {},
    step: 0,
    data: {},          // scope -> payload
    stale: {},         // scope -> true while showing a restored snapshot
    publicLoading: false,
    stepIndex: {},     // scope -> last viewed step
    adminToken: null,
    gateShown: false,
    gateNote: '',
    illustrations: null,
    illustrationsLoading: false,
    busy: {},
    tabs: null,        // filled from TABS once it is resolved, for diagnostics
    specs: []          // chart specs currently mounted, for re-render on resize
  };

  /* The administrative tab is served only where an access code can gate it.
     A front end hosted outside Apps Script declares the public tabs alone. */
  var TABS = (window.BOOT_TABS && window.BOOT_TABS.length)
    ? window.BOOT_TABS : ['wcc', 'bu', 'pac', 'iqms', 'triage', 'admin'];

  /* How often the page re-reads the register. Matches CACHE_SECS in Code.gs,
     so a refresh normally costs a cache read rather than a re-read of the
     whole sheet. */
  var REFRESH_MS = 15 * 60 * 1000;

  /* How long to wait for a server call before giving up on it and offering a
     retry. Generous: a cold Apps Script invocation on a large register is
     slow, but nothing legitimate takes half a minute. */
  var SERVER_TIMEOUT_MS = 30000;

  var PUBLIC_TABS = ['wcc', 'bu', 'pac'];

  /* Last-known figures, kept per browser. A returning visitor sees real
     numbers immediately -- stamped with the time they were generated, so a
     stale set reads as stale -- instead of a spinner. Discarded beyond this
     age: an old figure shown without comment is worse than no figure. */
  var SNAP_KEY = 'edpac_snap_v1';
  var SNAP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

  function readSnapshot() {
    try {
      var raw = localStorage.getItem(SNAP_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.savedAt || !o.data) return null;
      if (Date.now() - o.savedAt > SNAP_MAX_AGE_MS) { localStorage.removeItem(SNAP_KEY); return null; }
      return o.data;
    } catch (e) { return null; }
  }

  function writeSnapshot() {
    try {
      var out = {};
      for (var i = 0; i < PUBLIC_TABS.length; i++) {
        var d = S.data[PUBLIC_TABS[i]];
        if (d && !d.error) out[PUBLIC_TABS[i]] = d;
      }
      if (!Object.keys(out).length) return;
      localStorage.setItem(SNAP_KEY, JSON.stringify({ savedAt: Date.now(), data: out }));
    } catch (e) { /* quota or private mode: the snapshot is a nicety */ }
  }

  /* Figures inlined by doGet from the warm server cache: the first paint can
     show real numbers with no server round trip at all. Falls back to the
     browser's own snapshot, then to fetching. */
  function seedData() {
    var inlined = window.BOOT_DATA;
    var seeded = false;
    if (inlined && typeof inlined === 'object') {
      for (var i = 0; i < PUBLIC_TABS.length; i++) {
        var k = PUBLIC_TABS[i];
        if (inlined[k] && !inlined[k].error) { S.data[k] = inlined[k]; seeded = true; }
      }
    }
    if (seeded) return 'inline';

    var snap = readSnapshot();
    if (snap) {
      for (var j = 0; j < PUBLIC_TABS.length; j++) {
        var sk = PUBLIC_TABS[j];
        if (snap[sk]) { S.data[sk] = snap[sk]; S.stale[sk] = true; }
      }
      if (Object.keys(S.data).length) return 'snapshot';
    }
    return 'none';
  }

  S.tabs = TABS;

  // ── i18n ─────────────────────────────────────────────────
  function dict() { return I18N[S.lang] || I18N.ms; }
  function t(path) {
    var parts = String(path).split('.'), o = dict();
    for (var i = 0; i < parts.length; i++) {
      if (o === null || o === undefined) break;
      o = o[parts[i]];
    }
    if (o === undefined || o === null) {
      var f = I18N.ms;
      for (var j = 0; j < parts.length; j++) { if (!f) break; f = f[parts[j]]; }
      return f === undefined || f === null ? path : f;
    }
    return o;
  }
  function tf(path) {
    var fn = t(path), args = Array.prototype.slice.call(arguments, 1);
    return typeof fn === 'function' ? fn.apply(null, args) : String(fn);
  }
  function esc(s) { return Charts.esc(s); }

  // ── formatting ───────────────────────────────────────────
  function fmtMin(m) {
    if (m === null || m === undefined || isNaN(m)) return '—';
    m = Math.round(m);
    var h = Math.floor(m / 60), r = m % 60;
    var hu = S.lang === 'ms' ? 'j' : 'h';
    return h > 0 ? h + hu + ' ' + ('0' + r).slice(-2) + 'm' : r + 'm';
  }
  function fmtMinShort(m) {
    if (m === null || m === undefined || isNaN(m)) return '—';
    var h = m / 60;
    return (h >= 1 ? (Math.round(h * 10) / 10) + (S.lang === 'ms' ? 'j' : 'h') : Math.round(m) + 'm');
  }
  /** Axis formatter: one unit for the whole scale, chosen from its top value. */
  function axisMinFmt(topMin) {
    var hours = topMin >= 90, u = S.lang === 'ms' ? 'j' : 'h';
    return function (m) {
      if (m === null || m === undefined || isNaN(m)) return '—';
      return hours ? (Math.round(m / 60 * 10) / 10) + u : Math.round(m) + 'm';
    };
  }
  function fmtPct(v) { return (v === null || v === undefined) ? '—' : Charts.num(v, 1) + '%'; }
  function fmtInt(v) { return (v === null || v === undefined || isNaN(v)) ? '—' : String(Math.round(v)); }
  function zoneName(z) { return t('zone.' + z) || String(z).toUpperCase(); }
  function zoneShort(z) { return t('zoneShort.' + z) || String(z).toUpperCase(); }
  function statusName(s) { return t('status.' + s) || s; }
  function unitShort(u) { return t('unitsShort.' + u) || u; }

  // ── viewport scale: fill the screen, never exceed it ─────
  function setScale() {
    var h = window.innerHeight || 1024;
    var w = window.innerWidth || 768;
    var byH = h / 1024, byW = w / 768;
    var s = Math.min(byH, byW * 1.06);

    // A wide screen is almost always a wall display read from across a room,
    // and its layout packs the same content into fewer, shorter rows. Both
    // arguments point the same way: type up, not merely proportional to
    // height, which on a 1080p television is no taller than a tablet.
    if (w >= 1000) s *= 1.22;
    if (w >= 1600) s *= 1.06;

    s = Math.max(0.78, Math.min(1.75, s));
    document.documentElement.style.setProperty('--s', String(Math.round(s * 1000) / 1000));
  }

  /** Runs fn once the browser is idle, or after ms at the latest. */
  function deferIdle(fn, ms) {
    var done = false;
    function go() { if (done) return; done = true; fn(); }
    if (window.requestIdleCallback) window.requestIdleCallback(go, { timeout: ms });
    setTimeout(go, ms);
  }

  // ── DOM helpers ──────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function node(tagName, cls, html) {
    var n = document.createElement(tagName);
    if (cls) n.className = cls;
    if (html !== undefined && html !== null) n.innerHTML = html;
    return n;
  }

  /* ══════════════════════════════════════════════════════════
     CHROME
     ══════════════════════════════════════════════════════════ */
  function renderChrome() {
    $('appTitle').textContent = t('appTitle');
    $('appSub').textContent = t('appSub');
    $('demoTag').textContent = t('demoTag');
    $('demoNote').textContent = t('demoNote');
    $('langLabel').textContent = t('langLabel');
    $('langFlag').textContent = t('langFlag');
    if (S.search) {
      $('searchBtnLabel').textContent = t('searchBtn');
      $('searchTitle').textContent = t('search.title');
      $('searchInput').placeholder = t('search.placeholder');
      $('searchHint').textContent = t('search.hint');
      $('searchGo').textContent = t('searchBtn');
    } else {
      // Removed rather than hidden: an overlay still in the document is still
      // a form a visitor can reach, and its result rows would still be built.
      ['searchBtn', 'ovSearch'].forEach(function (id) {
        var el = $(id); if (el && el.parentNode) el.parentNode.removeChild(el);
      });
    }
    $('gateTitle').textContent = t('admin.gateTitle');
    $('gateBody').textContent = t('admin.gateBody');
    $('gateInput').placeholder = t('admin.passcode');
    $('gateGo').textContent = t('admin.enter');
    $('tblTitle').textContent = t('tableView');
    // The privacy footer lives inside the search overlay, which is removed
    // outright when search is off. Its message -- ask at the counter -- is
    // carried by the counter panel on the public tabs instead.
    var ft = $('footerText');
    if (ft) ft.textContent = t('footer') + '  ·  ' + t('credit');
    var cm = $('creditMark');
    if (cm) cm.textContent = t('credit');
    document.documentElement.lang = S.lang;

    var tabs = $('tabs');
    tabs.innerHTML = '';
    TABS.forEach(function (key) {
      var b = node('button', 'tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', key === S.tab ? 'true' : 'false');
      b.innerHTML = '<span class="tab-name">' + esc(t('tabs.' + key + '.name')) + '</span>' +
                    '<span class="tab-sub">' + esc(t('tabs.' + key + '.sub')) + '</span>';
      b.onclick = function () { gotoTab(key); };
      tabs.appendChild(b);
    });
  }

  function renderStamp(data) {
    var el = $('stamp'), pre = $('stampPrefix');
    if (!data || data.error) { el.textContent = '—'; pre.textContent = t('loading'); return; }
    // The prefix is the first thing dropped on a narrow screen, so the
    // timestamp itself must stand alone.
    pre.textContent = data.isSnapshot ? t('snapshot') : t('updated');
    el.textContent = data.refTime;
  }

  function renderNarrative(data) {
    var strip = $('narr'), txtEl = $('narrText'), icon = $('narrIcon');
    if (!data || !data.narrative) { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    var crisis = (data.kpi && data.kpi.crisisBeds > 0);
    strip.className = 'narr' + (crisis ? ' is-crisis' : '');
    icon.textContent = crisis ? '⚠️' : 'ℹ️';

    // One standing message, not a running commentary on the department's
    // workload: the zone cards and the crisis alert carry the numbers.
    txtEl.innerHTML = '<strong>' + esc(t('public.tapTitle')) + '</strong> ' +
                      esc(t('public.tapBody'));
  }

  /* ── Poster viewer. Shows the reviewed illustrations and nothing else: the
        running commentary on the department's workload that used to open here
        was operational detail a waiting family has no use for. ── */
  function openPosters() {
    $('helpTitle').textContent = t('public.posterBtn');
    $('helpCredit').textContent = t('footer');
    paintHelpImages(S.illustrations || { items: [] });
    openOv('ovHelp');
  }

  function paintHelpImages(data) {
    var box = $('helpImages');
    if (!data.items || !data.items.length) { box.innerHTML = ''; return; }
    box.innerHTML = data.items.map(function (it) {
      var cap = S.lang === 'ms' ? it.captionMs : it.captionEn;
      return '<figure class="help-fig"><img src="' + it.dataUri + '" alt="' + esc(cap) +
             '" loading="lazy"/><figcaption>' + esc(cap) + '</figcaption></figure>';
    }).join('');
  }

  /** Fetched once; the guidance panel offers the posters only if any exist. */
  function loadIllustrations() {
    if (S.illustrations || S.illustrationsLoading) return;
    S.illustrationsLoading = true;
    serverCall('getIllustrations', null, function (res) {
      S.illustrationsLoading = false;
      S.illustrations = (res && res.items) ? res : { items: [] };
      if (S.illustrations.items.length) renderTab();
    });
  }

  /* ══════════════════════════════════════════════════════════
     KPI TILES
     ══════════════════════════════════════════════════════════ */
  function kpiTile(o) {
    var tone = o.tone ? ' t-' + o.tone : '';
    var val = o.na
      ? '<span class="kpi-na">' + esc(o.na) + '</span>'
      : esc(o.value) + (o.unit ? '<span class="unit">' + esc(o.unit) + '</span>' : '');
    return '<div class="kpi' + tone + '">' +
      '<span class="kpi-label">' + esc(o.label) + '</span>' +
      '<span class="kpi-val">' + val + '</span>' +
      '<span class="kpi-sub">' + esc(o.sub || '') + '</span>' +
      '</div>';
  }
  function kpiBlock(tiles, cols) {
    var wrap = node('div', 'kpis');
    wrap.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    wrap.innerHTML = tiles.map(kpiTile).join('');
    return wrap;
  }

  /* ══════════════════════════════════════════════════════════
     PANELS
     ══════════════════════════════════════════════════════════ */
  function panel(def) {
    var p = node('div', 'panel' + (def.cls ? ' ' + def.cls : ''));
    p.style.gridArea = def.area;

    var hd = node('div', 'panel-hd');
    hd.innerHTML = '<h2>' + esc(def.title) + '</h2>' +
                   '<span class="sub">' + esc(def.sub || '') + '</span>';
    if (def.table) {
      var tb = node('button', 'panel-tbl', esc(t('tableView')));
      tb.type = 'button';
      tb.onclick = function () { openTable(def.title, def.table); };
      hd.appendChild(tb);
    }
    p.appendChild(hd);

    var bd = node('div', 'panel-bd');
    p.appendChild(bd);

    if (def.legend && def.legend.length) {
      var lg = node('div', 'legend');
      lg.innerHTML = def.legend.map(function (l) {
        var cls = 'legend-sw' + (l.kind === 'line' ? ' is-line' : l.kind === 'band' ? ' is-band' : '');
        var style = 'background:' + l.colour + (l.hatch ? ';opacity:.45' : '');
        return '<span class="legend-item"><span class="' + cls + '" style="' + style + '"></span>' +
               esc(l.label) + '</span>';
      }).join('');
      p.appendChild(lg);
    }
    if (def.note) p.appendChild(node('div', 'panel-note', esc(def.note)));

    if (def.html) { bd.innerHTML = def.html; }
    else if (def.chart) { S.specs.push({ el: bd, spec: def.chart }); }
    return p;
  }

  /* ══════════════════════════════════════════════════════════
     PANEL BUILDERS — one per visual
     ══════════════════════════════════════════════════════════ */

  function capacityPanel(d, area) {
    var rows = d.occupancy.map(function (z) {
      return {
        zone: z.zone, label: zoneShort(z.zone), capacity: z.capacity,
        funded: z.funded, crisis: z.crisis, waiting: z.waiting
      };
    });
    return panel({
      area: area, title: t('panel.capacity'), sub: t('panel.capacitySub'),
      chart: {
        type: 'capacityBars', rows: rows, t: t('chart'),
        aria: t('panel.capacity')
      },
      legend: [
        { colour: 'var(--zone-rz)', label: t('chart.legendFunded') },
        { colour: 'var(--zone-rz)', label: t('chart.legendCrisis'), hatch: true },
        { colour: 'var(--ink)', kind: 'line', label: t('chart.legendCapacity') }
      ],
      table: {
        caption: t('panel.capacity'),
        head: [t('chart.zone'), t('chart.legendCapacity'), t('chart.funded'),
               t('chart.crisis'), t('chart.queueShort')],
        body: d.occupancy.map(function (z) {
          return [zoneName(z.zone), z.capacity, z.funded, z.crisis, z.waiting];
        })
      }
    });
  }

  function statusPanel(d, area) {
    var data = d.statusMix.map(function (s, i) {
      return { label: statusName(s.key), count: s.count, colour: Charts.CAT[i % Charts.CAT.length] };
    });
    return panel({
      area: area, title: t('panel.statusMix'),
      chart: {
        type: 'donut', data: data, centreLabel: t('kpi.attendances'),
        aria: t('panel.statusMix')
      },
      legend: data.map(function (x) { return { colour: x.colour, label: x.label }; }),
      table: {
        caption: t('panel.statusMix'),
        head: [t('field.status'), t('chart.patients')],
        body: d.statusMix.map(function (s) { return [statusName(s.key), s.count]; })
      }
    });
  }

  function arrivalsPanel(d, area) {
    var fc = (d.forecast && d.forecast.available) ? d.forecast.points : [];

    // Plot complete hours only. The hour in progress holds a few minutes of
    // arrivals, so drawing it alongside full hours makes the line dive to the
    // floor and reads as a collapse in attendances that has not happened.
    var series = d.arrivals.series.filter(function (p) { return !p.partial; });
    var droppedPartial = series.length < d.arrivals.series.length;

    var notes = [];
    if (d.forecast && d.forecast.available) {
      notes.push(d.forecast.model === 'holtWintersAdditive' ? t('note.modelHW') : t('note.modelDamped'));
      if (d.forecast.stale) notes.push(t('note.staleForecast'));
    }
    if (droppedPartial) notes.push(t('note.partialExcluded'));

    return panel({
      area: area, title: t('panel.arrivals'),
      sub: series.length + ' ' + t('chart.hour').toLowerCase(),
      chart: {
        type: 'forecastLine', observed: series, forecast: fc,
        t: t('chart'), aria: t('panel.arrivals')
      },
      legend: [
        { colour: Charts.CAT[0], kind: 'line', label: t('chart.observed') },
        { colour: Charts.CAT[1], kind: 'line', label: t('chart.forecastLbl') },
        { colour: Charts.CAT[0], kind: 'band', label: t('chart.pi80') }
      ],
      note: notes.join(' '),
      table: {
        caption: t('panel.arrivals'),
        head: [t('chart.hour'), t('chart.arrivals'), t('chart.projected'), t('chart.pi80')],
        body: series.map(function (p) {
          return [Charts.pad2(p.hour) + ':00', p.count, '', ''];
        }).concat(fc.map(function (p) {
          return [Charts.pad2(p.hour) + ':00', '', Charts.num(p.yhat, 1),
                  Charts.num(p.lo80, 1) + '–' + Charts.num(p.hi80, 1)];
        }))
      }
    });
  }

  function waitsPanel(d, area) {
    var w = d.waits.elapsed;
    if (w.suppressed) {
      return panel({
        area: area, title: t('panel.waitDist'),
        html: '<div class="state"><span class="state-icon">◦</span><span>' +
              esc(tf('note.suppressed', d.waits.minN)) + '</span></div>'
      });
    }
    return panel({
      area: area, title: t('panel.waitDist'),
      sub: 'n = ' + w.summary.n,
      chart: {
        type: 'histogram', bins: w.histogram.bins, binWidth: w.histogram.binWidth,
        medianValue: w.summary.median, fmt: axisMinFmt(w.summary.max || 0), t: t('chart'),
        aria: t('panel.waitDist')
      },
      note: t('chart.elapsed') + ': ' + t('chart.median') + ' ' + fmtMin(w.summary.median) +
            '  ·  p90 ' + fmtMin(w.summary.p90),
      table: {
        caption: t('panel.waitDist'),
        head: [t('chart.range'), t('chart.patients')],
        body: w.histogram.bins.map(function (b) {
          return [b.overflow ? fmtMinShort(b.lo) + '+' : fmtMinShort(b.lo) + '–' + fmtMinShort(b.hi), b.count];
        })
      }
    });
  }

  function hourZonePanel(d, area) {
    return panel({
      area: area, title: t('panel.heatHourZone'),
      chart: {
        type: 'heatmap', matrix: d.heatmaps.hourZone,
        unit: t('heat.unitPatients'), t: t('chart'),
        rowLabelWidth: 34, colLabelHeight: 14,
        aria: t('panel.heatHourZone')
      },
      note: t('heat.hourZoneNote'),
      table: heatTable(d.heatmaps.hourZone, t('panel.heatHourZone'))
    });
  }

  function heatTable(m, caption) {
    if (!m || !m.rows.length) return null;
    return {
      caption: caption,
      head: [''].concat(m.cols),
      body: m.rows.map(function (r, ri) { return [r].concat(m.cells[ri]); })
    };
  }

  /* Scatter: three colour classes at most. Past three, colour-vision
     separation cannot be guaranteed for every pair, so the six zones
     collapse to the acuity grouping clinicians already use. */
  function scatterPanel(d, area, byUnit) {
    var pts, legend;
    if (byUnit) {
      var order = ['ED WCC', 'ED BU', 'PAC WCC'];
      var cols = [Charts.CAT[0], Charts.CAT[1], Charts.CAT[2]];
      pts = d.scatter.map(function (p) {
        var i = Math.max(0, order.indexOf(p.unit));
        return { x: p.x, y: p.y, colour: cols[i], groupLabel: unitShort(p.unit || order[i]) };
      });
      legend = order.map(function (u, i) { return { colour: cols[i], label: unitShort(u) }; });
    } else {
      var MAP = {
        rz: { c: 'var(--zone-rz)', hex: '#c0392b', label: zoneName('rz') },
        yz: { c: 'var(--zone-yz)', hex: '#e08b00', label: zoneName('yz') }
      };
      var OTHER = { hex: '#2a78d6', label: S.lang === 'ms' ? 'Zon lain' : 'Other zones' };
      pts = d.scatter.map(function (p) {
        var m = MAP[p.z];
        return { x: p.x, y: p.y, colour: m ? m.hex : OTHER.hex,
                 groupLabel: m ? m.label : OTHER.label };
      });
      legend = [
        { colour: MAP.rz.hex, label: MAP.rz.label },
        { colour: MAP.yz.hex, label: MAP.yz.label },
        { colour: OTHER.hex, label: OTHER.label }
      ];
    }
    var yTopMin = pts.length ? Math.max.apply(null, pts.map(function (q) { return q.y; })) : 60;
    var yFmt = axisMinFmt(yTopMin);
    return panel({
      area: area, title: t('panel.scatter'),
      sub: 'n = ' + pts.length,
      chart: {
        type: 'scatter', points: pts, yFmt: yFmt,
        xAxisLabel: t('chart.axisAge'), t: t('chart'), aria: t('panel.scatter')
      },
      legend: legend,
      note: t('chart.axisAge') + ' × ' + t('chart.elapsed') +
            (S.lang === 'ms' ? '. Setiap titik ialah seorang pesakit.'
                             : '. Each point is one patient.'),
      table: {
        caption: t('panel.scatter'),
        head: [t('chart.group'), t('chart.age'), t('chart.elapsed')],
        body: pts.slice(0, 300).map(function (p) { return [p.groupLabel, p.x, fmtMin(p.y)]; })
      }
    });
  }

  function projectionPanel(d, area) {
    var j = d.projection;
    if (!j || !j.available) {
      return panel({
        area: area, title: t('panel.projection'),
        html: '<div class="state"><span class="state-icon">◦</span><span>' +
              esc(S.lang === 'ms' ? 'Unjuran tidak tersedia — rekod terlalu sedikit.'
                                  : 'No projection — too few records.') + '</span></div>'
      });
    }
    var notes = [];
    notes.push((S.lang === 'ms' ? 'Sekarang ' : 'Now ') + j.current +
               ' (' + j.beddedNow + ' ' + t('chart.funded').toLowerCase() +
               ', ' + j.waitingNow + ' ' + t('chart.queueShort') + ').');
    if (j.losIsDefault) {
      notes.push(t('note.losDefault'));
    } else {
      notes.push((S.lang === 'ms' ? 'Tempoh rawatan rata-rata ' : 'Mean length of stay ') +
                 j.meanLosHours + (S.lang === 'ms' ? ' jam.' : ' h.'));
    }
    if (j.crisisBedsImplied > 0) {
      notes.push((S.lang === 'ms' ? 'Dijangka perlu ' : 'Projected need: ') +
                 j.crisisBedsImplied + (S.lang === 'ms' ? ' katil krisis.' : ' escalation beds.'));
    }
    return panel({
      area: area, title: t('panel.projection'),
      sub: (S.lang === 'ms' ? 'Aliran deterministik' : 'Deterministic flow model'),
      chart: {
        type: 'projection', projection: j,
        t: {
          hour: t('chart.hour'), patients: t('chart.patients'), pi80: t('chart.pi80'),
          now: S.lang === 'ms' ? 'Kini' : 'Now',
          bedsAvailable: S.lang === 'ms' ? 'Tempat sedia ada' : 'Places available'
        },
        aria: t('panel.projection')
      },
      legend: [
        { colour: Charts.CAT[0], kind: 'line', label: t('kpi.census') },
        { colour: Charts.CAT[0], kind: 'band', label: t('chart.pi80') },
        { colour: Charts.STATUS.critical, kind: 'line',
          label: (S.lang === 'ms' ? 'Tempat sedia ada' : 'Places available') }
      ],
      note: notes.join(' '),
      table: {
        caption: t('panel.projection'),
        head: [t('chart.hour'), t('kpi.census'), '80% lo', '80% hi'],
        body: j.hours.map(function (h, i) {
          return [Charts.pad2(h) + ':00', j.mid[i], j.lo80[i], j.hi80[i]];
        })
      }
    });
  }

  function methodPanel(d, area) {
    var f = d.forecast || {};
    var lines = [];
    if (f.available) {
      lines.push('<strong>' + esc(f.model === 'holtWintersAdditive'
        ? t('note.modelHW') : t('note.modelDamped')) + '</strong>');
      var pr = f.params || {};
      var ps = Object.keys(pr).map(function (k) { return k + ' = ' + pr[k]; }).join(', ');
      lines.push(esc('α/β/φ: ' + ps));
      lines.push(esc((S.lang === 'ms' ? 'Jam lengkap digunakan: ' : 'Complete hours fitted: ') + f.n +
        (S.lang === 'ms' ? '. Jam belum tamat dikecualikan.' : '. The part-elapsed hour is excluded.')));
      if (f.accuracy && f.accuracy.n) {
        lines.push(esc(tf('note.accuracy', Charts.num(f.accuracy.mae, 2), Charts.num(f.accuracy.rmse, 2))));
      }
      if (f.stale) lines.push('<em>' + esc(t('note.staleForecast')) + '</em>');
    } else {
      lines.push(esc(S.lang === 'ms'
        ? 'Ramalan tidak tersedia — rekod kemasukan terlalu sedikit.'
        : 'No forecast — too few arrival records.'));
    }
    return panel({
      area: area, title: t('panel.method'),
      html: '<div style="padding:2px 10px 8px;font-size:calc(10px * var(--s));' +
            'color:var(--ink-2);line-height:1.5">' + lines.join('<br>') + '</div>'
    });
  }

  function barListPanel(d, area, title, items, labelFn, unitLabel) {
    if (!items.length) {
      return panel({ area: area, title: title,
        html: '<div class="state"><span class="state-icon">◦</span><span>—</span></div>' });
    }
    var groups = items.map(function (x) {
      return { label: labelFn(x.key), short: labelFn(x.key), values: [x.count] };
    });
    return panel({
      area: area, title: title,
      chart: {
        type: 'groupedBars', groups: groups,
        series: [{ label: unitLabel, colour: Charts.CAT[0] }],
        t: t('chart'), aria: title
      },
      table: {
        caption: title, head: [title, unitLabel],
        body: items.map(function (x) { return [labelFn(x.key), x.count]; })
      }
    });
  }

  function ageBandPanel(d, area) {
    var groups = d.ageBands.map(function (b) {
      return { label: b.key, short: b.key, values: [b.count] };
    });
    return panel({
      area: area, title: t('panel.ageBands'),
      sub: t('chart.median') + ' ' + fmtInt(d.ageSummary.median) + ' ' + t('chart.years'),
      chart: {
        type: 'groupedBars', groups: groups,
        series: [{ label: t('chart.patients'), colour: Charts.CAT[3] }],
        t: t('chart'), aria: t('panel.ageBands')
      },
      table: {
        caption: t('panel.ageBands'), head: [t('chart.age'), t('chart.patients')],
        body: d.ageBands.map(function (b) { return [b.key, b.count]; })
      }
    });
  }

  function genderPanel(d, area) {
    var data = d.genderMix.map(function (g, i) {
      return { label: g.key, count: g.count, colour: Charts.CAT[i % Charts.CAT.length] };
    });
    return panel({
      area: area, title: t('panel.gender'),
      chart: { type: 'donut', data: data, aria: t('panel.gender') },
      legend: data.map(function (x) { return { colour: x.colour, label: x.label }; }),
      table: { caption: t('panel.gender'), head: [t('field.gender'), t('chart.patients')],
               body: d.genderMix.map(function (g) { return [g.key, g.count]; }) }
    });
  }

  function bedBoardPanel(d, area) {
    var b = d.bedBoard;
    if (!b || !b.rows.length) {
      return panel({ area: area, title: t('panel.bedBoard'),
        html: '<div class="state"><span class="state-icon">◦</span><span>—</span></div>' });
    }
    var dwellFmt = axisMinFmt(b.maxDwellMin || 0);
    var showLocation = b.rows.some(function (r) { return r.location !== b.rows[0].location; });

    return panel({
      area: area, title: t('panel.bedBoard'),
      sub: tf('heat.bedSummary', {
        occupied: b.totals.occupied, places: b.totals.places,
        pct: Charts.num(b.occupancyPct, 1), empty: b.totals.empty,
        crisisOccupied: b.totals.crisisOccupied, crisisPlaces: b.totals.crisisPlaces
      }),
      chart: {
        type: 'bedBoard', board: b,
        rowLabel: function (r) {
          var zn = zoneShort(r.zone), un = unitShort(r.location);
          if (!showLocation || zn === un) return zn;
          return un + ' ' + zn;
        },
        zoneName: zoneName,
        statusName: statusName,
        fmtDwell: dwellFmt,
        t: {
          bed: t('chart.bed'), zone: t('chart.zone'), free: t('chart.free'),
          crisisBed: t('chart.crisisBed'), dwell: t('chart.dwell'),
          dwellUnit: t('chart.dwellUnit'), status: t('field.status'),
          referredTo: t('field.referredTo')
        },
        aria: t('panel.bedBoard')
      },
      note: t('heat.bedNote'),
      table: {
        caption: t('panel.bedBoard'),
        head: [t('chart.zone'), t('chart.legendCapacity'), t('chart.legendCrisis'),
               t('chart.occupied'), t('kpi.freeBeds')],
        body: b.rows.map(function (r) {
          var zn = zoneName(r.zone), un = unitShort(r.location);
          return [zn === un ? zn : un + ' ' + zn, r.funded, r.crisisPlaces,
                  (r.occupiedFunded + r.occupiedCrisis), r.emptyFunded];
        }).concat([[t('chart.places'), b.totals.places - b.totals.crisisPlaces,
                    b.totals.crisisPlaces, b.totals.occupied, b.totals.empty]])
      }
    });
  }

  function unitComparePanel(d, area) {
    var units = d.units || [];
    var series = [
      { label: t('status.ongoingtreatment'), colour: Charts.CAT[0] },
      { label: t('status.referred'), colour: Charts.CAT[1] },
      { label: t('status.preadmit'), colour: Charts.CAT[3] },
      { label: t('status.admitted'), colour: Charts.CAT[2] }
    ];
    var groups = units.map(function (u) {
      return { label: t('units.' + u.location) || u.location, short: unitShort(u.location),
               values: [u.ongoing, u.referred, u.preadmit, u.admitted] };
    });
    return panel({
      area: area, title: t('panel.unitCompare'),
      chart: { type: 'groupedBars', groups: groups, series: series,
               t: t('chart'), aria: t('panel.unitCompare') },
      legend: series,
      table: {
        caption: t('panel.unitCompare'),
        head: [t('chart.unit'), t('kpi.attendances'), t('chart.legendCapacity'),
               t('chart.crisis'), t('kpi.load')],
        body: units.map(function (u) {
          return [unitShort(u.location), u.attendances, u.capacity, u.crisis,
                  fmtPct(u.capacity ? (u.funded + u.crisis) / u.capacity * 100 : null)];
        })
      }
    });
  }

  function completenessPanel(d, area) {
    var dq = d.dataQuality;
    var rows = dq.fields.map(function (f) {
      return { label: t('field.' + f.key) || f.key, n: f.n, total: f.total, pct: f.pct };
    });
    return panel({
      area: area, title: t('panel.completeness'), sub: dq.records + ' ' + t('chart.patients').toLowerCase(),
      chart: { type: 'completeness', rows: rows, t: t('chart'), aria: t('panel.completeness') },
      table: {
        caption: t('panel.completeness'),
        head: [t('panel.completeness'), t('chart.populated'), '%'],
        body: rows.map(function (r) { return [r.label, r.n + ' / ' + r.total, fmtPct(r.pct)]; })
      }
    });
  }

  function flagsPanel(d, area) {
    var dq = d.dataQuality;
    var html = '<div style="padding:2px 10px 8px;font-size:calc(10px * var(--s));line-height:1.6">';
    if (!dq.flags.length && !dq.capacityFlags.length && !dq.stepDown.length) {
      html += '<span style="color:var(--ok);font-weight:700">✓ ' + esc(t('dq.clean')) + '</span>';
    } else {
      dq.flags.forEach(function (f) {
        html += '<div><span style="color:var(--critical);font-weight:800">' + f.count + '</span> ' +
                esc(t('dq.' + f.key) || f.key) + '</div>';
      });
      dq.capacityFlags.forEach(function (c) {
        html += '<div><span style="color:var(--warn);font-weight:800">!</span> ' +
                esc(unitShort(c.location) + ' ' + zoneShort(c.zone) + ': ' + c.funded + ' > ' + c.capacity) +
                '</div>';
      });
      if (dq.stepDown.length) {
        html += '<div style="margin-top:6px;color:var(--ink-2)">' +
                esc(tf('note.stepDown', dq.stepDown.length)) + '</div>';
      }
    }
    html += '</div>';
    return panel({ area: area, title: t('panel.flags'), html: html });
  }

  /* ══════════════════════════════════════════════════════════
     STEP DEFINITIONS
     ══════════════════════════════════════════════════════════ */
  /** KPI row summarising the bed establishment for one scope. */
  /* ══════════════════════════════════════════════════════════
     PUBLIC VIEW — tabs 1 to 3

     These screens answer the three questions a waiting family
     actually has: where is my relative, how full is the zone they
     are in, and how long is the green-zone queue. No charts: the
     analysis lives on the Administrative tab.
     ══════════════════════════════════════════════════════════ */

  /**
   * What stands where the search used to.
   *
   * Taking the look-up away without replacing it would leave a family with no
   * answer and no next step, so the panel names the next step: the counter,
   * which is where a named patient's status can be given to the right person
   * face to face.
   */
  function counterPrompt(area) {
    var n = node('div', 'seek is-counter');
    n.style.gridArea = area;
    n.innerHTML =
      '<span class="seek-ic" aria-hidden="true">\\ud83d\\udc69\\u200d\\u2695\\ufe0f</span>' +
      '<div class="seek-copy">' +
        '<h2>' + esc(t('public.counterTitle')) + '</h2>' +
        '<p>' + esc(t('public.counterSub')) + '</p>' +
      '</div>';
    return n;
  }

  /** The search prompt, shown inline rather than hidden behind the header. */
  function searchPrompt(area) {
    var n = node('div', 'seek');
    n.style.gridArea = area;
    n.innerHTML =
      '<div class="seek-copy">' +
        '<h2>' + esc(t('search.title')) + '</h2>' +
        '<p>' + esc(t('public.seekSub')) + '</p>' +
      '</div>' +
      '<button class="seek-btn" type="button">' +
        '<span aria-hidden="true">🔍</span> ' + esc(t('searchBtn')) +
      '</button>';
    n.querySelector('.seek-btn').onclick = function () {
      var b = $('searchBtn'); if (b) b.click();
    };
    return n;
  }

  /**
   * One card per zone: how many patients are being cared for against the
   * zone's normal bed count, and whether escalation beds are open.
   * The green zone also carries the queue length and the average wait,
   * which is the single most asked question in the waiting area.
   */
  function zoneCards(d, area) {
    var wrap = node('div', 'zone-grid');
    wrap.style.gridArea = area;

    // Fixed reading order, left to right: red, yellow, observation, asthma,
    // then green. All on one row - never wrapped onto a second layer - so the
    // sequence reads as the escalation ladder it is.
    var ORDER = ['rz', 'yz', 'ob', 'ab', 'pac', 'gz'];
    var zones = d.occupancy.filter(function (z) { return z.capacity > 0; })
      .sort(function (a, b) { return ORDER.indexOf(a.zone) - ORDER.indexOf(b.zone); });
    wrap.style.gridTemplateColumns = 'repeat(' + zones.length + ', minmax(0, 1fr))';

    wrap.innerHTML = zones.map(function (z) {
      var total = z.funded + z.crisis;
      var isRoom = z.isRoomZone;

      // Beds beyond the normal establishment, derived from the two numbers on
      // the card. Counting bed codes instead can disagree with what the reader
      // can see - a patient in a crisis bed while a normal bed stands empty -
      // and a public screen that does not add up is not worth showing. The
      // Administrative tab keeps the coded count and flags that difference as
      // a step-down opportunity.
      var over = Math.max(0, total - z.capacity);
      var full = total >= z.capacity;
      var pct = z.capacity > 0 ? Math.min(100, Math.round(total / z.capacity * 100)) : 0;
      var state = over > 0 ? 'crisis' : (full ? 'full' : (pct >= 70 ? 'busy' : 'ok'));

      var badge = over > 0
        ? '<span class="zc-badge is-crisis">' + over + ' ' + esc(t('public.crisisBeds')) + '</span>'
        : '<span class="zc-badge is-' + state + '">' + esc(t('public.state.' + state)) + '</span>';

      // The green zone carries the two figures families ask about most.
      var extra = '';
      if (isRoom) {
        extra = '<div class="zc-gz">' +
          '<div class="zc-gz-row"><span class="zc-gz-n">' + z.waiting + '</span>' +
            '<span class="zc-gz-l">' + esc(t('public.waitingNow')) + '</span></div>' +
          (d.kpi.gzAverageWaitMin
            ? '<div class="zc-gz-wait">' + esc(t('public.avgWait')) + ' <strong>' +
              esc(fmtMin(d.kpi.gzAverageWaitMin)) + '</strong></div>'
            : '<div class="zc-gz-wait zc-muted">' + esc(t('public.avgWaitNone')) + '</div>') +
          '</div>';
      }

      return '<div class="zone-card z-' + z.zone + (full ? ' is-full' : '') + '">' +
        '<div class="zc-name">' + esc(zoneName(z.zone)) + '</div>' +
        '<div class="zc-nums">' +
          '<span class="zc-big">' + total + '</span>' +
          '<span class="zc-cap">/ ' + z.capacity + '<br>' +
            esc(isRoom ? t('public.rooms') : t('public.beds')) + '</span>' +
        '</div>' +
        '<div class="zc-bar"><span style="width:' + pct + '%"></span></div>' +
        badge + extra +
      '</div>';
    }).join('');
    return wrap;
  }

  /**
   * Standing notice for non-emergency attendances. Kept on the first screen of
   * every public tab: it is the message that actually shortens the queue.
   */
  function klinikNotice(area) {
    var n = node('div', 'klinik');
    n.style.gridArea = area;
    n.innerHTML =
      '<span class="klinik-ic" aria-hidden="true">🏥</span>' +
      '<div><strong>' + esc(t('public.klinikTitle')) + '</strong>' +
      '<p>' + esc(t('public.klinikBody')) + '</p>' +
      '<p class="klinik-madani">' + esc(t('public.klinikMadani')) + '</p></div>';
    return n;
  }

  /** Plain-language guidance: what the zones mean and what happens next. */
  /**
   * @param compact  true on the single-screen PAC layout, where the guidance
   *                 shares the screen with the zone card and the clinic notice
   *                 and so cannot run at the full-page type size.
   */
  function guidePanel(d, area, compact) {
    var rows = t('public.guide');
    var html = '<div class="guide' + (compact ? ' is-compact' : '') + '">' + rows.map(function (g) {
      return '<div class="guide-row"><span class="guide-ic" aria-hidden="true">' + esc(g.icon) +
             '</span><div><strong>' + esc(g.title) + '</strong><p>' + esc(g.body) + '</p></div></div>';
    }).join('') + '</div>';
    // The posters used to hang off this panel's header as a small button. They
    // have their own tab now, where there is room to say what they are.
    return panel({ area: area, title: t('public.guideTitle'), html: html });
  }

  /* Below this width the five zone cards cannot share a row, so they stack
     in the same order, top to bottom, and the content area is allowed to
     scroll. That is a phone; on anything from a 10-inch tablet upwards the
     whole public view is one page with nothing to page through. */
  var NARROW_PX = 620;

  /**
   * One page. Nobody walks up to a waiting-room television and presses Next,
   * and a family glancing at a screen on their way past should not have to
   * either, so every public tab is a single screen: the zone row, the search
   * prompt, the non-emergency notice and the guidance together.
   */
  function publicSteps(d) {
    return [{
      title: t('public.stepNow'),
      // The zone board is the reason anyone opened this page, so it takes the
      // larger share. It also needs it: the green-zone card carries one block
      // more than the others (those waiting, and their average wait) and is
      // the first to run short when the column narrows, as it does beside the
      // wall-display rail.
      rows: 'minmax(0,1.2fr) auto minmax(0,1fr)',
      cols: '1.15fr 1fr',
      areas: '"zones zones" "seek klinik" "guide guide"',
      build: function () {
        return [zoneCards(d, 'zones'),
                S.search ? searchPrompt('seek') : counterPrompt('seek'),
                klinikNotice('klinik'), guidePanel(d, 'guide', true)];
      }
    }];
  }

  /* ══════════════════════════════════════════════════════════
     ADMINISTRATIVE VIEW — every visualisation lives here
     ══════════════════════════════════════════════════════════ */
  function bedKpis(d) {
    var b = d.bedBoard, tot = b.totals;
    return kpiBlock([
      { label: t('chart.places'), value: fmtInt(tot.places),
        sub: (tot.places - tot.crisisPlaces) + ' ' + t('chart.legendFunded').toLowerCase() +
             ' + ' + tot.crisisPlaces + ' ' + t('chart.crisisBed').toLowerCase() },
      { label: t('chart.occupied'), value: fmtPct(b.occupancyPct),
        tone: b.occupancyPct >= 95 ? 'critical' : b.occupancyPct >= 80 ? 'warn' : 'ok',
        sub: tot.occupied + ' / ' + tot.places },
      { label: t('kpi.freeBeds'), value: fmtInt(tot.empty),
        tone: tot.empty === 0 ? 'critical' : tot.empty <= 2 ? 'warn' : 'ok',
        sub: t('chart.free') },
      { label: t('kpi.crisis'), value: fmtInt(tot.crisisOccupied),
        tone: tot.crisisOccupied > 0 ? 'critical' : 'ok',
        sub: t('chart.crisisBed') + ' ' + tot.crisisOccupied + ' / ' + tot.crisisPlaces }
    ], 4);
  }

  function adminSteps(d) {
    var k = d.kpi;
    return [
      {
        title: t('steps.overview'),
        rows: 'auto minmax(0,1fr)', cols: '1.45fr 1fr',
        areas: '"kpi kpi" "units status"',
        build: function () {
          var tiles = [
            { label: t('kpi.attendances'), value: fmtInt(k.attendances),
              sub: fmtInt(k.census) + ' ' + t('kpi.census').toLowerCase() },
            { label: t('kpi.admitted'), value: fmtInt(k.admitted),
              sub: t('kpi.admitRate') + ' ' + fmtPct(k.admissionRatePct) },
            { label: t('kpi.deaths'),
              value: k.deathFieldPresent ? fmtInt(k.deaths) : null,
              na: k.deathFieldPresent ? null : t('note.notConfigured'),
              sub: k.deathFieldPresent ? fmtPct(k.mortalityRatePct) : t('note.noDeathField'),
              tone: k.deaths > 0 ? 'critical' : null },
            { label: t('kpi.referRate'), value: fmtPct(k.referralRatePct),
              sub: fmtInt(k.referred) + ' ' + t('kpi.referred').toLowerCase() },
            { label: t('kpi.medianWait'), value: fmtMinShort(k.medianElapsedMin),
              sub: (S.lang === 'ms' ? 'Nilai pertengahan' : 'Median') +
                   (k.medianTwtMin ? ' · ' + t('kpi.medianTwt') + ' ' + fmtMinShort(k.medianTwtMin) : '') },
            { label: t('kpi.cost'),
              value: k.costConfigured ? ('RM ' + Number(k.cost).toLocaleString('en-MY')) : null,
              na: k.costConfigured ? null : t('note.notConfigured'),
              sub: k.costConfigured ? t('note.costModelled') : 'UNIT_COST_PER_ATTENDANCE' }
          ];
          var blk = kpiBlock(tiles, 3);
          blk.style.gridArea = 'kpi';
          return [blk, unitComparePanel(d, 'units'), statusPanel(d, 'status')];
        }
      },
      {
        title: t('steps.flow'),
        rows: 'minmax(0,1fr) minmax(0,1fr)', cols: '1fr',
        areas: '"arr" "proj"',
        build: function () {
          return [arrivalsPanel(d, 'arr'), projectionPanel(d, 'proj')];
        }
      },
      {
        title: t('steps.waits'),
        rows: 'minmax(0,1fr) minmax(0,1fr)', cols: '1fr 1fr',
        areas: '"wait wait" "scat method"',
        build: function () {
          return [waitsPanel(d, 'wait'), scatterPanel(d, 'scat', true), methodPanel(d, 'method')];
        }
      },
      {
        title: t('steps.casemix'),
        rows: 'minmax(0,1fr) minmax(0,1fr)', cols: '1.25fr 1fr',
        areas: '"refs ages" "heatref gender"',
        build: function () {
          return [
            barListPanel(d, 'refs', t('panel.referrals'), d.referralMix,
                         function (x) { return x; }, t('chart.patients')),
            ageBandPanel(d, 'ages'),
            panel({
              area: 'heatref', title: t('panel.heatZoneRef'),
              chart: {
                type: 'heatmap', matrix: d.heatmaps.zoneReferral,
                unit: t('heat.unitReferrals'), t: t('chart'),
                rowLabelWidth: 40, colLabelHeight: 34,
                rowLabel: function (r) { return zoneShort(String(r).toLowerCase()); },
                aria: t('panel.heatZoneRef')
              },
              note: t('heat.zoneRefNote'),
              table: heatTable(d.heatmaps.zoneReferral, t('panel.heatZoneRef'))
            }),
            genderPanel(d, 'gender')
          ];
        }
      },
      {
        title: t('steps.beds'),
        rows: 'auto minmax(0,1.3fr) minmax(0,1fr)', cols: '1fr',
        areas: '"kpi" "board" "heathz"',
        build: function () {
          var blk = bedKpis(d);
          blk.style.gridArea = 'kpi';
          return [blk, bedBoardPanel(d, 'board'), hourZonePanel(d, 'heathz')];
        }
      },
      {
        title: t('steps.quality'),
        rows: 'minmax(0,1.25fr) minmax(0,1fr)', cols: '1fr 1fr',
        areas: '"complete flags" "cap cap"',
        build: function () {
          return [completenessPanel(d, 'complete'), flagsPanel(d, 'flags'),
                  capacityPanel(d, 'cap')];
        }
      }
    ];
  }

  function stepsFor(tab, d) {
    if (tab === 'iqms') return posterStep('iqms', queueFallback);
    if (tab === 'triage') return posterStep('triage', triageFallback);
    return tab === 'admin' ? adminSteps(d) : publicSteps(d);
  }

  /* ══════════════════════════════════════════════════════════
     IQMS & TRIAGE TAB
     Standing guidance shared by all three units: why order of arrival is not
     order of treatment, which conditions belong here and which do not, and
     how the queue number works. One screen, no live data.
     ══════════════════════════════════════════════════════════ */
  function bulletList(items, cls) {
    return '<ul class="cklist' + (cls ? ' ' + cls : '') + '">' +
      items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }

  function whyPanel(area) {
    var html =
      '<p class="iq-lead">' + esc(t('iqms.whyBody1')) + '</p>' +
      '<p class="iq-lead">' + esc(t('iqms.whyBody2')) + '</p>' +
      '<p class="iq-alert"><span aria-hidden="true">\\u26a0\\ufe0f</span> ' +
        esc(t('iqms.whyAlert')) + '</p>';
    return panel({ area: area, title: '\\ud83d\\ude91 ' + t('iqms.whyTitle'), html: html });
  }

  function emergPanel(area) {
    return panel({
      area: area,
      title: '\\ud83d\\udd34 ' + t('iqms.emergTitle'),
      cls: 'is-emerg',
      html: bulletList(t('iqms.emergList'), 'is-emerg')
    });
  }

  function nonEmergPanel(area) {
    var html = bulletList(t('iqms.nonList'), 'is-ok') +
      '<p class="iq-warn">' + esc(t('iqms.nonWarn')) + '</p>' +
      '<p class="iq-madani">' + esc(t('iqms.nonMadani')) + '</p>';
    return panel({ area: area, title: '\\ud83c\\udfe5 ' + t('iqms.nonTitle'), cls: 'is-non', html: html });
  }

  function queuePanel(area) {
    var p = panel({
      area: area,
      title: '\\ud83d\\udd22 ' + t('iqms.queueTitle'),
      html: bulletList(t('iqms.queueList'), 'is-num')
    });
    // The reviewed posters live here now rather than behind a small button on
    // the status board, where they were easy to miss.
    if (S.illustrations && S.illustrations.items && S.illustrations.items.length) {
      var btn = node('button', 'panel-tbl', esc(t('public.posterBtn')));
      btn.type = 'button';
      btn.onclick = openPosters;
      p.querySelector('.panel-hd').appendChild(btn);
    }
    return p;
  }

  /**
   * A tab that is one poster.
   *
   * The hospital's own artwork says this better than a wall of panels, so the
   * image fills the screen and nothing else competes with it. The written
   * version is kept and shown only if the image cannot be loaded -- a blank
   * tab in a waiting hall is worse than plain text.
   */
  function posterPanel(key, area, fallbackBuild) {
    var wrap = node('div', 'poster-tab');
    wrap.style.gridArea = area;

    var p = S.posters && S.posters[key];
    if (!p || !p.src) { return fallbackNode(fallbackBuild, area); }

    var img = node('img', 'poster-img');
    img.alt = t('tabs.' + key + '.name');
    img.decoding = 'async';
    // The wall display asks for the larger rendition; a phone does not.
    img.src = (window.innerWidth >= 1200 && p.srcLarge) ? p.srcLarge : p.src;
    img.onerror = function () {
      var el = fallbackNode(fallbackBuild, area);
      if (wrap.parentNode) wrap.parentNode.replaceChild(el, wrap);
    };
    wrap.appendChild(img);
    return wrap;
  }

  /**
   * The queue page as a link, not a QR code.
   *
   * The poster's QR is right for a printed sheet on a wall. On a screen the
   * reader is already holding the device that would scan it, so asking them to
   * photograph their own phone is a step for nothing.
   */
  function iqmsAction(area) {
    var url = (S.posters && S.posters.iqmsUrl) || '';
    if (!url) return null;
    var n = node('div', 'poster-cta');
    n.style.gridArea = area;
    n.innerHTML =
      '<div class="cta-copy"><strong>' + esc(t('iqms.ctaTitle')) + '</strong>' +
        '<span>' + esc(t('iqms.ctaSub')) + '</span></div>' +
      '<a class="cta-btn" href="' + esc(url) + '" target="_blank" rel="noopener">' +
        '<span aria-hidden="true">\\ud83d\\udd22</span> ' + esc(t('iqms.ctaBtn')) + '</a>';
    return n;
  }

  function fallbackNode(build, area) {
    var wrap = node('div', 'poster-fallback');
    wrap.style.gridArea = area;
    build().forEach(function (n) { if (n) wrap.appendChild(n); });
    return wrap;
  }

  function posterStep(key, fallbackBuild) {
    var cta = key === 'iqms';
    return [{
      title: t('tabs.' + key + '.name'),
      guide: true,
      rows: cta ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)',
      cols: 'minmax(0, 1fr)',
      areas: cta ? '"poster" "cta"' : '"poster"',
      build: function () {
        return [posterPanel(key, 'poster', fallbackBuild), cta ? iqmsAction('cta') : null];
      }
    }];
  }

  /** Shown only when the IQMS poster cannot be loaded. */
  function queueFallback() {
    return [queuePanel('')];
  }

  /** Shown only when the triage poster cannot be loaded. */
  function triageFallback() {
    return [whyPanel(''), emergPanel(''), nonEmergPanel('')];
  }

  /* ══════════════════════════════════════════════════════════
     RENDER
     ══════════════════════════════════════════════════════════ */
  function showState(kind, msg) {
    var c = $('content');
    c.innerHTML = '<div class="state" style="height:100%">' +
      (kind === 'load' ? '<div class="spin"></div>'
                       : '<span class="state-icon">⚠️</span>') +
      '<span>' + esc(msg) + '</span>' +
      (kind === 'err' ? '<button class="pager-btn" id="retryBtn" type="button">' +
                        esc(t('retry')) + '</button>' : '') +
      '</div>';
    $('pager').style.display = 'none';
    var r = $('retryBtn');
    if (r) r.onclick = function () { loadTab(S.tab, true); };
  }

  /** The administrative tab before an access code has been accepted. */
  function showLocked() {
    var c = $('content');
    c.innerHTML =
      '<div class="state" style="height:100%">' +
        '<span class="state-icon">🔒</span>' +
        '<span style="font-size:calc(15px * var(--s));font-weight:800;color:var(--ink)">' +
          esc(t('admin.gateTitle')) + '</span>' +
        '<span id="lockedMsg">' + esc(S.gateNote || t('admin.lockedBody')) + '</span>' +
        '<button class="btn-go" id="lockedBtn" type="button" style="margin-top:calc(6px * var(--s))">' +
          esc(t('admin.openGate')) + '</button>' +
      '</div>';
    $('pager').style.display = 'none';
    $('lockedBtn').onclick = openGate;
  }

  function renderTab() {
    var d = S.data[S.tab];
    renderStamp((S.tab === 'iqms' || S.tab === 'triage')
      ? (S.data.wcc || S.data.bu || S.data.pac) : d);

    // Locked: show a way back in rather than a spinner. Nothing has been
    // requested, so a spinner would turn forever - which is exactly what it
    // did whenever the access-code dialog was dismissed.
    if (S.tab === 'admin' && !S.adminToken) {
      showLocked();
      if (!S.gateShown) { S.gateShown = true; openGate(); }
      return;
    }
    // Standing guidance, identical whichever unit you came from: it waits on
    // nothing and renders the moment it is opened.
    var isGuide = S.tab === 'iqms' || S.tab === 'triage';
    if (!d && !isGuide) { showState('load', t('loading')); return; }
    if (d && d.error && !isGuide) {
      showState('err',
        d.error === 'UNAUTHORISED' ? t('admin.unauth')
        : d.error === 'TIMEOUT' ? t('errTimeout')
        : d.error === 'NO_RESPONSE' ? t('errNoResponse')
        : t('errBody'));
      return;
    }

    renderNarrative((S.tab === 'admin' || isGuide) ? null : d);
    var steps = stepsFor(S.tab, d);
    S.step = Math.min(S.step, steps.length - 1);

    var c = $('content');
    c.innerHTML = '';
    S.specs = [];

    var def = steps[S.step];
    var stepEl = node('div', 'step is-active' + (def.guide ? ' is-guide' : ''));
    stepEl.style.gridTemplateRows = def.rows;
    stepEl.style.gridTemplateColumns = def.cols;
    stepEl.style.gridTemplateAreas = def.areas;
    def.build().forEach(function (n) { if (n) stepEl.appendChild(n); });
    c.appendChild(stepEl);

    renderPager(steps);
    drawCharts();
  }

  function renderPager(steps) {
    var p = $('pager');
    // A single-step tab has nothing to page through, so the bar is removed
    // rather than shown with two disabled buttons.
    if (steps.length <= 1) { p.style.display = 'none'; return; }
    p.style.display = 'flex';
    p.style.visibility = 'visible';
    var prev = $('pgPrev'), next = $('pgNext');
    prev.textContent = '‹ ' + t('prev');
    next.textContent = t('next') + ' ›';
    prev.disabled = S.step === 0;
    next.disabled = S.step >= steps.length - 1;
    $('pgTitle').textContent = steps[S.step].title;
    var dots = $('pgDots');
    dots.innerHTML = '';
    steps.forEach(function (s, i) {
      var b = node('button', 'pager-dot');
      b.type = 'button';
      b.setAttribute('aria-current', i === S.step ? 'true' : 'false');
      b.setAttribute('aria-label', tf('stepOf', i + 1, steps.length) + ': ' + s.title);
      b.onclick = function () { S.step = i; S.stepIndex[S.tab] = i; renderTab(); };
      dots.appendChild(b);
    });
  }

  function drawCharts() {
    // Two frames: the grid must settle before a chart can measure its box.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        S.specs.forEach(function (s) { Charts.render(s.el, s.spec); });
      });
    });
  }

  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { setScale(); drawCharts(); }, 160);
  }

  /* ══════════════════════════════════════════════════════════
     DATA
     ══════════════════════════════════════════════════════════ */
  /**
   * Calls the data layer. Three hosts are supported, in order:
   *   __BRIDGE__   the static browser build (or the layout tests), which may
   *                answer synchronously or with a promise
   *   google.script.run   the Apps Script web app
   *   neither      report it rather than hanging
   */
  function serverCall(fn, arg, onOk) {
    var bridge = window.__BRIDGE__ || window.__MOCK__;
    if (bridge && bridge[fn]) {
      setTimeout(function () {
        var res;
        try { res = bridge[fn](arg); }
        catch (err) { onOk({ error: 'SERVER_ERROR', message: String(err && err.message || err) }); return; }
        if (res && typeof res.then === 'function') {
          res.then(onOk, function (err) {
            onOk({ error: 'SERVER_ERROR', message: String(err && err.message || err) });
          });
        } else {
          onOk(res);
        }
      }, 0);
      return;
    }
    if (typeof google === 'undefined' || !google.script || !google.script.run) {
      onOk({ error: 'NO_BRIDGE' });
      return;
    }
    // A call that never comes back must not leave a spinner turning. Apps
    // Script can drop a response without firing either handler -- a dropped
    // connection, a quota, a redeploy mid-flight -- and the page then showed
    // "Loading..." for ever with no way out. Whatever happens, something is
    // delivered exactly once.
    var settled = false;
    function settle(res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onOk(res === undefined || res === null ? { error: 'NO_RESPONSE' } : res);
    }
    var timer = setTimeout(function () {
      settle({ error: 'TIMEOUT' });
    }, SERVER_TIMEOUT_MS);

    google.script.run
      .withSuccessHandler(settle)
      .withFailureHandler(function (err) {
        settle({ error: 'SERVER_ERROR', message: err && err.message });
      })[fn](arg);
  }

  /**
   * Fetches a tab's figures.
   *
   * Every google.script.run call is a cold server invocation, so the round trip
   * dominates and the number of calls is what matters. The three public tabs
   * therefore come down together in one call: switching between them costs
   * nothing afterwards, and a refresh renews all three at once.
   */
  function loadTab(tab, force) {
    if (tab === 'admin') { loadAdmin(force); return; }
    loadPublic(force);
  }

  function loadPublic(force) {
    if (S.publicLoading && !force) return;
    S.publicLoading = true;
    // A spinner only when there is genuinely nothing to show. A refresh keeps
    // the current figures on screen and swaps them when the new ones arrive,
    // rather than blanking the page on every cycle.
    if (!S.data[S.tab] && S.tab !== 'admin') showState('load', t('loading'));
    serverCall('getPublicDashboards', null, function (res) {
      S.publicLoading = false;
      if (!res || res.error) {
        // Keep whatever is on screen; only an empty tab shows the error.
        if (!S.data[S.tab] && S.tab !== 'admin') { S.data[S.tab] = res || { error: 'SERVER_ERROR' }; renderTab(); }
        return;
      }
      for (var i = 0; i < PUBLIC_TABS.length; i++) {
        var k = PUBLIC_TABS[i];
        if (res[k]) { S.data[k] = res[k]; S.stale[k] = false; }
      }
      writeSnapshot();
      if (S.tab !== 'admin') renderTab();
    });
  }

  function loadAdmin(force) {
    if (!S.adminToken) { renderTab(); return; }
    if (S.busy.admin && !force) return;
    S.busy.admin = true;
    if (!S.data.admin && S.tab === 'admin') showState('load', t('loading'));
    serverCall('getAdminDashboard', S.adminToken, function (res) {
      S.busy.admin = false;
      if (res && res.error === 'UNAUTHORISED') S.adminToken = null;
      S.data.admin = res;
      if (S.tab === 'admin') renderTab();
    });
  }

  function gotoTab(tab) {
    if (S.tab === tab) return;
    if (tab === 'admin' && !S.adminToken) S.gateShown = false;
    S.stepIndex[S.tab] = S.step;
    S.tab = tab;
    // A host that owns the address bar (the Vercel build) keeps the URL in
    // step with the tab. Undefined under Apps Script, where the page runs in
    // a sandbox iframe and has no address bar of its own.
    if (window.ON_TAB_CHANGE) { try { window.ON_TAB_CHANGE(tab); } catch (e) {} }
    S.step = S.stepIndex[tab] || 0;
    renderChrome();
    if (S.data[tab] && !S.data[tab].error) renderTab(); else loadTab(tab);
  }

  /* ══════════════════════════════════════════════════════════
     OVERLAYS
     ══════════════════════════════════════════════════════════ */
  function openOv(id) {
    var el = $(id);
    if (!el) return;
    el.classList.add('is-open');
    document.removeEventListener('keydown', escClose);
    document.addEventListener('keydown', escClose);
  }
  function closeOv(id) {
    var el = $(id);
    if (el) el.classList.remove('is-open');
  }
  function escClose(e) {
    if (e.key !== 'Escape') return;
    ['ovSearch', 'ovTable', 'ovGate', 'ovHelp'].forEach(closeOv);
    document.removeEventListener('keydown', escClose);
  }

  function openTable(title, spec) {
    $('tblTitle').textContent = title;
    $('tblBody').innerHTML = Charts.tableHtml(spec);
    openOv('ovTable');
  }

  // ── search ───────────────────────────────────────────────
  function doSearch() {
    var q = $('searchInput').value.trim();
    var out = $('searchResults');
    if (q.length < 6) { out.innerHTML = msgBox(tf('search.minChars', 6)); return; }
    out.innerHTML = '<div class="state"><div class="spin"></div></div>';
    serverCall('getPatientStatus', q, function (res) {
      if (!res) { out.innerHTML = msgBox(t('search.error')); return; }
      if (res.error === 'MIN_CHARS') { out.innerHTML = msgBox(tf('search.minChars', res.minChars || 6)); return; }
      if (res.error === 'TOO_MANY') { out.innerHTML = msgBox(tf('search.tooMany', res.found)); return; }
      if (res.error === 'RATE_LIMITED') { out.innerHTML = msgBox(t('search.rateLimit')); return; }
      if (res.error) { out.innerHTML = msgBox(t('search.error')); return; }
      if (!res.results || !res.results.length) { out.innerHTML = msgBox(t('search.none')); return; }
      out.innerHTML = res.results.map(resultCard).join('');
    });
  }
  function msgBox(m) {
    return '<div class="state"><span class="state-icon">🔍</span><span>' + esc(m) + '</span></div>';
  }
  function resultCard(p) {
    var f = t('search.fields');
    var chipColour = {
      ongoingtreatment: 'var(--brand-lt);color:var(--brand-dk)',
      referred: '#e6f0fa;color:#1a4c82',
      preadmit: '#fff4e0;color:#8a4b00',
      admitted: '#e6f7ee;color:#1a7c4a',
      discharge: '#f3eeff;color:#6b3ea0'
    }[p.status] || 'var(--surface-2);color:var(--ink-2)';

    var rows = [];
    function add(k, v) { if (v) rows.push('<div><div class="res-k">' + esc(k) + '</div><div class="res-v">' + esc(v) + '</div></div>'); }
    add(f.location, p.location);
    add(f.zone, zoneName(p.zone) + (p.isCrisisBed ? ' · ' + f.crisisBed : '') + (p.isWaiting ? ' · ' + f.waitingArea : ''));
    add(f.triage, p.triage);
    add(f.elapsed, p.elapsed);
    add(f.referredTo, p.referredTo);
    add(f.preadmit, p.preadmit);
    add(f.admitted, p.admitted);
    add(f.bwt, p.bwt);
    add(f.twt, p.twt);

    var queue = '';
    if (p.queueNo && !p.calledGZ) {
      queue = '<div class="queue"><span class="queue-n">' + esc(p.queueNo) + '</span>' +
              '<span class="queue-t"><strong>' + esc(f.queueNo) + '</strong><br>' +
              esc(t('search.queueWait')) + '</span></div>';
    } else if (p.calledGZ) {
      queue = '<div class="queue"><span style="font-size:calc(19px * var(--s))">✅</span>' +
              '<span class="queue-t"><strong>' + esc(f.calledIn) + '</strong><br>' + esc(p.calledGZ) + '</span></div>';
    }

    return '<div class="res"><div class="res-hd">' +
      '<div><div class="res-name">' + esc(p.nameDisplay) + '</div>' +
      '<div class="res-id mono">IC ' + esc(p.icMasked) + ' · MRN ' + esc(p.mrnMasked) + '</div></div>' +
      '<span class="chip" style="background:' + chipColour + '">' + esc(statusName(p.status)) + '</span>' +
      '</div><div class="res-grid">' + rows.join('') + '</div>' + queue + '</div>';
  }

  // ── admin gate ───────────────────────────────────────────
  function openGate() {
    $('gateMsg').textContent = '';
    openOv('ovGate');
    setTimeout(function () { $('gateInput').focus(); }, 80);
  }
  function submitGate() {
    var code = $('gateInput').value;
    var msg = $('gateMsg');
    msg.textContent = t('loading');
    serverCall('verifyAdmin', code, function (res) {
      if (!res) { msg.textContent = t('search.error'); return; }
      if (res.ok) {
        S.adminToken = res.token;
        $('gateInput').value = '';
        msg.textContent = '';
        closeOv('ovGate');
        loadTab('admin', true);
        return;
      }
      if (res.reason === 'NOT_CONFIGURED') msg.textContent = t('admin.notConfig');
      else if (res.reason === 'RATE_LIMITED') msg.textContent = t('admin.rateLimited');
      else msg.textContent = tf('admin.badCode', res.remaining === undefined ? 0 : res.remaining);
      // Carry the reason onto the locked screen, so dismissing the dialog does
      // not lose the explanation.
      S.gateNote = msg.textContent;
      var lm = $('lockedMsg');
      if (lm) lm.textContent = S.gateNote;
    });
  }

  /* ══════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════ */
  function toggleLang() {
    S.lang = S.lang === 'ms' ? 'en' : 'ms';
    try { localStorage.setItem('edpac_lang', S.lang); } catch (e) { /* private mode */ }
    renderChrome();
    renderTab();
    if (S.mode === 'tv') Banner.render();
    if (S.illustrations) paintHelpImages(S.illustrations);
  }

  function boot() {
    try {
      var saved = localStorage.getItem('edpac_lang');
      if (saved === 'ms' || saved === 'en') S.lang = saved;
    } catch (e) { /* storage unavailable — default stands */ }

    if (S.mode === 'tv') document.body.classList.add('is-tv');

    S.seededFrom = seedData();
    setScale();
    Charts.initTooltip();
    renderChrome();
    if (S.mode === 'tv') Banner.mount($('rail'), function () { return S.lang; });

    $('langBtn').onclick = toggleLang;
    if (S.search) {
      $('searchBtn').onclick = function () {
        openOv('ovSearch');
        setTimeout(function () { $('searchInput').focus(); }, 80);
      };
      $('searchGo').onclick = doSearch;
      $('searchInput').onkeydown = function (e) { if (e.key === 'Enter') doSearch(); };
    }
    $('gateGo').onclick = submitGate;
    $('gateInput').onkeydown = function (e) { if (e.key === 'Enter') submitGate(); };
    ['ovSearch', 'ovTable', 'ovGate', 'ovHelp'].forEach(function (id) {
      var ov = $(id);
      if (!ov) return;
      ov.addEventListener('click', function (e) { if (e.target === ov) closeOv(id); });
      ov.querySelector('.ov-x').onclick = function () { closeOv(id); };
    });
    $('pgPrev').onclick = function () {
      if (S.step > 0) { S.step--; S.stepIndex[S.tab] = S.step; renderTab(); }
    };
    $('pgNext').onclick = function () {
      S.step++; S.stepIndex[S.tab] = S.step; renderTab();
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // Already-seeded figures render immediately; the fetch then renews them
    // in the background without blanking anything.
    if (S.data[S.tab]) renderTab();
    loadTab(S.tab);

    // Illustrations are decoration and each one is a base64 image on a second
    // cold round trip. They wait until the figures are on screen.
    deferIdle(loadIllustrations, 2500);

    // Refresh quietly on the same cadence as the server cache.
    setInterval(function () {
      if (S.tab === 'admin' && !S.adminToken) return;
      loadTab(S.tab, true);
    }, REFRESH_MS);
  }

  // Small surface for diagnostics and for the tests: \`reload\` is what the
  // refresh timer calls, so a test can prove a refresh does not blank the page.
  window.EDPAC = {
    state: S, boot: boot, render: renderTab, t: t,
    reload: function () { loadTab(S.tab, true); },
    seededFrom: function () { return S.seededFrom; },
    banner: typeof Banner === 'undefined' ? null : Banner,
    refreshMs: REFRESH_MS
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
</script>

</body>
</html>
`;
