# Walk Score Patent Portfolio — Independent Claim Map

**A working document for outside counsel. Prepared 26 July 2026 by an engineer, not a lawyer.**

## What this is, and what it is not

This document exists to save counsel the first eight hours of a freedom-to-operate review. It
enumerates every US patent and published application assigned to **Walk Score Management
LLC**, extracts the text of **every independent claim** in the live patents, and maps each
claim element-by-element against two things:

- **(A) the engine as built today** — the `dream-walk-scores` service, whose scoring logic is
  in `lib/scoring/` and is described in `docs/METHODOLOGY.md` and `walk-score-strategy.md`
- **(B) a proposed replacement metric** that reports raw counts instead of scores (defined
  in §3)

**This is not a legal opinion and must not be relied on as one.** Claim construction, the
doctrine of equivalents, prosecution-history estoppel, validity, and inequitable-conduct
questions are all outside what an engineering read can answer. Every "outside" conclusion
below is an assertion about *literal* claim element presence only, and literal
non-infringement is not the whole test.

Every patent number was individually fetched from Google Patents and resolved to a real
document; claim text is quoted from the granted patents. Two items could **not** be verified
because USPTO Patent Center and Patent Public Search were unreachable from this environment,
and they are flagged in §7 as the first things counsel should confirm.

---

## 1. Executive summary — the six things that matter

**1. The portfolio is closed. There are no pending applications.** All seven granted patents
have issued and both non-granted applications were abandoned in 2018. No continuation was
filed off the most recent members. **Claim scope is therefore fixed** — nobody can draft new
claims aimed at a product they see in the market. This is a materially better risk posture
than a portfolio with a live continuation, and it is the single most reassuring fact here.

**2. The entire walkability family is avoidable by never computing one specific term.** All
**seven** independent claims across `US 8,738,422` and `US 8,892,455` require a **population
density metric**. The engine does not compute population density anywhere — there is no such
term in `lib/scoring/constants.ts` or in any scoring module. On a literal reading, that
single missing element places the current engine outside every independent claim of both
walkability patents. Fortuitously, Ewing & Cervero's meta-analysis finds density only weakly
associated with travel behaviour once other variables are controlled, so there is an
independent methodological reason never to add it.

**3. The real exposure is Transit Score, and it is a patent that was missed in the first
pass.** `US 9,677,892` — the parent of `US 10,962,373`, expiring **2033-03-24**, the
longest-lived asset in the portfolio — claims batch-precomputing transit scores for *a
plurality of locations*, caching them, and serving them through a selection interface. That
is a precise description of `pipeline/precompute_grid.py` writing to `score_cache` and
`app/embed` serving results. Section 4.2 maps all eleven elements; on my reading **every one
is arguably present** in the deployed system. This is the claim to clear before anything
else.

**4. Counting destinations is safe. Drawing the isochrone is not.** `US 10,317,219` is the
broadest travel-shed claim — the graph-reduction limitation present in its two ancestors is
gone. What remains as the distinguishing element is that the output must be **a travel shed
indicating an *area*, formed as a combination of areas associated with reachable nodes**. A
count of reachable destinations is not an area. A rendered isochrone polygon is. That gives a
clean, testable product rule.

**5. Your instinct to use miles rather than minutes is legally helpful, and it conflicts with
my earlier methodology advice.** Every travel-shed claim recites a "threshold period of
**time**." The current engine and your proposed metric both threshold on **distance**. But
`walk-score-strategy.md` §4.2 recommends cumulative-opportunity accessibility measured at the
region's mean commute *time*, which is the better methodology and the more exposed
formulation. This tension is real and counsel should weigh in — see §6.3.

**6. There is no litigation history, and one patent may be lapsing.** No infringement action,
reexamination, IPR, or post-grant review appears on any of the nine documents in 12 years of
issued patents. Separately, the 12-year maintenance fee on `US 8,892,455` was due
**2026-05-18** and is not recorded as paid; it is in the six-month grace period closing around
**2026-11-18**. If unpaid it expires and becomes unenforceable, cutting nearly five years off
its term. Confirm in Patent Center — Google Patents lags fee postings.

---

## 2. Portfolio inventory

Ultimate parent note: **Rocket Companies completed its acquisition of Redfin on 1 July 2025**,
so Walk Score Management LLC's ultimate parent is Rocket Companies (NYSE: RKT), not Redfin
standing alone. No assignment out of Walk Score Management LLC has been recorded, which is
expected for a stock acquisition. This matters for common-ownership and standing questions.

### Granted and active

| Patent | Title (short) | Priority | Granted | Expires | Indep. claims |
| --- | --- | --- | --- | --- | --- |
| **US 8,738,422 B2** | Location assessments | 2007-09-28 | 2014-05-27 | 2030-03-30 | 1, 7, 13, 22 |
| **US 8,892,455 B2** | Location assessments | 2007-09-28 | 2014-11-18 | 2031-02-15 ⚠ fee | 1, 16, 26 |
| **US 9,195,953 B2** | Travel times / travel sheds | 2011-08-16 | 2015-11-24 | 2032-08-18 | 1, 10, 15, 20 |
| **US 9,677,892 B2** | Transit network quality | 2011-08-16 | 2017-06-13 | **2033-03-24** | 1, 12, 23 |
| **US 9,964,410 B2** | Travel times (CON of '953) | 2011-08-16 | 2018-05-08 | 2032-08-16 | 1, 6, 15, 20 |
| **US 10,317,219 B1** | Travel times (CON of '410) | 2011-08-16 | 2019-06-11 | 2032-08-16 | 1, 6, 15 |
| **US 10,962,373 B2** | Transit network quality (CON of '892) | 2011-08-16 | 2021-03-30 | 2032-12-12 | 1, 8, 15 |

### Abandoned — prior art, free to practice

| Publication | Title | Abandoned | Why it matters |
| --- | --- | --- | --- |
| **US 2015/0026088 A1** | Crime assessment tool and method | 2018-07-18 | Claimed severity-weighted crime scoring normalised by population, with dependent claims covering a **walk-shed-defined area** and population estimated from cellular usage. Dead and unrevivable. |
| **US 2015/0356099 A1** | Neighborhood similarity tool and method | 2018-02-22 | **The only document in the portfolio that recites "a bike score metric"** (claims 3 and 19). Dead. There is no granted Bike Score claim anywhere. |

### Family structure

```
FAMILY A — walkability scoring
  Provisional 60/995,823 (2007-09-28)
    ├── US 8,738,422   (siblings, NOT parent/continuation)
    └── US 8,892,455

FAMILY B — travel times & transit quality
  Provisionals 61/524,260 (2011-08-16) + 61/539,944 (2011-09-27)
    ├── B1 travel sheds:  US 9,195,953 → CON US 9,964,410 → CON US 10,317,219
    └── B2 Transit Score: US 9,677,892 → CON US 10,962,373

ORPHANS (abandoned): US 2015/0026088, US 2015/0356099
```

Two corrections to earlier working notes: `'422` and `'455` are **siblings**, both filed
2008-05-07 directly off the same provisional — neither is a continuation of the other, and
there is no earlier non-provisional to find. And `'953`'s granted title uses "**travel**
times," not "commute times"; the latter was the provisional's title.

### Maintenance fee status

| Patent | 4-yr | 8-yr | 12-yr | Next event |
| --- | --- | --- | --- | --- |
| 8,738,422 | 2017-11-16 | 2021-11-24 | 2025-11-18 | none — paid to end of term |
| **8,892,455** | 2018-05-17 | 2022-05-17 | **not recorded** | **⚠ due 2026-05-18, grace to ~2026-11-18** |
| 9,195,953 | 2019-05-23 | 2023-05-03 | — | 12-yr due 2027-05-24 |
| 9,677,892 | 2020-12-10 | 2024-12-06 | — | 12-yr due 2028-12-13 |
| 9,964,410 | 2021-11-08 | 2025-11-06 | — | 12-yr due 2029-11 |
| 10,317,219 | 2022-12-09 | not yet paid | — | 8-yr due 2026-12-11 (window open) |
| 10,962,373 | 2024-09-27 | — | — | 8-yr due 2028-09-30 |

The owner has a consistent pattern of paying late but inside the window (the `'410` 8-year fee
was paid two days before deadline), so the `'455` gap is more likely a data lag or a
grace-period payment than deliberate abandonment. Do not plan around its expiry.

---

## 3. The two systems being mapped

### (A) The engine as built today

Read from `lib/scoring/constants.ts`, `walk.ts`, `bike.ts`, `transit.ts` and `lib/network.ts`
on the deployed commit:

- **Walk**: nine amenity categories; each candidate weighted by a **piecewise-linear distance
  decay** (1.0 to 0.25 mi, zero at 1.5 mi) times a tag-quality multiplier; ranked into
  fixed-weight category slots totalling 15 raw points; multiplied by a **street-shape penalty**
  (intersection density and mean block length, up to −10%); normalised by
  `EFFECTIVE_MAX_POINTS = 14.2` to a **0–100 score**.
- **Transit**: for each route within **0.75 mi**, `mode weight × frequency factor × distance
  decay`, where frequency factor is `min(2.0, √(trips per weekday / 60))`; summed and
  normalised `round(100 × √(min(1, total / 55)))` to a **0–100 score**.
- **Bike**: weighted components — infrastructure 40%, terrain 25%, destinations 25%,
  connectivity 10% — to a **0–100 score**.
- **Distance** is measured by a bounded Dijkstra over a graph built from OSM ways; thresholds
  are in **miles**, not minutes.
- **Caching**: results stored per 25 m grid cell in `score_cache`;
  `pipeline/precompute_grid.py` **batch-computes a grid of locations** (2,800 cells for Fort
  Pierce at 200 m spacing) and stores them.
- **Delivery**: JSON REST and GraphQL APIs; **plus** `app/embed` (an iframe surface),
  `public/embed.js` (a one-line SDK), a home page with an address input, and `/admin`.
- **No population density term exists anywhere in the engine.**
- **No isochrone or travel-shed area is ever computed or rendered.**

### (B) The proposed count-based metric

As proposed by the owner, and the subject of the second mapping column:

1. **Walkable destinations within 2 miles** — a count.
2. **Bikeable destinations within 5 miles** — a count.
3. **Transit stops within ½ mile, and the number of destinations reachable from those stops
   only** — counts.

Explicitly: **no 0–100 score, no distance decay, no category weighting, no normalisation, no
population density, and no area/polygon output.** Thresholds in miles.

---

## 4. Claim-by-claim map

Legend: **PRESENT** = element appears to be practised. **ABSENT** = element appears not to be
practised. **ARGUABLE** = depends on construction or on which product surface is considered.

### 4.1 Family A — US 8,738,422 and US 8,892,455 (walkability)

All seven independent claims are variants of one recipe, claimed as method, system, and CRM,
and from both the requester's and the provider's side. **Every one requires a population
density metric.** Claims `'422`/13 and `'422`/22 use a broader form — "reflecting a population
of a local area around the indicated location," dropping the "relative to a larger
surrounding region" qualifier — so those two are satisfied by *any* population density term.

Mapping `US 8,738,422` claim 1 (representative; the other six differ in framing, not in
substance):

| Claim element | (A) Current engine | (B) Proposed metric |
| --- | --- | --- |
| Receive a request for a location assessment | PRESENT | PRESENT |
| Score based on **distances** to multiple categorised point-location entities | PRESENT | **ABSENT** — unweighted count, no distance term |
| **At least one entity belongs to two or more categories** | **ABSENT** — each POI classified once | ABSENT |
| Score based on **non-point features indicating a pedestrian/bicycle-friendly environment** | ARGUABLE — the street-shape penalty and bike-lane metres are plausibly this | ARGUABLE |
| **Score based on a population density metric** (local vs larger region) | **ABSENT** | **ABSENT** |
| Weighting **inversely related to distance** and directly related to those features | PRESENT — decay curve | **ABSENT** |
| **Weight the aggregate by the population density metric** | **ABSENT** | **ABSENT** |
| Display a representation of the assessment with the location | PRESENT — widget, home page | PRESENT |

**Reading:** three elements absent today, two of them the population-density elements that
appear in all seven independent claims. On a literal analysis the current engine is outside
Family A. The proposed metric is further outside, adding the loss of distance weighting and
of the score itself.

**Two live risks in Family A:**

- **Do not add a population density term.** It is the load-bearing element. Adding it as a
  score modifier would supply the one thing currently missing from all seven claims.
- **Overture `taxonomy.alternates` moves toward a claim element.** `walk-score-strategy.md`
  §A.1 recommends adopting Overture places, whose `alternates` field lets one POI belong to
  two categories (a gas station that is also a grocery store). That is precisely `'422`
  claim 1's "at least one geographic-related entity belongs to two or more of the
  categories." On its own it is one element of eight, but it should be a conscious decision
  rather than a side effect.

### 4.2 Family B branch B2 — US 9,677,892 (Transit Score) ⚠ the exposed claim

Expires **2033-03-24**. Claim 1 quoted in full, element by element:

| Claim element (US 9,677,892 cl. 1) | (A) Current engine | (B) Proposed metric |
| --- | --- | --- |
| Obtain transit information identifying **transit access points** within a geographical area | **PRESENT** — GTFS `gtfs_stop`, 162,389 stops | PRESENT |
| **Determine a plurality of locations** within the area on which to conduct assessments | **PRESENT** — `precompute_grid.py`, 2,800-cell grid | ARGUABLE |
| For each location: inspect transit info for access points **within a threshold distance** | **PRESENT** — `TRANSIT_MAX_WALK_METERS` = 0.75 mi | PRESENT — ½ mi |
| For each access point, assign a **weighted value based on (a) distance AND (b) frequency of service** on the route servicing it | **PRESENT** — `mode × √(trips/60) × decay` | **ABSENT** — no weighting at all |
| **Combine the weighted values into a location score** | **PRESENT** | **ABSENT** — no score |
| **Store the location score for each location in a memory** as location score information | **PRESENT** — `score_cache` | ABSENT (counts may still be cached — see note) |
| Receive from a computing device over a network a request for information regarding the area | **PRESENT** | PRESENT |
| Transmit **interface instructions configured to output an interface enabling selection of a location** from the plurality | **ARGUABLE** — a bare JSON API arguably does not; `embed.js`, `/embed` and the home-page address input arguably do | ARGUABLE |
| Receive an indication of the location made **within the interface** | ARGUABLE — same | ARGUABLE |
| **Retrieve the stored score** for the indicated location | **PRESENT** | ABSENT |
| Transmit the score to the computing device | **PRESENT** | ABSENT |

**Reading: this is the claim that matters.** On my reading every element of `'892` claim 1 is
arguably present in the deployed system once the widget or home page is considered, and the
two arguable elements are the *weakest* basis for a non-infringement position because they
turn on how "interface instructions" is construed rather than on any technical difference.
The batch-precompute-and-cache architecture that makes the product economical is the same
architecture the claim recites.

`US 10,962,373` claim 1 (the continuation, expiring 2032-12-12) is the same weighting logic
rewritten for **a single location** with the caching step removed. It is therefore reached
even without `precompute_grid.py` — a purely on-demand deployment still practises the distance
× frequency weighting and score combination. Both patents are cleared by the same change.

**The single element that breaks both:** assigning a per-access-point weighted value based on
distance **and** service frequency, then combining into a score. The proposed metric removes
exactly this. Counting stops, and counting destinations reachable from them, involves no
per-stop weighting and produces no score.

**Note on caching the proposed metric:** the "store for each of a plurality of locations"
element is satisfied by any precompute cache. But it is only one element, and with the
weighting and score elements absent, caching counts should not by itself bring the proposed
metric inside `'892`. Counsel should confirm.

### 4.3 Family B branch B1 — travel sheds

Three patents, progressively broader as the graph-reduction limitation erodes.

**US 9,195,953 claim 1** — requires processing road-graph data with mode-specific criteria to
identify and **discard a lower-priority portion**, storing a **reduced road graph**, and
**displaying a transit shed on a graphical interface**.

| Element | (A) Current engine | (B) Proposed |
| --- | --- | --- |
| Receive location + **desired travel time** via graphical interface | ABSENT — thresholds are distances | ABSENT |
| **Display a transit shed** on the interface | **ABSENT** — no shed is ever produced | ABSENT |
| Classify road graph into higher/lower priority by mode and **store a reduced graph** | **ABSENT** — full graph, no pruning | ABSENT |

**US 9,964,410 claim 1** — replaces road-type pruning with a quantitative trigger: remove
nodes until **node density falls below a threshold value** (nodes per unit area), then
traverse the reduced graph and **combine reachable nodes into a travel shed**.

| Element | (A) Current engine | (B) Proposed |
| --- | --- | --- |
| **Remove nodes to reach a node-density threshold** | **ABSENT** | ABSENT |
| Request indicating location, **threshold period of time**, mode of transport | ABSENT — distance, not time | ABSENT |
| Combine reachable nodes **into a travel shed indicating areas** | **ABSENT** | ABSENT |

**US 10,317,219 claim 1** — the broadest in the portfolio; **no graph reduction required.**

| Element | (A) Current engine | (B) Proposed |
| --- | --- | --- |
| Data store with a road graph — nodes as locations, edges as routes, edges indicating distance | **PRESENT** — `lib/network.ts` | PRESENT |
| Obtain a location, **a threshold period of time**, and **a mode of transport** | **ABSENT** — distance thresholds; mode is implicit in which score is requested | ABSENT (miles) |
| Traverse using a **subset of edges** to determine **at least a first and second reachable node** within the time threshold | ARGUABLE — bounded Dijkstra does find reachable nodes, but on distance | ARGUABLE |
| **Combine into a travel shed indicating an *area*, where the area is a combination of a first area associated with the first location and a second area associated with the second location** | **ABSENT** — no area is formed | **ABSENT** |
| **Generate an indication of the travel shed** | **ABSENT** | **ABSENT** |

**Reading, and the resulting design rule.** Branch B1 is cleared today on two independent
grounds: no graph reduction, and no area output. The `'219` claim survives the loss of the
first ground, so **the area/shed output is the element to protect**. Hence:

> **Design rule: count reachable destinations; never render or return an isochrone polygon.**
> A count is not "a travel shed indicating an area." A rendered 20-minute-walk boundary,
> built by unioning per-node areas, is squarely what `'219` claim 1 recites — and dependent
> claims 2 and 3 confirm the intended embodiment is exactly a GUI displaying a series of
> geometric shapes.

This is worth naming explicitly because an isochrone map is an obvious and attractive feature
for a real-estate product, and it is the one visualisation to avoid until 2032-08-16.

---

## 5. Consolidated position

| Patent | Expires | Current engine | Proposed metric | Element that decides it |
| --- | --- | --- | --- | --- |
| US 8,738,422 | 2030-03-30 | Outside (literal) | Outside | No population density metric |
| US 8,892,455 | 2031-02-15 ⚠ | Outside (literal) | Outside | No population density metric |
| US 9,195,953 | 2032-08-18 | Outside | Outside | No graph reduction; no shed displayed |
| **US 9,677,892** | **2033-03-24** | **⚠ arguably inside** | Outside | Per-stop distance × frequency weighting → score |
| US 9,964,410 | 2032-08-16 | Outside | Outside | No node-density reduction; no shed |
| US 10,317,219 | 2032-08-16 | Outside | Outside | **No area/travel-shed output** |
| **US 10,962,373** | **2032-12-12** | **⚠ arguably inside** | Outside | Per-stop distance × frequency weighting → score |

**The whole analysis reduces to one sentence:** the walkability patents are already cleared by
the absence of a population density term, the travel-shed patents are cleared by not emitting
an area, and the only genuine exposure is the Transit Score pair — which the proposed
count-based metric resolves.

That is a much narrower problem than "the product infringes three patents," and it means the
redesign the owner proposed is well targeted: it happens to remove precisely the element that
carries the one live risk.

---

## 6. Questions for counsel

### 6.1 The Transit Score claims

- Does `pipeline/precompute_grid.py` + `score_cache` + `embed.js` collectively practise
  `'892` claim 1, and does serving a JSON API without the widget change the answer? The
  "interface instructions configured to output an interface enabling selection of a location"
  element is where I would expect the argument to be.
- Is the proposed count-based transit metric — stops within ½ mile, plus destinations
  reachable from those stops, with no per-stop weighting and no score — outside both `'892`
  and `'373` under the doctrine of equivalents as well as literally? A count is a different
  quantity, but counsel should test whether it performs substantially the same function in
  substantially the same way.
- `'373` had an unusually protracted prosecution — a non-final rejection in 2019 and **three
  separate notices of allowance** (2020-01-08, 2020-05-08, 2020-08-20) with the case twice
  returned to "docketed new case" before grant in March 2021. That file wrapper is worth
  ordering for prosecution-history estoppel and narrowing arguments.

### 6.2 Validity as a defensive card

The Family B priority date is 2011-08-16 and Family A's is 2007-09-28. Cumulative-opportunity
accessibility — literally counting destinations reachable within a threshold — is published
prior art from **Wachs & Kumagai (1973)**; gravity-based accessibility is **Hansen (1959)**;
the 3Ds/5Ds framework and Frank's walkability index predate 2007. Is there a §102/§103
position worth documenting now, even if never asserted? Also note both `'455` claim 26 and
the Family A CRM claims are bare "computer-readable medium" claims rather than
"non-transitory," which may be a §101 vulnerability.

### 6.3 The methodology/exposure tension

`walk-score-strategy.md` §4.2 recommends rebuilding Transit Score as cumulative-opportunity
accessibility with the threshold set to **the region's mean commute time**, because that is
where correlation with gravity-based measures peaks (0.90–0.97). But every travel-shed claim
recites a "threshold period of **time**," and the owner's proposal thresholds on **distance**.
Which of these is the better trade?

My engineering read is that a time threshold is still outside `'219` because no *area* is
produced — the area element does the work, not the time element. But if counsel prefers belt
and braces, distance thresholds are available at a modest methodological cost, and that
choice should be made deliberately rather than by default.

### 6.4 Trademark, which is probably the nearer-term risk

"Walk Score," "Transit Score" and "Bike Score" are Walk Score/Redfin marks. The product
currently computes fields named `walkscore`, exposes `/api/walkscore`, and is described in its
own documentation as "a free replacement for the walkscore.com API." That is descriptive use
of the marks in precisely the context where they are protected, and it is a more likely
trigger for a letter than any patent claim. The proposed count-based reframing removes the
word "score" as a by-product. **Renaming is cheap now and expensive once the marks are in
`dreamneighborhood`'s templates, the widget copy, and partner sites.**

### 6.5 Compatibility endpoint

`/api/walkscore` deliberately reproduces the upstream response shape, status codes and field
names, and accepts-and-ignores `wsapikey`. It is the reason migrating `dreamneighborhood` is a
one-line change with a config-var rollback. It is also the most exposed surface in the system
on both patent and trademark axes. Counsel should advise on whether a short-lived
compatibility shim for a single cutover is acceptable, and if so for how long.

---

## 7. Verification gaps — confirm these first

1. **`US 8,892,455` 12-year maintenance fee.** Due 2026-05-18, no payment recorded as of
   2026-07-26, grace period closes ~2026-11-18. Google Patents lags; confirm in Patent Center.
   If lapsed, the patent is unenforceable and Family A shrinks to `'422` (2030-03-30).
2. **Terminal disclaimers.** None appear on any Google Patents page, but Google's legal-event
   feed does not reliably surface them — they appear on the printed front page and in the file
   wrapper. Given `'410` is a continuation of `'953`, `'219` of `'410`, and `'373` of `'892`,
   all claiming off shared specifications, a disclaimer somewhere in that chain is likely.
   This matters because a terminal disclaimer ties the later patent's enforceability to
   common ownership. Pull the front pages of `'410`, `'219` and `'373`.
3. **Unpublished applications.** Anything filed with a non-publication request, or within the
   last 18 months, would be invisible to every source reachable here. The last filing in the
   portfolio was 2018 and nothing has been filed since, so this is unlikely but not excluded.
4. **Litigation.** Google's litigation feed is incomplete for US district courts. A clean
   record across nine documents and twelve years is credible but not dispositive.
5. **Dependent claims.** This document maps **independent** claims only. Dependent claims
   narrow rather than broaden, so they cannot create exposure where the independent claim is
   cleared — but they are the best evidence of intended scope and are worth reading during
   construction. `'892` claims 9–11 add normalisation against a "perfect score" city, which is
   notable: our `TRANSIT_SATURATION_POINTS = 55` and `EFFECTIVE_MAX_POINTS = 14.2` are
   normalisation constants of a similar character.

---

## 8. Engineering design rules that follow

Independent of what counsel concludes, these cost little and remove most of the argument:

1. **Never compute a population density term.** It is a required element of all seven
   independent claims in Family A, and the literature says it adds little.
2. **Do not weight transit stops by distance × service frequency and combine into a score.**
   This is the sole load-bearing element of both Transit Score patents. Count reachable
   destinations instead.
3. **Never emit an isochrone or travel-shed polygon.** Counting is outside `'219`; unioning
   per-node areas into a displayed shed is inside it. This forecloses an attractive feature
   until 2032-08-16 — decide consciously.
4. **Do not perform mode-specific road-graph reduction or node-density pruning** as a
   performance optimisation. Both are claimed (`'953`, `'410`). If Overpass latency needs
   fixing, fix it with local data (`walk-score-strategy.md` §A.3), not graph pruning.
5. **Think twice about Overture `taxonomy.alternates`.** Multi-category POIs are a `'422`
   claim 1 element.
6. **Rename the outputs, and retire the compatibility shim on a schedule.**
7. **Document the prior-art basis as you build** — cite EPA's National Walkability Index
   (federal, public domain, documented methodology), Wachs & Kumagai (1973), Hansen (1959),
   and the peer-reviewed Walkable Accessibility Score. Implementing published prior art is a
   stronger posture than novel avoidance, and it is what counsel will want on hand.

---

*Claim text quoted from the granted US patents as published on Google Patents, retrieved
26 July 2026. Portfolio enumeration cross-checked against Google Patents DOCDB family data,
inventor-name sweeps across all eleven named inventors, and third-party portfolio counts
(PatSnap and CB Insights both report 9 documents, matching this enumeration). Not legal
advice.*
