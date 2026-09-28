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
| 5 | IC / Passport | Identifier | 217/217 | Search key only | Search overlay (masked) |
| 6 | MRN | Identifier | 217/217 | Search key | Search overlay (partially masked) |
| 7 | Age | Continuous (1–85) | 217/217 | Case-mix | Age histogram; scatter Y-partner; age-band bar |
| 8 | Gender | Categorical (2) | 217/217 | Case-mix | Gender pie; PAC data-quality check |
| 9 | Zone Code | Categorical (6) | 217/217 | Acuity proxy (`rz`>`yz`>`gz`; `ob`,`ab`,`pac` functional) | Capacity bars, heatmap columns, scatter colour |
| 10 | Bed / Position Code | Structured string | 217/217 | **Capacity state.** `<loc><zone><NN>` = funded bed; `…crisis` = overflow bed; `<loc>gz-waiting` = queue, not a bed | Occupancy/crisis bars, crisis KPI, GZ queue KPI, **bed board** |
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
| `ageBand` | 0–4, 5–12, 13–17, 18–29, 30–44, 45–59, 60–74, 75+ | Bar/histogram |
| `meanLOS` | Mean of TWT (hours) | Census projection |
| `bedBoard` | Every position in the establishment, occupied or not, with its occupant's dwell time | Bed board heatmap |
| `dwellMin` | Minutes from triage to now (or to admission) for the bed's occupant | Bed board cell shade |
| `modelledCost` | attendances × configurable unit cost (**off unless configured**) | Big number |

---

## 2. Tab and step architecture

Hard constraint: **every screen fits a 10-inch tablet in portrait (768 × 1024 CSS px) with no page scroll.** The shell is a fixed `100vh` grid — header 52 px, narrative strip 40 px, tab bar 48 px, step bar 44 px, content the remainder. Where a section holds more than fits, it is split into numbered **steps** reached by a pager, never by scrolling.

**The division of labour is deliberate and absolute:**

| | Tabs 1–3 (public) | Tab 4 (Administrative) |
|---|---|---|
| Audience | Families in the waiting area | Department staff |
| Question answered | Where is my relative, how full is their zone, how long is the green-zone queue | How is the service performing |
| Charts | **None** | **All of them** |
| Access | Open | Passcode gated |

A family in a waiting room does not need a scatter plot. Every chart, distribution, forecast and matrix therefore lives on the Administrative tab; the public tabs carry big numbers, a crisis alert and the queue, in plain Malay.

### Tabs 1–3 — public view

| Tab | Scope filter | Screens |
|-----|-------------|---------|
| **A — Emergency Department, Women & Children Centre** | `Location = ED WCC` | 1 |
| **B — Emergency Department, Main Building** | `Location = ED BU` | 1 |
| **C — Patient Assessment Centre, O&G** | `Location = PAC WCC` | 1 |

Each is a **single page with no pager**. A waiting-room television cannot be paged, so everything a family needs sits on one screen.

| Panel | Form | Variables |
|-------|------|-----------|
| **One card per zone, in a single row** — Red, Yellow, Observation Bay, Asthma Bay, Green Zone, left to right and never wrapped. Patients being cared for against the zone's normal bed count, a fill bar and a state badge | **Big numbers** | Bed code (10), Zone (9) |
| Green-zone card — queue length and average time to be called | **Big numbers** | Queue No. (14), Called into GZ (15), Triage (2) |
| Crisis alert, when crisis beds are activated | Conditional banner | Bed code (10) |
| Patient search prompt | Call to action | 3, 5, 6 via the search overlay |
| Non-emergency notice — Klinik Kesihatan, GP, Skim Perubatan MADANI | Standing banner | — |
| Family guidance — urgency order, what each zone means, waiting for a ward bed, what belongs at a Klinik Kesihatan | Plain-language text | — |

The strip above the tabs carries one standing message: patients are seen in order of clinical urgency, not order of arrival.

**Excluded from the public view by design:** patient counts by stage of care, and any commentary on departmental workload or forecast arrivals. Both are operational measures for the staff view. Public type scales with the viewport and steps up again above 1000px wide, for reading across a waiting room.

### Tab 4 — Administrative (gated)

Every visual the specification asks for lives here.

| Step | Panels | Form | Variables |
|------|--------|------|-----------|
| 1 — Overview | Attendances, admitted, deaths, referral rate, median time in department, modelled cost | **Big numbers** (total, percentage, ratio, cost) | 1, 12, 19 |
| | Comparison across the three units | **Grouped bar** | 1, 12 |
| | Disposition mix | **Pie / donut** | 12 |
| 2 — Arrivals & forecast | Arrivals per hour with the projection and its 80 % / 95 % bands | **Line graph + forecast** | 2 |
| | Projected patients in the department | **Line with band** | 2, 19, 10 |
| 3 — Waiting times | Time already spent in the department | **Histogram** | 2, 17, 21 |
| | Age against time in department, coloured by unit | **Scatter plot** | 7, 2, 1 |
| | Model specification and in-sample accuracy | Text | — |
| 4 — Case-mix | Referrals by discipline | **Bar graph** | 13 |
| | Age groups | **Histogram** | 7 |
| | Zone against referral discipline | **Heatmap** | 9 × 13 |
| | Sex | **Pie / donut** | 8 |
| 5 — Bed management | Places, occupancy, free beds, escalation open | **Big numbers** | 10 |
| | Bed board — every bed position, shaded by its occupant's dwell time | **Heatmap** | 10, 2, 12 |
| | Arrival intensity by hour and zone | **Heatmap** | 2 × 9 |
| 6 — Data quality & method | Field completeness | **Bar graph** | all |
| | Integrity flags and step-down candidates | Text | all |
| | Zone occupancy against establishment | **Stacked bar** | 10, 9 |

## 3. Heatmap specification

Three heatmaps, all sequential single-hue (light → dark blue), all carrying the
three legend elements the brief requires: **scale**, **unit**, and **a sentence
stating what dark versus bright means**.

| Heatmap | Rows × Columns | Cell value | Unit | Legend sentence |
|---------|---------------|-----------|------|-----------------|
| **Bed board** | Zone × bed position | Hours the occupant has been in the department | hours in department | "Each cell is one bed. Dark = longest in that bed; bright = just arrived; white dashed = empty. The black rule marks normal capacity." |
| Arrival intensity | Hour of day × Zone | Count of arrivals | patients per hour per zone | "Darker cells carry more arrivals in that hour and zone; brighter cells carry fewer." |
| Zone × discipline | Zone × Referral discipline | Count of referrals | referrals | "Darker cells are frequently used referral routes; brighter cells are rare." |

### The bed board

The primary bed-management visual, present on all three clinical tabs (scoped
to that unit) and on the Administrative tab (all nine zones across the three
units at once).

It enumerates **every position in the establishment**, not only those appearing
in the register. This matters: a register lists occupied beds, but the question
a bed manager asks is where the *free* ones are. Empty beds are therefore drawn
as white cells with a dashed outline, and counted.

Each row is a zone. Cells run left to right in bed order. A black rule marks
where funded capacity ends, so escalation beds are the cells to its right; those
cells also carry the same diagonal hatch used for escalation capacity elsewhere
in the dashboard, so colour is never the only cue. The count at the right of
each row turns red when no *funded* bed is free, which is the moment escalation
becomes unavoidable.

Shading is the occupant's dwell time — minutes from triage to now, or to
admission where that has happened. A dark cluster is a zone where patients have
been held a long time, which is what bed management needs to see; a row of pale
cells is a zone that has just turned over.

Green-zone waiting places are deliberately **excluded**: a queue position is not
a bed, and counting the 50 waiting patients as occupancy would overstate bed
demand several-fold. They appear instead as the green-zone queue KPI and on the
capacity bars.

**Not derivable:** a true geographic catchment map. The register holds no
residential address, district or postcode. An earlier draft approximated it from
IC digits 7–8, but those encode state of registration *at birth*, not where the
patient lives, so it was removed rather than left to be misread.

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
| **Geographic catchment map** | Removed. IC digits 7–8 give state of registration at birth, not residence, so the map would have been read as something it was not. The bed board occupies that panel instead. | Residential district, postcode or state |
| **Case-fatality / mortality rate** | Blocked by the deaths gap above. | as above |
