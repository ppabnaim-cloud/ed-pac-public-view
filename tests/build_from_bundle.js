/**
 * Builds the test page from the page inlined in dist/Code.gs, rather than from
 * the source files, so the layout gates run against what actually ships.
 */
const fs = require('fs');
const path = require('path');
let html = fs.readFileSync(path.join(__dirname, '..', 'build', 'extracted-page.html'), 'utf8');
html = html.replace(/__BOOT_SCOPE__/g, 'wcc');
const payloads = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'payloads.json'), 'utf8'));
const mock = `
<script>
window.__BRIDGE__ = {
  getDashboard: function (scope) { return window.__PAYLOADS__[scope]; },
  getAdminDashboard: function () { return window.__PAYLOADS__.admin; },
  verifyAdmin: function () { return { ok: true, token: 't', via: 'passcode' }; },
  getIllustrations: function () { return { items: [], source: 'none' }; },
  getPatientStatus: function () {
    return { results: [{
      nameDisplay: 'N. Ibrahim', icMasked: '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022-\\u2022\\u2022-2527',
      mrnMasked: 'MRN\\u2022\\u2022\\u2022790', location: 'ED WCC', zone: 'yz', status: 'preadmit',
      isCrisisBed: true, isWaiting: false, referredTo: 'Orthopedic', queueNo: '',
      triage: '05/03 08:12', calledGZ: '', preadmit: '05/03 12:39', admitted: '',
      elapsed: '6:48', bwt: '', twt: '' }], refTime: '05/03/2025 15:00', isSnapshot: true };
  }
};
window.__PAYLOADS__ = ${JSON.stringify(payloads)};
</script>`;
html = html.replace('<script>window.BOOT_SCOPE', mock + '\n<script>window.BOOT_SCOPE');
fs.writeFileSync(path.join(__dirname, 'dashboard_test.html'), html);
console.log('dashboard_test.html built from dist/Code.gs,', html.length, 'bytes');
