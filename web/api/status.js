/**
 * The only data path the public site has.
 *
 * The browser never talks to Apps Script. This function does, server side,
 * and rebuilds the response from a fixed field list before returning it.
 * That whitelist is the point: the upstream payload is already aggregates
 * only and is gated as such by tests/test_server.js, but a proxy that simply
 * forwards whatever it is given would pass on a future mistake. Nothing can
 * cross this boundary unless it is named below.
 *
 * Environment (Vercel project settings):
 *   APPS_SCRIPT_URL  required  the web app's /exec URL, no /u/N/ in it
 *   APPS_SCRIPT_KEY  optional  matches the API_TOKEN script property
 */

// Only these survive. Everything else the dashboard computes -- the bed board,
// the scatter, the heatmaps, the forecast -- stays on the server, because the
// public board does not draw it.
const UNIT_FIELDS = ['scope', 'locations', 'refTime', 'isSnapshot', 'generatedAt', 'narrative'];
const KPI_FIELDS = ['census', 'capacity', 'waiting', 'crisisBeds', 'gzQueue',
                    'gzAverageWaitMin', 'occupancyPct', 'freeFundedBeds'];
const ZONE_FIELDS = ['zone', 'capacity', 'funded', 'crisis', 'waiting', 'isRoomZone'];

function pick(src, fields) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

function cleanUnit(u) {
  if (!u || typeof u !== 'object') return null;
  const out = pick(u, UNIT_FIELDS);
  out.kpi = pick(u.kpi, KPI_FIELDS);
  out.occupancy = Array.isArray(u.occupancy) ? u.occupancy.map(z => pick(z, ZONE_FIELDS)) : [];
  return out;
}

// Survives between invocations on a warm instance. If the upstream is briefly
// unreachable the site shows the last good figures with their own timestamp,
// rather than an error -- a stale number that says when it is from beats a
// blank panel in a waiting hall.
let lastGood = null;

module.exports = async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');

  const base = process.env.APPS_SCRIPT_URL;
  if (!base) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: 'NOT_CONFIGURED' }));
    return;
  }

  const url = new URL(base);
  url.searchParams.set('api', 'status');
  if (process.env.APPS_SCRIPT_KEY) url.searchParams.set('key', process.env.APPS_SCRIPT_KEY);

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 9000);
    const upstream = await fetch(url.toString(), {
      redirect: 'follow',                       // Apps Script answers via a redirect
      headers: { accept: 'application/json' },
      signal: ctl.signal
    });
    clearTimeout(timer);

    const text = await upstream.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      // An Apps Script fault answers in HTML, not JSON. Say so plainly rather
      // than passing a login page through as if it were data.
      throw new Error('upstream did not return JSON (' + upstream.status + ')');
    }
    if (!raw || raw.ok !== true || !raw.units) throw new Error(raw && raw.error || 'upstream error');

    const body = {
      ok: true,
      generatedAt: raw.generatedAt || null,
      units: {
        wcc: cleanUnit(raw.units.wcc),
        bu: cleanUnit(raw.units.bu),
        pac: cleanUnit(raw.units.pac)
      }
    };
    lastGood = { at: Date.now(), body };

    // One upstream call a minute at most, however many people are looking.
    res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=600');
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  } catch (err) {
    if (lastGood) {
      res.setHeader('cache-control', 'public, s-maxage=30');
      res.statusCode = 200;
      res.end(JSON.stringify(Object.assign({ stale: true }, lastGood.body)));
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.statusCode = 502;
    res.end(JSON.stringify({ ok: false, error: 'UPSTREAM_UNAVAILABLE' }));
  }
};
