const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');
(async () => {
  const b = await chromium.launch({ executablePath: findChromium() });
  const fails = [];
  for (const vp of [{ w: 768, h: 1024 }, { w: 600, h: 960 }]) {
    const p = await b.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    p.on('pageerror', e => fails.push(`pageerror: ${e.message}`));
    await p.goto('file://' + path.join(__dirname, 'dashboard_test.html'));
    await p.waitForTimeout(500);

    // Search overlay, with a result rendered
    await p.click('#searchBtn'); await p.waitForTimeout(200);
    await p.fill('#searchInput', '830702-07-2527'); await p.click('#searchGo');
    await p.waitForTimeout(300);
    if (vp.w === 768) await p.screenshot({ path: '/home/user/ed-pac-public-view/tests/shots/ov-search.png' });
    let r = await p.evaluate(() => {
      const c = document.querySelector('#ovSearch .ov-card').getBoundingClientRect();
      return { fits: c.bottom <= window.innerHeight + 1 && c.top >= -1,
               results: document.querySelectorAll('#searchResults .res').length,
               bodyScroll: document.body.scrollHeight > document.documentElement.clientHeight + 1 };
    });
    if (!r.fits) fails.push(`${vp.w}: search card does not fit`);
    if (r.results !== 1) fails.push(`${vp.w}: search rendered ${r.results} results, expected 1`);
    if (r.bodyScroll) fails.push(`${vp.w}: page scrolls with search open`);
    await p.click('#ovSearch .ov-x'); await p.waitForTimeout(150);

    // Help overlay
    await p.click('#narr'); await p.waitForTimeout(350);
    r = await p.evaluate(() => {
      const c = document.querySelector('#ovHelp .ov-card').getBoundingClientRect();
      return { open: document.getElementById('ovHelp').classList.contains('is-open'),
               fits: c.bottom <= window.innerHeight + 1,
               narrative: (document.getElementById('helpNarrative').textContent || '').length,
               bodyScroll: document.body.scrollHeight > document.documentElement.clientHeight + 1 };
    });
    if (!r.open) fails.push(`${vp.w}: help overlay did not open`);
    if (!r.fits) fails.push(`${vp.w}: help card does not fit`);
    if (r.narrative < 40) fails.push(`${vp.w}: help narrative empty (${r.narrative} chars)`);
    if (r.bodyScroll) fails.push(`${vp.w}: page scrolls with help open`);
    if (vp.w === 768) await p.screenshot({ path: '/home/user/ed-pac-public-view/tests/shots/ov-help.png' });
    await p.click('#ovHelp .ov-x'); await p.waitForTimeout(150);

    // Table view from a chart
    await p.evaluate(() => document.querySelector('.panel-tbl').click());
    await p.waitForTimeout(250);
    r = await p.evaluate(() => {
      const c = document.querySelector('#ovTable .ov-card').getBoundingClientRect();
      return { fits: c.bottom <= window.innerHeight + 1,
               rows: document.querySelectorAll('#tblBody table.dt tbody tr').length,
               bodyScroll: document.body.scrollHeight > document.documentElement.clientHeight + 1 };
    });
    if (!r.fits) fails.push(`${vp.w}: table card does not fit`);
    if (!r.rows) fails.push(`${vp.w}: table view has no rows`);
    if (r.bodyScroll) fails.push(`${vp.w}: page scrolls with table open`);
    if (vp.w === 768) await p.screenshot({ path: '/home/user/ed-pac-public-view/tests/shots/ov-table.png' });
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);

    // Language toggle round-trip
    await p.click('#langBtn'); await p.waitForTimeout(400);
    const en = await p.evaluate(() => ({
      title: document.querySelector('.tab[aria-selected="true"] .tab-name').textContent,
      narr: document.getElementById('narrText').textContent.slice(0, 40),
      charts: document.querySelectorAll('.panel-bd svg').length
    }));
    if (!/Emergency/.test(en.title)) fails.push(`${vp.w}: language toggle did not switch tabs to English`);
    if (!en.charts) fails.push(`${vp.w}: charts disappeared after language switch`);
    if (vp.w === 768) await p.screenshot({ path: '/home/user/ed-pac-public-view/tests/shots/en-wcc-step1.png' });
    await p.close();
  }
  await b.close();
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('Overlays, search, table view and the language toggle all behave and fit.');
})();
