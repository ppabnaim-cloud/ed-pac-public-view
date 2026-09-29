/**
 * Public-view contract:
 *   - every zone card adds up from the numbers printed on it
 *   - the zones read left to right in escalation order, on one row
 *   - a refresh does not blank the page
 *   - the crisis banner that duplicated the cards is gone
 */
const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');

const ORDER = ['rz', 'yz', 'ob', 'ab', 'pac', 'gz'];
const TABS = [0, 1, 2];

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const fails = [];

  for (const vp of [{ w: 1920, h: 1080 }, { w: 1280, h: 800 }, { w: 768, h: 1024 }]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    page.on('pageerror', e => fails.push(`${vp.w}: pageerror ${e.message}`));
    await page.goto('file://' + path.join(__dirname, 'dashboard_test.html'));
    await page.waitForTimeout(600);

    for (const tab of TABS) {
      await page.evaluate(i => document.querySelectorAll('.tab')[i].click(), tab);
      await page.waitForTimeout(350);

      const r = await page.evaluate((order) => {
        const cards = [...document.querySelectorAll('.zone-card')];
        return {
          unit: document.querySelector('.tab[aria-selected="true"] .tab-sub').textContent,
          banner: !!document.querySelector('.banner.is-critical'),
          rows: new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size,
          zones: cards.map(c => (c.className.match(/z-(\w+)/) || [])[1]),
          cards: cards.map(c => ({
            name: c.querySelector('.zc-name').textContent,
            patients: parseInt(c.querySelector('.zc-big').textContent, 10),
            cap: parseInt((c.querySelector('.zc-cap').textContent.match(/\d+/) || [0])[0], 10),
            badge: c.querySelector('.zc-badge').textContent.trim()
          }))
        };
      }, ORDER);

      const tag = `${vp.w}x${vp.h} / ${r.unit}`;

      if (r.banner) fails.push(`${tag}: the crisis banner is back; the cards already say it`);

      // One row, never a second layer.
      if (r.rows !== 1) fails.push(`${tag}: zone cards span ${r.rows} rows, expected 1`);

      // Escalation order, left to right.
      const ranks = r.zones.map(z => ORDER.indexOf(z));
      const sorted = ranks.slice().sort((a, b) => a - b);
      if (ranks.join() !== sorted.join()) {
        fails.push(`${tag}: zones out of order — ${r.zones.join(' > ')}`);
      }

      // The arithmetic a reader can check.
      r.cards.forEach(c => {
        const expect = Math.max(0, c.patients - c.cap);
        const shown = /crisis|krisis/i.test(c.badge) ? parseInt(c.badge, 10) : 0;
        if (shown !== expect) {
          fails.push(`${tag} / ${c.name}: ${c.patients} patients in ${c.cap} beds ` +
                     `should read ${expect} crisis beds, card says "${c.badge}"`);
        }
      });
    }

    // Nothing a family reads may be cut off mid-sentence. Truncated public
    // guidance has crept back in several times, so it is guarded here.
    const clipped = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll(
        '.zc-name,.zc-cap,.zc-badge,.zc-gz-l,.zc-gz-wait,.guide-row p,.guide-row strong,' +
        '.klinik p,.klinik strong,.seek-copy p,.seek-copy h2'
      ).forEach(n => {
        if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) {
          out.push(n.textContent.trim().slice(0, 44));
        }
      });
      return out;
    });
    clipped.forEach(t => fails.push(`${vp.w}x${vp.h}: text cut off — "${t}…"`));

    // A refresh must keep the figures on screen, not blank them to a spinner.
    await page.evaluate(() => document.querySelectorAll('.tab')[0].click());
    await page.waitForTimeout(350);
    const during = await page.evaluate(() => {
      window.EDPAC.reload();
      return {
        spinner: !!document.querySelector('#content .spin'),
        cards: document.querySelectorAll('.zone-card').length
      };
    });
    if (during.spinner) fails.push(`${vp.w}: a refresh blanked the page to a spinner`);
    if (!during.cards) fails.push(`${vp.w}: a refresh cleared the zone cards`);

    const mins = await page.evaluate(() => window.EDPAC.refreshMs / 60000);
    if (mins !== 15) fails.push(`refresh interval is ${mins} minutes, expected 15`);

    await page.close();
  }

  await browser.close();
  if (fails.length) {
    console.error('PUBLIC VIEW FAILURES:');
    fails.forEach(f => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log('Zone cards add up, read in order on one row, and a refresh does not blank the page.');
})();
