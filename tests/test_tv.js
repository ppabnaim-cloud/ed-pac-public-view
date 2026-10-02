/**
 * Wall-display mode (?mode=tv) and the boot path.
 *
 *   - the health-promotion rail appears beside the zone board on a TV,
 *     is absent from the ordinary view, and is absent on a phone
 *   - the zone board keeps its whole width budget: cards still read on one
 *     row in escalation order with the rail taking its column
 *   - no rail card overflows its box, in either language, on any card
 *   - the rail rotates, and follows the language toggle
 *   - figures inlined by doGet are on screen with no server call at all
 */
const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');

const PAGE = 'file://' + path.join(__dirname, 'dashboard_test.html');
const ORDER = ['rz', 'yz', 'ob', 'ab', 'pac', 'gz'];

const fails = [];
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  fails.push(name + (detail ? '  — ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? '  — ' + detail : ''));
}

function railProbe() {
  const rail = document.getElementById('rail');
  const vis = rail && getComputedStyle(rail).display !== 'none';
  const card = rail && rail.querySelector('.rail-card');
  const parts = card ? [...card.querySelectorAll('.rail-title, .rail-lead, .rail-pts li, .rail-action, .rail-src')] : [];
  return {
    visible: !!vis,
    width: vis ? Math.round(rail.getBoundingClientRect().width) : 0,
    title: card ? card.querySelector('.rail-title').textContent : '',
    index: window.EDPAC.banner ? window.EDPAC.banner.index() : -1,
    count: window.EDPAC.banner ? window.EDPAC.banner.count : 0,
    // Does any element print more than its box can show?
    clipped: parts.filter(function (el) {
      return el.scrollHeight - el.clientHeight > 2 || el.scrollWidth - el.clientWidth > 2;
    }).map(function (el) { return el.className + ': ' + el.textContent.slice(0, 50); }),
    railOverflow: vis ? rail.scrollHeight - rail.clientHeight : 0,
    appScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });

  // ── The rail is wall-display only ───────────────────────────────
  console.log('\nThe rail appears only where it belongs');
  for (const c of [
    { w: 1920, h: 1080, mode: 'tv', want: true,  label: 'TV 1080p, mode=tv' },
    { w: 1920, h: 1080, mode: '',   want: false, label: 'TV 1080p, ordinary view' },
    { w: 1280, h: 800,  mode: 'tv', want: true,  label: 'landscape tablet, mode=tv' },
    { w: 768,  h: 1024, mode: 'tv', want: false, label: '10in portrait tablet, mode=tv' },
    { w: 390,  h: 844,  mode: 'tv', want: false, label: 'phone, mode=tv' }
  ]) {
    const page = await browser.newPage({ viewport: { width: c.w, height: c.h } });
    page.on('pageerror', e => fails.push(`${c.label}: pageerror ${e.message}`));
    await page.goto(PAGE + (c.mode ? '?mode=' + c.mode : ''));
    await page.waitForTimeout(600);
    const r = await page.evaluate(railProbe);
    ok(c.label + ': rail ' + (c.want ? 'shown' : 'hidden'), r.visible === c.want,
       'visible=' + r.visible);
    if (c.want) {
      ok(c.label + ': rail has a card with a title', r.title.length > 5, r.title);
      ok(c.label + ': nothing clipped in the rail', r.clipped.length === 0, r.clipped.join(' | '));
      ok(c.label + ': rail does not overflow its own column', r.railOverflow <= 1,
         r.railOverflow + 'px');
    }
    ok(c.label + ': page does not scroll', r.appScroll <= 1, r.appScroll + 'px');
    await page.close();
  }

  // ── The zone board is not squeezed out of shape by the rail ─────
  console.log('\nThe zone board survives beside the rail');
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fails.push(`board: pageerror ${e.message}`));
    await page.goto(PAGE + '?mode=tv');
    await page.waitForTimeout(600);
    for (const tab of [0, 1, 2]) {
      await page.evaluate(i => document.querySelectorAll('.tab')[i].click(), tab);
      await page.waitForTimeout(300);
      const r = await page.evaluate((order) => {
        const cards = [...document.querySelectorAll('.zone-card')];
        return {
          unit: document.querySelector('.tab[aria-selected="true"] .tab-sub').textContent,
          rows: new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size,
          zones: cards.map(c => (c.className.match(/z-(\w+)/) || [])[1]),
          tally: cards.map(c => {
            const p = parseInt(c.querySelector('.zc-big').textContent, 10);
            const cap = parseInt((c.querySelector('.zc-cap').textContent.match(/\d+/) || [0])[0], 10);
            const m = c.querySelector('.zc-badge').textContent.match(/\d+/);
            return { p, cap, badge: m ? parseInt(m[0], 10) : null };
          }),
          overflow: [...document.querySelectorAll('.panel, .zone-card')]
            .filter(e => e.scrollHeight - e.clientHeight > 2).length
        };
      }, ORDER);
      const seq = r.zones.slice().sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
      ok(r.unit + ': zones on one row', r.rows === 1, r.rows + ' rows');
      ok(r.unit + ': zones in escalation order', r.zones.join() === seq.join(), r.zones.join());
      ok(r.unit + ': no panel or card overflows', r.overflow === 0, r.overflow + ' overflowing');
      const bad = r.tally.filter(z => z.badge !== null && z.badge !== Math.max(0, z.p - z.cap));
      ok(r.unit + ': crisis badges still add up', bad.length === 0, JSON.stringify(bad));

      // The rail narrows the content column, and the guidance grid sizes its
      // columns off the viewport rather than off the box it lands in. That
      // mismatch cut two entries short the first time round.
      const cut = await page.evaluate(() =>
        [...document.querySelectorAll('.guide-row p, .guide-row strong, .klinik p, .seek-copy p')]
          .filter(e => e.scrollHeight - e.clientHeight > 2)
          .map(e => e.textContent.slice(0, 44) + ' (+' + (e.scrollHeight - e.clientHeight) + 'px)'));
      ok(r.unit + ': no public sentence is cut short', cut.length === 0, cut.join(' | '));
    }
    await page.close();
  }

  // ── Every card, both languages ──────────────────────────────────
  console.log('\nEvery rail card fits, in both languages');
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fails.push(`cards: pageerror ${e.message}`));
    await page.goto(PAGE + '?mode=tv');
    await page.waitForTimeout(600);
    const n = await page.evaluate(() => window.EDPAC.banner.count);
    ok('all five roles plus an opening card', n === 6, n + ' cards');
    for (const lang of ['ms', 'en']) {
      await page.evaluate(l => {
        if (window.EDPAC.state.lang !== l) document.getElementById('langBtn').click();
      }, lang);
      await page.waitForTimeout(250);
      for (let i = 0; i < n; i++) {
        const r = await page.evaluate(i => {
          const B = window.EDPAC.banner;
          while (B.index() !== i) B.next();
          B.render();
          const p = (function () {
            const card = document.querySelector('#rail .rail-card');
            const parts = [...card.querySelectorAll('.rail-title, .rail-lead, .rail-pts li, .rail-action, .rail-src')];
            return {
              title: card.querySelector('.rail-title').textContent,
              clipped: parts.filter(el => el.scrollHeight - el.clientHeight > 2
                                       || el.scrollWidth - el.clientWidth > 2)
                            .map(el => el.className + ': ' + el.textContent.slice(0, 60)),
              overflow: document.getElementById('rail').scrollHeight
                      - document.getElementById('rail').clientHeight
            };
          })();
          return p;
        }, i);
        ok(lang + ' card ' + i + ' fits: "' + r.title.slice(0, 34) + '"',
           r.clipped.length === 0 && r.overflow <= 1,
           r.clipped.join(' | ') + (r.overflow > 1 ? ' railOverflow=' + r.overflow : ''));
      }
    }

    // Language toggle must carry the rail with it.
    const before = await page.evaluate(() => document.querySelector('.rail-title').textContent);
    await page.evaluate(() => document.getElementById('langBtn').click());
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => document.querySelector('.rail-title').textContent);
    ok('the rail follows the language toggle', before !== after, before + ' -> ' + after);

    // Rotation.
    const i0 = await page.evaluate(() => window.EDPAC.banner.index());
    await page.evaluate(() => window.EDPAC.banner.next());
    const i1 = await page.evaluate(() => window.EDPAC.banner.index());
    ok('the rail advances', i1 !== i0, i0 + ' -> ' + i1);
    const period = await page.evaluate(() => window.EDPAC.banner.period);
    ok('each card is held long enough to read', period >= 8000, period + ' ms');
    await page.close();
  }

  // ── Inlined figures: first paint with no server call ────────────
  console.log('\nFigures inlined by doGet need no server call');
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => fails.push(`inline: pageerror ${e.message}`));
    // Serve the payloads the way doGet does, and make every server call fail:
    // anything on screen must therefore have come from the inlined copy.
    await page.addInitScript(() => {
      window.__CALLS__ = [];
      Object.defineProperty(window, '__LATE__', { value: true, writable: true });
    });
    await page.goto(PAGE);
    await page.evaluate(() => {
      window.EDPAC.state.data = {};
      window.BOOT_DATA = {
        wcc: window.__PAYLOADS__.wcc, bu: window.__PAYLOADS__.bu, pac: window.__PAYLOADS__.pac
      };
      window.__MOCK__.getPublicDashboards = function () {
        window.__CALLS__.push('getPublicDashboards');
        throw new Error('no server available');
      };
      window.EDPAC.boot();
    });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({
      seeded: window.EDPAC.seededFrom(),
      cards: document.querySelectorAll('.zone-card').length,
      spinner: !!document.querySelector('.state.is-load'),
      bigs: [...document.querySelectorAll('.zc-big')].map(e => e.textContent).slice(0, 3),
      calls: window.__CALLS__.length
    }));
    ok('the page seeded itself from the inlined payload', r.seeded === 'inline', r.seeded);
    ok('zone cards are on screen', r.cards > 0, r.cards + ' cards');
    ok('with real numbers on them', r.bigs.every(v => /^\d+$/.test(v)), r.bigs.join(','));
    ok('no spinner', !r.spinner);
    ok('and a failing server did not blank it', r.cards > 0 && r.calls > 0,
       r.calls + ' attempted calls');

    // Tab switching must not go back to the server at all.
    const callsBefore = await page.evaluate(() => window.__CALLS__.length);
    await page.evaluate(() => document.querySelectorAll('.tab')[1].click());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      calls: window.__CALLS__.length,
      cards: document.querySelectorAll('.zone-card').length,
      unit: document.querySelector('.tab[aria-selected="true"] .tab-sub').textContent
    }));
    ok('switching tabs costs no server call', after.calls === callsBefore,
       callsBefore + ' -> ' + after.calls);
    ok('and the new tab is drawn', after.cards > 0, after.unit + ', ' + after.cards + ' cards');
    await page.close();
  }

  // ── Snapshot fallback ───────────────────────────────────────────
  console.log('\nLast-known figures when nothing is inlined');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => fails.push(`snapshot: pageerror ${e.message}`));
    await page.goto(PAGE);
    await page.waitForTimeout(600);
    const stored = await page.evaluate(() => !!localStorage.getItem('edpac_snap_v1'));
    ok('a successful load writes a snapshot', stored);

    const r = await page.evaluate(() => {
      window.EDPAC.state.data = {};
      window.BOOT_DATA = {};
      window.__MOCK__.getPublicDashboards = function () { throw new Error('offline'); };
      window.EDPAC.boot();
      return { seeded: window.EDPAC.seededFrom(), cards: document.querySelectorAll('.zone-card').length };
    });
    await page.waitForTimeout(300);
    ok('a cold boot falls back to the snapshot', r.seeded === 'snapshot', r.seeded);
    ok('and shows figures rather than a spinner', r.cards > 0, r.cards + ' cards');

    const aged = await page.evaluate(() => {
      const o = JSON.parse(localStorage.getItem('edpac_snap_v1'));
      o.savedAt = Date.now() - 6 * 60 * 60 * 1000;
      localStorage.setItem('edpac_snap_v1', JSON.stringify(o));
      window.EDPAC.state.data = {};
      window.EDPAC.boot();
      return { seeded: window.EDPAC.seededFrom(), left: localStorage.getItem('edpac_snap_v1') };
    });
    ok('a stale snapshot is discarded, not shown', aged.seeded === 'none', aged.seeded);
    ok('and removed from storage', aged.left === null);
    await page.close();
  }

  await browser.close();
  if (fails.length) {
    console.log('\n' + fails.length + ' TV/boot gate(s) FAILED:');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nWall-display rail fits and rotates; inlined figures paint with no server call.\n');
})();
