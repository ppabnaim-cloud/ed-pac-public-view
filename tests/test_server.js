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

console.log('\nPatient search is off, and nothing reaches a record while it is');
ok('search refuses by default', getPatientStatus('830702-07-2527').error === 'SEARCH_DISABLED');
ok('it refuses a name query too', getPatientStatus('Nurul Ibrahim').error === 'SEARCH_DISABLED');
ok('and a blank one', getPatientStatus('').error === 'SEARCH_DISABLED');
ok('the page is told search is off', searchEnabled_() === false);

global.__PROPS__.PUBLIC_SEARCH = 'on';
const live = getPatientStatus('830702-07-2527');
ok('one property restores it, so the implementation is intact',
   !!live && (live.results || live.error === 'NOT_FOUND' || live.error === 'MIN_CHARS'),
   JSON.stringify(live).slice(0, 90));
if (live && live.results && live.results[0]) {
  const r = live.results[0];
  ok('and it still masks the IC when on', /[\u2022*]/.test(String(r.icMasked || '')), r.icMasked);
  ok('and never returns a full name', !/\d{6}-\d{2}-\d{4}/.test(JSON.stringify(r)));
}
delete global.__PROPS__.PUBLIC_SEARCH;
ok('removing the property switches it off again',
   getPatientStatus('830702-07-2527').error === 'SEARCH_DISABLED');

console.log('\nThe JSON API carries aggregates and nothing else');
clearCaches();
const res = apiStatus_();
ok('served as JSON', res.getMimeType() === 'application/json', String(res.getMimeType()));
let api = null;
try { api = JSON.parse(res.getContent()); } catch (e) { /* reported next */ }
ok('the body parses', !!api && api.ok === true);
ok('it holds all three units',
   api && Object.keys(api.units).sort().join(',') === 'bu,pac,wcc',
   api ? Object.keys(api.units || {}).join(',') : '');
ok('it reports that search is off', api && api.search === false);
ok('it carries a generation stamp', !!(api && api.generatedAt));

const body = res.getContent();
const reg = require('./gas_stub.js').REGISTER;
const leakName = reg.map(r => String(r[2] || '')).filter(n => n.length > 6).find(n => body.indexOf(n) >= 0);
const leakIc = reg.map(r => String(r[4] || '')).filter(n => n.length > 6).find(n => body.indexOf(n) >= 0);
const leakMrn = reg.map(r => String(r[5] || '')).filter(n => n.length > 4).find(n => body.indexOf(n) >= 0);
ok('no patient name in the API body', !leakName, leakName);
ok('no IC number in the API body', !leakIc, leakIc);
ok('no MRN in the API body', !leakMrn, leakMrn);

global.__PROPS__.API_TOKEN = 's3cret';
ok('with API_TOKEN set, a call without the key is refused',
   JSON.parse(apiStatus_().getContent()).error === 'UNAUTHORISED');
ok('a wrong key is refused',
   JSON.parse(apiStatus_('nope').getContent()).error === 'UNAUTHORISED');
ok('the right key is served', JSON.parse(apiStatus_('s3cret').getContent()).ok === true);
delete global.__PROPS__.API_TOKEN;
ok('unset again, the endpoint is open', JSON.parse(apiStatus_().getContent()).ok === true);

console.log('\nrepairSetup: one run that fixes what it can and names what it cannot');
clearCaches();
removeWarmTrigger();
global.__WEBAPP_URL__ = 'https://script.google.com/macros/s/AKfycbTEST/exec';
const rep = repairSetup();
ok('it reports the register', /Register readable/.test(rep));
ok('it primes the cache', /Cache primed: 3 public payloads/.test(rep), (rep.match(/Cache primed.*/) || [''])[0]);
ok('and the cache really is primed afterwards',
   Object.keys(JSON.parse(bootData_())).length === 3);
ok('it installs the warming trigger',
   ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'warmCache').length === 1);
ok('it prints the web app URL', rep.indexOf(global.__WEBAPP_URL__) >= 0);
ok('and the two forms built from it', /\?mode=tv/.test(rep) && /\?api=status/.test(rep));
ok('it confirms patient search is off', /Patient search is off/.test(rep));

const rerun = repairSetup();
ok('running it twice does not duplicate the trigger',
   ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'warmCache').length === 1);
ok('and says so', /reinstalled/.test(rerun));

global.__PROPS__.PUBLIC_SEARCH = 'on';
ok('it warns when patient search has been switched back on',
   /Patient search is ON/.test(repairSetup()));
delete global.__PROPS__.PUBLIC_SEARCH;

global.__WEBAPP_URL__ = null;
const undeployed = repairSetup();
ok('with no deployment it says so instead of printing nothing',
   /no active web app deployment/.test(undeployed));
ok('and gives the exact menu path',
   /Deploy > New deployment/.test(undeployed) && /Who has access:  Anyone/.test(undeployed));

global.__WEBAPP_URL__ = 'https://script.google.com/macros/u/1/s/AKfycbTEST/exec';
ok('it flags a /u/N/ URL, which resolves for nobody else',
   /contains \/u\/N\//.test(repairSetup()));

// A Workspace account deploys to a domain-scoped address. Reconstructing it as
// the personal-account form is what produced the Drive "Page not found" page.
global.__WEBAPP_URL__ = 'https://script.google.com/a/macros/moh.gov.my/s/AKfycbTEST/exec';
const ws = repairSetup();
ok('a Workspace deployment is recognised', /Workspace deployment on moh\.gov\.my/.test(ws));
ok('and the domain segment is spelled out', /\/a\/macros\/moh\.gov\.my\//.test(ws));
ok('with the personal-account form named as the wrong one',
   /personal-account/.test(ws));
ok('and external sharing flagged', /external sharing/.test(ws));
ok('the printed links keep the domain segment',
   ws.indexOf('https://script.google.com/a/macros/moh.gov.my/s/AKfycbTEST/exec?mode=tv') >= 0);
global.__WEBAPP_URL__ = null;
removeWarmTrigger();

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

console.log('\nThe administrative session no longer locks itself out');
// Session.getTemporaryActiveUserKey() ROTATES. Binding the token to it meant a
// session issued under one value stopped validating under the next, which is
// what left the Administrative tab loading for ever with the right passcode.
let rotations = 0;
global.Session.getTemporaryActiveUserKey = () => 'key-' + (++rotations);
global.__PROPS__.ADMIN_PASSCODE = 'test-code';

const v = verifyAdmin('test-code');
ok('the passcode is accepted', v && v.ok === true, JSON.stringify(v).slice(0, 70));
ok('a token is issued', !!(v && v.token));
ok('the token still validates after the temporary key rotates',
   checkAdminToken_(v.token), 'rotations=' + rotations);
ok('and again, several rotations later',
   checkAdminToken_(v.token) && checkAdminToken_(v.token) && checkAdminToken_(v.token));
const admin = getAdminDashboard(v.token);
ok('so the administrative payload is served', !admin.error, admin.error || 'ok');
ok('it carries the unit breakdown', !!(admin.units && admin.units.length === 3));
ok('a made-up token is still refused', getAdminDashboard('not-a-token').error === 'UNAUTHORISED');
ok('and an empty one', getAdminDashboard('').error === 'UNAUTHORISED');

const t0 = new Date().getTime();
const again2 = getAdminDashboard(v.token);
ok('a second look is served from the cache', !again2.error && (new Date().getTime() - t0) < 50,
   (new Date().getTime() - t0) + ' ms');
ok('clearCaches drops the administrative payload too',
   clearCaches() === 'cleared' && !global.__CACHE__['dash_v3_admin']);
delete global.__PROPS__.ADMIN_PASSCODE;

// -- A brand-new deployment, before anything is configured -------------
// The failure that cost the most time was a deployment that did not exist.
// These prove that once one does, nothing else has to be set up first: no
// script properties, a cold cache, and ScriptApp not yet authorised.
console.log('\nA fresh deployment serves the page before anything is configured');
(function () {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'dist', 'Code.gs');
  if (!fs.existsSync(file)) { ok('dist/Code.gs exists', false); return; }

  let served = null;
  global.HtmlService = {
    createHtmlOutput: html => { served = html;
      const c = { setTitle: () => c, addMetaTag: () => c, setXFrameOptionsMode: () => c }; return c; },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
  };
  const savedScriptApp = global.ScriptApp;
  delete global.ScriptApp;                       // scopes not yet authorised

  try {
    (0, eval)('(function(){' + fs.readFileSync(file, 'utf8') +
      '\nreadRegister_ = global.readRegister_;' +
      '\nglobal.__FRESH__ = { doGet, clearCaches, checkSetup, installWarmTrigger, repairSetup };})()');
  } catch (err) {
    ok('the bundle loads without ScriptApp', false, err.message);
    global.ScriptApp = savedScriptApp;
    return;
  }
  ok('the bundle loads without ScriptApp', !!global.__FRESH__);

  for (const k of Object.keys(global.__PROPS__)) delete global.__PROPS__[k];
  global.__FRESH__.clearCaches();

  let threw = null;
  try { global.__FRESH__.doGet({ parameter: {} }); } catch (e) { threw = e.message; }
  ok('doGet serves with no properties and a cold cache', !threw && served && served.length > 100000, threw);
  ok('it does not block on a register read to find the cache empty',
     /window\.BOOT_DATA = \{\}/.test(served || ''));
  ok('patient search is off by default, with nothing configured',
     /BOOT_SEARCH = \'\'/.test(served || ''));

  let api = null;
  try { api = JSON.parse(global.__FRESH__.doGet({ parameter: { api: 'status' } }).getContent()); }
  catch (e) { /* reported next */ }
  ok('the JSON endpoint builds from cold', api && api.ok === true,
     api ? JSON.stringify(api).slice(0, 60) : 'threw');

  global.__FRESH__.doGet({ parameter: {} });
  ok('and that call warms the page for the next visitor',
     /window\.BOOT_DATA = \{"/.test(served || ''));

  ok('checkSetup runs unauthorised', (() => {
    try { global.__FRESH__.checkSetup(); return true; } catch (e) { return false; }
  })());
  ok('installWarmTrigger explains itself rather than throwing',
     /authorise the script first/.test(global.__FRESH__.installWarmTrigger()));

  global.ScriptApp = savedScriptApp;
})();

console.log(fails ? '\n' + fails + ' server gate(s) FAILED\n' : '\nServer data path: one read per refresh, warm cache, nothing identifiable leaked.\n');
process.exit(fails ? 1 : 0);
