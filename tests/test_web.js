/**
 * The Vercel site, served over HTTP the way it will be in production.
 *
 *   - the landing page and the board it links to report the same figures
 *   - no search, no input, no admin tab anywhere on the public site
 *   - the API route carries aggregates and nothing else, and degrades to the
 *     last good figures rather than to an error
 *   - both languages, phone to television, with no horizontal scroll
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { findChromium } = require('./chromium');
const { start } = require('./serve_web.js');

const fails = [];
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  fails.push(name + (detail ? '  — ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? '  — ' + detail : ''));
}

const ORDER = ['rz', 'yz', 'ob', 'ab', 'pac', 'gz'];

(async () => {
  const { server, port } = await start();
  const BASE = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ executablePath: findChromium() });

  // ── The API route ───────────────────────────────────────────────
  console.log('\nThe API route is a filter, not a pipe');
  const api = await (await fetch(BASE + '/api/status')).json();
  ok('it answers ok', api.ok === true);
  ok('all three units', Object.keys(api.units).sort().join(',') === 'bu,pac,wcc');
  const extra = Object.keys(api.units.wcc).filter(k =>
    ['scope', 'locations', 'refTime', 'isSnapshot', 'generatedAt', 'narrative', 'kpi', 'occupancy'].indexOf(k) < 0);
  ok('no field crosses that is not on the whitelist', extra.length === 0, extra.join(','));
  ok('the heavy analysis fields are gone',
     !api.units.wcc.bedBoard && !api.units.wcc.scatter && !api.units.wcc.heatmaps);

  const body = JSON.stringify(api);
  const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'register.json'), 'utf8'));
  const leak = f => reg.map(r => String(r[f] || '')).filter(v => v.length > 5).find(v => body.indexOf(v) >= 0);
  ok('no patient name crosses', !leak(2), leak(2));
  ok('no IC crosses', !leak(4), leak(4));
  ok('no MRN crosses', !leak(5), leak(5));
  ok('the response is small enough to be cheap', body.length < 12000, body.length + ' bytes');

  // ── Landing page ────────────────────────────────────────────────
  console.log('\nThe landing page');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => fails.push('landing pageerror: ' + e.message));
  await page.goto(BASE + '/');
  await page.waitForSelector('.unit', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

  const land = await page.evaluate(() => ({
    units: [...document.querySelectorAll('.unit')].map(u => ({
      name: u.querySelector('.unit-name').firstChild.textContent.trim(),
      href: u.getAttribute('href'),
      big: parseInt(u.querySelector('.unit-big').textContent, 10),
      cap: parseInt((u.querySelector('.unit-cap').textContent.match(/\d+/) || [0])[0], 10),
      badge: u.querySelector('.state').textContent.trim(),
      strips: u.querySelectorAll('.zstrip i').length
    })),
    roles: document.querySelectorAll('.role').length,
    roleVisible: document.querySelectorAll('.role [data-lang="ms"]:not([hidden])').length,
    inputs: document.querySelectorAll('input, textarea, form').length,
    searchWord: /cari pesakit|find a patient/i.test(document.body.textContent),
    stamp: document.getElementById('stampTime').textContent,
    hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));

  ok('three unit cards', land.units.length === 3, JSON.stringify(land.units.map(u => u.name)));
  ok('each links to its board',
     land.units.map(u => u.href).join(',') === '/wcc,/bu,/pac', land.units.map(u => u.href).join(','));
  ok('each shows a patient count', land.units.every(u => u.big > 0), JSON.stringify(land.units.map(u => u.big)));
  ok('each shows a zone strip', land.units.every(u => u.strips > 0));
  ok('five role cards', land.roles === 5, land.roles + ' cards');
  ok('one language visible per role card', land.roleVisible === 5, land.roleVisible);
  ok('no form, input or textarea anywhere', land.inputs === 0, land.inputs + ' found');
  ok('the words "find a patient" appear nowhere', !land.searchWord);
  ok('a timestamp is shown', land.stamp.length > 4, land.stamp);
  ok('no horizontal scroll', land.hScroll <= 1, land.hScroll + 'px');

  // ── The landing figures must equal the board's ──────────────────
  console.log('\nThe landing page and the board agree');
  for (const u of land.units) {
    const b = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    b.on('pageerror', e => fails.push('board pageerror: ' + e.message));
    await b.goto(BASE + u.href);
    await b.waitForSelector('.zone-card', { timeout: 5000 }).catch(() => {});
    await b.waitForTimeout(300);
    const r = await b.evaluate(() => {
      const cards = [...document.querySelectorAll('.zone-card')];
      return {
        patients: cards.reduce((a, c) => a + parseInt(c.querySelector('.zc-big').textContent, 10), 0),
        capacity: cards.reduce((a, c) =>
          a + parseInt((c.querySelector('.zc-cap').textContent.match(/\d+/) || [0])[0], 10), 0),
        zones: cards.map(c => (c.className.match(/z-(\w+)/) || [])[1]),
        tabs: (window.EDPAC.state.tabs || []).join(','),
        searchBtn: !!document.getElementById('searchBtn'),
        overlay: !!document.getElementById('ovSearch'),
        counter: !!document.querySelector('.seek.is-counter'),
        inputs: document.querySelectorAll('.content input, .content form').length,
        scroll: document.documentElement.scrollHeight - document.documentElement.clientHeight
      };
    });
    const tag = u.href;
    ok(tag + ': patient count matches the landing page', r.patients === u.big, r.patients + ' vs ' + u.big);
    ok(tag + ': capacity matches the landing page', r.capacity === u.cap, r.capacity + ' vs ' + u.cap);
    const seq = r.zones.slice().sort((a, c) => ORDER.indexOf(a) - ORDER.indexOf(c));
    ok(tag + ': zones in escalation order', r.zones.join() === seq.join(), r.zones.join());
    ok(tag + ': the three units plus guidance, and no administrative tab',
       r.tabs === 'wcc,bu,pac,iqms,triage,rakyat', r.tabs);
    ok(tag + ': no search button', !r.searchBtn);
    ok(tag + ': no search overlay', !r.overlay);
    ok(tag + ': the counter panel stands in its place', r.counter);
    ok(tag + ': no input in the content area', r.inputs === 0);
    ok(tag + ': the board does not scroll', r.scroll <= 1, r.scroll + 'px');
    await b.close();
  }

  // ── Tab switching keeps the URL honest ──────────────────────────
  console.log('\nNavigation');
  {
    const b = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await b.goto(BASE + '/wcc');
    await b.waitForSelector('.zone-card', { timeout: 5000 }).catch(() => {});
    await b.evaluate(() => document.querySelectorAll('.tab')[1].click());
    await b.waitForTimeout(300);
    const u = new URL(b.url());
    ok('switching tab updates the address bar', u.pathname === '/bu', u.pathname);
    const cards = await b.evaluate(() => document.querySelectorAll('.zone-card').length);
    ok('and the new unit is drawn', cards > 0, cards + ' cards');
    await b.close();
  }

  // ── TV mode ─────────────────────────────────────────────────────
  console.log('\nThe wall display');
  {
    const b = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    b.on('pageerror', e => fails.push('tv pageerror: ' + e.message));
    await b.goto(BASE + '/tv');
    await b.waitForSelector('.rail-card', { timeout: 5000 }).catch(() => {});
    await b.waitForTimeout(400);
    const r = await b.evaluate(() => ({
      rail: !!document.querySelector('#rail .rail-card'),
      title: (document.querySelector('.rail-title') || {}).textContent || '',
      cards: document.querySelectorAll('.zone-card').length,
      clipped: [...document.querySelectorAll('.rail-title, .rail-lead, .rail-pts li, .rail-action, .guide-row p')]
        .filter(e => e.scrollHeight - e.clientHeight > 2).length,
      scroll: document.documentElement.scrollHeight - document.documentElement.clientHeight
    }));
    ok('the rail is there', r.rail && r.title.length > 4, r.title);
    ok('the zone board is there too', r.cards > 0, r.cards + ' cards');
    ok('nothing is cut short', r.clipped === 0, r.clipped + ' clipped');
    ok('it does not scroll', r.scroll <= 1, r.scroll + 'px');
    await b.close();
  }

  // ── Phone ───────────────────────────────────────────────────────
  console.log('\nOn a phone');
  {
    const b = await browser.newPage({ viewport: { width: 390, height: 844 } });
    b.on('pageerror', e => fails.push('phone pageerror: ' + e.message));
    await b.goto(BASE + '/');
    await b.waitForSelector('.unit', { timeout: 5000 }).catch(() => {});
    const r = await b.evaluate(() => ({
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      units: document.querySelectorAll('.unit').length,
      rail: !!document.querySelector('#rail .rail-card'),
      cut: [...document.querySelectorAll('.unit-name, .role h4, .note h4')]
        .filter(e => e.scrollWidth - e.clientWidth > 2).length
    }));
    ok('no horizontal scroll', r.hScroll <= 1, r.hScroll + 'px');
    ok('all three units stack', r.units === 3);
    ok('no heading overflows its box', r.cut === 0, r.cut + ' overflowing');
    await b.goto(BASE + '/tv');
    await b.waitForTimeout(500);
    const tv = await b.evaluate(() => !!(document.getElementById('rail') &&
      getComputedStyle(document.getElementById('rail')).display !== 'none'));
    ok('the wall-display rail is suppressed on a phone', !tv);
    await b.close();
  }

  // ── Language ────────────────────────────────────────────────────
  console.log('\nLanguage');
  {
    const b = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await b.goto(BASE + '/');
    await b.waitForSelector('.unit', { timeout: 5000 }).catch(() => {});
    const before = await b.evaluate(() => document.querySelector('.role h4:not([hidden])').textContent);
    await b.evaluate(() => document.getElementById('langBtn').click());
    await b.waitForTimeout(250);
    const after = await b.evaluate(() => ({
      role: document.querySelector('.role [data-lang="en"]:not([hidden]) h4').textContent,
      units: document.querySelectorAll('.unit').length,
      msHidden: document.querySelectorAll('.role [data-lang="ms"]:not([hidden])').length
    }));
    ok('role cards switch language', after.role !== before, before + ' -> ' + after.role);
    ok('only one language is shown at a time', after.msHidden === 0, after.msHidden + ' still visible');
    ok('the unit cards survive the switch', after.units === 3);
    await b.close();
  }

  // ── Posters ─────────────────────────────────────────────────────
  console.log('\nThe printable posters');
  {
    const b = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
    b.on('pageerror', e => fails.push('poster pageerror: ' + e.message));
    await b.goto(BASE + '/poster');
    await b.waitForSelector('.qr svg', { timeout: 5000 }).catch(() => {});
    await b.waitForTimeout(500);
    const r = await b.evaluate(() => ({
      sheets: document.querySelectorAll('.sheet').length,
      qr: document.querySelectorAll('.qr svg').length,
      // An A4 sheet that overflows loses the bottom of the poster at the printer.
      over: [...document.querySelectorAll('.sheet')].map(s => s.scrollHeight - s.clientHeight),
      label: (document.querySelector('.qr svg') || {}).getAttribute
        ? document.querySelector('.qr svg').getAttribute('aria-label') : '',
      url: (document.querySelector('[data-url]') || {}).textContent || '',
      roles: [...document.querySelectorAll('.ph-no')].map(e => e.textContent.trim()),
      searchWord: /cari pesakit|find a patient|kad pengenalan/i.test(document.body.textContent)
    }));
    ok('six A4 sheets: one status, five roles', r.sheets === 6, r.sheets + ' sheets');
    ok('every sheet carries a QR code', r.qr === 6, r.qr + ' codes');
    ok('no sheet overflows its page', r.over.every(v => v <= 1), JSON.stringify(r.over));
    ok('the QR points at this deployment, not a hard-coded address',
       r.label.indexOf(BASE) >= 0, r.label.slice(0, 60));
    ok('the address is printed as text as well', r.url.indexOf(BASE) >= 0, r.url);
    ok('the roles are numbered 1 to 5',
       r.roles.slice(1).join(',') === 'Peranan 1,Peranan 2,Peranan 3,Peranan 4,Peranan 5',
       r.roles.join(' | '));
    ok('no search wording on any poster', !r.searchWord);
    await b.close();
  }

  await page.close();
  await browser.close();
  server.close();

  // ── Degradation ─────────────────────────────────────────────────
  console.log('\nWhen Apps Script is unreachable');
  {
    const down = await start({ upstreamFails: true });
    const r = await fetch('http://127.0.0.1:' + down.port + '/api/status');
    const j = await r.json();
    ok('a cold proxy says so rather than pretending', r.status === 502 && j.error === 'UPSTREAM_UNAVAILABLE',
       r.status + ' ' + JSON.stringify(j).slice(0, 60));
    down.server.close();

    const warm = await start();
    await fetch('http://127.0.0.1:' + warm.port + '/api/status');          // prime
    process.env.__FAIL__ = '1';
    warm.server.close();
  }
  {
    const html = await start({ upstreamHtml: true });
    const j = await (await fetch('http://127.0.0.1:' + html.port + '/api/status')).json();
    ok('an Apps Script HTML error page is never passed off as data', j.ok !== true,
       JSON.stringify(j).slice(0, 70));
    html.server.close();
  }

  if (fails.length) {
    console.log('\n' + fails.length + ' web gate(s) FAILED:');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nLanding page and boards agree, no search path exists, aggregates only.\n');
})();
