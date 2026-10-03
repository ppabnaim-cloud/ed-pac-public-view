const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');
(async () => {
  const b = await chromium.launch({ executablePath: findChromium() });
  const fails = [];
  for (const vp of [{ w: 768, h: 1024 }, { w: 600, h: 960 }]) {
    const p = await b.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    p.on('pageerror', e => fails.push(`pageerror: ${e.message}`));
    // Patient search is off by default now. This pass runs with it switched
    // back on, so the implementation that remains in the file stays covered;
    // the pass at the end of this loop proves the default leaves no trace of it.
    await p.goto('file://' + path.join(__dirname, 'dashboard_test.html?search=1'));
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

    // The strip is a standing message now, not a way into an overlay, and it
    // must not carry the operational commentary it used to.
    const strip = await p.evaluate(() => {
      const n = document.getElementById('narr');
      return {
        isButton: n.tagName === 'BUTTON',
        text: (document.getElementById('narrText').textContent || '').trim(),
        overlayOpen: document.getElementById('ovHelp').classList.contains('is-open')
      };
    });
    if (strip.isButton) fails.push(`${vp.w}: the narrative strip is still a button`);
    if (strip.text.length < 20) fails.push(`${vp.w}: narrative strip is empty`);
    if (/\d+\s*(patients|pesakit)/i.test(strip.text)) {
      fails.push(`${vp.w}: strip still carries operational figures: "${strip.text}"`);
    }
    if (vp.w === 768) await p.screenshot({ path: '/home/user/ed-pac-public-view/tests/shots/ov-help.png' });

    // The non-emergency notice must be on the first screen of every public tab.
    const klinik = await p.evaluate(() =>
      (document.querySelector('.klinik') || {}).textContent || '');
    if (!/Klinik Kesihatan/.test(klinik)) {
      fails.push(`${vp.w}: the Klinik Kesihatan notice is missing from the public screen`);
    }

    // The public tabs must carry no charts at all — the analysis belongs on
    // the Administrative tab. Assert that, then go there for the table view.
    const pub = await p.evaluate(() => ({
      charts: document.querySelectorAll('#content .panel-bd svg').length,
      zoneCards: document.querySelectorAll('.zone-card').length,
      seek: !!document.querySelector('.seek-btn')
    }));
    if (pub.charts) fails.push(`${vp.w}: public tab renders ${pub.charts} chart(s); it should render none`);
    if (!pub.zoneCards) fails.push(`${vp.w}: public tab shows no zone cards`);
    if (!pub.seek) fails.push(`${vp.w}: public tab has no search prompt`);

    // ── With search off (the default), nothing of it may survive ──
    await p.goto('file://' + path.join(__dirname, 'dashboard_test.html'));
    await p.waitForTimeout(500);
    const off = await p.evaluate(() => ({
      headerBtn: !!document.getElementById('searchBtn'),
      overlay: !!document.getElementById('ovSearch'),
      input: !!document.querySelector('input[type="text"], input[type="password"]:not(#gateInput)'),
      seekBtn: !!document.querySelector('.seek-btn'),
      counter: !!document.querySelector('.seek.is-counter'),
      counterText: (document.querySelector('.seek.is-counter h2') || {}).textContent || '',
      zoneCards: document.querySelectorAll('.zone-card').length,
      scroll: document.documentElement.scrollHeight - document.documentElement.clientHeight
    }));
    if (off.headerBtn) fails.push(`${vp.w}: the search button is still in the document`);
    if (off.overlay) fails.push(`${vp.w}: the search overlay is still in the document`);
    if (off.input) fails.push(`${vp.w}: a free-text input survives on the public view`);
    if (off.seekBtn) fails.push(`${vp.w}: the inline search prompt is still there`);
    if (!off.counter) fails.push(`${vp.w}: nothing replaced the search prompt`);
    if (off.counterText.length < 10) fails.push(`${vp.w}: the counter panel has no heading`);
    if (!off.zoneCards) fails.push(`${vp.w}: zone cards vanished with search off`);
    if (off.scroll > 1) fails.push(`${vp.w}: the page scrolls with search off (${off.scroll}px)`);

    // Administrative tab: dismissing the access-code dialog must leave a way
    // back in, not a spinner that turns for ever.
    await p.evaluate(() => {
      const i = (window.EDPAC.state.tabs || []).indexOf('admin');
      document.querySelectorAll('.tab')[i].click();
    });
    await p.waitForTimeout(350);
    const gateOpen = await p.evaluate(() =>
      document.getElementById('ovGate').classList.contains('is-open'));
    if (!gateOpen) fails.push(`${vp.w}: the access-code dialog did not open`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    const locked = await p.evaluate(() => ({
      spinner: !!document.querySelector('#content .spin'),
      button: !!document.getElementById('lockedBtn'),
      text: (document.getElementById('content').textContent || '').trim().slice(0, 60)
    }));
    if (locked.spinner) fails.push(`${vp.w}: admin tab left spinning after the dialog was dismissed`);
    if (!locked.button) fails.push(`${vp.w}: no way to reopen the access-code dialog`);

    // Reopening it from that button must work, and the code must let us in.
    await p.click('#lockedBtn');
    await p.waitForTimeout(250);
    await p.fill('#gateInput', 'test-code');
    await p.click('#gateGo');
    await p.waitForTimeout(600);
    const entered = await p.evaluate(() => ({
      gateShut: !document.getElementById('ovGate').classList.contains('is-open'),
      charts: document.querySelectorAll('.panel-bd svg').length
    }));
    if (!entered.gateShut) fails.push(`${vp.w}: the dialog stayed open after a correct code`);
    if (!entered.charts) fails.push(`${vp.w}: the admin tab rendered no charts after unlocking`);
    const tblBtn = await p.evaluate(() => {
      const b = document.querySelector('.panel-tbl');
      if (!b) return false;
      b.click(); return true;
    });
    if (!tblBtn) { fails.push(`${vp.w}: no chart table button on the admin tab`); }
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
      tabs: [...document.querySelectorAll('.tab-name')].map(n => n.textContent).join(' | '),
      charts: document.querySelectorAll('.panel-bd svg').length
    }));
    if (!/Emergency/.test(en.tabs)) fails.push(`${vp.w}: language toggle did not switch tabs to English`);
    if (!en.charts) fails.push(`${vp.w}: charts disappeared after the language switch`);
    if (vp.w === 768) await p.screenshot({ path: '/home/user/ed-pac-public-view/tests/shots/en-wcc-step1.png' });
    await p.close();
  }
  await b.close();
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('Overlays, search, table view and the language toggle all behave and fit.');
})();
