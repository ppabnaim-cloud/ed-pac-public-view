# Variable → Visual Mapping Specification

**Dashboard:** ED / PAC Public & Operational View
**Site:** Hospital Tengku Permaisuri Norashikin (HTPN), Kajang
**Source:** `Sheet1` of the ED_PAC tracking register (20 columns, header on row 2, data from row 3)
**Reference extract:** 217 records, single operating day (2025-03-05, triage 07:00–15:00)

---

## 1. Source variables and their analytical role

| # | Column | Type | Completeness in extract | Analytical role | Carried by |
|---|--------|------|------------------------|-----------------|------------|
| 1 | Location | Categorical (3) | 217/217 | **Tab selector.** `ED BU`, `ED WCC`, `PAC WCC` | Tab routing; unit-comparison bar (Admin) |
| 2 | Triage Date/Time | Datetime | 217/217 | Arrival clock — the time axis for everything | Line graph, heatmap rows, forecast input, wait derivations |
| 3 | Full Name | Free text | 217/217 | Search key only (never plotted) | Search overlay, masked to `N. Surname` |
| 4 | Initial | Free text | 217/217 | Not used — redundant with (3) | — |
| 5 | IC / Passport | Identifier | 217/217 | Search key; digits 7–8 give state-of-registration | Search (masked); Malaysia tile cartogram |
| 6 | MRN | Identifier | 217/217 | Search key | Search overlay (partially masked) |
| 7 | Age | Continuous (1–85) | 217/217 | Case-mix | Age histogram; scatter Y-partner; age-band bar |
| 8 | Gender | Categorical (2) | 217/217 | Case-mix | Gender pie; PAC data-quality check |
| 9 | Zone Code | Categorical (6) | 217/217 | Acuity proxy (`rz`>`yz`>`gz`; `ob`,`ab`,`pac` functional) | Capacity bars, heatmap columns, scatter colour |
| 10 | Bed / Position Code | Structured string | 217/217 | **Capacity state.** `<loc><zone><NN>` = funded bed; `…crisis` = overflow bed; `<loc>gz-waiting` = queue, not a bed | Occupancy/crisis bars, crisis KPI, GZ queue KPI |
| 11 | Current Zone | Categorical (6) | 217/217 | Duplicates (9) in this extract | Cross-check flag only |
| 12 | Status | Categorical (4 seen) | 217/217 | Disposition | Status pie, admission/referral rate KPIs |
| 13 | Referred To | Categorical (9) | 71/217 (33%) | Referral demand by discipline | Referral bar; zone × discipline heatmap |
| 14 | Queue No. (GZ only) | Integer-as-text | 104/217 | Green-zone queue position | GZ queue big number |
| 15 | Called into GZ Room | Datetime | **4/217 (1.8%)** | Consultation start | GZ wait — *flagged as unstable, n too small* |
| 16 | Pre-admit Date/Time | Datetime | 40/217 (18%) | Decision-to-admit | Boarding-wait derivation; funnel KPI |
| 17 | Admit Date/Time | Datetime | 21/217 (10%) | Ward transfer | Boarding KPI; admitted census |
| 18 | BWT (hh:mm) | Duration | 21/217 | Bed waiting time (boarding) | BWT histogram; median BWT KPI |
| 19 | TWT (hh:mm) | Duration | 21/217 | Total waiting time (triage → admit) | TWT histogram; scatter Y-axis; LOS input to census projection |
| 20 | GZWT (hh:mm) | Duration | **4/217** | Green-zone waiting time | Suppressed unless n ≥ 10 |

### Derived variables computed by the dashboard

| Derived | Definition | Carried by |
|---------|-----------|------------|
| `census` | Rows with active status (`ongoingtreatment`, `referred`, `preadmit`) + `admitted` within 24 h | Big number |
| `occupancy %` | Occupied funded beds ÷ funded capacity | Big number, capacity bar |
| `crisisBeds` | Count of `Bed / Position Code` matching `…crisis` (counted from the code, **not** inferred from overflow arithmetic) | Big number, crisis banner |
| `admissionRate %` | (`preadmit` + `admitted`) ÷ attendances | Big number |
| `referralRate %` | `referred` ÷ attendances | Big number |
| `arrivalsPerHour` | Count of records grouped by `HOUR(Triage)` | Line graph, forecast input |
| `stateOfRegistration` | IC digits 7–8 → Malaysian state | Tile cartogram |
| `ageBand` | 0–4, 5–12, 13–17, 18–29, 30–44, 45–59, 60–74, 75+ | Bar/histogram |
| `meanLOS` | Mean of TWT (hours) | Census projection |
| `modelledCost` | attendances × configurable unit cost (**off unless configured**) | Big number |

---

## 2. Tab and step architecture

Hard constraint: **every screen fits a 10-inch tablet in portrait (768 × 1024 CSS px) with no page scroll.** The shell is a fixed `100vh` grid — header 56 px, tab bar 48 px, step bar 44 px, content the remainder. Where a section holds more than fits, it is split into numbered **steps** reached by a pager, never by scrolling.

| Tab | Scope filter | Steps |
|-----|-------------|-------|
| **A — Emergency Department, Women & Children Centre** | `Location = ED WCC` | 3 |
| **B — Emergency Department, Main Building** | `Location = ED BU` | 3 |
| **C — Patient Assessment Centre, O&G** | `Location = PAC WCC` | 2 |
| **D — Administrative** | All locations (passcode-gated) | 4 |

### Tab A / B — clinical, per site

| Step | Panels | Visual type | Variables |
|------|--------|-------------|-----------|
| 1 — Current status | 4 KPI tiles | **Big numbers** | census; occupancy %; crisis beds; GZ queue length |
| | Zone occupancy | **Stacked bar** (funded + crisis overflow vs capacity) | Bed code (10), Zone (9) |
| | Crisis banner | Conditional alert | crisisBeds > 0 |
| 2 — Flow & waiting | Arrivals by hour | **Line graph**, 2 series (arrivals, cumulative) | Triage (2) |
| | Waiting-time distribution | **Histogram**, 60-min bins | TWT (19) |
| | Disposition mix | **Pie / donut** | Status (12) |
| 3 — Patterns & forecast | Arrival intensity | **Heatmap**, hour × zone | Triage (2) × Zone (9) |
| | Age vs waiting time | **Scatter plot**, coloured by zone | Age (7) × TWT (19) × Zone (9) |
| | Next 4 hours | **Forecast** with 80 % / 95 % band | arrivalsPerHour |

### Tab C — PAC (n = 15 in extract, so deliberately leaner)

| Step | Panels | Visual type | Variables |
|------|--------|-------------|-----------|
| 1 | 4 KPI tiles + zone occupancy + disposition | **Big numbers, bar, pie** | 10, 12 |
| 2 | Age bands + referral discipline + forecast + data-quality flags | **Histogram, bar, forecast** | 7, 13, 2, 8 |

### Tab D — Administrative

| Step | Panels | Visual type | Variables |
|------|--------|-------------|-----------|
| 1 — Overview | 6 KPI tiles; unit comparison | **Big numbers** (attendances, admitted, deaths, admission %, median TWT, modelled cost) + **grouped bar** | 1, 12, 19 |
| 2 — Case-mix | Referral discipline; age bands; gender; zone × discipline | **Bar, histogram, pie, heatmap** | 13, 7, 8, 9 |
| 3 — Geography & forecast | Malaysia state tiles; zone × hour intensity; hospital-wide forecast | **Cartogram heatmap, heatmap, forecast** | 5, 9, 2 |
| 4 — Data quality & method | Field completeness; integrity flags; model specification | **Bar + text** | all |

---

## 3. Heatmap specification

Three heatmaps, all sequential single-hue (light → dark teal), all carrying the same three legend elements the brief requires: **scale**, **unit**, and **a sentence stating what dark versus bright means**.

| Heatmap | Rows × Columns | Cell value | Unit | Legend sentence |
|---------|---------------|-----------|------|-----------------|
| Arrival intensity | Hour of day × Zone | Count of arrivals | patients per hour per zone | "Darker cells carry more arrivals; brighter cells carry fewer. The darkest cell is the busiest hour-and-zone combination of the day." |
| Zone × discipline | Zone × Referral discipline | Count of referrals | referrals | "Darker cells are more frequent referral routes; brighter cells are rarer ones." |
| Malaysia states | Geographic tile grid, 16 states/territories | Patients registered to that state | patients | "Darker states contribute more patients to this department today; brighter states contribute fewer; unshaded states contributed none." |

The Malaysia visual is a **geographically-arranged tile cartogram**, not a true outline map — this keeps it legible in a ~300 px tablet panel. It is derived from **IC digits 7–8, which encode state of registration at birth, not current residence**. It is therefore labelled as an origin proxy, and the caveat is printed inside the panel. A genuine catchment map needs a residential address, district or postcode field, which the register does not currently hold.

---

## 4. Forecast specification

### Model selection (automatic, stated on the chart)

Hourly arrival counts `y₁…yₙ` are taken from **complete hours only** — the current, partially-elapsed hour is excluded, because including it biases the level downwards.

1. **n ≥ 72 complete hours (≥ 3 days):** additive **Holt–Winters** with seasonal period m = 24 (level, trend, hour-of-day seasonality) — α = 0.30, β = 0.05, γ = 0.30.
2. **2 ≤ n < 72 (the reference extract's case):** **damped Holt linear trend** (double exponential smoothing) — α = 0.40, β = 0.15, damping φ = 0.85.
3. **n < 2:** no forecast; the panel states that instead of drawing a line.

Damping is used deliberately: an undamped trend fitted to 8 intraday points extrapolates implausibly over a 4-hour horizon.

Recursions (damped Holt):

```
ℓₜ = α·yₜ + (1−α)(ℓₜ₋₁ + φ·bₜ₋₁)
bₜ = β(ℓₜ − ℓₜ₋₁) + (1−β)·φ·bₜ₋₁
ŷₜ₊ₕ = ℓₜ + (φ + φ² + … + φʰ)·bₜ,  floored at 0
```

### Prediction intervals

Arrivals are counts, so a Poisson error structure is assumed (variance = mean):

```
80 % interval: ŷ ± 1.2816·√ŷ
95 % interval: ŷ ± 1.9600·√ŷ      (both floored at 0)
```

### Accuracy reported on-screen

One-step-ahead in-sample MAE and RMSE are computed and printed beneath the forecast, so the reader can see how far to trust it.

### Census projection (secondary forecast)

Projected occupancy uses a deterministic flow equation with an exponential length-of-stay assumption:

```
Ĉₜ₊₁ = Ĉₜ + Âₜ₊₁ − Ĉₜ·(1 − e^(−1/L̄))
```

where `L̄` is mean TWT in hours (defaulting to 4.0 h, flagged, when fewer than 5 TWT values exist). The 80 % arrival bounds are propagated through the same equation to give a projected-occupancy band. **No probability of breach is quoted** — with 21 completed episodes in the extract, a stated probability would imply more precision than the data supports.

### Stated limitations (printed in the Administrative tab)

- The reference extract is a **single day**, so no day-of-week or seasonal effect can be estimated; the seasonal model activates only once multi-day history accumulates in the sheet.
- TWT and BWT exist for 21 of 217 records (the admitted subset) — waiting-time medians describe **admitted patients only** and are not department-wide.
- `Called into GZ Room` has 4 values; green-zone waiting time is suppressed below n = 10 rather than shown as a misleading average.
- `Referred To` is populated for 33 % of records; referral rates are expressed against total attendances, not against referred-only.

---

## 5. Metrics requested by the brief but not derivable from the current register

Stated plainly rather than substituted with a proxy:

| Requested | Status | Field needed to enable it |
|-----------|--------|--------------------------|
| **Deaths** | Not present. The dashboard counts `death` / `deceased` / `bid` in `Status` and will display the tile the moment those values appear; until then it reports 0 with the gap noted. | A `death`/`bid` value in `Status`, or a separate outcome column |
| **Cost** | Not present. Rendered only if a unit cost is configured in Script Properties, and then labelled "modelled — unit cost × attendances, not actual billing". | Actual costing feed, or an agreed unit cost per attendance/zone |
| **Malaysia catchment map** | Approximated from IC state of registration, with the caveat printed in-panel. | Residential district, postcode or state |
| **Case-fatality / mortality rate** | Blocked by the deaths gap above. | as above |
