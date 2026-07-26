# Handoff: prompt for the DN-integration agent, and further legal work

Written 26 July 2026. The standalone `dream-walk-scores` service is being wound down as a
product; the mobility scoring capability is moving into the `dreamneighborhood` widget's
mobility section, built by a separate Cursor agent working in that repo.

This file contains two things:

1. **§1 — a self-contained prompt** for that agent, instructing it to produce
   `legal-analysis.md` in the DN repo. It carries every verified fact it needs so it does not
   have to redo the patent research.
2. **§2 — further legal analysis** to add to the DN repo's TODO file, including several issues
   that only arise because the capability now lives inside a commercial real-estate product.

Source material in this repo: `patent-claim-map.md` (every independent claim mapped) and
`walk-score-strategy.md` (methodology and data sources).

---

# §1 — Prompt for the DN-integration agent

> Copy everything below this line into the other agent.

---

## Task

Write a new file `legal-analysis.md` at the root of this repository. It is a working document
for outside counsel covering the legal exposure created by computing walkability, bikeability
and transit-access metrics **in-house inside this product**, replacing the paid
walkscore.com API that this codebase currently calls.

You are an engineer writing for a lawyer. **Do not give legal advice, do not state legal
conclusions, and do not invent or paraphrase case law.** Your job is to lay out verified
facts, map them against what this codebase actually does, and pose precise questions. Every
conclusion you draw must be explicitly limited to *literal* patent-claim-element presence or
to observable facts about the code. Say "this appears to" and "counsel should determine
whether", never "this is lawful".

## Background you need

This product (`dreamneighborhood`, a Django + PostGIS "Neighborhood Explorer") currently pays
for the walkscore.com API. All six of its Walk Score consumers flow through
`get_mobility_data()` in `apps/widget/services.py`, which flows through one HTTP call in
`apps/widget/utils/get_walk_score_utils.py`. The plan is to compute these metrics in-house
from open data and surface them in the widget's mobility section.

A prior project built a standalone engine that did this. Its methodology, and a full map of the
relevant patent claims, were researched in the `motormouthvis/dream-walk-scores` repository —
specifically `patent-claim-map.md` and `walk-score-strategy.md` there. **You do not need to
re-derive the patent research below, but you must verify anything you rely on**, because two
items in it could not be confirmed (noted at the end).

## Verified patent facts — carry these into the document

All assigned to **Walk Score Management LLC**. Walk Score was acquired by Redfin in 2014;
**Rocket Companies completed its acquisition of Redfin on 1 July 2025**, so the ultimate parent
is now Rocket Companies (NYSE: RKT). No assignment out of Walk Score Management LLC is
recorded.

The portfolio is **nine US documents: seven granted and active, two abandoned. There are no
pending applications, so claim scope is fixed** — nobody can draft new claims aimed at a
product they observe in the market. No litigation, reexamination, IPR or post-grant review
appears on any of the nine in twelve years.

| Patent | Expires | Independent claims | What claim 1 turns on |
| --- | --- | --- | --- |
| US 8,738,422 | 2030-03-30 | 1, 7, 13, 22 | Walkability score requiring **a population density metric** |
| US 8,892,455 | 2031-02-15 ⚠ | 1, 16, 26 | Same recipe, provider-side; also requires **population density** |
| US 9,195,953 | 2032-08-18 | 1, 10, 15, 20 | Travel shed via **mode-specific road-graph pruning** + GUI display |
| **US 9,677,892** | **2033-03-24** | 1, 12, 23 | **Batch-precomputing transit scores for many locations, caching them, serving via a selection interface** |
| US 9,964,410 | 2032-08-16 | 1, 6, 15, 20 | Travel shed via **node-density-threshold pruning** |
| US 10,317,219 | 2032-08-16 | 1, 6, 15 | Broadest travel shed — no pruning required; turns on **emitting an *area*** |
| US 10,962,373 | 2032-12-12 | 1, 8, 15 | Single-location transit score, distance × service-frequency weighting |

Abandoned, therefore prior art and free to practise: **US 2015/0026088 A1** (crime assessment,
abandoned 2018-07-18) and **US 2015/0356099 A1** (neighborhood similarity, abandoned
2018-02-22 — the only document in the portfolio that recites "a bike score metric").

Four claim details that matter most for this integration:

1. **All seven independent claims in the two walkability patents require a population density
   metric.** Two of them (`'422` claims 13 and 22) use a broader form satisfied by *any*
   population density term; the others require it be local population relative to a larger
   surrounding region. A system that computes no population density term appears to fall
   outside all seven on a literal reading.
2. **`US 8,738,422` claim 2 recites: "wherein the method is performed by a real estate
   information provider, and wherein the indicated location is a street address of a residence
   that is available for purchase."** That dependent claim describes this product precisely.
   It does not broaden claim 1, but it is direct evidence of the intended target, and counsel
   should know it exists.
3. **`US 9,677,892` claim 1 requires computing scores for *a plurality of locations*, storing
   them in memory, then serving a stored score through an interface that lets a user select a
   location.** Any design that precomputes a grid of scores into a database table and serves
   them from property pages should be mapped against this claim element by element. Its two
   "interface instructions" elements were *arguable* for a bare JSON API — **they are much less
   arguable inside a product that has property pages, a widget and a map.**
4. **`US 10,317,219` claim 1 requires forming "a travel shed indicating an area... a
   combination of a first area associated with the first location and a second area."** A
   count of reachable destinations is not an area. A rendered isochrone polygon is.

## Six engineering design rules to check the implementation against

Report, with file and line citations, whether the code in this repository complies with each:

1. **No population density term** anywhere in the metric computation.
2. **No per-transit-stop weighted value based on distance AND service frequency, combined into
   a score.** This is the single load-bearing element of both Transit Score patents.
3. **No isochrone or travel-shed area** computed, returned, or rendered — including on a map.
4. **No mode-specific road-graph reduction and no node-density pruning** as a performance
   optimisation. Both are claimed.
5. **Multi-category POIs are a claim element.** `US 8,738,422` claim 1 requires "at least one
   geographic-related entity belongs to two or more of the categories". If the implementation
   uses Overture's `taxonomy.alternates` (where a gas station is also a grocery store), flag it.
6. **No use of the marks.** "Walk Score", "Bike Score" and "Transit Score" are Walk Score /
   Redfin trademarks. Flag every occurrence in this repository of those marks, of a field or
   URL named `walkscore` or similar, and of any text describing the feature as a Walk Score
   replacement or equivalent.

## Issues specific to building this inside *this* product — research these properly

These do not arise for a standalone API and are the reason this document is needed. Several may
matter more than the patents.

### A. Contract and terms of service — likely the most urgent

This product **is or was a paying walkscore.com API customer**. Find and read whatever
agreement or terms govern that relationship, and determine:

- whether it restricts using the API, its output, or its data to **build, benchmark against, or
  train a competing or replacement product**;
- whether it restricts **storing, caching or deriving** from returned values;
- what the **termination and post-termination** obligations are, including any duty to delete
  cached values;
- whether any **attribution obligation survives** termination.

Then check this repository for whether Walk Score values have been **stored, cached, or
committed** anywhere — database tables, fixtures, test data, migrations, CSVs, snapshots.
Report every instance with a path.

**Flag this specifically:** the standalone project's calibration tooling
(`npm run calibrate`, `scripts/calibration-set.ts`) worked by **scraping published Walk Score
reference values from walkscore.com** to tune constants. If any equivalent practice is carried
into this repository, or if any such scraped values are committed here, that is a terms-of-service
and possibly a Computer Fraud and Abuse Act question **entirely separate from patents**, and it
is one of the few issues here that could create liability even if every patent is cleared.
Do not assert whether it is a breach — surface it, cite the file, and ask counsel.

### B. Trademark removal and substitution

The Walk Score® attribution currently appears in at least these files — verify and complete
the list:

- `templates/core/data_sources.html`
- `assets/javascript/widget/full_script.js`
- `templates/reports/neighborhood_report.html`

Determine what attribution is contractually required *while* the API is still in use, what
must be removed at cutover, and propose replacement naming for the in-house metrics that does
not use the marks or a confusingly similar variant. Note that describing the new feature as
"like Walk Score" or "Walk Score equivalent" in user-facing copy, marketing, or documentation
raises its own question distinct from the field names.

### C. Fair Housing Act and steering — research this seriously

This is a **real-estate product**, and neighborhood-quality scoring in real estate has a
documented history of fair-housing scrutiny. Cover:

- whether a mobility or neighborhood score that influences **which listings are surfaced,
  ranked, or how they are described** could constitute steering or produce a disparate impact
  under the Fair Housing Act;
- the fact that **Redfin has itself faced housing discrimination litigation**, and that several
  major real-estate platforms **removed crime data** from listings for precisely these reasons;
- that Walk Score's own **crime-scoring application (US 2015/0026088) was abandoned**, and
  whether any crime, safety, or "neighborhood quality" signal is planned here — if so, treat it
  as a distinct and elevated risk and say so;
- whether the scores feed anything that touches **valuation, appraisal, or lending**, which
  brings appraisal-bias considerations into scope;
- what disclosure, documentation, or auditability counsel might want — e.g. retaining the
  breakdown behind each number so a score can be explained after the fact.

Be concrete about the mechanism, not hand-wavy: identify in the code where scores could
influence ranking, filtering, or listing presentation, and cite it.

### D. Accessibility (ADA / WCAG)

**Walk Score and Redfin were sued in 2017 over website accessibility for blind users.** This is
precedent in this exact product space. Assess whether the mobility widget — score chips,
colour-coded bands, any map or chart — is usable with a screen reader and meets WCAG 2.2 AA,
including whether meaning is conveyed by colour alone. Cite the relevant template and JS files.

### E. Open-data licensing, with attention to what changes by moving in-house

This repository already holds **the full Overture Maps dataset in PostGIS via GeoDjango**. That
matters legally:

- **Overture `places` is CDLA-Permissive-2.0 / Apache-2.0 and contains no OpenStreetMap data**,
  so it carries no share-alike obligation. Prefer it for the POI layer.
- **Overture `transportation`, `buildings`, `base` and `divisions` are ODbL**, because they are
  OSM-derived.
- Under ODbL, a **Produced Work** needs attribution only; a **Derivative Database** triggers
  share-alike under §4.4 and a machine-readable-copy offer under §4.6. Determine which of these
  applies when derived scores are **stored persistently in this product's own database and
  served from it**. Note that this is a materially different question from a stateless API
  answering one query at a time — a persistent, systematically-populated table of scores
  derived from an ODbL network is closer to a Derivative Database. The OSMF Geocoding Community
  Guideline is the closest analogous guidance and should be cited.
- Identify every data source the implementation uses and give each a row: source, licence,
  whether share-alike, whether attribution is required, and where that attribution currently
  appears in the UI. Include GTFS feeds, whose terms are **per-agency** and are the integrator's
  responsibility even though the Mobility Database's own metadata is CC0.

### F. What the in-house move *improves*

Say this explicitly, because it is a real benefit and counsel should not have to infer it: the
standalone design needed a `/api/walkscore` compatibility endpoint that reproduced the upstream
response shape, status codes and field names in order to make migration a one-line change.
**Computing in-house removes the need for that endpoint entirely**, and with it the most
patent- and trademark-exposed surface of the whole design. Confirm whether any such
shape-mirroring code exists in this repository and recommend it not be created.

## Required structure for `legal-analysis.md`

1. **Purpose and limits** — engineer not lawyer; not legal advice; what was verified and how;
   what could not be verified.
2. **Executive summary** — the handful of findings that would change a decision, ordered by
   how likely they are to matter. Put the contract/ToS and Fair Housing items high if your
   research supports that.
3. **What this product does** — the actual implementation, with file and line citations. Be
   specific about where metrics are computed, where they are stored, and where they are
   displayed.
4. **Patent analysis** — the portfolio table, then an element-by-element map of each
   independent claim against this implementation. Use a table per claim. Mark each element
   PRESENT / ABSENT / ARGUABLE and justify ARGUABLE.
5. **Trademark**.
6. **Contract and terms of service**.
7. **Fair Housing, steering and valuation**.
8. **Accessibility**.
9. **Open-data licensing**, with the per-source table.
10. **Questions for counsel** — precise, answerable, each tied to a section above.
11. **Verification gaps** — what you could not confirm and exactly where to confirm it.
12. **Design rules** — the concrete engineering constraints that follow, in imperative form.

## Rules for how you work

- **Verify every patent number resolves** to a real document before citing it. Google Patents
  at `https://patents.google.com/patent/USXXXXXXXX/en` is fetchable. Do not guess numbers.
- **Quote claim language** rather than paraphrasing it when the exact words carry the argument.
- **Cite files and line numbers** in this repository for every statement about what the code does.
- **Distinguish sharply** between (a) verified fact, (b) your engineering reading, and (c) what
  needs counsel. Label them.
- **Two things could not be verified** in the prior research because USPTO Patent Center and
  Patent Public Search were unreachable. Re-check both and report:
  - whether the **12-year maintenance fee on US 8,892,455**, due 2026-05-18, has been paid. It
    was unrecorded as of 2026-07-26 and the grace period closes around 2026-11-18. If it
    lapsed, that patent is unenforceable.
  - whether **terminal disclaimers** exist on `US 9,964,410`, `US 10,317,219` or
    `US 10,962,373`. Google Patents does not reliably surface these; the front page and file
    wrapper do.
- **Do not change any application code** as part of this task. If you find a compliance problem,
  document it and propose the fix; do not implement it in the same change.
- **Do not create or modify any user-facing legal text** — no terms of service, no privacy
  policy, no disclaimers. Recommend what is needed and let counsel draft it.
- If you cannot verify something, **say so plainly** rather than filling the gap.

---

# §2 — Further legal analysis for the DN repo TODO

Suggested items to add. Ordered roughly by urgency rather than by size.

## Before cutover

- [ ] **Obtain and review the walkscore.com API agreement / terms of service.** Look
      specifically for restrictions on derived data, on benchmarking, and on building a
      replacement; for cache-deletion duties on termination; and for surviving attribution
      obligations. This is the one issue that can create liability even if every patent is
      cleared.
- [ ] **Audit the repository and database for stored Walk Score values** — tables, fixtures,
      migrations, test data, committed CSVs, snapshots. Decide what must be deleted at
      termination.
- [ ] **Determine whether any calibration against scraped Walk Score values has occurred or is
      planned.** The standalone project's `npm run calibrate` scraped published values from
      walkscore.com. Get counsel's view on ToS and CFAA before any equivalent is used here.
- [ ] **Confirm the `US 8,892,455` maintenance-fee status** in USPTO Patent Center. Grace
      period closes ~2026-11-18. If lapsed, one of the two walkability patents drops out.
- [ ] **Pull terminal disclaimers** for `US 9,964,410`, `US 10,317,219` and `US 10,962,373`
      from Patent Center front pages.
- [ ] **Decide and register the replacement naming** for the three metrics. Clear the proposed
      names for trademark conflicts before they appear in templates, the widget, partner sites
      or marketing.
- [ ] **Get a written engineering sign-off against the six design rules** in §1, so there is a
      contemporaneous record that the constraints were applied deliberately.

## Patent work for counsel

- [ ] **Freedom-to-operate opinion on `US 9,677,892` claim 1** — the batch-precompute-and-cache
      claim, expiring 2033-03-24. This is the highest-exposure claim and the interface elements
      become clearly satisfied inside a product with property pages and a widget.
- [ ] **Order the `US 10,962,373` file wrapper.** Prosecution was unusually protracted — a
      non-final rejection in 2019 and three separate notices of allowance in 2020 before grant
      in 2021 — which may support prosecution-history estoppel or narrow construction.
- [ ] **Doctrine-of-equivalents assessment** of a count-based metric against the Transit Score
      claims. Literal non-infringement is not the whole test; a hard-cutoff count could be
      argued equivalent to a decay-weighted score.
- [ ] **Document a §102/§103 prior-art position** as a defensive card, even if never asserted.
      Family B priority is 2011-08-16 and Family A's is 2007-09-28. Cumulative-opportunity
      accessibility is published in Wachs & Kumagai (1973); gravity-based accessibility in
      Hansen (1959); Frank's walkability index and the 3Ds/5Ds framework predate 2007.
- [ ] **Consider the §101 question** on the bare "computer-readable medium" claims
      (`US 8,892,455` claim 26 and the Family A CRM claims), which are not recited as
      "non-transitory".
- [ ] **Decide whether to defensively publish** any genuinely novel elements rather than leave
      them unprotected — e.g. street-lighting-based night walkability, or accessibility-aware
      routing using the OpenSidewalks schema. Both are things no competitor currently scores.

## Regulatory and product risk

- [ ] **Fair Housing Act review of the mobility feature**, covering steering and disparate
      impact, and specifically whether scores influence listing ranking, filtering or
      description. Include a decision on whether any crime, safety or composite
      "neighborhood quality" signal will ever be added — and if so, treat it as a separate
      review, because that is where the sector's actual enforcement history sits.
- [ ] **Decide the explainability standard.** Retaining the full breakdown behind every score
      makes it possible to explain a number after the fact. Confirm with counsel whether that
      is desirable for defensibility, and what the retention period should be.
- [ ] **Appraisal and lending touchpoints** — determine whether these metrics reach anything
      used in valuation, and if so what additional obligations attach.
- [ ] **WCAG 2.2 AA audit of the mobility widget**, with attention to colour-only meaning in
      the score bands and to screen-reader behaviour. There is 2017 litigation against Walk
      Score and Redfin over blind-user accessibility, so this is precedented in-sector.

## Data licensing

- [ ] **ODbL determination for persisted derived scores.** Decide whether a systematically
      populated table of scores derived from the ODbL Overture transportation layer is a
      Produced Work or a Derivative Database, and what §4.4 / §4.6 would require. Cite the
      OSMF Geocoding Community Guideline as the closest analogous guidance.
- [ ] **Architect the licence split deliberately:** keep the ODbL network layer internal and
      query-time only; source the POI layer from Overture `places` (CDLA-Permissive-2.0,
      contains no OSM data) so the amenity layer stays free of share-alike.
- [ ] **Per-agency GTFS licence audit.** The Mobility Database's metadata is CC0 but feed
      contents are licensed by each agency and compliance is the integrator's responsibility.
      Consider the FTA GTFS Weblinks registry instead, which is public domain and
      mandate-backed.
- [ ] **Verify attribution is actually rendered** in the UI for every source that requires it,
      and that it survives template changes.
- [ ] **Do not use OpenAddresses without per-source licence filtering** — it does not
      relicense from its sources, several of which are share-alike and a few revocable.
- [ ] **Avoid Mapillary-derived data in anything persisted**, or accept CC-BY-SA obligations;
      its terms are also revocable.

## Insurance and governance

- [ ] **Check whether existing insurance covers IP infringement defence**, and whether
      first-party media/technology E&O is in place.
- [ ] **Record the decision trail** — this document, `patent-claim-map.md` and
      `walk-score-strategy.md` — somewhere durable. Contemporaneous evidence that constraints
      were identified and deliberately applied is worth having if a dispute ever arises.
