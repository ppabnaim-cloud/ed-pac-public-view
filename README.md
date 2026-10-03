# ED / PAC Real-Time Public Dashboard

Jabatan Kecemasan & Pusat Penilaian Pesakit
**Hospital Tengku Permaisuri Norashikin (HTPN), Kajang**

A Google Apps Script web app that lets families check a patient's status in the
Emergency Department or the Patient Assessment Centre, and gives the department
an operational view of capacity, flow and demand.

Bahasa Malaysia is the default language; English is one tap away.

---

## What is in this repository

| File | Purpose |
|------|---------|
| `Code.gs` | Server: data access, aggregation, statistics, forecasting, search, access control |
| `SetupSheet.gs` | Builds the tracking register (headers, dropdowns, formulas, reference sheet) and generates the demonstration scenario |
| `Illustrations.gs` | Generates and serves the public illustrations via the Gemini image model |
| `Index.html` | Page shell |
| `Styles.html` | Design tokens and the fixed, non-scrolling layout |
| `Charts.html` | Inline-SVG chart library (no external dependencies) |
| `I18n.html` | Bahasa Malaysia and English strings |
| `App.html` | Tab and step routing, panel composition, search, admin gate |
| `appsscript.json` | Manifest (time zone, scopes, web-app access) |
| `dist/Code.gs` | **Generated** single-file build — everything in one pasteable file |
| `build/bundle.js`, `build/verify.js` | Builds and checks that single file |
| `sheet/ED_PAC_Register.xlsx` | Ready-to-upload register, pre-filled with the full-capacity scenario |
| `sheet/build_workbook.py` | Regenerates that workbook |
| `docs/VARIABLE_VISUAL_MAP.md` | Which variable each visual carries, and the statistical specification |

---

## Deployment

### Quickest route: the single-file build

`dist/Code.gs` contains everything — server, register builder, illustrations and
the whole interface inlined. Paste it over your existing `Code.gs`, save, and
redeploy. No new files to create.

```
Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy
```

Editing the **existing** deployment keeps the same `/exec` URL, so posters and
QR codes carry on working. Creating a *new* deployment would give you a new URL.

It reads your current `Sheet1` as it stands — 20 columns, header on row 2, data
from row 3. Column 21 (`Discharge Date/Time`) is used if present and ignored if
not, so **you do not need to rebuild the sheet to deploy.** Add
`ADMIN_PASSCODE` under Script Properties or the Administrative tab will not
open, and re-authorise when prompted: the scopes have changed.

Then run **`installWarmTrigger()`** once from the editor. See
[Making it load quickly](#making-it-load-quickly) — without it the dashboard
still works, but every visitor pays for a register read.

Rebuild it after editing any source file:

```bash
node build/bundle.js && node build/verify.js
```

`verify.js` checks that the page inlined in the bundle is byte-identical to the
one the multi-file build produces, that every entry point is present, and that
nothing still tries to load files from disk.

### Multi-file route (better for maintenance)

### 1. Create the spreadsheet and the register

Either upload `sheet/ED_PAC_Register.xlsx` to Google Drive and open it as a
Google Sheet, **or** build it in place:

1. Create a new Google Sheet.
2. **Extensions → Apps Script**, and add every `.gs` and `.html` file from this
   repository (file names must match exactly — `Index`, `Styles`, `Charts`,
   `I18n` and `App` are HTML files).
3. Run `setupRegister()` once. It creates `Sheet1` with the header row, the
   dropdowns, the duration formulas and conditional formatting, plus a
   `Reference` sheet holding the full bed establishment.
4. Run `generateFullScenario()` to populate the demonstration data: every
   funded and escalation bed occupied across all zones, plus 50 patients
   waiting in each green-zone waiting area — 217 records.

Reload the spreadsheet and an **ED/PAC Register** menu appears with both steps.

### 2. Deploy the web app

**Deploy → New deployment → Web app.** Execute as *Me*; access *Anyone*.

The manifest requests only what the app uses: the bound spreadsheet,
outbound requests (for the CSV fallback and image generation), and read-only
Drive access for the illustrations.

### 3. Script Properties

All optional unless stated. **Project Settings → Script Properties.**

| Property | Effect |
|----------|--------|
| `ADMIN_PASSCODE` | **Required to open the Administrative tab.** Without it the tab reports that no code is set. Script Properties are only stored once **Save script properties** is pressed — typing into the boxes and navigating away discards them silently. |
| `ADMIN_EMAILS` | Comma-separated allow-list. Stronger than the passcode, but only works when the deployment executes as the accessing user. |
| `CSV_URL` | Published-CSV fallback, used when the script is not bound to a spreadsheet. |
| `UNIT_COST_PER_ATTENDANCE` | Enables the modelled-cost tile. Left unset, the tile says so rather than inventing a figure. |
| `CAP_ED_BU_yz` (and similar) | Overrides a funded capacity, e.g. `CAP_ED_WCC_rz`. The establishment (funded and escalation counts per zone) lives in `ESTABLISHMENT` at the top of `Code.gs` and is shared with the register generator. |
| `GEMINI_API_KEY` | Enables illustration generation. |
| `GEMINI_IMAGE_MODEL` | Defaults to `gemini-2.5-flash-image`. **Confirm the current identifier against Google's documentation before relying on it** — these change. |
| `ILLUSTRATION_FOLDER` | Drive folder for generated images; created automatically if absent. |
| `IMG_IQMS_ID`, `IMG_POSTER_ID` | Drive file ids for the department's existing posters, used as the illustration fallback. |

---

## The six tabs

The split between them is deliberate: **charts live on the Administrative tab
only.** A family waiting in the department needs to know where their relative
is, how full that zone is and how long the green-zone queue is — not a scatter
plot. The public tabs carry big numbers, a crisis alert and the queue, in plain
Malay; every visualisation sits behind the passcode.

| Tab | Scope | Screens | Content |
|-----|-------|---------|---------|
| Emergency — Women & Children (WCC) | `Location = ED WCC` | 1 | Zone status, search, clinic notice and guidance, all on one page |
| Emergency — Main Building | `Location = ED BU` | 1 | the same |
| Patient Assessment Centre — O&G | `Location = PAC WCC` | 1 | the same |
| Administrative (gated) | all three | 6 steps | Overview · Arrivals & forecast · Waiting times · Case-mix · Bed management · Data quality & method |

**The public tabs are a single page with no pager at all.** Nobody walks up to a
waiting-room television and presses Next, and a family glancing at a screen on
their way past should not have to either. Everything a family needs — the zone
row, the search prompt, the non-emergency notice and the guidance — is on one
screen. The step pager exists only on the Administrative tab.

### What the public tabs show

- **A search prompt**, front and centre, since finding a relative is why most
  people open the page at all.
- **One card per zone in a single row**, left to right in fixed order — Red,
  Yellow, Observation Bay, Asthma Bay, then Green Zone. The row never wraps to
  a second layer: the sequence is the escalation ladder, and reading it across
  is the point. Each card carries how many patients are being cared for against
  that zone's normal bed count, a fill bar and a state badge.
- **A crisis badge on the zone itself** whenever patients exceed that zone's
  normal bed count, naming how many crisis beds that implies. The figure is
  derived from the two numbers printed on the card — patients minus normal
  capacity — so what a reader can see always adds up. The Administrative tab
  keeps the count of beds actually *coded* `crisis`; where the two differ,
  patients are sitting in crisis beds while normal beds stand empty, which the
  data-quality panel reports as a step-down opportunity.
- **The green zone across the full width**: how many are waiting, and the
  average time to be called, averaged over the last ten patients called in.
- **A standing notice** directing non-emergency cases to a Klinik Kesihatan or
  GP clinic, naming what belongs there, and pointing Skim Perubatan MADANI
  holders to a registered GP clinic.
- **Guidance in plain Malay** on every public tab: why the sickest are seen
  first, what each zone means, what happens while waiting for a ward bed, and
  what belongs at a Klinik Kesihatan instead.

The strip above the tabs carries one standing message — that turns are given by
how serious the condition is, not by arrival time.

Deliberately **not** on the public tabs: patient counts by stage of care, and
the running commentary on departmental workload and forecast arrivals that an
earlier draft showed. Those are operational measures; they belong to the staff
view. Public typography also runs a size up throughout, because these screens
are read from several metres away in a waiting area.

### What the Administrative tab shows

Every form the specification lists: **big numbers** (totals, percentages,
ratios, modelled cost), **pie charts** (disposition, sex), a **line graph** with
the **forecast** and its prediction bands, a **scatter plot**, **histograms**
(waiting times, age bands), **bar graphs** (unit comparison, referral
disciplines, field completeness, zone occupancy) and three **heatmaps** (the bed
board, arrival intensity by hour and zone, zone against referral discipline).

**Nothing scrolls** on a 10-inch tablet or anything larger. Verified
automatically at 768×1024, 800×1280, 600×960, 1280×800 and 1920×1080 across
every tab and screen, with additional checks that the public tabs render no
charts, keep their zone cards and search prompt, carry the Klinik Kesihatan
notice, and show no pager.

A phone is the one exception: below 620px the five zone cards cannot share a
row, so they stack in the same order and the content area scrolls. The
no-scroll guarantee was always for the tablet and up, and a phone is a
scrolling device by nature.

Type scales with the viewport, and steps up again above 1000px wide: a wide
screen is almost always a wall display read from across a room, and on a 1080p
television the viewport is no taller than a tablet, so scaling on height alone
would leave the text too small to read at distance.

`docs/VARIABLE_VISUAL_MAP.md` sets out which of the register's columns each
visual carries.

## The statistical model

Stated in full in `docs/VARIABLE_VISUAL_MAP.md` §4, and printed inside the app
on the *Patterns & forecast* and *Data quality & method* steps. In brief:

**Hourly arrivals.** Fitted on complete hours only — the part-elapsed hour is
excluded, because including it biases the level downwards.

- 72 or more complete hours: **additive Holt–Winters**, 24-hour seasonal period
  (α = 0.30, β = 0.05, γ = 0.30).
- 2 to 71 hours: **damped Holt linear trend** (α = 0.40, β = 0.15, φ = 0.85).
  Damping is deliberate — an undamped trend fitted to eight intraday points
  extrapolates implausibly across a four-hour horizon.
- Fewer than 2: no forecast is drawn, and the panel says so.

Arrivals are counts, so prediction intervals assume a Poisson error structure
(variance = mean): 80% is ŷ ± 1.2816·√ŷ, 95% is ŷ ± 1.9600·√ŷ, both floored at
zero. One-step-ahead in-sample MAE and RMSE are printed beneath the forecast.

A trailing run of zero-arrival hours is treated as a **recording gap**, not as
an absence of patients: the model is fitted up to the last hour that recorded an
arrival, projects forward from the reference hour, and the chart is flagged as
an estimate.

**Census projection.** A deterministic flow model,
`C(t+1) = C(t) + A(t+1) − C(t)·(1 − e^(−1/L̄))`, with an exponential
length-of-stay assumption and `L̄` taken from observed total waiting time
(defaulting to 4 hours, flagged, when fewer than five completed episodes
exist). The 80% arrival bounds are propagated to give a band. **No probability
of breach is quoted** — with the observation counts involved, a stated
probability would imply precision the data cannot support.

---

## Decisions worth knowing about

**Colour.** Red, yellow and green zones keep their triage colours: that
convention is a patient-safety standard, not a design choice. Observation,
asthma and PAC are functional areas and take validated categorical slots. The
palette was checked with a colour-vision validator against a white surface; it
passes the adjacent-pair gates, and the two slots that fall below 3:1 contrast
always carry a visible text label, so colour never works alone. Scatter plots
are capped at three colour classes, because across every pair of six hues
separation cannot be guaranteed.

**Light mode only.** This page runs on dedicated tablets and wall screens in
brightly lit waiting areas, and the palette was validated against a white
surface. Rather than ship a dark variant that has not cleared the same gates,
the page pins itself to light.

**Narrative generation is template-driven, not generative.** The plain-Malay
line at the top of each public tab is assembled from the data by fixed
templates. Putting an unreviewed language model's output onto a public hospital
display is a governance risk this dashboard does not take. Illustrations are
generated, but offline, and an administrator reviews them before they appear.

**Search is deliberately narrow.** The public endpoint requires six characters,
matches the *end* of an IC or a whole MRN, needs two name tokens for a name
search, refuses any query matching more than five records rather than returning
a sample, and is rate-limited per user. IC and MRN are both partially masked in
the results. Together these stop the endpoint being usable to enumerate the
register.

**No geographic map.** An earlier draft plotted patients onto a Malaysian state
cartogram derived from IC digits 7–8. Those digits encode state of registration
*at birth*, not where a patient lives, so the map invited exactly the reading it
could not support. It has been removed in favour of the bed board. A genuine
catchment map needs a residential district or postcode in the register.

**The Administrative tab's passcode is a soft gate.** A shared code on an
anonymous URL is weaker than proper authentication. For anything beyond
convenience, deploy the administrative view separately with *Execute as: user
accessing* and set `ADMIN_EMAILS`.

**Admitted patients free their bed.** They remain listed for 24 hours so late
-arriving family can still find them, but they are not counted as occupying an
ED bed. Patients awaiting discharge still hold theirs.

**Escalation beds are counted from the bed code**, not inferred from
`occupied − capacity`. A code ending `crisis` is escalation capacity; the
arithmetic approach mis-states the figure whenever occupancy and capacity drift
apart.

---

## Known gaps in the source register

These are reported honestly in the app rather than filled with proxies.

| Gap | Effect | Fix |
|-----|--------|-----|
| **No mortality field** | The deaths and case-fatality tiles read "not configured". The code already counts `death` / `deceased` / `bid` in `Status` and will display them the moment they appear. | Add those values to the Status dropdown, or a separate outcome column. |
| **No cost feed** | The cost tile reads "not configured" unless `UNIT_COST_PER_ATTENDANCE` is set, and is then labelled as modelled. | An agreed unit cost, or a real costing feed. |
| **No address or district** | No catchment map is possible, so none is shown. | Add a residential district or postcode column. |
| **No discharge timestamp in the original 20-column layout** | Total waiting time could only be computed for admitted patients. | The generated register adds **column 21, `Discharge Date/Time`**, and the dashboard uses it when present. Existing 20-column sheets keep working. |
| **`Called into GZ Room` sparsely populated** | Green-zone waiting time is suppressed below 10 observations rather than shown as a misleading average. | Record the call-in time routinely. |
| **`BWT` / `TWT` populated only for the admitted subset** | Waiting-time medians describe admitted patients. The public histogram therefore uses *time elapsed since triage*, which exists for everyone. | — |

---

## Two points to confirm

1. **Yellow zone, Main Building — bed 17.** Your specification lists funded beds
   `buyz01`–`buyz16` and then begins escalation at `buyz18crisis`, leaving 17
   unaccounted for. The arithmetic of the full-capacity scenario settles it:
   16 funded + 34 escalation = the 50 yellow-zone patients in your extract, so
   bed 17 is an escalation bed. The generator therefore produces
   `buyz17crisis`, and funded yellow-zone capacity is set to **16**. Your
   sample extract codes that bed as plain `buyz17`; if 17 really is a funded
   bed, set `CAP_ED_BU_yz = 17` and regenerate.

2. **PAC and sex.** The Patient Assessment Centre serves antenatal mothers, but
   the sample extract contains 9 PAC records coded Male, and 104 records where
   the `bin`/`binti` name particle disagrees with the recorded sex. Both are
   flagged on the *Data quality* step. The generated register does not
   reproduce them; if they exist in live data they need correcting at source.

---

## The public site on Vercel

Two deployments, one data contract. Apps Script keeps the register and does
the arithmetic; Vercel serves the pages from a CDN. The browser never speaks
to Apps Script.

```
   Google Sheet
        |
   Apps Script  ?api=status   -> aggregates as JSON (counts, no records)
        |
   Vercel /api/status          -> rebuilds the response from a field whitelist,
        |                          edge-caches it for 60 seconds
   The visitor's browser        -> landing page, boards, wall display, posters
```

### Routes

| Path | What it is |
|---|---|
| `/` | Landing page: live headline figures for all three units, the non-emergency notice, the five Peranan Rakyat, links onward |
| `/wcc` `/bu` `/pac` | The zone board for that unit |
| `/iqms` | The hospital's iQMS poster, with a button straight through to the live queue page |
| `/triage` | The hospital's emergency vs non-emergency poster |
| `/tv` | Wall display with the rotating health-promotion rail |
| `/poster` | Six A4 sheets to print: one status poster, five Peranan posters, each with a QR to this deployment |
| `/sihat` | KKM InfoSihat posters, grouped by Peranan. Generated only when posters have been added |
| `/api/status` | The only data path. Aggregates, 60-second edge cache |

### Setting it up

1. **Vercel → Add New → Project**, import this repository.
2. **Root Directory: `web`**. Framework preset: *Other*. No build command —
   `web/` is generated and committed.
3. **Environment variables:**

   | Name | Required | Value |
   |---|---|---|
   | `APPS_SCRIPT_URL` | yes | The web app `/exec` URL. **Must not contain `/u/N/`** — that form is a private, session-scoped link and resolves for nobody else |
   | `APPS_SCRIPT_KEY` | no | Matches the `API_TOKEN` script property, if you set one |

4. Deploy.

Regenerate `web/` after changing any source file, and commit the result:

```bash
node build/web.js
```

One set of partials, two front ends. The status board, the zone arithmetic,
the bilingual strings and the Peranan content each have exactly one home;
`build/web.js` emits a second front end *from* them rather than a second copy
*of* them, so the landing page cannot start disagreeing with the board it
links to. A test asserts that it does not.

### What can cross the boundary

`web/api/status.js` does not forward the upstream response. It rebuilds it
from three named field lists — unit, KPI, zone — and returns only those. The
upstream payload is already aggregates-only and is gated as such against the
real register, but a proxy that forwarded whatever it was handed would pass on
a future mistake. The whitelist also cuts the response from about 54 KB to
under 3 KB, because the public board does not draw the bed board, the scatter,
the heatmaps or the forecast.

If Apps Script is briefly unreachable the function returns the last good
figures it held, marked `stale`, rather than an error: a number that says when
it is from beats a blank panel in a waiting hall. If it has never had a good
response it answers `502` and says so. An Apps Script fault replies in HTML,
and the function refuses to pass a login page off as data.

### KKM health posters

Official Ministry of Health posters from
[InfoSihat](https://infosihat.moh.gov.my/penerbitan-multimedia/poster.html)
can be served alongside the dashboard. Drop the file in `web/kkm/`, add an
entry to `web/kkm/manifest.json`, rebuild — the gallery appears at `/sihat`,
grouped under the Peranan Rakyat it belongs to, and a link appears on the
landing page. `web/kkm/README.md` has the field reference.

They are **downloaded and self-hosted, not linked to moh.gov.my**, for the
same reason the rail carries no third-party embeds: a hospital display should
not render a file that can be moved, renamed or replaced after the hospital
has put it on a screen, it should not send the people standing in front of it
to another host, and the page's `connect-src 'self'` policy only holds if
nothing is fetched from elsewhere. The publisher credit, the source link and
the retrieval date are printed from the manifest on every gallery page.

The build **fails** if the manifest lists a file that is not in the folder,
and warns on anything over 1 MB. With no posters listed, neither the page nor
the link is generated: an empty gallery behind a link on the front page is
worse than no gallery.

## Patient search has been removed

The public interface no longer looks anyone up. Search was the only path by
which it could reach an identifiable record; with it gone, everything the
public side holds is a count, and the Vercel site has no route to a patient at
all.

What stands in its place, on every public tab and on the status poster: *for a
patient's status, please ask at the nurses' counter.* Taking the look-up away
without replacing it would leave a family with no answer and no next step.

The implementation is kept, masking and rate limiting intact, behind a script
property:

| `PUBLIC_SEARCH` | Effect |
|---|---|
| unset (default) | `getPatientStatus` refuses, the header button and the overlay are removed from the document, and the counter panel takes the inline slot |
| `on` | The search returns, exactly as it was |

Tests assert both states: that nothing of it survives by default — no button,
no overlay, no free-text input anywhere on the public view or the Vercel site —
and that one property brings it back intact.

The Vercel build never enables it: `web/` is built with search off and the
build fails outright if the words reach the landing page.

## Making it load quickly

Apps Script is slow in a specific way, and it is worth knowing which part. The
page itself is one download. Everything after that is `google.script.run`, and
**every one of those calls is a cold server invocation**: the runtime starts
and the whole script is parsed before a line of your code runs. A round trip
costs seconds whether it does real work or returns a cached string. So the
number of calls is what a visitor feels, not the amount of work in them.

Three things remove calls rather than shortening them.

**1. `installWarmTrigger()` — run this once.** It installs a time-driven
trigger that runs `warmCache()` every ten minutes, rebuilding all three public
payloads and putting them in the script cache. Ten minutes against a
fifteen-minute cache leaves five minutes of overlap, so an entry is always
replaced before it expires and the cache never goes cold under a visitor. It
needs the `script.scriptapp` scope, so authorise when prompted. Remove it again
with `removeWarmTrigger()`.

**2. The figures are inlined into the page.** `doGet` reads the warm cache and
writes the payloads straight into the HTML, so the first paint carries real
numbers and the first round trip disappears entirely. `doGet` never *builds*
the payloads — only reads what is cached — because a cold cache there would
make every visitor wait on a full register read before a single pixel appeared.
With no warm cache it inlines nothing and the page fetches as it used to.

**3. All three public tabs come down in one call.** `getPublicDashboards()`
reads the register once and builds all three. Switching tabs afterwards costs
no server call at all.

Beyond that the page keeps a last-known snapshot in `localStorage`, so a
returning visitor sees figures immediately rather than a spinner — stamped with
the time they were generated, and discarded beyond two hours, because an old
figure shown without comment is worse than no figure. Illustrations load after
the figures are on screen, not before.

**The ceiling.** Even with all of this, the Apps Script sandbox iframe and its
bootstrap cost roughly one to two seconds that nothing here can remove. If the
wall display needs to be genuinely instant, the page has to move off Apps
Script — serving it from a CDN while Apps Script continues to supply
*aggregates only* over a narrow endpoint. Never a build that ships the register
itself to the browser: that downloads every name, IC and MRN to every visitor,
masking becomes cosmetic and the search rate limit unenforceable.

## Wall-display mode

Add `?mode=tv` to the deployment URL for a hall or lobby television:

```
https://script.google.com/.../exec?mode=tv
```

It keeps the zone board and adds a vertical rail of rotating public-health
cards — *5 Peranan Rakyat ke arah Negara Sehat* — changing every twelve
seconds and following the language toggle. The content lives in `Banner.html`,
one object per card.

The rail is deliberately **absent below 1000px**, so `?mode=tv` opened on a
phone or a 10-inch tablet degrades to the ordinary view. A waiting hall is
captive attention with nothing else to look at, which is exactly what health
promotion normally cannot buy; a family member checking a relative on their own
phone wants one answer, and promotion beside it reads as the hospital changing
the subject.

Three editorial rules are applied to the card content and should survive any
edit:

- **No third-party embeds.** Nothing loads from Instagram, Threads or anywhere
  else. A hospital display must not render content someone else can edit after
  the hospital has endorsed it, and must not track the people standing in front
  of it. Facts are restated in our own words with the source named as plain text.
- **Every clinical claim has to survive a clinician reading it.** Claims that
  could not be supported were dropped rather than softened: one indefensible
  line discredits the defensible ones beside it. Step targets are tiered
  (5,000 to begin, 7,000–8,000 for the full benefit) rather than the
  conventional 10,000, which has no strong evidence base and tells the
  sedentary and elderly — who stand to gain most — that the challenge is not
  for them.
- **Each card ends in something a member of the public can do today.** Advocacy
  aimed at other parties does not belong on this screen.

Card tones are drawn from outside the triage palette on purpose. Red, amber and
green mean a clinical acuity on this screen and must not also mean "health
promotion topic" two hundred millimetres away.

Two citations to confirm against current policy before this goes live: the
front-of-pack scheme named on the sugar card (*Logo Pilihan Sihat*) and the
smoking legislation named on the smoking card.

## The poster tabs

Two tabs are one poster each, served from the hospital's own Drive:

| Tab | File | Script Property |
|---|---|---|
| `iqms` | *Banting iQMS2.jpg* | `IMG_IQMS_ID` |
| `triage` | *Poster Size HOSPITAL TENGKU PERMAISURI NORASHIKIN.png* | `IMG_TRIAGE_ID` |

**Both files must be shared "Anyone with the link can view."** Without that the
image will not load for the public, and the tab falls back to the written
guidance — which is why that fallback exists rather than a blank screen.

They are served as Drive image URLs, **not** base64 through the script. The
originals are 2.4 MB and 21 MB; inlining the second would be some 28 MB of
base64 in one response, which Apps Script will not carry and no phone on
hospital wifi should be asked to download. The Drive CDN resizes on request,
so the page asks for 1600px wide, or 2400px on a wall display.

The iQMS tab also carries a button straight to the live queue page
(`IQMS_URL`, default `https://jknselangor.moh.gov.my/htpn/qms`). The poster's
QR code is right for a printed sheet; on a screen the reader is already
holding the device that would scan it.

## Repairing or redeploying the Apps Script app

Run **`repairSetup()`** from the editor (Run > repairSetup) and read the
execution log. It is the only function you need after pasting a new build. It
checks the register, confirms patient search is off, primes the cache,
installs the warming trigger, and then **prints the web app URL**. Safe to run
as often as you like; nothing in it writes to the register.

If it reports *"no active web app deployment"*, create one:

```
Deploy > New deployment > type: Web app
  Execute as:      Me
  Who has access:  Anyone
```

Accept the permissions prompt, then run `repairSetup()` again — it will print
the URL.

### The URL shape depends on the account type — this is the trap

There are two different correct shapes, and using the wrong one gives a
**Google Drive "Sorry, unable to open the file at present"** page with
*Page not found* in the tab. It is not a script error, and redeploying,
re-authorising or pasting a new build will not change it.

| Account | Web app URL |
|---|---|
| Personal Google account | `https://script.google.com/macros/s/<id>/exec` |
| **Google Workspace** (e.g. `moh.gov.my`) | `https://script.google.com/a/macros/<domain>/s/<id>/exec` |

A Workspace deployment **must keep the `/a/macros/<domain>/` segment**. Strip
it and the address 404s even though the deployment is alive and the code is
fine.

Separately, the editor shows a `/macros/u/1/s/.../exec` form while more than
one Google account is signed in. That is a private, session-scoped link: it
resolves against *account slot 1 in whoever's browser opens it*, so for
everyone else it fails the same way. The shareable URL has no `/u/N/`.

**Do not reconstruct the URL by hand.** Take it from `repairSetup()`, which
prints what `ScriptApp.getService().getUrl()` returns, or from
**Deploy → Manage deployments**. `repairSetup()` names the domain when it sees
a Workspace deployment, and warns on `/u/N/`.

### Workspace sharing

On a Workspace domain, "Who has access: Anyone" can still be overridden by an
admin policy that forbids sharing outside the organisation. If that policy is
in force, members of the public are sent to a Google sign-in page instead of
the dashboard, and the Vercel proxy records the upstream as unavailable rather
than passing a login page off as data. Confirm external sharing with the
Workspace administrator before putting the address on a poster.

### Nothing has to be configured first

A fresh deployment serves the dashboard immediately: no script properties, a
cold cache, and the trigger not yet installed. Tests assert this against the
built `dist/Code.gs` with `ScriptApp` removed, which is how an unauthorised
project behaves. The only things configuration adds are the Administrative tab
(`ADMIN_PASSCODE`) and speed (`installWarmTrigger`). Patient search stays off
whatever you do or do not set.

## Checking the setup

Run **`checkSetup()`** from the Apps Script editor and read the execution log.
It reports, in order: whether `ADMIN_PASSCODE` is actually saved, whether the
register can be read and parsed, whether every bed code is recognised, and
whether each tab builds — with the figures it produced. It is the quickest way
to tell a configuration problem from a data problem.

## Maintenance

- `clearCaches()` — force a refresh of the public dashboards (they cache for 15 minutes).
- `repairSetup()` — the one to run after pasting a new build: checks, primes,
  installs the trigger and prints the web app URL.
- `warmCache()` — rebuild and re-cache all three public payloads now.
- `installWarmTrigger()` / `removeWarmTrigger()` — add or remove the ten-minute
  warming trigger. Run `installWarmTrigger()` once after deploying.
- `node build/web.js` — regenerate the Vercel site into `web/`.
- Script Properties: `PUBLIC_SEARCH` (`on` restores patient search),
  `API_TOKEN` (requires `?key=` on the JSON endpoint).
- `clearRegisterData()` — empty the data rows, keeping structure and validation.
- `generateIllustrations()` — regenerate the public illustrations; review the
  Drive folder afterwards, then `clearIllustrationCache()`.
- `sheet/build_workbook.py` — rebuild the demonstration workbook
  (`pip install openpyxl`, then `python3 build_workbook.py`).
