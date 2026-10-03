/**
 * Verifies the single-file bundle: that it parses, that the functions the page
 * calls are all present, and that the page inlined inside it is byte-identical
 * to the one the multi-file build produces.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const bundle = fs.readFileSync(path.join(ROOT, 'dist', 'Code.gs'), 'utf8');
let failures = [];

// 0. The whole file must parse. The checks below look at pieces of it, and a
// bundler fault can corrupt the join between them without disturbing either
// side -- as happened once, when a dollar sign followed by a quote inside the
// generated doGet was read as a back-reference by String.replace and pasted a
// copy of the rest of the file into the middle of a comment. The bundle still
// contained every function the other checks look for.
try {
  new Function(bundle);
} catch (err) {
  console.error('✗ dist/Code.gs does not parse: ' + err.message);
  process.exit(1);
}

// 1. Extract the inlined page by evaluating just the PAGE_HTML assignment.
const m = bundle.match(/var PAGE_HTML = `([\s\S]*)`;\s*$/);
if (!m) { console.error('✗ PAGE_HTML not found or not last in the file'); process.exit(1); }
let page;
try {
  page = (0, eval)('`' + m[1] + '`');
} catch (err) {
  console.error('✗ PAGE_HTML is not a valid template literal: ' + err.message);
  process.exit(1);
}

// 2. Compare against the page the multi-file build produces.
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let expected = read('Index.html')
  .replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (_, n) => read(n + '.html'))
  .replace(/<\?=\s*bootScope\s*\?>/g, '__BOOT_SCOPE__')
  .replace(/<\?=\s*bootMode\s*\?>/g, '__BOOT_MODE__')
  .replace(/<\?=\s*bootSearch\s*\?>/g, '__BOOT_SEARCH__')
  .replace(/<\?!=\s*bootData\s*\?>/g, '__BOOT_DATA__');
if (page !== expected) {
  failures.push('inlined page differs from the multi-file page (' +
    page.length + ' vs ' + expected.length + ' chars)');
}

// 3. No unresolved Apps Script template tags anywhere.
if (/<\?/.test(page)) failures.push('unresolved <? ?> template tag in the page');

// 4. The page must contain each part exactly once.
[['<style>', 1], ['var I18N', 1], ['var Charts', 1], ['var Banner', 1],
 ['window.EDPAC', 1], ['__BOOT_SCOPE__', 1], ['__BOOT_MODE__', 1], ['__BOOT_SEARCH__', 1],
 ['__BOOT_DATA__', 1]].forEach(([needle, want]) => {
  const got = page.split(needle).length - 1;
  if (got !== want) failures.push(`page contains "${needle}" ${got} times, expected ${want}`);
});

// 5. Every server function the page calls must exist in the bundle.
['getDashboard', 'getPublicDashboards', 'getAdminDashboard', 'getPatientStatus',
 'verifyAdmin', 'getIllustrations', 'doGet', 'bootScope_', 'bootMode_', 'bootData_',
 'jsonForScript_', 'searchEnabled_', 'apiStatus_', 'repairSetup', 'setupRegister', 'generateFullScenario', 'clearCaches',
 'warmCache', 'installWarmTrigger', 'removeWarmTrigger', 'onOpen'].forEach(fn => {
  if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(bundle)) {
    failures.push('missing function: ' + fn);
  }
});

// 6. Nothing may still reference the multi-file loader.
if (/createTemplateFromFile|createHtmlOutputFromFile/.test(bundle)) {
  failures.push('bundle still loads files from disk (createTemplateFromFile / createHtmlOutputFromFile)');
}

// 7. The establishment must appear once, not duplicated between files.
const estCount = (bundle.match(/^var ESTABLISHMENT = \[/gm) || []).length;
if (estCount !== 1) failures.push(`ESTABLISHMENT declared ${estCount} times, expected 1`);

if (failures.length) {
  console.error('BUNDLE VERIFICATION FAILED:');
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}

fs.writeFileSync(path.join(__dirname, 'extracted-page.html'), page);
console.log('✓ page extracted from the bundle is identical to the multi-file build');
console.log('✓ bundle parses; all entry-point functions present, establishment declared once');
console.log('  page: ' + (page.length / 1024).toFixed(1) + ' KB');
