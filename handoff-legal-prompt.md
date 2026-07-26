# Single handoff prompt for the DN-integration agent

Written 26 July 2026. The standalone `dream-walk-scores` service is being wound down as a
product; the mobility scoring capability is moving into the `dreamneighborhood` widget's
mobility section, built by a separate Cursor agent working in that repo.

Everything below the line is one self-contained prompt for that agent. Source material for it
lives in this repo: `patent-claim-map.md` (every independent claim mapped element by element)
and `walk-score-strategy.md` (methodology and data sources).

---

## Task

You are working in the `dreamneighborhood` repository (a Django + PostGIS "Neighborhood
Explorer" real-estate product). Mobility metrics — walkability, bikeability and transit access
— are being brought in-house and surfaced in the widget's mobility section, replacing the
walkscore.com API this codebase currently calls.

Produce **two deliverables**:

1. **`legal-analysis.md`** at the repository root — a working document for outside counsel
   covering the legal exposure this change creates.
2. **Additions to the repository's existing TODO file** — locate it (likely `TODO.md`) and
   append a "Legal and compliance" section using the checklist in the final part of this
   prompt. Create the file only if none exists. Adapt the items to what you actually find in
   the code; do not paste them blindly.

## Hard rules — read these first

- **You are an engineer writing for a lawyer. Do not give legal advice.** Do not state legal
  conclusions, do not assert that anything is lawful or unlawful, and do not invent, quote or
  paraphrase case law. Write "this appears to", "counsel should determine whether". Any
  conclusion you draw must be explicitly limited to *literal* patent-claim-element presence or
  to observable facts about the code.
- **Do not change any application code.** If you find a compliance problem, document it and
  propose the fix; do not implement it in this change.
- **Do not create or modify user-facing legal text** — no terms of service, no privacy policy,
  no disclaimers, no attribution copy. Recommend what is needed and let counsel draft it.
- **Cite files and line numbers** for every statement about what the code does.
- **Distinguish sharply and label** (a) verified fact, (b) your engineering reading, (c) what
  needs counsel.
- **Verify every patent number resolves** to a real document before citing it. Google Patents
  at `https://patents.google.com/patent/USXXXXXXXX/en` is fetchable. Never guess a number.
- **Quote claim language verbatim** where the exact words carry the argument.
- If you cannot verify something, **say so plainly** rather than filling the gap.

## Context

All six of this product's Walk Score consumers flow through `get_mobility_data()` in
`apps/widget/services.py`, which flows through one HTTP call in
`apps/widget/utils/get_walk_score_utils.py`. Walk Score® attribution appears in at least
`templates/core/data_sources.html`, `assets/javascript/widget/full_script.js` and
`templates/reports/neighborhood_report.html` — verify and complete that list.

This repository already holds **the full Overture Maps dataset in PostGIS via GeoDjango**,
which is central to the licensing analysis below.

A prior project built a standalone version of this engine. Its methodology and a full
independent-claim map were researched in the `motormouthvis/dream-walk-scores` repository
(`patent-claim-map.md`, `walk-score-strategy.md`). You do not need to re-derive the patent
research given below, but you must verify anything you rely on.

## Established facts — treat as given, verify rather than investigate

Provided by the product owner:

- This product has only ever used the **free** walkscore.com API tier. **Never a paid
  subscription**, so there is no negotiated commercial agreement to review.
- It has **never scraped** walkscore.com.
- It has **never stored or cached** Walk Score values.
- The free API is being **abandoned immediately**.

## Verified patent facts

All assigned to **Walk Score Management LLC**. Walk Score was acquired by Redfin in 2014;
**Rocket Companies completed its acquisition of Redfin on 1 July 2025**, so the ultimate parent
is now Rocket Companies (NYSE: RKT). No assignment out of Walk Score Management LLC is
recorded.

The portfolio is **nine US documents: seven granted and active, two abandoned. There are no
pending applications, so claim scope is fixed** — nobody can draft new claims aimed at a
product they observe in the market. **No litigation, reexamination, IPR or post-grant review**
appears on any of the nine in twelve years of issued patents.

| Patent | Expires | Independent claims | What claim 1 turns on |
| --- | --- | --- | --- |
| US 8,738,422 | 2030-03-30 | 1, 7, 13, 22 | Walkability score requiring **a population density metric** |
| US 8,892,455 | 2031-02-15 (see fee note) | 1, 16, 26 | Same recipe, provider-side; also requires **population density** |
| US 9,195,953 | 2032-08-18 | 1, 10, 15, 20 | Travel shed via **mode-specific road-graph pruning** + GUI display |
| **US 9,677,892** | **2033-03-24** | 1, 12, 23 | **Batch-precomputing transit scores for many locations, caching them, serving via a selection interface** |
| US 9,964,410 | 2032-08-16 | 1, 6, 15, 20 | Travel shed via **node-density-threshold pruning** |
| US 10,317,219 | 2032-08-16 | 1, 6, 15 | Broadest travel shed — no pruning required; turns on **emitting an *area*** |
| US 10,962,373 | 2032-12-12 | 1, 8, 15 | Single-location transit score, distance × service-frequency weighting |

Abandoned, therefore prior art and free to practise: **US 2015/0026088 A1** (crime assessment
tool, abandoned 2018-07-18) and **US 2015/0356099 A1** (neighborhood similarity, abandoned
2018-02-22 — the only document in the portfolio that recites "a bike score metric"; there is no
granted Bike Score claim anywhere).

Family structure: `'422` and `'455` are **siblings** off one 2007 provisional, not
parent-and-continuation. `'953` → `'410` → `'219` is the travel-shed chain; `'892` → `'373` is
the Transit Score chain, both off 2011 provisionals.

Four claim details that matter most here:

1. **All seven independent claims in the two walkability patents require a population density
   metric.** Two of them (`'422` claims 13 and 22) use a broader form satisfied by *any*
   population density term; the rest require local population **relative to a larger
   surrounding region**. A system computing no population density term appears to fall outside
   all seven on a literal reading.
2. **`US 8,738,422` claim 2 recites: "wherein the method is performed by a real estate
   information provider, and wherein the indicated location is a street address of a residence
   that is available for purchase."** That dependent claim describes this product precisely. It
   does not broaden claim 1, but it is direct evidence of the intended target and counsel
   should know it exists.
3. **`US 9,677,892` claim 1 requires computing scores for *a plurality of locations*, storing
   them in memory, then serving a stored score through an interface that lets a user select a
   location.** Map any grid-precompute-into-a-table design against this element by element. Its
   two "interface instructions" elements were merely *arguable* for a bare JSON API — **they
   are much less arguable inside a product with property pages, a widget and a map.** This is
   the highest-exposure claim in the portfolio and the longest-lived.
4. **`US 10,317,219` claim 1 requires forming "a travel shed indicating an area... a
   combination of a first area associated with the first location and a second area."** A count
   of reachable destinations is not an area. A rendered isochrone polygon is.

## Six design rules — audit the implementation against each

Report compliance with file and line citations:

1. **No population density term** anywhere in the metric computation.
2. **No per-transit-stop weighted value based on distance AND service frequency, combined into
   a score.** This is the single load-bearing element of both Transit Score patents.
3. **No isochrone or travel-shed area** computed, returned or rendered — including on a map.
4. **No mode-specific road-graph reduction and no node-density pruning** as a performance
   optimisation. Both are claimed.
5. **Multi-category POIs are a claim element.** `'422` claim 1 requires "at least one
   geographic-related entity belongs to two or more of the categories". If the implementation
   uses Overture's `taxonomy.alternates` (a gas station that is also a grocery store), flag it.
6. **No use of the marks.** "Walk Score", "Bike Score" and "Transit Score" are Walk Score /
   Redfin trademarks. Flag every occurrence in this repository of those marks, of any field,
   column, function or URL named `walkscore` or similar, and of any text describing the feature
   as a Walk Score replacement or equivalent.

## Issue areas to research

### A. Terms of service on the free API

Given the established facts above, the contract-termination and cached-data-deletion questions
do not arise. Three narrower things remain:

- **Locate and archive the free-tier terms of service** that governed prior use, and record
  what they said about attribution, permitted use, caching, and building competing or
  derivative products. Free tiers are frequently *more* restrictive than paid ones on exactly
  these points — non-commercial-use clauses, mandatory attribution and no-caching provisions
  are common — so they are worth having on file even though usage is ending.
- **Verify the negatives so counsel has them on record.** Search the repository and database
  schema for stored or cached Walk Score values — tables, columns, fixtures, migrations, test
  data, committed CSVs, cached HTTP responses. The expected result is none. **Report the search
  you performed and its negative result.** A documented negative is worth far more than an
  unstated assumption, and it is cheap now and expensive to reconstruct later.
- **Confirm all outbound calls to walkscore.com are removed** at cutover, not merely unreachable
  behind a feature flag, and cite the files where the calls were made.

**One inherited fact to record neutrally.** The scoring constants that may be ported into this
product were originally fitted in the sibling `dream-walk-scores` repository, whose
*development-time* calibration tool (`npm run calibrate`, `scripts/calibration-set.ts`) compared
computed values against **published Walk Score reference values retrieved from walkscore.com**.
It was never a runtime dependency and no values were stored. This product did not do it. But if
those fitted constants are carried across, the derivation history travels with them, and counsel
may wish to know how the numbers were tuned. State the fact plainly; **do not characterise it as
a breach and do not extend it into a CFAA discussion** — the conduct was retrieval of publicly
published values by a separate project, and assessing it is counsel's job. Note as a possible
mitigation that re-fitting the constants against EPA's National Walkability Index and the
peer-reviewed Walkable Accessibility Score would remove the question entirely.

### B. Trademark removal and substitution

Determine what attribution was required *while* the free API was in use, what must be removed
at cutover, and propose replacement naming for the in-house metrics that uses neither the marks
nor a confusingly similar variant. Note that describing the feature as "like Walk Score" or a
"Walk Score equivalent" in UI copy, marketing or documentation is a separate question from the
field names. Flag that once the product displays its own numbers, continuing to show Walk
Score® attribution is both factually inaccurate and a trademark problem.

### C. Fair Housing Act and steering — research this seriously

This is a **real-estate product**, and neighborhood scoring in real estate has a documented
history of fair-housing scrutiny. On the facts as known this is one of the two most likely
issues to matter. Cover:

- whether a mobility or neighborhood score that influences **which listings are surfaced,
  ranked, or how they are described** could constitute steering or produce a disparate impact
  under the Fair Housing Act;
- that **Redfin has itself faced housing discrimination litigation**, and that several major
  real-estate platforms **removed crime data** from listings for these reasons;
- that Walk Score's own **crime-scoring application (US 2015/0026088) was abandoned**, and
  whether any crime, safety or composite "neighborhood quality" signal is planned here — if so,
  treat it as a distinct and elevated risk and say so;
- whether the scores feed anything touching **valuation, appraisal or lending**, which brings
  appraisal-bias considerations into scope;
- what disclosure, documentation or auditability counsel might want — for example retaining the
  full breakdown behind every number so a score can be explained after the fact.

Be concrete about mechanism, not hand-wavy: identify in the code where scores could influence
ranking, filtering or listing presentation, and cite it.

### D. Accessibility (ADA / WCAG)

**Walk Score and Redfin were sued in 2017 over website accessibility for blind users** —
precedent in this exact product space, and the other of the two most likely issues to matter.
Assess whether the mobility widget — score chips, colour-coded bands, any map or chart — is
usable with a screen reader and meets WCAG 2.2 AA, including whether meaning is conveyed by
colour alone. Cite the relevant template and JS files.

### E. Open-data licensing

This repository holds the full Overture dataset in PostGIS, which matters legally:

- **Overture `places` is CDLA-Permissive-2.0 / Apache-2.0 and contains no OpenStreetMap data**,
  so no share-alike obligation. Prefer it for the POI layer.
- **Overture `transportation`, `buildings`, `base` and `divisions` are ODbL**, being OSM-derived.
- Under ODbL a **Produced Work** needs attribution only; a **Derivative Database** triggers
  share-alike under §4.4 and a machine-readable-copy offer under §4.6. Determine which applies
  when derived scores are **stored persistently in this product's own database and served from
  it**. This is materially different from a stateless API answering one query at a time — a
  systematically populated table of scores derived from an ODbL network sits closer to a
  Derivative Database. Cite the **OSMF Geocoding Community Guideline** as the closest analogous
  guidance.
- Produce a **per-source table**: source, licence, share-alike yes/no, attribution required
  yes/no, and where that attribution currently appears in the UI. Include GTFS feeds, whose
  terms are **per-agency** and are the integrator's responsibility even though the Mobility
  Database's own metadata is CC0.
- Flag that **OpenAddresses must not be used without per-source licence filtering** (it does
  not relicense from its sources; several are share-alike and a few revocable), and that
  **Mapillary-derived data is CC-BY-SA with revocable terms** so should not be persisted.

### F. What moving in-house improves

State this explicitly so counsel does not have to infer it: the standalone design needed a
`/api/walkscore` compatibility endpoint reproducing the upstream response shape, status codes
and field names so migration would be a one-line change. **Computing in-house removes the need
for that endpoint entirely**, and with it the most patent- and trademark-exposed surface of the
whole design. Confirm whether any shape-mirroring code exists here and recommend it not be
created.

## Required structure for `legal-analysis.md`

1. **Purpose and limits** — engineer not lawyer; not legal advice; what was verified and how;
   what could not be verified.
2. **Executive summary** — findings that would change a decision, ordered by likelihood of
   mattering. On the facts as known, **Fair Housing and accessibility lead**, followed by the
   `US 9,677,892` transit claim; the terms-of-service question is comparatively minor because
   only the free tier was used, nothing was scraped and nothing was stored. Order by what your
   own research supports and say so if you disagree with that ranking.
3. **What this product does** — the actual implementation with file and line citations. Be
   specific about where metrics are computed, where they are stored, and where they are
   displayed.
4. **Patent analysis** — the portfolio table, then a table per independent claim mapping each
   element against this implementation, marked PRESENT / ABSENT / ARGUABLE with ARGUABLE
   justified.
5. **Trademark.**
6. **Terms of service.**
7. **Fair Housing, steering and valuation.**
8. **Accessibility.**
9. **Open-data licensing**, with the per-source table.
10. **Questions for counsel** — precise, answerable, each tied to a section above.
11. **Verification gaps** — what you could not confirm and exactly where to confirm it.
12. **Design rules** — the engineering constraints that follow, in imperative form.

## Two things to verify that prior research could not

USPTO Patent Center and Patent Public Search were unreachable during the earlier work. Re-check
both and report:

- whether the **12-year maintenance fee on US 8,892,455**, due 2026-05-18, has been paid. It
  was unrecorded as of 2026-07-26 and the grace period closes around 2026-11-18. If it lapsed,
  that patent is unenforceable and one of the two walkability patents drops out.
- whether **terminal disclaimers** exist on `US 9,964,410`, `US 10,317,219` or
  `US 10,962,373`. Google Patents does not reliably surface these; the printed front page and
  the file wrapper do. A disclaimer ties the later patent's enforceability to common ownership.

## TODO checklist to append

Add under a "Legal and compliance" heading, adapted to what you actually find:

**Before cutover**

- [ ] Remove every outbound walkscore.com call — not merely disable behind a flag — and remove
      Walk Score® attribution at the same time.
- [ ] Archive a copy of the free-tier terms of service for the file.
- [ ] Document the negative: record a search establishing no Walk Score values are stored or
      cached anywhere.
- [ ] Record how the scoring constants were derived if ported from `dream-walk-scores`, or
      re-fit them against EPA's National Walkability Index and the Walkable Accessibility Score
      to remove the question and improve the methodology.
- [ ] Confirm `US 8,892,455` maintenance-fee status in USPTO Patent Center (grace closes
      ~2026-11-18).
- [ ] Pull terminal disclaimers for `US 9,964,410`, `US 10,317,219`, `US 10,962,373`.
- [ ] Decide and trademark-clear replacement naming before it reaches templates, the widget,
      partner sites or marketing.
- [ ] Obtain written engineering sign-off against the six design rules, as a contemporaneous
      record that the constraints were applied deliberately.

**Patent work for counsel**

- [ ] Freedom-to-operate opinion on `US 9,677,892` claim 1 — batch-precompute-and-cache,
      expiring 2033-03-24, highest exposure.
- [ ] Order the `US 10,962,373` file wrapper — protracted prosecution (non-final rejection
      2019, three notices of allowance in 2020, grant 2021) may support prosecution-history
      estoppel or narrow construction.
- [ ] Doctrine-of-equivalents assessment of a count-based metric against the Transit Score
      claims; literal non-infringement is not the whole test.
- [ ] Document a §102/§103 prior-art position: cumulative-opportunity accessibility in Wachs &
      Kumagai (1973), gravity-based accessibility in Hansen (1959), Frank's walkability index
      and the 3Ds/5Ds framework — all predating the 2007 and 2011 priority dates.
- [ ] Consider the §101 question on the bare "computer-readable medium" claims
      (`US 8,892,455` claim 26 and the Family A CRM claims), not recited as "non-transitory".
- [ ] Decide whether to defensively publish genuinely novel elements — street-lighting-based
      night walkability, accessibility-aware routing via the OpenSidewalks schema.

**Regulatory and product risk**

- [ ] Fair Housing review of the mobility feature: steering, disparate impact, and whether
      scores influence listing ranking, filtering or description. Separate review before any
      crime, safety or composite "neighborhood quality" signal is added.
- [ ] Decide the explainability standard and retention period — keeping each score's full
      breakdown makes numbers defensible after the fact.
- [ ] Identify any valuation, appraisal or lending touchpoints and the obligations that attach.
- [ ] WCAG 2.2 AA audit of the widget, with attention to colour-only meaning in score bands.

**Data licensing**

- [ ] ODbL determination for persisted derived scores — Produced Work or Derivative Database?
      Cite the OSMF Geocoding Community Guideline.
- [ ] Architect the licence split deliberately: keep the ODbL network layer internal and
      query-time only; source the POI layer from Overture `places` (CDLA, no OSM content) so
      the amenity layer stays free of share-alike.
- [ ] Per-agency GTFS licence audit; consider the FTA GTFS Weblinks registry instead
      (public domain, federally mandated).
- [ ] Verify required attribution actually renders in the UI and survives template changes.
- [ ] Do not use OpenAddresses without per-source licence filtering; do not persist
      Mapillary-derived data.

**Insurance and governance**

- [ ] Check whether existing insurance covers IP infringement defence; confirm media /
      technology E&O.
- [ ] Store the decision trail durably — `legal-analysis.md` plus the `patent-claim-map.md` and
      `walk-score-strategy.md` research from the sibling repo.
