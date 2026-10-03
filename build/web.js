/**
 * Builds the Vercel site from the same sources as the Apps Script app.
 *
 * One set of partials, two targets. The status board, the zone arithmetic,
 * the bilingual strings and the Peranan Rakyat content all have exactly one
 * home; this emits a second front end from them rather than a second copy of
 * them, so the two can never drift apart.
 *
 * Run: node build/web.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/^\s*<script>\n?/, '').replace(/<\/script>\s*$/, '');

// ── 1. Design tokens, from the one stylesheet that defines them ───────────
const styles = read('Styles.html');
const tokens = (styles.match(/:root \{[\s\S]*?\n\}/) || [])[0];
if (!tokens) throw new Error('could not find the :root token block in Styles.html');

// ── 2. The bilingual strings, subset to what the landing page says ───────
// The full dictionary is some 40 KB and carries every administrative label
// and every patient-search string. Shipping it whole to a page with no search
// would put "Cari pesakit" in the markup of a site built not to have it, so
// the page is given exactly the keys it renders and nothing else.
const LANDING_KEYS = [
  'appTitle', 'appSub', 'langFlag', 'langLabel', 'loading', 'updated', 'snapshot',
  'demoTag', 'demoNote', 'errTitle', 'footer', 'credit',
  'landing.*', 'zoneShort.*',
  'tabs.wcc.*', 'tabs.bu.*', 'tabs.pac.*',
  'public.beds', 'public.rooms', 'public.crisisBeds', 'public.state.*',
  'public.klinikTitle', 'public.klinikBody', 'public.klinikMadani',
  'public.counterTitle', 'public.counterSub'
];

const I18N_FULL = (0, eval)(strip(read('I18n.html')) + '; I18N');

function getPath(o, parts) {
  for (let i = 0; i < parts.length && o != null; i++) o = o[parts[i]];
  return o;
}
function setPath(o, parts, v) {
  for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] = o[parts[i]] || {});
  o[parts[parts.length - 1]] = v;
}
function subset(src) {
  const out = {};
  for (const key of LANDING_KEYS) {
    if (key.endsWith('.*')) {
      const base = key.slice(0, -2).split('.');
      const node = getPath(src, base);
      if (node && typeof node === 'object') setPath(out, base, JSON.parse(JSON.stringify(node)));
      continue;
    }
    const parts = key.split('.');
    const v = getPath(src, parts);
    if (v !== undefined) setPath(out, parts, v);
  }
  return out;
}

const i18nSrc = 'var I18N = ' +
  JSON.stringify({ ms: subset(I18N_FULL.ms), en: subset(I18N_FULL.en) }) + ';';

// ── 3. The Peranan Rakyat cards, rendered from the single content source ──
// Banner.html is evaluated rather than parsed, so the cards on the landing
// page are literally the same objects the wall display rotates through.
const bannerSrc = strip(read('Banner.html'));
const Banner = (0, eval)(bannerSrc + '; Banner');
if (!Banner || !Banner.items || !Banner.items.length) throw new Error('Banner.items did not load');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function roleCard(it) {
  // The opening card is the section heading on this page, so it is skipped.
  const langs = ['ms', 'en'].map(lg => {
    const pts = (it.points || []).map(p => '<li>' + esc(p[lg] || p.ms) + '</li>').join('');
    return '<div data-lang="' + lg + '"' + (lg === 'ms' ? '' : ' hidden') + '>' +
      '<h4>' + esc(it.title[lg]) + '</h4>' +
      '<p class="role-lead">' + esc(it.lead[lg]) + '</p>' +
      (pts ? '<ul>' + pts + '</ul>' : '') +
      '<p class="role-act">' + esc(it.action[lg]) + '</p>' +
      '<p class="role-src">' + esc(it.source[lg]) + '</p>' +
    '</div>';
  }).join('');
  return '<article class="role t-' + esc(it.tone) + '">' +
    '<div class="role-top">' +
      '<span class="role-ic" aria-hidden="true">' + esc(it.icon) + '</span>' +
      '<span class="role-no">' + esc(it.no) + '</span>' +
    '</div>' + langs +
  '</article>';
}

const roles = Banner.items.filter(it => it.no).map(roleCard).join('\n');

// ── 4. Landing page ───────────────────────────────────────────────────────
let landing = read('build/templates/landing.html')
  .replace('{{TOKENS}}', () => tokens)
  .replace('{{I18N}}', () => i18nSrc)
  .replace('{{PERANAN}}', () => roles);
// The KKM slot is filled in step 7, once it is known whether any posters
// exist; the placeholder check for the landing page runs after that.

// Nothing to do with search may reach a page built without it -- not a label,
// not a placeholder, not a leftover dictionary entry.
const FORBIDDEN = [/cari pesakit/i, /find a patient/i, /kad pengenalan/i,
                   /\bMRN\b/, /<input/i, /<form/i];
for (const re of FORBIDDEN) {
  if (re.test(landing)) throw new Error('landing page contains ' + re + ' — it must carry no search path');
}

// ── 5. Status board, from the Apps Script page ────────────────────────────
let board = read('Index.html')
  .replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (_, n) => read(n + '.html'));

// The Apps Script boot block is replaced wholesale: here the scope comes from
// the path, the figures come from the site's own API, and search does not
// exist at all.
const bootBlock = board.match(/<script>\s*\nwindow\.BOOT_SCOPE[\s\S]*?<\/script>/);
if (!bootBlock) throw new Error('could not find the boot script block in Index.html');

const webBoot = `<script>
/* Served from a CDN, not from Apps Script. The scope comes from the path, the
   figures from this site's own API route, and patient search is absent: the
   browser is never given a path to an identifiable record. */
(function () {
  var seg = (location.pathname.replace(/\\/+$/, '').split('/').pop() || 'wcc').toLowerCase();
  if (['wcc', 'bu', 'pac', 'iqms', 'tv'].indexOf(seg) < 0) seg = 'wcc';
  window.BOOT_SCOPE  = seg === 'tv' ? 'wcc' : seg;
  window.BOOT_MODE   = seg === 'tv' ? 'tv' : '';
  window.BOOT_SEARCH = '';
  window.BOOT_TABS   = ['wcc', 'bu', 'pac', 'iqms'];
  window.BOOT_DATA   = {};

  // Keep the address bar in step, so a tab can be bookmarked and shared.
  window.ON_TAB_CHANGE = function (tab) {
    if (window.BOOT_MODE === 'tv') return;
    try { history.replaceState(null, '', '/' + tab); } catch (e) {}
  };

  var inflight = null;
  function units() {
    if (inflight) return inflight;
    inflight = fetch('/api/status', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        inflight = null;
        return (d && d.ok && d.units) ? d.units : { error: 'SERVER_ERROR' };
      })
      .catch(function () { inflight = null; return { error: 'SERVER_ERROR' }; });
    return inflight;
  }

  window.__BRIDGE__ = {
    getPublicDashboards: function () { return units(); },
    getDashboard: function (scope) {
      return units().then(function (u) { return u.error ? u : u[scope]; });
    },
    getIllustrations: function () { return { items: [] }; },
    // Present only so a stray call cannot fall through to the live bridge.
    getPatientStatus: function () { return { error: 'SEARCH_DISABLED' }; },
    getAdminDashboard: function () { return { error: 'UNAUTHORISED' }; },
    verifyAdmin: function () { return { ok: false, error: 'UNAVAILABLE' }; }
  };
})();
</script>`;

board = board.replace(bootBlock[0], () => webBoot);
if (/<\?/.test(board)) {
  throw new Error('unresolved Apps Script template tag in the board page: ' +
    board.match(/<\?[^>]{0,60}/g).join(', '));
}

// ── 6. Printable posters ──────────────────────────────────────────────────
// One A4 sheet per role, from the same content objects as the rail and the
// landing page, so a poster on a wall cannot contradict the screen beside it.
const TONE = { move: '#2a78d6', sugar: '#4a3aa7', meds: '#8a3fa8', smoke: '#4a5763', screen: 'var(--brand-dk)' };

function posterSheet(it) {
  const pts = (it.points || []).map(p => '<li>' + esc(p.ms) + '</li>').join('');
  const ptsEn = (it.points || []).map(p => '<li>' + esc(p.en) + '</li>').join('');
  const long = it.title.ms.length > 24;
  return '<section class="sheet" style="--tone: ' + (TONE[it.tone] || 'var(--brand)') + '">' +
    '<div class="ph">' +
      '<div class="ph-id">' +
        '<h2>Peranan Rakyat ke arah Negara Sehat</h2>' +
        '<p>Hospital Tengku Permaisuri Norashikin, Kajang</p>' +
      '</div>' +
      '<span class="ph-no">Peranan ' + esc(it.no) + '</span>' +
    '</div>' +
    '<div class="p-title' + (long ? ' is-small' : '') + '">' + esc(it.title.ms) + '</div>' +
    '<div class="p-sub">' + esc(it.title.en) + '</div>' +
    '<p class="p-lead">' + esc(it.lead.ms) + '</p>' +
    (pts ? '<ul class="p-pts">' + pts + '</ul>' : '') +
    '<div class="p-act">' + esc(it.action.ms) + '</div>' +
    '<div class="p-en">' +
      '<h3>' + esc(it.title.en) + '</h3>' +
      '<p>' + esc(it.lead.en) + '</p>' +
      (ptsEn ? '<ul>' + ptsEn + '</ul>' : '') +
      '<p class="act">' + esc(it.action.en) + '</p>' +
    '</div>' +
    '<div class="p-foot">' +
      '<div class="p-foot-copy">' +
        '<strong>' + esc(it.icon) + ' Peranan ' + esc(it.no) + ' daripada 5</strong>' +
        '<span>Lihat status zon Jabatan Kecemasan dan empat peranan yang lain.<br>' +
          'See live zone status and the other four roles.</span>' +
        '<div class="p-src">' + esc(it.source.ms) + ' &middot; ' + esc(it.source.en) + '</div>' +
      '</div>' +
      '<figure class="qr" data-qr><figcaption>Imbas untuk status zon<br>Scan for zone status</figcaption></figure>' +
    '</div>' +
  '</section>';
}

let poster = read('build/templates/poster.html')
  .replace('{{TOKENS}}', () => tokens)
  .replace('{{POSTERS}}', () => Banner.items.filter(it => it.no).map(posterSheet).join('\n'))
  .replace('{{QRLIB}}', () => read('build/vendor/qrcode-generator.js'));
if (/\{\{\w+\}\}/.test(poster)) {
  throw new Error('unfilled placeholder in the poster: ' + poster.match(/\{\{\w+\}\}/)[0]);
}

// ── 7. KKM InfoSihat gallery, when any posters have been added ────────────
// The files are served from this site rather than linked to moh.gov.my: a
// hospital display should not render a file that can be moved or replaced
// after the hospital has put it on a screen, and the page's connect-src
// policy only holds if nothing is fetched from elsewhere. See web/kkm/README.
const KKM_DIR = path.join(OUT, 'kkm');
const kkm = JSON.parse(fs.readFileSync(path.join(KKM_DIR, 'manifest.json'), 'utf8'));
const kkmItems = Array.isArray(kkm.items) ? kkm.items : [];

for (const it of kkmItems) {
  if (!it.file) throw new Error('a kkm manifest entry has no file');
  const f = path.join(KKM_DIR, it.file);
  if (!fs.existsSync(f)) {
    throw new Error('kkm/manifest.json lists ' + it.file + ', which is not in web/kkm/');
  }
  const mb = fs.statSync(f).size / 1024 / 1024;
  if (mb > 1) {
    console.warn('  ! ' + it.file + ' is ' + mb.toFixed(1) +
      ' MB — resize it; these are read on a phone, not printed');
  }
  if (!it.title || !it.title.ms) throw new Error(it.file + ' has no Malay title');
}

const ROLE_NAMES = {};
for (const it of Banner.items) if (it.no) ROLE_NAMES[it.no] = it.title;

function kkmCard(it) {
  const src = it.sourceUrl || kkm.source;
  return '<figure class="card">' +
    '<a class="shot" href="kkm/' + encodeURIComponent(it.file) + '" target="_blank" rel="noopener">' +
      '<img src="kkm/' + encodeURIComponent(it.file) + '" alt="' + esc(it.title.ms) + '" loading="lazy"/>' +
    '</a>' +
    '<figcaption>' +
      '<b>' + esc(it.title.ms) + '</b>' +
      (it.title.en && it.title.en !== it.title.ms ? '<span class="en">' + esc(it.title.en) + '</span>' : '') +
      '<span class="src">Sumber: <a href="' + esc(src) + '" rel="noopener">InfoSihat, KKM</a></span>' +
    '</figcaption>' +
  '</figure>';
}

let sihatBuilt = false;
if (kkmItems.length) {
  const byRole = new Map();
  for (const it of kkmItems) {
    const k = ROLE_NAMES[String(it.role)] ? String(it.role) : 'other';
    if (!byRole.has(k)) byRole.set(k, []);
    byRole.get(k).push(it);
  }
  const order = ['1', '2', '3', '4', '5', 'other'].filter(k => byRole.has(k));
  const groups = order.map(k => {
    const head = k === 'other'
      ? '<h3>Lain-lain</h3><p>Other health-promotion material</p>'
      : '<h3>Peranan ' + k + ' — ' + esc(ROLE_NAMES[k].ms) + '</h3>' +
        '<p>' + esc(ROLE_NAMES[k].en) + '</p>';
    return '<section class="group">' + head +
      '<div class="grid">' + byRole.get(k).map(kkmCard).join('') + '</div></section>';
  }).join('\n');

  let sihat = read('build/templates/sihat.html')
    .replace('{{TOKENS}}', () => tokens)
    .replace('{{GROUPS}}', () => groups)
    .replace(/\{\{PUBLISHER_MS\}\}/g, () => esc((kkm.publisher && kkm.publisher.ms) || 'Kementerian Kesihatan Malaysia'))
    .replace(/\{\{PUBLISHER_EN\}\}/g, () => esc((kkm.publisher && kkm.publisher.en) || 'Ministry of Health Malaysia'))
    .replace(/\{\{SOURCE\}\}/g, () => esc(kkm.source || '#'))
    .replace('{{RETRIEVED}}', () => kkm.retrieved ? ' pada ' + esc(kkm.retrieved) : '');
  if (/\{\{\w+\}\}/.test(sihat)) {
    throw new Error('unfilled placeholder in the gallery: ' + sihat.match(/\{\{\w+\}\}/)[0]);
  }
  fs.writeFileSync(path.join(OUT, 'sihat.html'), sihat);
  sihatBuilt = true;
} else {
  // No posters yet, so no page and no link to it. An empty gallery behind a
  // link on the front page is worse than no gallery.
  const stale = path.join(OUT, 'sihat.html');
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
}

const toolsExtra = sihatBuilt
  ? '<a class="tool" href="/sihat">' +
      '<span class="note-ic" aria-hidden="true">\ud83d\udccb</span>' +
      '<div>' +
        '<h4 data-k="landing.kkmTitle"></h4>' +
        '<p data-k="landing.kkmBody"></p>' +
        '<div class="tool-go" data-k="landing.kkmLink"></div>' +
      '</div>' +
    '</a>'
  : '';
landing = landing.replace('{{TOOLS_EXTRA}}', () => toolsExtra);
if (/\{\{\w+\}\}/.test(landing)) {
  throw new Error('unfilled placeholder in the landing page: ' + landing.match(/\{\{\w+\}\}/)[0]);
}

// ── 8. Write ──────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), landing);
fs.writeFileSync(path.join(OUT, 'board.html'), board);
fs.writeFileSync(path.join(OUT, 'poster.html'), poster);

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log('web/ built');
console.log('  index.html  (landing)      : ' + kb(landing.length) + '  ' + Banner.items.filter(i => i.no).length + ' role cards');
console.log('  board.html  (wcc/bu/pac/tv): ' + kb(board.length));
console.log('  poster.html (A4 x ' + (Banner.items.filter(i => i.no).length + 1) + ')      : ' + kb(poster.length));
console.log('  kkm posters                : ' + (kkmItems.length
  ? kkmItems.length + ' -> sihat.html' : 'none yet (web/kkm/README.md says how to add them)'));
