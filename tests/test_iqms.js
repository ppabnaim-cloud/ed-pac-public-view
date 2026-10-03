/**
 * The IQMS & triage tab.
 *
 *   - the tab strip stays on ONE row now that there are five tabs
 *     (it was hard-coded to four columns and silently wrapped)
 *   - the tab renders with no live data, because it is standing guidance
 *   - nothing is cut short, in either language, phone to television
 *   - the emergency and non-emergency lists never say the same thing twice
 *   - the posters button lives here, not on the status board
 */
const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');

const PAGE = 'file://' + path.join(__dirname, 'dashboard_test.html');
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
  const text = el => (el ? el.textContent.trim() : '');
  return {
    tabRows: new Set([...document.querySelectorAll('.tab')]
      .map(t => Math.round(t.getBoundingClientRect().top))).size,
    tabNames: [...document.querySelectorAll('.tab .tab-name')].map(t => t.textContent.trim()),
    tabCut: [...document.querySelectorAll('.tab .tab-name, .tab .tab-sub')]
      .filter(e => e.scrollWidth - e.clientWidth > 2).length,
    panels: panels.length,
    titles: panels.map(p => text(p.querySelector('.panel-hd h2'))),
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
    hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight
  };
}

async function openIqms(page) {
  await page.evaluate(() => {
    const i = (window.EDPAC.state.tabs || []).indexOf('iqms');
    if (i < 0) throw new Error('no iqms tab');
    document.querySelectorAll('.tab')[i].click();
  });
  await page.waitForTimeout(350);
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });

  for (const vp of VIEWPORTS) {
    console.log('\n' + vp.n + ' (' + vp.w + 'x' + vp.h + ')');
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    page.on('pageerror', e => fails.push(vp.n + ' pageerror: ' + e.message));
    await page.goto(PAGE);
    await page.waitForTimeout(550);
    await openIqms(page);
    const r = await page.evaluate(probe);

    // The bug that adding this tab introduced: the strip was hard-coded to
    // four columns, so the fifth tab dropped onto a second row and the
    // administrative tab was half cut off.
    ok('the five tabs stay on one row', r.tabRows === 1, r.tabRows + ' rows');
    ok('five tabs are present', r.tabNames.length === 5, r.tabNames.join(' | '));
    ok('no tab label is cut off', r.tabCut === 0, r.tabCut + ' cut');

    ok('four panels render with no live data', r.panels === 4, r.panels + ' panels');
    ok('no panel title is cut off', r.titleCut === 0, r.titles.join(' | '));
    ok('no panel overflows', r.panelOver === 0, r.panelOver + ' overflowing');
    ok('no sentence is cut short', r.textCut.length === 0, r.textCut.join(' | '));
    ok('the page never scrolls sideways', r.hScroll <= 1, r.hScroll + 'px');
    if (vp.w > 620) {
      ok('and does not scroll down above phone width', r.vScroll <= 1, r.vScroll + 'px');
    }

    ok('the emergency list has entries', r.emerg.length >= 5, r.emerg.length + '');
    ok('the non-emergency list has entries', r.non.length >= 4, r.non.length + '');
    ok('the queue steps are numbered', r.queue.length === 4, r.queue.length + '');
    const overlap = r.emerg.filter(e => r.non.indexOf(e) >= 0);
    ok('nothing appears on both lists', overlap.length === 0, overlap.join(', '));

    await page.close();
  }

  // ── Both languages ──────────────────────────────────────────────
  console.log('\nBoth languages');
  {
    const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
    page.on('pageerror', e => fails.push('lang pageerror: ' + e.message));
    await page.goto(PAGE);
    await page.waitForTimeout(550);
    await openIqms(page);
    const ms = await page.evaluate(probe);
    await page.evaluate(() => document.getElementById('langBtn').click());
    await page.waitForTimeout(350);
    const en = await page.evaluate(probe);

    ok('the tab survives the language switch', en.panels === 4, en.panels + ' panels');
    ok('its content really changes language',
       ms.emerg[0] !== en.emerg[0], ms.emerg[0] + ' -> ' + en.emerg[0]);
    ok('nothing is cut short in English', en.textCut.length === 0, en.textCut.join(' | '));
    ok('no English panel title is cut off', en.titleCut === 0, en.titles.join(' | '));
    ok('no English tab label is cut off', en.tabCut === 0, en.tabCut + ' cut');
    ok('the tabs still fit on one row in English', en.tabRows === 1, en.tabRows + ' rows');
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
  console.log('\nIQMS tab fits every width in both languages; five tabs stay on one row.\n');
})();
