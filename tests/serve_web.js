/**
 * A local stand-in for Vercel: serves web/ and runs web/api/status.js, with
 * the Apps Script upstream replaced by the test fixture. Used by test_web.js
 * so the site is exercised over HTTP exactly as it will be served, including
 * the API route's own whitelisting.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const payloads = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'payloads.json'), 'utf8'));

const ROUTES = { '/wcc': '/board.html', '/bu': '/board.html', '/pac': '/board.html',
                 '/iqms': '/board.html', '/triage': '/board.html', '/tv': '/board.html' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** Stands in for the Apps Script endpoint the real function calls. */
function upstream() {
  return JSON.stringify({
    ok: true,
    generatedAt: '05/03/2025 15:00:00',
    search: false,
    units: { wcc: payloads.wcc, bu: payloads.bu, pac: payloads.pac }
  });
}

function start(opts) {
  opts = opts || {};
  process.env.APPS_SCRIPT_URL = 'https://upstream.test/exec';
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).indexOf('upstream.test') >= 0) {
      if (opts.upstreamFails) throw new Error('upstream down');
      if (opts.upstreamHtml) return { status: 200, text: async () => '<html>login</html>' };
      return { status: 200, text: async () => upstream() };
    }
    return realFetch(url);
  };
  delete require.cache[require.resolve(path.join(WEB, 'api', 'status.js'))];
  const api = require(path.join(WEB, 'api', 'status.js'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname.replace(/\/+$/, '') || '/index.html';
    if (p === '/api/status') return api(req, res);
    if (ROUTES[p]) p = ROUTES[p];
    if (p === '/') p = '/index.html';
    if (!path.extname(p)) p += '.html';
    const file = path.join(WEB, p);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, () => resolve({ server, port: server.address().port })));
}

module.exports = { start };
