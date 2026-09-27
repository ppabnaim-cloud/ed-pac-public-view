/**
 * ILLUSTRATIONS — friendly explanatory images for the public view,
 * generated with Google's Gemini image model ("Nano Banana").
 *
 * The generation step is deliberately OFF the request path. A public
 * dashboard must not call a generative model while a family is waiting for
 * the page: it would be slow, it would bill per view, and it would put
 * unreviewed output in front of patients. Instead an administrator runs
 * generateIllustrations() once, reviews what comes back in the Drive folder,
 * and the dashboard then serves those reviewed, cached images.
 *
 * Setup (Script Properties):
 *   GEMINI_API_KEY        required to generate; without it nothing is called
 *   GEMINI_IMAGE_MODEL    optional, defaults below — confirm the current
 *                         model id against Google's documentation, as these
 *                         identifiers change
 *   ILLUSTRATION_FOLDER   optional Drive folder id to write into
 *   ILLUSTRATION_IDS      written by the generator; read by the dashboard
 *
 * If no key is configured the dashboard falls back to the department's own
 * poster images, and failing that to the built-in inline diagrams. The public
 * page never shows a broken panel because a model was unavailable.
 */

var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
var DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image';
var ILLUSTRATION_CACHE_KEY = 'illustrations_v1';

/**
 * The image set. Prompts are written for a Malaysian public hospital waiting
 * area: warm, plain, and free of anything that could be read as clinical
 * instruction. No text is requested inside the images — captions are rendered
 * by the page, so they stay translatable and legible at any size.
 */
var ILLUSTRATION_SPECS = [
  {
    key: 'triage',
    captionMs: 'Kenapa ada pesakit didahulukan?',
    captionEn: 'Why are some patients seen first?',
    prompt: 'A warm, friendly flat vector illustration for a Malaysian public ' +
      'hospital waiting area. Three groups of patients waiting in a bright, calm ' +
      'emergency department, gently colour-coded by area: one area red, one amber, ' +
      'one green. A nurse in a light blue uniform with a tudung guides a patient ' +
      'towards the red area. Diverse Malaysian families of different ages, modest ' +
      'everyday clothing. Soft teal and cream palette, rounded shapes, no text, ' +
      'no logos, no gore, no medical equipment detail. Reassuring and calm.'
  },
  {
    key: 'queue',
    captionMs: 'Nombor giliran Zon Hijau',
    captionEn: 'How the Green Zone queue works',
    prompt: 'A warm, friendly flat vector illustration for a Malaysian public ' +
      'hospital. A family sitting comfortably in a bright green-zone waiting area, ' +
      'looking at a large blank display board on the wall and at a blank paper ' +
      'slip in hand. A consultation room door is open nearby with a doctor ' +
      'welcoming someone in. Soft teal and cream palette, rounded shapes, ' +
      'no text or numbers anywhere, no logos. Patient and hopeful mood.'
  },
  {
    key: 'when',
    captionMs: 'Bila perlu ke Jabatan Kecemasan?',
    captionEn: 'When to come to the Emergency Department',
    prompt: 'A warm, friendly flat vector illustration, split into two calm halves ' +
      'for a Malaysian public hospital. On one side a person clutching their chest ' +
      'being helped urgently by a paramedic. On the other side a person with a ' +
      'minor scrape sitting calmly at a community clinic reception. Soft teal and ' +
      'cream palette, rounded shapes, diverse Malaysian people, modest clothing, ' +
      'no text, no logos, no blood, nothing frightening.'
  },
  {
    key: 'wait',
    captionMs: 'Sementara menunggu',
    captionEn: 'While you are waiting',
    prompt: 'A warm, friendly flat vector illustration for a Malaysian public ' +
      'hospital waiting area. An elderly woman in a tudung and her adult daughter ' +
      'sitting together on waiting-room chairs, sharing a flask of water, with a ' +
      'nurse passing by and smiling. Large windows, plants, warm daylight. Soft ' +
      'teal and cream palette, rounded shapes, no text, no logos. Calm, dignified, ' +
      'unhurried mood.'
  }
];

/**
 * Generates the illustration set and stores the Drive file ids.
 * Run this from the editor, then open the folder and review every image
 * before the public deployment is refreshed.
 */
function generateIllustrations(opts) {
  opts = opts || {};
  var key = prop_('GEMINI_API_KEY');
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set in Script Properties. ' +
      'Without it the dashboard falls back to the department posters.');
  }
  var model = prop_('GEMINI_IMAGE_MODEL') || DEFAULT_IMAGE_MODEL;
  var folder = illustrationFolder_();

  var only = opts.only || null;
  var ids = readIllustrationIds_();
  var report = [];

  for (var i = 0; i < ILLUSTRATION_SPECS.length; i++) {
    var spec = ILLUSTRATION_SPECS[i];
    if (only && only.indexOf(spec.key) < 0) continue;
    try {
      var blob = requestImage_(key, model, spec.prompt, spec.key);
      // Replace rather than accumulate, so the folder stays reviewable.
      var existing = folder.getFilesByName(spec.key + '.png');
      while (existing.hasNext()) existing.next().setTrashed(true);
      var file = folder.createFile(blob);
      file.setDescription('ED/PAC dashboard illustration "' + spec.key +
        '" generated ' + new Date().toISOString() + ' with ' + model +
        '. Review before publishing.');
      ids[spec.key] = file.getId();
      report.push(spec.key + ': ok (' + file.getId() + ')');
    } catch (err) {
      report.push(spec.key + ': FAILED — ' + (err && err.message || err));
    }
  }

  PropertiesService.getScriptProperties()
    .setProperty('ILLUSTRATION_IDS', JSON.stringify(ids));
  try { CacheService.getScriptCache().remove(ILLUSTRATION_CACHE_KEY); } catch (e) { /* not cached yet */ }

  return 'Model: ' + model + '\nFolder: ' + folder.getUrl() + '\n' + report.join('\n') +
    '\n\nReview every image in that folder before relying on it publicly.';
}

function requestImage_(apiKey, model, prompt, name) {
  var url = GEMINI_ENDPOINT + encodeURIComponent(model) + ':generateContent';
  var payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    throw new Error('HTTP ' + code + ' from ' + model + ': ' + body.slice(0, 300));
  }

  var json = JSON.parse(body);
  var cands = json.candidates || [];
  for (var i = 0; i < cands.length; i++) {
    var parts = (cands[i].content && cands[i].content.parts) || [];
    for (var j = 0; j < parts.length; j++) {
      var inline = parts[j].inlineData || parts[j].inline_data;
      if (inline && inline.data) {
        var mime = inline.mimeType || inline.mime_type || 'image/png';
        var ext = mime.indexOf('jpeg') >= 0 ? '.jpg' : '.png';
        return Utilities.newBlob(Utilities.base64Decode(inline.data), mime, name + ext);
      }
    }
  }
  // A safety block returns 200 with no image part; say so plainly.
  var reason = cands.length && cands[0].finishReason ? cands[0].finishReason : 'no image in response';
  throw new Error('No image returned (' + reason + ')');
}

function illustrationFolder_() {
  var id = prop_('ILLUSTRATION_FOLDER');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* fall through and create */ }
  }
  var name = 'ED-PAC Dashboard Illustrations';
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  PropertiesService.getScriptProperties().setProperty('ILLUSTRATION_FOLDER', folder.getId());
  return folder;
}

function readIllustrationIds_() {
  var raw = prop_('ILLUSTRATION_IDS');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

/**
 * Serves the reviewed illustrations to the page, with the department's own
 * posters as the fallback. Cached, because these are large and unchanging.
 */
function getIllustrations() {
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(ILLUSTRATION_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* oversize or cold cache — rebuild below */ }

  var ids = readIllustrationIds_();
  var out = { items: [], source: 'none' };

  for (var i = 0; i < ILLUSTRATION_SPECS.length; i++) {
    var spec = ILLUSTRATION_SPECS[i];
    if (!ids[spec.key]) continue;
    try {
      var blob = DriveApp.getFileById(ids[spec.key]).getBlob();
      out.items.push({
        key: spec.key, captionMs: spec.captionMs, captionEn: spec.captionEn,
        dataUri: 'data:' + blob.getContentType() + ';base64,' +
                 Utilities.base64Encode(blob.getBytes())
      });
    } catch (err) { /* a deleted or unshared file simply drops out of the set */ }
  }
  if (out.items.length) out.source = 'generated';

  if (!out.items.length) {
    var posters = getImages();
    if (posters.iqms) {
      out.items.push({ key: 'iqms', captionMs: 'iQMS — semakan nombor giliran',
        captionEn: 'iQMS — check your queue number online', dataUri: posters.iqms });
    }
    if (posters.poster) {
      out.items.push({ key: 'poster', captionMs: 'Kes kecemasan vs bukan kecemasan',
        captionEn: 'Emergency vs non-emergency', dataUri: posters.poster });
    }
    if (out.items.length) out.source = 'posters';
  }

  // Only cache what comfortably fits; large data URIs are served uncached.
  try {
    var json = JSON.stringify(out);
    if (json.length < 90000) cache.put(ILLUSTRATION_CACHE_KEY, json, 21600);
  } catch (e) { /* serve uncached */ }
  return out;
}

/** Clears the cached set after regenerating or replacing an image. */
function clearIllustrationCache() {
  CacheService.getScriptCache().remove(ILLUSTRATION_CACHE_KEY);
  return 'cleared';
}
