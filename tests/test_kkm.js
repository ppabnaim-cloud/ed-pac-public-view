/**
 * The KKM InfoSihat gallery.
 *
 * Posters are self-hosted, not linked to moh.gov.my, so this proves the whole
 * path: a file dropped in web/kkm/ with an entry in the manifest becomes a
 * page at /sihat and a link on the landing page, grouped under the right
 * Peranan — and with no posters, neither the page nor the link exists.
 *
 * The manifest and the folder are restored whatever happens.
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findChromium } = require('./chromium');
const { start } = require('./serve_web.js');

const ROOT = path.join(__dirname, '..');
const KKM = path.join(ROOT, 'web', 'kkm');
const MANIFEST = path.join(KKM, 'manifest.json');
const FIXTURE = path.join(__dirname, 'fixtures', 'kkm', 'sample-poster.svg');
const PLANTED = path.join(KKM, '__test-poster.svg');

const fails = [];
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  fails.push(name + (detail ? '  — ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? '  — ' + detail : ''));
}
const build = () => execFileSync('node', [path.join(ROOT, 'build', 'web.js')], { cwd: ROOT });

(async () => {
  const original = fs.readFileSync(MANIFEST, 'utf8');
  let browser = null, srv = null;

  try {
    // ── With no posters ──────────────────────────────────────────
    console.log('\nWith no posters added');
    build();
    ok('no gallery page is generated', !fs.existsSync(path.join(ROOT, 'web', 'sihat.html')));
    ok('and the landing page does not link to one',
       fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8').indexOf('/sihat') < 0);

    // ── A missing file must stop the build, not ship a broken page ─
    console.log('\nThe manifest is checked, not trusted');
    fs.writeFileSync(MANIFEST, JSON.stringify({
      source: 'https://infosihat.moh.gov.my/penerbitan-multimedia/poster.html',
      publisher: { ms: 'Bahagian Pendidikan Kesihatan, KKM', en: 'Health Education Division, MOH' },
      items: [{ file: 'does-not-exist.jpg', title: { ms: 'Hantu' }, role: 2 }]
    }, null, 2));
    let threw = '';
    try { build(); } catch (e) { threw = String(e.stderr || e.message); }
    ok('a listed file that is not there fails the build',
       /not in web\/kkm/.test(threw), threw.split('\n').find(l => /Error/.test(l)) || '(no error)');

    // ── With a poster ────────────────────────────────────────────
    console.log('\nWith a poster added');
    fs.copyFileSync(FIXTURE, PLANTED);
    fs.writeFileSync(MANIFEST, JSON.stringify({
      source: 'https://infosihat.moh.gov.my/penerbitan-multimedia/poster.html',
      retrieved: '2026-10-02',
      publisher: { ms: 'Bahagian Pendidikan Kesihatan, KKM', en: 'Health Education Division, MOH' },
      items: [{
        file: '__test-poster.svg',
        title: { ms: 'Kurangkan Gula', en: 'Cut Down on Sugar' },
        role: 2,
        sourceUrl: 'https://infosihat.moh.gov.my/poster/gula.html'
      }]
    }, null, 2));
    build();
    ok('the gallery page is generated', fs.existsSync(path.join(ROOT, 'web', 'sihat.html')));

    srv = await start();
    browser = await chromium.launch({ executablePath: findChromium() });

    const g = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    g.on('pageerror', e => fails.push('sihat pageerror: ' + e.message));
    await g.goto('http://127.0.0.1:' + srv.port + '/sihat');
    await g.waitForTimeout(400);
    const r = await g.evaluate(() => ({
      cards: document.querySelectorAll('figure.card').length,
      group: (document.querySelector('.group h3') || {}).textContent || '',
      title: (document.querySelector('figcaption b') || {}).textContent || '',
      en: (document.querySelector('figcaption .en') || {}).textContent || '',
      imgSrc: (document.querySelector('figure.card img') || {}).getAttribute
        ? document.querySelector('figure.card img').getAttribute('src') : '',
      imgLoaded: (() => { const i = document.querySelector('figure.card img'); return !!(i && i.naturalWidth > 0); })(),
      credit: (document.querySelector('.credit') || {}).textContent || '',
      external: [...document.querySelectorAll('img, script[src], link[rel="stylesheet"]')]
        .map(e => e.getAttribute('src') || e.getAttribute('href'))
        .filter(u => u && /^https?:/.test(u) && !/fonts\.googleapis|fonts\.gstatic/.test(u)),
      back: (document.querySelector('.back') || {}).getAttribute('href')
    }));
    ok('the poster is on the page', r.cards === 1, r.cards + ' cards');
    ok('grouped under its Peranan', /Peranan 2/.test(r.group), r.group);
    ok('the Malay title is shown', r.title === 'Kurangkan Gula', r.title);
    ok('the English title too', r.en === 'Cut Down on Sugar', r.en);
    ok('the image is served from this site', r.imgSrc.indexOf('kkm/') === 0, r.imgSrc);
    ok('and it actually loads', r.imgLoaded);
    ok('the publisher is credited', /Bahagian Pendidikan Kesihatan/.test(r.credit));
    ok('the source is named with the retrieval date', /2026-10-02/.test(r.credit), r.credit.slice(0, 90));
    ok('no poster is fetched from an external host', r.external.length === 0, r.external.join(', '));
    ok('there is a way back to the status board', r.back === '/', r.back);
    await g.close();

    const l = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await l.goto('http://127.0.0.1:' + srv.port + '/');
    await l.waitForSelector('.unit', { timeout: 5000 }).catch(() => {});
    const link = await l.evaluate(() => {
      const a = [...document.querySelectorAll('a.tool')].find(x => x.getAttribute('href') === '/sihat');
      return a ? { text: a.querySelector('h4').textContent, go: a.querySelector('.tool-go').textContent } : null;
    });
    ok('the landing page now links to it', !!link && link.text.length > 4, JSON.stringify(link));
    ok('in the reader\'s language', !!link && /KKM|MOH/.test(link.text), link && link.text);
    await l.close();

  } finally {
    if (browser) await browser.close();
    if (srv) srv.server.close();
    fs.writeFileSync(MANIFEST, original);
    if (fs.existsSync(PLANTED)) fs.unlinkSync(PLANTED);
    const page = path.join(ROOT, 'web', 'sihat.html');
    if (fs.existsSync(page)) fs.unlinkSync(page);
    build();
  }

  console.log('\nRestored: manifest empty, no gallery page, no dead link.');
  if (fails.length) {
    console.log('\n' + fails.length + ' KKM gate(s) FAILED:');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('KKM posters are self-hosted, grouped by role, and absent cleanly when none exist.\n');
})();
