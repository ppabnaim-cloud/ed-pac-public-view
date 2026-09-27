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
    .addItem('1. Build sheet structure', 'setupRegister')
    .addItem('2. Generate full-capacity scenario', 'generateFullScenario')
    .addSeparator()
    .addItem('Clear data rows', 'clearRegisterData')
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
