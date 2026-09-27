// Inlines the Apps Script includes into one standalone file, with mock data,
// so the layout can be tested in a real browser.
const fs = require('fs');
const R = require('path').join(__dirname, '..') + '/';
let html = fs.readFileSync(R + 'Index.html', 'utf8');
html = html.replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (_, name) => fs.readFileSync(R + name + '.html', 'utf8'));
html = html.replace(/<\?=\s*bootScope\s*\?>/g, 'wcc');
const payloads = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'fixtures', 'payloads.json'), 'utf8'));
const mock = `
<script>
window.__MOCK__ = {
  getDashboard: function (scope) { return window.__PAYLOADS__[scope]; },
  getAdminDashboard: function () { return window.__PAYLOADS__.admin; },
  verifyAdmin: function () { return { ok: true, token: 'test-token', via: 'passcode' }; },
  getPatientStatus: function () {
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
html = html.replace('<script>window.BOOT_SCOPE', mock + '\n<script>window.BOOT_SCOPE');
fs.writeFileSync(require('path').join(__dirname, 'dashboard_test.html'), html);
console.log('dashboard_test.html written,', html.length, 'bytes');
