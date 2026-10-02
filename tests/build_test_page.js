// Inlines the Apps Script includes into one standalone file, with mock data,
// so the layout can be tested in a real browser.
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let html = fs.readFileSync(R + 'Index.html', 'utf8');
html = html.replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (_, name) => fs.readFileSync(R + name + '.html', 'utf8'));
html = html.replace(/<\?=\s*bootScope\s*\?>/g, 'wcc');
// The test page is opened as a file:// URL, so it can read its own query
// string; the real page cannot (it runs inside Apps Script's sandbox iframe)
// and has these templated in by doGet instead.
html = html.replace(/'<\?=\s*bootMode\s*\?>'/g,
  "(new URLSearchParams(location.search)).get('mode') || ''");
// Search is off unless ?search=1, mirroring the PUBLIC_SEARCH property.
html = html.replace(/'<\?=\s*bootSearch\s*\?>'/g,
  "((new URLSearchParams(location.search)).get('search') === '1' ? '1' : '')");
// Empty by default: the tests exercise the fetch path, and a dedicated test
// sets window.BOOT_DATA itself to exercise the inlined path.
html = html.replace(/<\?!=\s*bootData\s*\?>/g, '{}');
const payloads = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'fixtures', 'payloads.json'), 'utf8'));
const mock = `
<script>
window.__MOCK__ = {
  getDashboard: function (scope) { return window.__PAYLOADS__[scope]; },
  getPublicDashboards: function () {
    return { wcc: window.__PAYLOADS__.wcc, bu: window.__PAYLOADS__.bu, pac: window.__PAYLOADS__.pac };
  },
  getIllustrations: function () { return { items: [] }; },
  getAdminDashboard: function () { return window.__PAYLOADS__.admin; },
  verifyAdmin: function () { return { ok: true, token: 'test-token', via: 'passcode' }; },
  // Mirrors the server: refuses unless PUBLIC_SEARCH is on.
  getPatientStatus: function () {
    if (new URLSearchParams(location.search).get('search') !== '1') {
      return { error: 'SEARCH_DISABLED' };
    }
    return { results: [{
      nameDisplay: 'N. Ibrahim', icMasked: '••••••-••-2527', mrnMasked: 'MRN•••790',
      location: 'ED WCC', zone: 'yz', status: 'preadmit', isCrisisBed: true, isWaiting: false,
      referredTo: 'Orthopedic', queueNo: '', triage: '05/03 08:12', calledGZ: '',
      preadmit: '05/03 12:39', admitted: '', elapsed: '6:48', bwt: '', twt: ''
    }], refTime: '05/03/2025 15:00', isSnapshot: true };
  }
};
window.__PAYLOADS__ = ${JSON.stringify(payloads)};
</script>`;
html = html.replace('<script>\nwindow.BOOT_SCOPE', mock + '\n<script>\nwindow.BOOT_SCOPE');
if (html.indexOf('__MOCK__') < 0) throw new Error('mock was not injected: boot script anchor changed');
fs.writeFileSync(require('path').join(__dirname, 'dashboard_test.html'), html);
console.log('dashboard_test.html written,', html.length, 'bytes');
