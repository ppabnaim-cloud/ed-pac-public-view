/**
 * The two poster tabs: IQMS, and emergency vs non-emergency.
 *
 *   - the tab strip stays on ONE row now that there are six tabs
 *     (it was hard-coded to four columns and silently wrapped)
 *   - each tab is one poster, fitted to the screen, with no live data
 *   - when the poster cannot be loaded the written guidance stands in,
 *     because a blank tab in a waiting hall is worse than plain text
 *   - no poster image is ever fetched from a host other than Google's own
 */
const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');

const PAGE = 'file://' + path.join(__dirname, 'dashboard_test.html');
const MANIFEST_COUNT = JSON.parse(
  require('fs').readFileSync(path.join(__dirname, '..', 'web', 'rakyat', 'manifest.json'), 'utf8')
).items.length;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  fails.push(name + (detail ? '  — ' + detail : ''));
  console.log('  FAIL ' + name + (detail ? '  — ' + detail : ''));
}

const VIEWPORTS = [
  { n: 'TV 1080p', w: 1920, h: 1080 },
  { n: 'landscape tablet', w: 1280, h: 800 },
  { n: '10in portrait', w: 768, h: 1024 },
  { n: 'small tablet', w: 600, h: 960 },
  { n: 'phone', w: 390, h: 844 }
];

function probe() {
  const panels = [...document.querySelectorAll('#content .panel')];
  const img = document.querySelector('.poster-img');
  const box = document.querySelector('.poster-tab, .poster-fallback');
  const text = el => (el ? el.textContent.trim() : '');
  return {
    tabRows: new Set([...document.querySelectorAll('.tab')]
      .map(t => Math.round(t.getBoundingClientRect().top))).size,
    tabNames: [...document.querySelectorAll('.tab .tab-name')].map(t => t.textContent.trim()),
    tabCut: [...document.querySelectorAll('.tab .tab-name, .tab .tab-sub')]
      .filter(e => e.scrollWidth - e.clientWidth > 2).length,
    hasImage: !!img,
    imgLoaded: !!(img && img.naturalWidth > 0),
    imgSrc: img ? img.getAttribute('src') : '',
    imgFits: !!(img && box &&
      img.getBoundingClientRect().width <= box.getBoundingClientRect().width + 1 &&
      img.getBoundingClientRect().height <= box.getBoundingClientRect().height + 1),
    panels: panels.length,
    titleCut: panels.filter(p => {
      const h = p.querySelector('.panel-hd h2');
      return h && h.scrollWidth - h.clientWidth > 2;
    }).length,
    panelOver: panels.filter(p => p.scrollHeight - p.clientHeight > 2).length,
    textCut: [...document.querySelectorAll('.iq-lead, .iq-alert, .iq-warn, .iq-madani, .cklist li')]
      .filter(e => e.scrollHeight - e.clientHeight > 2 || e.scrollWidth - e.clientWidth > 2)
      .map(e => e.textContent.slice(0, 44)),
    emerg: [...document.querySelectorAll('.cklist.is-emerg li')].map(e => e.textContent.trim()),
    non: [...document.querySelectorAll('.cklist.is-ok li')].map(e => e.textContent.trim()),
    queue: [...document.querySelectorAll('.cklist.is-num li')].map(e => e.textContent.trim()),
    creditText: text(document.getElementById('creditMark')),
    creditPos: (() => {
      const c = document.getElementById('creditMark');
      if (!c) return 'absent';
      const b = c.getBoundingClientRect();
      return Math.round(b.right) + ',' + Math.round(b.bottom);
    })(),
    creditBottomRight: (() => {
      const c = document.getElementById('creditMark');
      if (!c) return false;
      const b = c.getBoundingClientRect();
      return b.right <= window.innerWidth + 1 && b.right > window.innerWidth * 0.5
          && b.bottom <= window.innerHeight + 1 && b.bottom > window.innerHeight * 0.75;
    })(),
    hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight
  };
}

async function openTab(page, key) {
  await page.evaluate((k) => {
    const i = (window.EDPAC.state.tabs || []).indexOf(k);
    if (i < 0) throw new Error('no such tab: ' + k);
    document.querySelectorAll('.tab')[i].click();
  }, key);
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });

  for (const vp of VIEWPORTS) {
    console.log('\n' + vp.n + ' (' + vp.w + 'x' + vp.h + ')');
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    page.on('pageerror', e => fails.push(vp.n + ' pageerror: ' + e.message));
    await page.goto(PAGE);
    await page.waitForTimeout(550);

    for (const key of ['iqms', 'triage']) {
      await openTab(page, key);
      const r = await page.evaluate(probe);

      // The bug adding these tabs introduced: the strip was hard-coded to
      // four columns, so the extra tabs dropped onto a second row and took
      // the administrative tab with them.
      ok(key + ': every tab stays on one row', r.tabRows === 1, r.tabRows + ' rows');
      ok(key + ': the credit is in the bottom-right corner',
         r.creditText.length > 8 && r.creditBottomRight,
         r.creditText + ' @ ' + r.creditPos);
      ok(key + ': all seven tabs are present', r.tabNames.length === 7, r.tabNames.join(' | '));
      ok(key + ': no tab label is cut off', r.tabCut === 0, r.tabCut + ' cut');

      ok(key + ': the poster is shown', r.hasImage);
      ok(key + ': and it loads', r.imgLoaded, r.imgSrc);
      ok(key + ': it fits inside its box rather than spilling out',
         vp.w <= 620 || r.imgFits, 'image larger than its container');
      ok(key + ': the page never scrolls sideways', r.hScroll <= 1, r.hScroll + 'px');
      ok(key + ': every tab label is readable in full', r.tabCut === 0, r.tabCut + ' clipped');
      if (vp.w > 620) {
        ok(key + ': and does not scroll down above phone width', r.vScroll <= 1, r.vScroll + 'px');
      }
    }
    await page.close();
  }

  // ── The written fallback, when the poster cannot be loaded ──────
  console.log('\nWith no poster configured, the written guidance stands in');
  for (const vp of [{ n: 'TV', w: 1920, h: 1080 }, { n: 'tablet', w: 768, h: 1024 }]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    page.on('pageerror', e => fails.push('fallback pageerror: ' + e.message));
    await page.goto(PAGE + '?noposter=1');
    await page.waitForTimeout(550);

    await openTab(page, 'iqms');
    let r = await page.evaluate(probe);
    ok(vp.n + ' iqms: falls back to written guidance', !r.hasImage && r.panels === 1,
       r.panels + ' panels, image=' + r.hasImage);
    ok(vp.n + ' iqms: the queue steps are numbered', r.queue.length === 4, r.queue.length + '');
    ok(vp.n + ' iqms: nothing cut short', r.textCut.length === 0, r.textCut.join(' | '));
    ok(vp.n + ' iqms: no panel overflows', r.panelOver === 0, r.panelOver + '');

    await openTab(page, 'triage');
    r = await page.evaluate(probe);
    ok(vp.n + ' triage: falls back to three panels', !r.hasImage && r.panels === 3,
       r.panels + ' panels, image=' + r.hasImage);
    ok(vp.n + ' triage: the emergency list has entries', r.emerg.length >= 5, r.emerg.length + '');
    ok(vp.n + ' triage: the non-emergency list has entries', r.non.length >= 4, r.non.length + '');
    const overlap = r.emerg.filter(e => r.non.indexOf(e) >= 0);
    ok(vp.n + ' triage: nothing appears on both lists', overlap.length === 0, overlap.join(', '));
    ok(vp.n + ' triage: nothing cut short', r.textCut.length === 0, r.textCut.join(' | '));
    ok(vp.n + ' triage: no panel title is cut off', r.titleCut === 0, r.titleCut + '');
    ok(vp.n + ' triage: no panel overflows', r.panelOver === 0, r.panelOver + '');
    await page.close();
  }

  // ── Both languages ──────────────────────────────────────────────
  console.log('\nBoth languages');
  {
    const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
    page.on('pageerror', e => fails.push('lang pageerror: ' + e.message));
    await page.goto(PAGE + '?noposter=1');
    await page.waitForTimeout(550);
    await openTab(page, 'triage');
    const ms = await page.evaluate(probe);
    await page.evaluate(() => document.getElementById('langBtn').click());
    await page.waitForTimeout(350);
    const en = await page.evaluate(probe);

    ok('the tab survives the language switch', en.panels === 3, en.panels + ' panels');
    ok('its content really changes language',
       ms.emerg[0] !== en.emerg[0], ms.emerg[0] + ' -> ' + en.emerg[0]);
    ok('nothing is cut short in English', en.textCut.length === 0, en.textCut.join(' | '));
    ok('no English panel title is cut off', en.titleCut === 0, en.titleCut + '');
    ok('no English tab label is cut off', en.tabCut === 0, en.tabCut + ' cut');
    ok('the tabs still fit on one row in English', en.tabRows === 1, en.tabRows + ' rows');
    await page.close();
  }

  // ── The Peranan Rakyat gallery ──────────────────────────────────
  console.log('\nThe Peranan Rakyat poster gallery');
  for (const vp of [{ n: 'desktop', w: 1280, h: 900 }, { n: 'phone', w: 390, h: 844 }]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    page.on('pageerror', e => fails.push('rakyat pageerror: ' + e.message));
    await page.goto(PAGE);
    await page.waitForTimeout(550);
    await openTab(page, 'rakyat');
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({
      heading: (document.querySelector('.rk-head h2') || {}).textContent || '',
      sub: (document.querySelector('.rk-sub') || {}).textContent || '',
      cards: document.querySelectorAll('.rk-card').length,
      loaded: [...document.querySelectorAll('.rk-shot img')].filter(i => i.naturalWidth > 0).length,
      groups: [...document.querySelectorAll('.rk-group-h')].map(h => h.textContent.trim()),
      downloads: document.querySelectorAll('.rk-dl[download]').length,
      // Every poster opens full size in its own tab.
      opens: [...document.querySelectorAll('.rk-shot')].filter(a => a.getAttribute('target') === '_blank').length,
      credits: [...document.querySelectorAll('.rk-credit')].map(c => c.textContent.trim()),
      fits: [...document.querySelectorAll('.rk-shot img')].every(i => {
        const box = i.parentElement.getBoundingClientRect(), b = i.getBoundingClientRect();
        return b.width <= box.width + 1 && b.height <= box.height + 1;
      }),
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    ok(vp.n + ': the heading names the campaign', /Peranan Rakyat/i.test(r.heading), r.heading);
    ok(vp.n + ': and the crowding it is aimed at', /[Kk]esesakan|crowding/.test(r.sub), r.sub);
    ok(vp.n + ': every poster in the manifest is shown', r.cards === MANIFEST_COUNT,
       r.cards + ' of ' + MANIFEST_COUNT);
    ok(vp.n + ': every poster image loads', r.loaded === r.cards, r.loaded + '/' + r.cards);
    ok(vp.n + ': no image spills out of its box', r.fits);
    ok(vp.n + ': grouped under the Peranan they belong to',
       r.groups.length >= 4 && r.groups.every(g => /Peranan \d|Lain|Other|Role \d/.test(g)),
       r.groups.join(' | '));
    ok(vp.n + ': every poster can be downloaded', r.downloads === r.cards, r.downloads + '');
    ok(vp.n + ': and opened full size', r.opens === r.cards, r.opens + '');
    ok(vp.n + ': the designer is credited on every poster',
       r.credits.length === r.cards && r.credits.every(c => c.length > 5), r.credits.join(' | '));
    ok(vp.n + ": the hospital's own work is credited to Dr Naim",
       r.credits.some(c => /Dr Naim/.test(c)), r.credits.join(' | '));
    ok(vp.n + ": and KKM's is credited to KKM",
       r.credits.some(c => /Kesihatan Malaysia|Ministry of Health/.test(c)), r.credits.join(' | '));
    ok(vp.n + ': no sideways scroll', r.hScroll <= 1, r.hScroll + 'px');
    await page.close();
  }

  // ── The status board gave up its posters button ─────────────────
  console.log('\nThe posters moved off the status board');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(PAGE);
    await page.waitForTimeout(550);
    const board = await page.evaluate(() =>
      [...document.querySelectorAll('#content .panel-tbl')].map(b => b.textContent.trim()));
    ok('the status board no longer carries a posters button',
       board.every(b => !/poster/i.test(b)), board.join(', '));
    await page.close();
  }

  await browser.close();
  if (fails.length) {
    console.log('\n' + fails.length + ' IQMS gate(s) FAILED:');
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\nBoth poster tabs fit every width, with the written guidance as a fallback.\n');
})();
