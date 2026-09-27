// Produces the four dashboard payloads from the real register, for the layout tests.
require('./gas_stub.js');
const fs = require('fs');
const recs = buildRecords_();
const ri = resolveRefTime_(recs);
const out = {};
for (const sc of ['wcc','bu','pac']) {
  const p = buildScope_(sc, recs, ri);
  p.generatedAt = '05/03/2025 15:00:00';
  out[sc] = p;
}
const a = buildScope_('admin', recs, ri);
a.dataQuality = dataQuality_(recs, ri.ref);
a.units = ['ED WCC','ED BU','PAC WCC'].map(loc => {
  const sub = recs.filter(r=>r.location===loc);
  const inC = sub.filter(r=>countsInCensus_(r, ri.ref));
  const occ = occupancyFor_(recs,[loc],ri.ref);
  let cap=0,f=0,c=0; occ.forEach(o=>{cap+=o.capacity;f+=o.funded;c+=o.crisis;});
  return { location: loc, attendances: sub.length, census: inC.length,
    capacity: cap, funded: f, crisis: c,
    occupancyPct: cap? Math.round(f/cap*1000)/10 : null,
    admitted: sub.filter(r=>r.status==='admitted').length,
    referred: sub.filter(r=>r.status==='referred').length,
    preadmit: sub.filter(r=>r.status==='preadmit').length,
    ongoing: sub.filter(r=>r.status==='ongoingtreatment').length,
    medianAge: summarise_(sub.map(r=>r.age)).median };
});
// Admin scatter carries the unit, for the by-unit colouring.
a.scatter = recs.filter(r=>countsInCensus_(r, ri.ref)).map(r=>{
  const e = elapsedMinutes_(r, ri.ref);
  if (r.age===null || e===null) return null;
  return { x: r.age, y: Math.round(e), z: (r.bed.valid?r.bed.zone:r.zone),
           unit: r.location, admitted: r.status==='admitted' };
}).filter(Boolean);
a.method = methodMetadata_(a);
a.generatedAt = '05/03/2025 15:00:00';
out.admin = a;
fs.writeFileSync(require('path').join(__dirname, 'fixtures', 'payloads.json'), JSON.stringify(out));
console.log('payload bytes:', Object.keys(out).map(k=>k+'='+JSON.stringify(out[k]).length).join(' '));
