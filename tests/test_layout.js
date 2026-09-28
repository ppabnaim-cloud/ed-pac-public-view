/**
 * Layout gate: every tab, every step, at the target tablet sizes, must fit
 * without page scroll, and no panel may overflow its own box.
 */
const { chromium } = require('playwright');
const path = require('path');
const { findChromium } = require('./chromium');

const VIEWPORTS = [
  { name: 'iPad-portrait-768x1024',    width: 768,  height: 1024 },
  { name: 'Android10in-portrait-800x1280', width: 800, height: 1280 },
  { name: 'small-tablet-600x960',      width: 600,  height: 960 },
  { name: 'phone-390x844',             width: 390,  height: 844 },
  { name: 'tv-1080p-1920x1080',        width: 1920, height: 1080 },
  { name: 'landscape-tablet-1280x800', width: 1280, height: 800 }
];
// Every public tab is a single page with no pager. Phones are exempt from
// the no-scroll assertion: the guarantee is for a 10-inch tablet and larger.
const TABS = { wcc: 1, bu: 1, pac: 1, admin: 6 };

(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() });
  const failures = [];
  const consoleErrors = [];

  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height },
                                         deviceScaleFactor: 2 });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(vp.name + ': ' + m.text()); });
    page.on('pageerror', e => consoleErrors.push(vp.name + ' PAGEERROR: ' + e.message));
    await page.goto('file://' + path.join(__dirname, 'dashboard_test.html'));
    await page.waitForTimeout(500);

    const tabSteps = TABS;
    for (const [tab, nSteps] of Object.entries(tabSteps)) {
      await page.evaluate((tb) => {
        const btns = [...document.querySelectorAll('.tab')];
        const order = ['wcc','bu','pac','admin'];
        btns[order.indexOf(tb)].click();
      }, tab);
      await page.waitForTimeout(400);

      // The administrative tab is gated; authenticate through the real flow.
      if (tab === 'admin') {
        const gateOpen = await page.evaluate(() =>
          document.getElementById('ovGate').classList.contains('is-open'));
        if (gateOpen) {
          await page.fill('#gateInput', 'test-code');
          await page.click('#gateGo');
          await page.waitForTimeout(500);
        }
      }

      for (let step = 0; step < nSteps; step++) {
        await page.evaluate((st) => {
          const dots = [...document.querySelectorAll('.pager-dot')];
          if (dots[st]) dots[st].click();
        }, step);
        await page.waitForTimeout(350);

        const r = await page.evaluate(() => {
          const de = document.documentElement, b = document.body;
          const res = {
            pageScrollH: Math.max(de.scrollHeight, b.scrollHeight),
            clientH: de.clientHeight,
            pageScrollW: Math.max(de.scrollWidth, b.scrollWidth),
            clientW: de.clientWidth,
            appH: document.getElementById('app').getBoundingClientRect().height,
            contentH: document.getElementById('content').getBoundingClientRect().height,
            gridRows: getComputedStyle(document.getElementById('app')).gridTemplateRows,
            stepTitle: (document.getElementById('pgTitle') || {}).textContent || '',
            overflowing: [],
            emptyCharts: [],
            panels: 0, charts: 0
          };
          document.querySelectorAll('.panel, .kpi, .step').forEach(el => {
            if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
              res.overflowing.push({
                cls: el.className,
                area: el.style.gridArea || '',
                sh: el.scrollHeight, ch: el.clientHeight,
                sw: el.scrollWidth, cw: el.clientWidth,
                txt: (el.textContent || '').slice(0, 40)
              });
            }
          });
          document.querySelectorAll('.panel').forEach(() => res.panels++);
          // A panel body is satisfied by a chart OR by rendered HTML content;
          // several public panels are deliberately plain markup, not SVG.
          document.querySelectorAll('.panel-bd').forEach(bd => {
            if (bd.querySelector('svg')) { res.charts++; return; }
            const hasContent = bd.children.length > 0 &&
                               (bd.textContent || '').trim().length > 0;
            if (!hasContent) {
              res.emptyCharts.push(bd.parentElement.querySelector('h2')?.textContent || '?');
            }
          });
          // Any element sticking out past the viewport
          const vw = window.innerWidth, vh = window.innerHeight;
          document.querySelectorAll('#app *').forEach(el => {
            const q = el.getBoundingClientRect();
            if (q.width === 0 && q.height === 0) return;
              if (q.right > vw + 1.5 || q.bottom > vh + 1.5 || q.left < -1.5) {
              res.overflowing.push({ cls: 'OUTSIDE ' + el.className + ' ' + el.tagName,
                right: Math.round(q.right), bottom: Math.round(q.bottom), vw, vh,
                txt: (el.textContent || '').slice(0, 30) });
            }
          });
          return res;
        });

        const dots = await page.evaluate(() =>
          getComputedStyle(document.getElementById('pager')).display === 'none'
            ? 0 : document.querySelectorAll('.pager-dot').length);
        const wantDots = nSteps <= 1 ? 0 : nSteps;
        if (dots !== wantDots) {
          failures.push(`${vp.name} / ${tab}: pager shows ${dots} steps, expected ${wantDots}`);
        }
        const label = `${vp.name} / ${tab} / step${step + 1} "${r.stepTitle}"`;
        const phone = vp.width < 620;
        const scrolls = !phone && (r.pageScrollH > r.clientH + 1 || r.pageScrollW > r.clientW + 1);
        if (scrolls) {
          failures.push(`${label}: PAGE SCROLLS  h ${r.pageScrollH}>${r.clientH}  w ${r.pageScrollW}>${r.clientW}`);
        }
        if (r.overflowing.length) {
          failures.push(`${label}: ${r.overflowing.length} overflow(s) ` +
            JSON.stringify(r.overflowing.slice(0, 4)));
        }
        // The content area must get the lion's share; a layout bug that hands
        // the flexible track to a different row passes every overflow check
        // while leaving the charts squashed into a strip.
        const share = r.contentH / r.clientH;
        if (!phone && share < 0.55) {
          failures.push(`${label}: content area only ${Math.round(share * 100)}% of the ` +
            `viewport (rows ${r.gridRows})`);
        }
        if (r.emptyCharts.length) {
          failures.push(`${label}: chart(s) did not render: ${r.emptyCharts.join(', ')}`);
        }
        console.log(`${scrolls || r.overflowing.length || r.emptyCharts.length ? 'FAIL' : ' ok '} ${label}` +
                    `  panels=${r.panels} charts=${r.charts} app=${Math.round(r.appH)}/${r.clientH}`);

        if (vp.width === 768 || vp.width === 1920) {
          const pre = vp.width === 1920 ? 'tv-' : '';
          await page.screenshot({ path: `/home/user/ed-pac-public-view/tests/shots/${pre}${tab}-step${step + 1}.png` });
        }
      }
    }
    await page.close();
  }
  await browser.close();

  console.log('\n' + '='.repeat(70));
  if (consoleErrors.length) {
    console.log('CONSOLE ERRORS:'); consoleErrors.slice(0, 12).forEach(e => console.log('  ' + e));
  } else { console.log('No console errors.'); }
  if (failures.length) {
    console.log('\nFAILURES (' + failures.length + '):');
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('\nAll tabs and steps fit with no page scroll and no panel overflow.');
})();
