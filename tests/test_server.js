// Server-layer gates: the data path that the page's speed depends on.
//
// Every google.script.run call is a cold server invocation, so the number of
// calls is what the user feels. These prove that the three public tabs really
// do come from one register read, that the cache is shared rather than
// per-tab, and that nothing identifiable rides along in a public payload.
require('./gas_stub.js');

let fails = 0;
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  fails++;
  console.log('  FAIL ' + name + (detail ? '  — ' + detail : ''));
}

// Count register reads by wrapping the fixture reader.
let reads = 0;
const realRead = global.readRegister_;
global.readRegister_ = readRegister_ = function () { reads++; return realRead(); };

console.log('\nOne register read for all three public tabs');
clearCaches();
reads = 0;
const all = getPublicDashboards();
ok('three payloads returned', Object.keys(all).sort().join(',') === 'bu,pac,wcc',
   Object.keys(all).join(','));
ok('register read exactly once', reads === 1, reads + ' reads');
ok('each payload has figures',
   ['wcc', 'bu', 'pac'].every(k => all[k] && all[k].occupancy && all[k].occupancy.length > 0));
ok('all three share one generatedAt stamp',
   all.wcc.generatedAt === all.bu.generatedAt && all.bu.generatedAt === all.pac.generatedAt);

console.log('\nA warm cache costs no register read at all');
reads = 0;
const again = getPublicDashboards();
ok('no read on a cache hit', reads === 0, reads + ' reads');
ok('same figures served', JSON.stringify(again.wcc.kpi) === JSON.stringify(all.wcc.kpi));

reads = 0;
const one = getDashboard('bu');
ok('single-tab refresh also hits the cache', reads === 0, reads + ' reads');
ok('single-tab refresh returns that tab', one && one.scope === 'bu' || !!(one && one.occupancy),
   JSON.stringify(Object.keys(one || {})).slice(0, 80));

console.log('\nThe boot payload inlined by doGet');
const boot = JSON.parse(bootData_());
ok('warm cache yields all three inlined', Object.keys(boot).sort().join(',') === 'bu,pac,wcc',
   Object.keys(boot).join(','));
ok('no raw angle bracket can close the script element', bootData_().indexOf('<') < 0);
ok('no raw ampersand either', bootData_().indexOf('&') < 0);

reads = 0;
clearCaches();
const cold = JSON.parse(bootData_());
ok('a cold cache inlines nothing rather than blocking', Object.keys(cold).length === 0);
ok('and reads no register to find that out', reads === 0, reads + ' reads');

console.log('\nThe public payload carries no identifiable data');
clearCaches();
const pub = JSON.stringify(getPublicDashboards());
const register = require('./gas_stub.js').REGISTER;
const names = register.map(r => String(r[2] || '')).filter(n => n.length > 6);
const ics = register.map(r => String(r[4] || '')).filter(n => n.length > 6);
const leakedName = names.find(n => pub.indexOf(n) >= 0);
const leakedIc = ics.find(n => pub.indexOf(n) >= 0);
ok('no patient name in any public payload', !leakedName, leakedName);
ok('no IC number in any public payload', !leakedIc, leakedIc);
ok('no MRN either', !register.map(r => String(r[5] || '')).filter(x => x.length > 4)
   .some(m => pub.indexOf(m) >= 0));

console.log('\nThe cache-warming trigger');
clearCaches();
const msg = installWarmTrigger();
const trs = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'warmCache');
ok('exactly one warming trigger installed', trs.length === 1, trs.length + ' triggers');
ok('it runs more often than the cache expires', trs[0]._every * 60 < CACHE_SECS,
   trs[0]._every + ' min vs ' + CACHE_SECS + ' s');
ok('installing it primes the cache', Object.keys(JSON.parse(bootData_())).length === 3);
installWarmTrigger();
ok('installing twice does not duplicate the trigger',
   ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'warmCache').length === 1);
ok('removeWarmTrigger takes it away again', removeWarmTrigger().indexOf('removed 1') === 0);
ok('install reports what it did', /every 10 minutes/.test(msg), msg);

console.log('\nMode and scope are validated, not trusted');
ok('an unknown tab falls back to wcc', bootScope_('../admin') === 'wcc');
ok('admin is a legitimate boot scope', bootScope_('admin') === 'admin');
ok('an unknown mode is dropped', bootMode_('<script>') === '');
ok('tv mode is accepted', bootMode_('tv') === 'tv');
ok('the admin tab is never served without a token',
   getDashboard('admin').error === 'ADMIN_REQUIRES_TOKEN');

// -- The single-file bundle is what actually gets pasted ---------------
// Exercised end to end: the page the bundled doGet returns must carry the
// substituted boot values, with the figures already inside it.
console.log('\nThe single-file bundle serves a page with its figures already in it');
(function () {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'dist', 'Code.gs');
  if (!fs.existsSync(file)) { ok('dist/Code.gs exists (run node build/bundle.js)', false); return; }

  let served = null;
  global.HtmlService = {
    createHtmlOutput: html => {
      served = html;
      const chain = { setTitle: () => chain, addMetaTag: () => chain, setXFrameOptionsMode: () => chain };
      return chain;
    },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
  };
  global.SpreadsheetApp = { getActiveSpreadsheet: () => null, getUi: () => null };

  // The bundle redeclares the whole server layer, so give it its own scope and
  // feed it the same fixture register.
  const sandbox = { module: { exports: {} } };
  const src = fs.readFileSync(file, 'utf8');
  try {
    (0, eval)('(function(){' + src +
      '\nreadRegister_ = global.readRegister_;' +
      '\nglobal.__BUNDLE__ = { doGet: doGet, warm: warmCache, clear: clearCaches };' +
      '})()');
  } catch (err) {
    ok('the bundle parses and loads', false, err.message);
    return;
  }
  ok('the bundle parses and loads', !!global.__BUNDLE__);

  global.__BUNDLE__.clear();
  global.__BUNDLE__.warm();
  global.__BUNDLE__.doGet({ parameter: { tab: 'bu', mode: 'tv' } });
  ok('the bundled doGet returned a page', !!served && served.length > 100000,
     served ? served.length + ' chars' : 'nothing');
  ok('no placeholder left unsubstituted', served.indexOf('__BOOT_') < 0);
  ok('the requested tab is the boot scope', /window\.BOOT_SCOPE = 'bu'/.test(served));
  ok('wall-display mode came through', /window\.BOOT_MODE = 'tv'/.test(served));

  const m = served.match(/window\.BOOT_DATA = (\{[\s\S]*?\});\n/);
  ok('the page carries an inlined BOOT_DATA object', !!m);
  if (m) {
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch (e) { /* reported below */ }
    ok('BOOT_DATA is valid JSON in the served page', !!parsed);
    ok('and holds all three public tabs',
       parsed && Object.keys(parsed).sort().join(',') === 'bu,pac,wcc',
       parsed ? Object.keys(parsed).join(',') : '');
    ok('with real occupancy figures in it',
       parsed && parsed.bu && parsed.bu.occupancy && parsed.bu.occupancy.length > 0);
  }

  global.__BUNDLE__.clear();
  served = null;
  global.__BUNDLE__.doGet({ parameter: {} });
  ok('a cold cache still serves the page, just without figures',
     !!served && /window\.BOOT_DATA = \{\}/.test(served));
  ok('and defaults to the first public tab', /window\.BOOT_SCOPE = 'wcc'/.test(served));
})();

console.log(fails ? '\n' + fails + ' server gate(s) FAILED\n' : '\nServer data path: one read per refresh, warm cache, nothing identifiable leaked.\n');
process.exit(fails ? 1 : 0);
