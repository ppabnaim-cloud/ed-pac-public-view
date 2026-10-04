/**
 * Bundles the whole project into one pasteable Apps Script file.
 *
 * The multi-file layout is the maintainable one; this exists so the script can
 * also be deployed by replacing a single Code.gs, with no new files to create
 * in the editor. Run: node build/bundle.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'Code.gs');

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── 1. Inline the page ───────────────────────────────────────
let page = read('Index.html');
page = page.replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (_, name) => read(name + '.html'));

// The template tag for the boot scope is substituted by doGet at runtime.
page = page.replace(/<\?=\s*bootScope\s*\?>/g, '__BOOT_SCOPE__');
page = page.replace(/<\?=\s*bootMode\s*\?>/g, '__BOOT_MODE__');
page = page.replace(/<\?=\s*bootSearch\s*\?>/g, '__BOOT_SEARCH__');
page = page.replace(/<\?!=\s*bootPosters\s*\?>/g, '__BOOT_POSTERS__');
page = page.replace(/<\?!=\s*bootData\s*\?>/g, '__BOOT_DATA__');

if (/<\?/.test(page)) {
  throw new Error('Unresolved Apps Script template tag left in the page:\n' +
    page.match(/<\?[^>]{0,60}/g).join('\n'));
}

// Escape for a JavaScript template literal.
const escaped = page
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

// ── 2. Server files ──────────────────────────────────────────
// The poster manifest becomes a constant in the bundle, so the gallery needs
// no round trip and no file the script cannot read.
const manifest = JSON.parse(read('web/rakyat/manifest.json'));
delete manifest._comment;
let code = read('Code.gs').replace(
  /var RAKYAT_MANIFEST = \{ baseUrl: '', items: \[\] \};/,
  () => 'var RAKYAT_MANIFEST = ' + JSON.stringify(manifest) + ';');
if (code.indexOf('var RAKYAT_MANIFEST = {"') < 0) {
  throw new Error('the poster manifest was not substituted into Code.gs');
}

// Replace the multi-file doGet and drop the include() helper.
const oldDoGet = code.slice(code.indexOf('function doGet(e) {'), code.indexOf('function prop_(key) {'));
if (!oldDoGet.includes('createTemplateFromFile')) {
  throw new Error('doGet did not look as expected; bundler needs updating');
}
const newDoGet = `function doGet(e) {
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
    .setTitle('Status Pesakit \\u2014 Jabatan Kecemasan & PAC | HTPN Kajang')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

`;
code = code.replace(oldDoGet, () => newDoGet);

let setup = read('SetupSheet.gs');
// Make the destructive menu entries impossible to misread.
setup = setup
  .replace(".addItem('1. Build sheet structure', 'setupRegister')",
           ".addItem('\\u26A0 Rebuild sheet structure (CLEARS Sheet1)', 'setupRegister')")
  .replace(".addItem('2. Generate full-capacity scenario', 'generateFullScenario')",
           ".addItem('\\u26A0 Generate demo scenario (REPLACES all data)', 'generateFullScenario')")
  .replace(".addItem('Clear data rows', 'clearRegisterData')",
           ".addItem('\\u26A0 Clear data rows', 'clearRegisterData')");

const illustrations = read('Illustrations.gs');

const banner = `/**
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
 * Built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
 * ============================================================================
 */

`;

const pageConst = `
// ── THE PAGE ────────────────────────────────────────────────
// The full interface: styles, chart library, bilingual strings and app logic.
// Generated — see the header.
var PAGE_HTML = \`${escaped}\`;
`;

const out = [
  banner,
  code,
  '\n\n// ============================================================\n' +
  '//  REGISTER BUILDER\n' +
  '// ============================================================\n',
  setup,
  '\n\n// ============================================================\n' +
  '//  ILLUSTRATIONS\n' +
  '// ============================================================\n',
  illustrations,
  pageConst
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log('dist/Code.gs written');
console.log('  server + builder + illustrations : ' + kb(code.length + setup.length + illustrations.length));
console.log('  inlined page                     : ' + kb(escaped.length));
console.log('  total                            : ' + kb(out.length) +
            '  (' + out.split('\n').length.toLocaleString() + ' lines)');
