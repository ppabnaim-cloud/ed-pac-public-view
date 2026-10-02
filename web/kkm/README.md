# KKM InfoSihat posters

Official Ministry of Health health-promotion posters, served from this site
rather than linked to infosihat.moh.gov.my.

## Why self-hosted rather than linked

The same rule the wall-display rail follows. A hospital display should not
render a file that can be moved, renamed or replaced after the hospital has
put it on a screen, and should not send the people standing in front of it to
a third-party host. Downloading the file fixes what is shown, keeps the page
working when the source site is reorganised, and makes the page's
`connect-src 'self'` policy hold.

Reproducing KKM material inside a KKM hospital is plainly within its intended
use. Keep the publisher credit and the source link on every poster — the
gallery adds both automatically from this manifest.

## Adding a poster

1. Download the file from the InfoSihat poster page.
2. Resize it if it is large. Target the long edge at 1600px and the file under
   400 KB; these are read on a phone in a waiting hall, not printed. The build
   warns on anything over 1 MB.
3. Drop it in this folder.
4. Add an entry to `manifest.json`:

```json
{
  "file": "kurangkan-gula.jpg",
  "title": { "ms": "Kurangkan Gula", "en": "Cut Down on Sugar" },
  "role": 2,
  "sourceUrl": "https://infosihat.moh.gov.my/..."
}
```

| Field | |
|---|---|
| `file` | Filename in this folder. The build fails if it is missing |
| `title` | Shown under the poster, both languages. `en` may repeat `ms` |
| `role` | 1–5 to group it under a Peranan Rakyat, or omit for "Lain-lain" |
| `sourceUrl` | The page the file came from. Optional; the manifest `source` is used otherwise |

5. Rebuild and commit:

```bash
node build/web.js
```

The gallery appears at `/sihat` and a link to it appears on the landing page.
With no items, neither is generated — there are no empty pages and no dead
links.

## What the roles mean

| Role | Peranan Rakyat |
|---|---|
| 1 | Bergerak setiap hari |
| 2 | Kurangkan gula |
| 3 | Berhenti suplemen terlebih janji |
| 4 | Lapor merokok di kawasan larangan |
| 5 | Guna perkhidmatan yang betul |
