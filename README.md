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
| `sheet/ED_PAC_Register.xlsx` | Ready-to-upload register, pre-filled with the full-capacity scenario |
| `sheet/build_workbook.py` | Regenerates that workbook |
| `docs/VARIABLE_VISUAL_MAP.md` | Which variable each visual carries, and the statistical specification |

---

## Deployment

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
| `ADMIN_PASSCODE` | **Required to open the Administrative tab.** Without it the tab reports that no code is set. |
| `ADMIN_EMAILS` | Comma-separated allow-list. Stronger than the passcode, but only works when the deployment executes as the accessing user. |
| `CSV_URL` | Published-CSV fallback, used when the script is not bound to a spreadsheet. |
| `UNIT_COST_PER_ATTENDANCE` | Enables the modelled-cost tile. Left unset, the tile says so rather than inventing a figure. |
| `CAP_ED_BU_yz` (and similar) | Overrides a funded capacity, e.g. `CAP_ED_WCC_rz`. |
| `GEMINI_API_KEY` | Enables illustration generation. |
| `GEMINI_IMAGE_MODEL` | Defaults to `gemini-2.5-flash-image`. **Confirm the current identifier against Google's documentation before relying on it** — these change. |
| `ILLUSTRATION_FOLDER` | Drive folder for generated images; created automatically if absent. |
| `IMG_IQMS_ID`, `IMG_POSTER_ID` | Drive file ids for the department's existing posters, used as the illustration fallback. |

---

## The four tabs

| Tab | Scope | Steps |
|-----|-------|-------|
| Emergency — Women & Children (WCC) | `Location = ED WCC` | Current status · Arrivals & waiting times · Patterns & forecast |
| Emergency — Main Building | `Location = ED BU` | the same three |
| Patient Assessment Centre — O&G | `Location = PAC WCC` | Current status · Arrivals & referrals |
| Administrative (gated) | all three | Overview · Case-mix · Geography & forecast · Data quality & method |

**Nothing scrolls.** The shell is a fixed grid of viewport height; where a
section holds more than fits, it is split into numbered steps reached by the
pager at the foot of the screen. This is verified automatically at 768×1024,
800×1280 and 600×960 across every tab and step.

`docs/VARIABLE_VISUAL_MAP.md` sets out which of the register's columns each
visual carries.

---

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
| **No address or district** | The Malaysia map is built from IC digits 7–8, which give *state of registration at birth*, not residence. The caveat is printed in the panel. | Add a residential district or postcode column. |
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

## Maintenance

- `clearCaches()` — force a refresh of the public dashboards (they cache for 5 minutes).
- `clearRegisterData()` — empty the data rows, keeping structure and validation.
- `generateIllustrations()` — regenerate the public illustrations; review the
  Drive folder afterwards, then `clearIllustrationCache()`.
- `sheet/build_workbook.py` — rebuild the demonstration workbook
  (`pip install openpyxl`, then `python3 build_workbook.py`).
