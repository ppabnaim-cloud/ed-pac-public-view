/**
 * Locates a Chromium build. Honours PLAYWRIGHT_CHROMIUM if set, otherwise
 * looks in PLAYWRIGHT_BROWSERS_PATH (where CI images place it) and finally
 * lets Playwright resolve its own download.
 */
const fs = require('fs');
const path = require('path');

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dirs = fs.readdirSync(root).filter(d => d.startsWith('chromium-'));
    for (const d of dirs) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* fall through to Playwright's own resolution */ }
  return undefined;   // let Playwright decide
}

module.exports = { findChromium };
