# Walk / Bike / Transit Score — Current Method and Improvement Strategy

*Research and analysis, 26 July 2026. Prepared for a decision, not for implementation —
nothing in this document has been coded.*

Every URL cited was fetched live on 26 July 2026, and every record count is measured rather
than quoted from documentation. Where something could not be verified, it says so.

---

## What I would decide first

Nine findings drive everything below. The first is the one I would act on before anything
else.

**1. Fort Pierce — the market this product exists to serve — has no transit schedule
loaded, and the feed exists.** St. Lucie County Area Regional Transit publishes a valid
GTFS feed: 8 routes, 198 stops, 290 weekday/Saturday trips, calendar valid through
2026-12-31. It is **not in the Mobility Database**, which is the only catalogue
`pipeline/load_gtfs.py --catalog` reads, so no amount of scaling that catalogue up will
ever find it. It lives on the Florida Transit Data Exchange at
`https://ftis.org/PostFileDownload.aspx?id=977A0` (verified: HTTP 200, 81,907 bytes, valid
GTFS). Loading it is one command with existing code. The same scraper generalises to ~40
more Florida agencies on the same URL pattern.

**2. Overture's `places` theme is not ODbL.** It carries no OpenStreetMap data at all and is
licensed CDLA-Permissive-2.0 / Apache-2.0. Roughly 75M POIs, US-heavy, with a ~2,300-entry
hierarchical category taxonomy that maps cleanly onto our nine amenity categories. This
simultaneously improves amenity recall — our single largest source of residual Walk Score
error — *and* removes share-alike encumbrance from the half of the engine we most want to
cache and precompute. Given the Dream Neighborhood database already holds Overture, this is
also the cheapest thing on the list.

**3. "Walk Score", "Bike Score" and "Transit Score" are Redfin trademarks, and the
underlying patents are live.** US 8,738,422 (expires 2030-03-30), US 8,892,455 (2031-02-15)
and US 10,962,373 — the Transit Score patent — (2032-12-12), all assigned to Walk Score
Management LLC. Marketing a product as computing "Walk Score / Bike Score / Transit Score"
as a "free replacement for the walkscore.com API" asserts the marks in exactly the context
where they are protected. **This is a business decision that should be made before launch,
not after**, and it is cheap to act on: renaming the outputs costs almost nothing. I am not
able to give a legal opinion and you should get counsel, but the naming risk is more
immediate than the patent risk.

**4. Calibrating against Walk Score caps us at Walk Score, and Walk Score is measurably
flawed.** The peer-reviewed literature finds it is positively associated with things that
*hinder* walking — crime, cul-de-sac count, average speed limit, highway density — and one
Canadian study found it positively related to pedestrian crash rate even controlling for
exposure. A systematic review concludes it is largely a surrogate for density. Our
`npm run calibrate` currently scrapes their values, which means we are spending effort
reproducing those biases, and doing so via a fragile dependency on a competitor's website
with a 38-point sample.

**5. There is a free, peer-reviewed, national replacement for that calibration target.** The
Walkable Accessibility Score (Credit et al., *Environment and Planning B*, 2025) publishes
both code and precomputed values for **every US census block group for every year
1997–2019**, and reports Spearman ρ = 0.912 against proprietary Walk Score with an explicit
parameter set. It gives us an independent national benchmark instead of 38 scraped points.

**6. Transit Score should move from counting service to counting reachable destinations.**
Walk Score's own co-founder publicly conceded this is the right approach. Our current
formula — sum over routes of mode weight × frequency × distance decay — has the same
structural flaw as theirs: it never asks where those routes *go*, and it penalises wider
stop spacing even when that produces faster service. The literature says a
cumulative-opportunity measure correlates 0.90–0.97 with theoretically superior
gravity-based measures, so we can have the better metric without the complexity.

**7. Our distance-decay curve uses the empirically worst-fitting functional form.** Two
independent literatures — Dutch commuting studies and Canadian transit accessibility work —
find negative-exponential and power decay fit observed behaviour poorly, and that
log-logistic or Gaussian CDF forms fit materially better. Our piecewise-linear curve is an
approximation to roughly the wrong shape.

**8. Local government sidewalk data would make Fort Pierce *worse*, not better.** This is
the opposite of the usual assumption and it is measured. St. Lucie County's sidewalk layer
has 6,937 segments and was **last edited 10 January 2017**; OSM has 6,191 sidewalk ways plus
4,287 roads carrying a `sidewalk=*` tag plus 4,581 mapped crossings in the same county. The
county layer also codes its `Type` field four different ways and has `LengthMiles = 0.0` on
every row. Bike facilities are the reverse: OSM has **13** cycleways county-wide against
FDOT's **532 km** of typed bike facilities. Integrate FDOT for bikes; do not integrate the
county for sidewalks.

**9. `docs/METHODOLOGY.md` is stale against the code in six places.** Both files state the
code is the source of truth, and the code has moved. Details in §1.6 — this matters because
the methodology page is public-facing and renders at `/methodology`.

---

# Part 1 — How the scores are calculated today

Everything here is read from `lib/scoring/constants.ts`, `lib/scoring/walk.ts`,
`lib/scoring/bike.ts`, `lib/scoring/transit.ts` and `lib/network.ts` as they stand on the
deployed commit, not from the methodology document.

## 1.1 The shared pipeline

A single query point drives one pass:

1. **Geocode** (if given an address) via the US Census geocoder, with Nominatim/Photon
   fallback.
2. **One Overpass fetch** at a 1.5-mile radius (`ANALYSIS_RADIUS_METERS`, 2,414 m) returning
   amenities, the way network, and transit stops. One radius serves the amenity search, the
   network build, the street-shape metrics and the bike infrastructure tally — deliberately,
   because it makes a scored point cost exactly one network query and one amenity query.
3. **Build a routing graph** from OSM ways, including footways.
4. **One bounded Dijkstra** from the query point out to 1.5 miles. Every amenity snaps to its
   nearest graph node and inherits that node's network distance.
5. **Score** walk, bike and transit off that one traversal.
6. **Cache** into `score_cache` on a 25 m grid cell (`SCORE_CELL_METERS`).

The database is optional by design — with no `DATABASE_URL` the service still answers every
request live from Overpass.

## 1.2 Walk Score

**Amenities.** Every POI within 1.5 miles is classified into nine categories: grocery,
restaurants, shopping, coffee, errands & banking, parks, schools, books & libraries,
entertainment. Each OSM tagging rule carries a **quality multiplier** — `shop=supermarket`
counts as grocery at 1.0, `shop=convenience` at 0.45. Weak members are kept rather than
dropped because in low-density areas the corner store genuinely is the grocery store.
Disused, abandoned, closed and private features are excluded.

**Distance.** Measured along the pedestrian network, not crow-flies. Where the network is
too sparse to route, straight-line distance is multiplied by a **circuity factor** selected
from local intersection density — 1.20 for a tight grid up to 1.65 for cul-de-sac
subdivision, defaulting to 1.42. The response reports which was used in
`provenance.distanceModel`.

**Decay.** Piecewise-linear between these anchors (this is the code, and it differs from the
published table — see §1.6):

| Miles | 0.0 | 0.25 | 0.4 | 0.5 | 0.75 | 1.0 | 1.25 | 1.5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Weight | 1.00 | 1.00 | 0.90 | 0.80 | 0.45 | 0.22 | 0.09 | 0.00 |

**Category slots.** 15 raw points across nine categories, in descending per-slot weight —
grocery is a single 3.00 slot, restaurants get ten slots tapering 0.75 → 0.20, coffee gets
1.25 and 0.75, and the remaining five categories get one 1.00 slot each. The asymmetry is
the point: a second grocery store is worth nothing, restaurant variety is worth a lot.
Candidates are ranked by **value** (decay × quality), not raw distance, so a real supermarket
slightly further out beats a nearer corner store for the 3-point slot.

**Street-shape penalty.** Intersection density and mean block length, each on a five-band
table, combining to at most a 10% deduction. Both are measured over the **street network
only** — service roads, driveways, parking aisles and footways are excluded from the metric
though they remain in the routing graph.

**Normalisation.**

```
Walk Score = min(100, round( (rawPoints / 14.2) × 100 × penaltyFactor ))
```

The divisor is `EFFECTIVE_MAX_POINTS = 14.2`, **not** the theoretical 15. The reasoning in
the code is sound: 15 requires all nine categories saturated with perfectly-tagged amenities
inside a five-minute walk, and no real place achieves that in OSM — Times Square tops out
around 14.4. Normalising against the theoretical maximum builds in a systematic
under-report that grows toward the top of the scale, measured at about five points.

## 1.3 Transit Score

**Data.** GTFS via the Mobility Database, flattened at ingest into a single `trips_per_day`
per route/stop pair for a representative weekday, so scoring is one spatial join rather than
a timetable computation. Where no feed is loaded, routes come from OSM instead — stops and
route membership but no schedule, so frequency is estimated and confidence drops.

The two sources are **merged, not chosen between**. This is load-bearing: large agencies
publish per-mode or per-borough feeds (the MTA ships nine), so selecting GTFS whenever *any*
feed covers a point makes partial coverage score worse than no coverage.

**Formula.** Each route within 0.75 miles contributes `mode weight × frequency factor ×
distance decay`.

- Mode weight: rail/subway 2.0, tram/ferry/cable 1.5, bus 1.0
- Frequency factor: `min(2.0, √(trips per weekday / 60))`; 0.6 where no schedule exists
- Distance decay: 1.0 within 400 m, falling linearly to 0 at 0.75 mi

```
Transit Score = round( 100 × √( min(1, total value / 55) ) )
```

The square root spreads the low end so that one hourly bus is distinguishable from nothing.
`null` is returned — never `0` — when neither a feed nor OSM covers the area.

## 1.4 Bike Score

Four weighted components (code values; the published table differs — see §1.6):

| Component | Weight |
| --- | --- |
| Infrastructure | 40% |
| Terrain | 25% |
| Destinations | 25% |
| Connectivity | 10% |

- **Infrastructure** — `0.55 × protected + 0.25 × painted + 0.20 × lowStressShare`, where
  protected saturates at 6 km of lane within the radius and painted at 12 km, and
  low-stress is a share of total way metres.
- **Terrain** — driven by the **85th-percentile grade**, not the mean, because a flat
  neighbourhood with one brutal climb between you and the shops averages out to "gently
  rolling" when the climb is what decides whether you ride. 100 at ≤1% grade, 0 at ≥8%,
  linear between. Grades sampled from free AWS terrain tiles.
- **Destinations** — same nine categories and slots as Walk Score, over a cycling decay curve
  that stays flat to 1 mile and reaches zero at 3.
- **Connectivity** — street-network intersection density, saturating at 50/km².

Components that cannot be measured are dropped and the remainder re-weighted, so a failed
elevation lookup does not silently treat the place as flat.

## 1.5 Confidence

Reported separately and driven by **data coverage, not by the score**. A genuinely
car-dependent place gets a high-confidence 8. Confidence drops when the network was
unavailable or too sparse to route, fewer than four amenities were found, no transit
schedule covers the area, transit came from OSM without frequencies, or elevation failed.

## 1.6 ⚠ The methodology document is stale

`docs/METHODOLOGY.md` renders publicly at `/methodology` and states that the code is
authoritative. Six places where it no longer matches:

| Item | Document says | Code says |
| --- | --- | --- |
| Decay at 0.50 mi | 0.65 | **0.80** |
| Decay at 0.75 mi | 0.40 | **0.45** |
| Walk normalisation | `rawPoints / 15` | **`rawPoints / 14.2`** |
| Transit walk radius | half a mile | **three quarters of a mile** |
| Transit full-weight radius | 200 m | **400 m** |
| Transit saturation | `/ 78` | **`/ 55`** |
| Bike weights | 30 dest / 30 infra / 25 terrain / 15 conn | **40 infra / 25 terrain / 25 dest / 10 conn** |

The bike row is the most visible: the document's own prose two pages later says
"Weighting infrastructure at 40% took most of this out," contradicting its own table. This
is a documentation fix, not a code fix, and it should happen before any external party reads
the methodology page.

## 1.7 Where accuracy actually stands

Against a 38-point reference set with 44 GTFS feeds loaded:

| | MAE | Bias | r | Within 10 |
| --- | --- | --- | --- | --- |
| Walk | 6.2 | −1.3 | 0.927 | 82% |
| Bike | 11.0 | +2.8 | 0.822 | 61% |
| Transit | 13.3 | −10.1 | 0.892 | 42% |

Walk is strong. Bike is the weakest on correlation and reads generous in quiet streetcar
suburbs with no bike network. Transit tracks well in rank order but reads low, and the
existing diagnosis — coverage, not formula — is confirmed by the live deployment: loading
real metro feeds moved Times Square from 79 to 100.

---

# Part 2 — The ceiling of the current design

Four structural limits. None is a bug; all are consequences of design choices that were
correct at the time.

**Live Overpass is the binding constraint on everything.** A cold lookup takes 3–20 seconds
and Heroku's router hard-kills at 30, which produced real `503 H12` errors on the live
deployment during the Fort Pierce smoke test. It also causes R14 memory pressure from
parsing Overpass JSON, and it makes precomputing a metro a multi-hour job. Worse, a Dijkstra
that gives up early because Overpass truncated produces a systematically *low* score — a
silent error, not a loud one.

**We measure proximity, not urban form.** Ewing & Cervero's meta-analysis finds walking is
most strongly related to (a) land-use diversity, (b) intersection density, and (c) count of
destinations within walking distance. We do (c) well. We use intersection density only as a
≤10% penalty, and we do not measure diversity at all. Frank's index weights intersection
density **2×** — the heaviest of its four terms. Notably, Frank's team partnered with Walk
Score's original company around 2012, and the resulting paper found that even after moving
to network distance, a code-based urban-form index *still* predicted measured physical
activity better than destination proximity did.

**Transit Score counts supply near the origin and never asks where you can go.** Two
locations with identical route sums can have completely different opportunity access. The
formula also penalises wider stop spacing even when that means faster service — Jarrett
Walker's critique is that it "assumes walking is bad for you, and that you hate walking more
than you hate riding," which is a strange position for a walking-score company.

**Bike Score infers stress from tags rather than modelling it.** We grade ways as protected /
painted / low-stress. The established framework — Mekuria, Furth & Nixon's Level of Traffic
Stress, which is what PeopleForBikes uses — asks instead whether a *mainstream adult would
actually ride this*, and then whether a low-stress route exists **end to end**, since a
network is only as good as its worst link. That reframing is precisely the fix for our
known over-generosity in quiet suburbs: those streets are individually low-stress but do not
connect to anything without crossing an arterial.

---

# Part 3 — Data source inventory

Organised by what each source would actually fix. Full detail and caveats follow each tier.

## 3.1 Federal

### Adopt

**FTA National Transit Database — GTFS Weblinks.**
`https://data.transportation.gov/resource/2u7n-ub22.json` · Public Domain · refreshed
2026-07-07, monthly. Since Report Year 2023, **every NTD reporter with fixed-route service
is legally required to publish a public-domain GTFS feed**, and FTA publishes the URL list
with validation flags. 1,539 rows (agency × mode × service type). This is a
mandate-backed, license-clean feed registry for the US, and `certification_flag` /
`new_date_validated` give a feed-quality signal the Mobility Database does not. `ntd_id`
joins into NTD ridership data. Caveat: `weblink` is a Socrata URL object, not a string, and
one feed URL often serves many modes — deduplicate before fetching.

**BTS National Transit Map.** 680,275 stops, 67,588 route shapes, 1,243 agencies; 1,228 of
1,243 agencies explicitly Public Domain; compiled 2026-03-09. **It has no `stop_times`, so
it cannot compute a Transit Score** — its value is as a *coverage oracle*. Two uses: (a) if
NTM shows stops in the walkshed and we have no feed, we owe a `null` plus a coverage
warning rather than a low score; (b) diffing its 1,243 agencies against our loaded feeds
produces a ranked, evidence-based backlog. It would have caught the Fort Pierce gap
immediately — NTM has ART as `NTD_ID 41199` with "Agency fetch URL available and in
compliance with GTFS standards" while the Mobility Database does not list it at all.

**USGS 3DEP elevation.** Point API `https://epqs.nationalmap.gov/v1/json`, public domain,
data published through 2026-06-23. 1 m lidar-derived coverage where available with 10 m
fallback, versus roughly 30 m for our AWS terrain tiles. At 30 m you cannot resolve a short
steep block, which is exactly the feature that makes a route unrideable. The API returns the
resolution actually used per query, so we can attach a confidence flag. Two real caveats:
per-point HTTP will not scale (pull tiles for the service area and sample locally), and
**bare-earth DEM flattens bridges into the terrain beneath**, so overpasses read as false
steep grades — this needs a bridge mask.

**USDA SNAP retailer locations.**
`https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/snap_retailer_location_data/FeatureServer/0`
· public domain · current to 2025-12-31. **253,894 point-level food retailers** with a store
type taxonomy: 22,179 Grocery Store + 20,586 Super Store + 19,583 Supermarket = 62,348
full-service grocery points, plus 112,413 convenience stores as a separately weightable
category. This is effectively a free, national, federally-maintained grocery POI layer —
normally the most expensive thing to license for a walk score, and grocery is our single
highest-weighted slot at 3.00 points. Caveats: coverage is conditioned on SNAP
authorisation, 23% of records are typed only "Other", and coordinates are rounded to ~100 m,
which is coarse against a 0.25 mi ring.

**NTAD Bikeshare.** 78,380 docking stations, public domain, compiled 2025-06-30. A
legitimate Bike Score input that Walk Score does not model. **Must filter on `STARTDT` /
`ENDDT`** — it is a historical series including removed stations.

### Adopt with real engineering effort

**FHWA HPMS 2024.** `https://geo.dot.gov/server/rest/services/Hosted/HPMS_FULL_{ST}_2024/FeatureServer`
· public domain · 52 state layers. 105 fields including `speed_limit`, `through_lanes`,
`aadt`, `median_type`, `signal_type`, `shoulder_width_r`. This is the missing ingredient for
both a **pedestrian crossing-difficulty penalty** and a proper **LTS** calculation — a
6-lane 45 mph arterial at 40,000 AADT is a genuine barrier that `highway=primary` cannot
express. Two significant caveats, measured on Idaho 2024: attribute completeness is poor
because attribution is only mandated on the Federal-aid system (`speed_limit` present on 40%
of segments, `aadt` on 53%, `f_system` null on 49%), and **joining linear-referenced HPMS to
OSM requires geometric conflation** with directional and offset tolerance. Tolerable for a
crossing penalty, since arterials are the barriers and arterials are the well-attributed
part; not usable as a general street network.

**Census LEHD LODES 8.4.** Released 2025-12-18 with 2023 data, at **2020 census block**
resolution — much finer than the block groups most datasets offer. The NAICS sector split is
the useful part: `CNS07` retail, `CNS18` accommodation and food service, `CNS14`–`CNS17`
education/health/arts give a destination-richness surface paralleling our amenity categories
where OSM POI coverage is thin. Also the natural denominator for a jobs-accessibility
Transit Score. Caveats: **2023 excludes Alaska and Michigan entirely**; the data is partially
synthetic with noise infusion, so block-level values are only meaningful aggregated over a
walkshed; jobs count employment, not establishments.

**USDOT National Address Database.** Compiled 2026-06-30, quarterly, public domain, ~80M
surveyed address points, ~9.7 GB. The Census geocoder interpolates along TIGER address
ranges — it guesses an offset along a block face. NAD gives the surveyed point. For a
product whose entire output keys off an address, that difference moves the walkshed origin
by tens of metres and changes which destinations fall inside the 0.25 mi full-weight ring.
Caveat: coverage is a bottom-up aggregation and varies by jurisdiction, so it needs a
per-county coverage flag with Census geocoder fallback.

### Use for validation, not as inputs

**NHTS 2022 (V2.1, released April 2025).** Trip-level `TRPMILES` by `TRIPPURP`. This is the
empirical basis for **purpose-specific distance decay** — grocery, school and restaurant
trips have measurably different acceptable walking distances, and we currently apply one
global curve to all nine categories. Survey microdata, so it calibrates parameters rather
than feeding scores.

**ACS B08301 walk/bike/transit commute mode share.** Available at **block group** on
`acs5` (the subject table S0801 is tract-only). ACS 2024 5-year is live. The API **now
requires a free key**, and unauthenticated requests return an HTML notice via a 302 — a
client that only checks status codes sees 200 and then fails to parse. Commute-only, so
treat correlation as a lower bound, and control for `_021E` worked-from-home.

**BTS LATCH** `pct_veh_0`, the car-free household share by tract — arguably the best single
outcome validator for a combined walk-plus-transit score, because going car-free is a
revealed-preference statement covering all trip purposes, not just commuting. Caveat: 2017 is
the newest vintage and there is no 2022 edition; it is modelled from NHTS, not observed.

**NHTSA FARS 2024.** Point-geocoded national census of fatal crashes; 7,080 pedestrian and
1,103 cyclist fatalities in 2024. The `Pbtype` file's `PBSWALK` and `PBCWALK` fields are the
only national-scale federal observations of sidewalk and marked-crosswalk presence recorded
by an investigator at a specific point — a sparse but independent way to audit how much our
OSM sidewalk coverage varies by region, which we currently have no way to know. Caveats:
fatalities only (non-fatal pedestrian injuries are ~100× more numerous and are not
point-geocoded anywhere nationally), counts per walkshed are Poisson-noisy, and the
sidewalk fields are only populated for crashes, which selects on the outcome.

### Do not build on these

- **EPA Smart Location Database / National Walkability Index** — frozen at **2021** on 2019
  block-group boundaries, and I measured its transit variables at only **41% block-group
  coverage** (`D4A` populated for 91,087 of 220,134). Its value is methodological and as a
  benchmark, not as a live input. Two things worth taking: `NatWalkInd` as a free national
  regression target that would catch an intersection-density inversion instantly, and
  `D3B`'s documented definition of pedestrian-oriented intersection density —
  reimplemented on current OSM rather than consumed from EPA's stale file.
- **HUD Location Affordability Index** — March 2019, on 2012–2016 ACS. Seven years stale.
- **USDA Food Access Research Atlas** — still on 2010 census tracts and a 2019 supermarket
  list.
- **EPA EJScreen** — **removed from the web February 2025**; `ejscreen.epa.gov` no longer
  resolves in DNS.
- **USGS National Hydrography Dataset** — retired 1 October 2023.
- **TIGER pedestrian codes** — measured one single `S1710` walkway in an entire county. Do
  not attempt to build a pedestrian network from TIGER.

A cross-cutting warning: these sources span 2010 tracts, 2019 block groups, 2020 blocks,
TIGER 2024 and TIGER 2025 geography. **Any join without an explicit crosswalk produces
silently wrong scores.** Pick 2020 blocks as canonical (that is what the geocoder returns)
and crosswalk everything once, at ingest.

Also note `dot.gov`, `bts.gov`, `nhtsa.gov` and `usgs.gov` all return HTTP 403 to scripted
requests behind bot protection. They are live; use their ArcGIS/Socrata API endpoints, which
are not blocked.

## 3.2 State and local

The general finding is **buy statewide, skip municipal** — and the reasoning is structural
rather than a judgement about any particular city. Integration cost scales with the number
of jurisdictions; value scales with area covered. A statewide layer puts one jurisdiction in
the denominator and a whole state in the numerator. If Dream Neighborhood expands to 20
Florida markets, that is 20 bespoke municipal integrations against **one** FDOT integration
covering all 67 counties under one schema with one refresh cadence.

### FDOT — the anchor source, and the fix for Bike Score

`https://gis-fdot.opendata.arcgis.com/` · 256 datasets · DCAT catalogue at
`/api/feed/dcat-us/1.1.json` · layers refreshed 2026-07-20.

Measured inside a St. Lucie County bounding box:

| Layer | Records | What it gives us |
| --- | --- | --- |
| `Bike_Lane_TDA` | 792 | facility type: designated / buffered / colored / sharrow |
| `Sidewalk_Width_Sep_TDA` | 3,124 | width **and offset from pavement** |
| `Shared_Path_TDA` | 45 | shared-use path width |
| `Annual_Average_Daily_Traffic_TDA` | 691 | AADT, truck factor |
| `Functional_Classification_TDA` | 453 | functional class |
| `Preliminary_Context_Classification_TDA` | 834 | C1–C6 built-form typology |

The bike numbers are the headline: **532 km of typed bike facility** (423 km designated,
48 km buffered, 35 km sharrow, 4 km colored) against OSM's **13 cycleway ways** in the same
county. The buffered/colored/sharrow split is exactly the comfort gradient a Bike Score
should weight, since a sharrow is close to no facility and a buffered lane is close to a
path.

`Sidewalk_Width_Sep_TDA`'s `DISTFMRD` is genuinely unique — a sidewalk 24 ft back from a
45 mph arterial is a materially different pedestrian experience from one flush against the
kerb, and no national dataset carries that.

The **Context Classification** layer deserves separate mention as free statewide validation
ground truth rather than an input: FDOT planners assign every state-road segment a class
from C1 (natural) to C6 (urban core). A Walk Score of 70 on a C2 rural segment is a bug
report, delivered free, statewide.

Three caveats that matter. Coverage is the State Highway System plus roads functionally
classified Rural Major Collector and above — **residential streets, where the listings are,
are largely absent**, which is why FDOT has 3,124 sidewalk records against the county's
6,937. Second, there are two different clocks: the GIS extract refreshes weekly (hence the
2026-07-20 timestamps) but the underlying field inventory runs on a 3–5 year cycle, so a
fresh file timestamp is not fresh ground truth. Third, geometry is **linear-referenced by
milepost, not a routable graph**, so conflation onto the OSM graph is the real engineering
cost. There is also no formal open licence — only a liability disclaimer — though Florida
public records law makes the data public.

**FGDL** (`https://fgdl.org/zips/geospatial_data/current/`) mirrors the same layers on a
predictable `<layer>_<mon><yy>.zip` naming pattern with an archive, which is easier to
automate against than FDOT direct. Trade-off: quarterly mirror versus FDOT's weekly refresh.
One trap — the SUN Trail layer's status code is `1 = Active, 2 = Pending (not open to the
public), 3 = Dropped`. Counting pending trails as existing infrastructure would hand out
bike points for a trail nobody can ride.

### Florida statewide parcels — the sleeper source

`Florida_Statewide_Cadastral/FeatureServer/0` · **10,831,924 parcels**, all 67 counties · 121
fields · free · refreshed each August.

Three uses. `NO_RES_UNT` summed over a walkshed is a **true dwelling-unit count** rather than
a block-group average — the highest-resolution free density denominator available in Florida,
and materially better than block-group interpolation for suburban parcels where one block
group spans a subdivision and a cow pasture. `PHY_ADDR1` plus parcel centroid is a
**geocoding fallback that beats the Census geocoder** for new construction, which matters
because the St. Lucie TPO documents rapid growth west of I-95 — exactly the addresses TIGER
interpolation handles worst. And `DOR_UC` use codes cross-check OSM amenity classification.

Caveats: annual vintage; a full-table count took **111 seconds**, so this is bulk-load only,
never a live per-request lookup; and **St. Lucie keeps condominium parcels in a separate
file**, which is dense multi-family housing we cannot afford to drop from a density measure.

### St. Lucie County — a lesson about discovery, and one thing worth taking

The county publishes on two surfaces and **the good one is invisible to every catalogue**.
Its ArcGIS Hub portal returns 1 hit for "sidewalk" (a web app, not a layer) and **zero** for
"bike", "bicycle", "pedestrian" and "greenway". Its raw ArcGIS Server at
`https://slcgis.stlucieco.gov/hosting/rest/services` — indexed nowhere — exposes 38 folders
containing 6,937 sidewalk segments, 155 bike facilities, 11,292 street lights, 593 traffic
count stations and 211 park polygons.

As established in the summary, **the sidewalk layer should not be integrated**: nine years
stale, four inconsistent `Type` codes, a zeroed `LengthMiles` field on all 6,937 rows,
duplicated across two folders with no canonical marker, and smaller than what OSM already
gives us.

Two county layers *are* worth having, and both are current:

- **`PublicWorks/StreetLights` — 11,292 points** with `LightType`, `Watts`, `Condition`.
  There is no national or statewide street-lighting dataset, and no competitor scores
  lighting. This is the most genuinely novel layer found in the entire research effort.
- **`Recreation/ParksPreserves` — 211 polygons, edited June 2026**, with `ParkType`, `Acres`,
  `OperationHours` and a delimited `Amenities` string. This is *park quality*, where OSM
  gives only `leisure=park` extent. A 674-acre state park and a 0.2-acre beach access are
  not the same amenity and currently both fill our single 1.00-point parks slot.

Note the contrast within one county: the sidewalk layer was abandoned in 2017 while the
parks layer was edited last month. **The lesson is per-layer currency checks, not
per-jurisdiction judgements** — one `outStatistics` query on `max(last_edited_date)` is the
cheapest and highest-value due diligence available before integrating anything.

### On automated national discovery of local data — it does not work

I had this tested properly, across 45 cities. ArcGIS Hub keyword search finds a plausible
sidewalk layer for 78% of cities but only **40% of those hits are from the right
jurisdiction**; for crash data precision is **14%**. The failures are not marginal: querying
"Ocala" + park matched **Mississauga, Ontario**; "Fort Pierce" + crash matched **Fort
Collins, Colorado**; 27 different cities all matched the same Iowa DOT crash record. The
`bbox` spatial filter is effectively broken — a Fort Pierce bounding box returns 4,398 hits
and a San Francisco one returns 4,411, because many catalogue entries carry null or
statewide extents.

Socrata's Discovery API is much better designed and its `metadata.domain` gives unambiguous
provenance — but it federates only **49 US domains** for sidewalks, heavily concentrated in
NYC, Seattle, Austin and Cambridge. Fort Pierce is not on it.

Also worth flagging as a live breaking change: **data.gov's CKAN API is retired** and returns
404. The replacement is `https://api.gsa.gov/technology/datagov/v4/search` with an
`X-Api-Key` header; the legacy instance survives at `catalog-old.data.gov` only through fall
2026. Any integration guide written before April 2026 is wrong on this.

**Conclusion: do not build municipal-portal auto-discovery.** The best data in our primary
market sits on a server no catalogue indexes, and the catalogues that do work cannot tell
Florida from California.

### Two doors that are closed

**Florida crash data (Signal Four Analytics)** is the best crash resource in the state and
includes purpose-built pedestrian and bicycle crash typing — but access is restricted to
government entities, and **Fla. Stat. 316.066(2)** restricts crash-report distribution to a
defined list explicitly "not for redistribution." A commercial scoring product is not on
that list. Use FARS if we want crash data at all.

**MPO data** should be skipped as a systematic source. ~450 MPOs, 450 boundaries, no shared
schema, and the good examples are exceptions — DVRPC publishes an excellent LTS layer with
open methodology, while the *median* MPO is St. Lucie, where the federal certification review
team had to formally recommend that the bike and pedestrian networks stop being **static
PDF maps**. Harvest individual MPO LTS layers opportunistically for metros we serve; do not
attempt national coverage.

## 3.3 Open and non-governmental

### Overture Maps `places` — the highest-value single change

`https://docs.overturemaps.org/guides/places/` · ~75M POIs · **CDLA-Permissive-2.0 /
Apache-2.0, contains no OSM data**.

Composition: Meta 60.6M, Microsoft 6.3M, Foursquare 4.7M (Apache-2.0), AllThePlaces 1.4M
(CC0), plus smaller contributors. Category counts relevant to us: Shopping 14.0M, Food and
Drink 10.4M, Health Care 4.0M, Education 3.6M, Sports and Recreation 2.9M.

The taxonomy is what makes it directly usable. `taxonomy.hierarchy` is an ordered list from
top level to primary category, so we can aggregate by supertype without maintaining our own
tag-mapping table. `taxonomy.alternates` means **one POI can legitimately satisfy two
categories** — a gas station that also sells groceries carries primary `gas_station` and
alternate `grocery_store`, which our current single-classification model cannot express.
`basic_category` is a ~280-label set very close to the granularity our nine baskets need.
And `operating_status` lets us exclude permanently-closed businesses, which is a real and
under-appreciated source of score inflation in OSM-derived indices.

**One hard deadline:** the legacy `categories` property is deprecated and **removed in the
September 2026 release**. Any integration should target `taxonomy` + `basic_category` from
day one.

Caveats: no opening hours in most records; Foursquare-sourced records are single-sourced and
never cross-validated; positional accuracy of ML-derived points is generally worse than
surveyed OSM nodes, which matters when snapping POIs to the network.

### Overture `transportation` — better graph semantics, but still ODbL

No licensing gain here (it is OSM-derived), but the data model is materially better for our
Dijkstra. Overture splits the network into **segments** (centrelines carrying all
attribution) and **connectors** (points where segments physically meet). Topology is
explicit via a `connectors[]` array with linear-referenced positions — meaning **every
routing decision point is precomputed and handed to us**, where in OSM we must infer topology
by detecting shared node IDs and splitting ways ourselves.

Three classification differences that matter directly to our known traps:

- **`highway=service` is decomposed into `alley` / `driveway` / `parking_aisle` subclasses** —
  18.2M driveways and 6.7M parking aisles individually identifiable globally. In OSM these
  are distinguished by a separate `service=*` key that is frequently absent. This is Trap 1
  in the context file solved at the data layer rather than by heuristic.
- **`footway` splits into `sidewalk` (4.18M) vs `crosswalk` (2.57M) vs plain**, pre-classified.
- `_link` roads become a subclass rather than a separate class, and access/turn restrictions
  and speed limits are **structured typed objects** rather than free-text
  `maxspeed:conditional` strings.

Two caveats: linear-referenced scoped properties mean the graph builder must either honour
sub-segment scoping or pre-split, and Overture's own `transportation-splitter` tool
**requires Spark**, which is a heavy dependency for a TypeScript project — implementing
linear-reference handling directly is probably cheaper. Also, monthly release cadence means
no same-day OSM edits.

### Getting off public Overpass

The recommended path is Geofabrik state PBF → `osmium tags-filter` → `osm2pgsql` with a
flex-output Lua script emitting exactly our graph schema → PostGIS with spatial indexes.
This beats self-hosting Overpass because we do not need arbitrary ad-hoc queries; we need
one fixed schema refreshed nightly. Note the **Overpass API itself is AGPL-3.0**, which
carries network-service source-offer obligations if self-hosted. Also buffer state-level
extracts at boundaries or addresses near state lines get truncated networks.

### Sidewalks

**Tile2Net** (`https://github.com/VIDA-NYU/tile2net`, **BSD-3-Clause**) generates
topologically connected sidewalk, crosswalk and footpath centrelines from public aerial
imagery. The current pretrained model is retrained beyond the published version and
deliberately not fine-tuned to any city, so it generalises better than the paper's numbers
suggest. Batch pipeline, GPU recommended, hours-to-days per metro. Trees and building
overhangs occlude sidewalks; output has no surface, width or curb-ramp attributes.

**OpenSidewalks / TDEI / OS-CONNECT** (`https://sidewalks.washington.edu/`) is the standards
effort, and as of January 2026 hosts **5,600+ validated datasets covering 10.5M crossings and
~400,000 miles of sidewalks** — concentrated in Washington State and partner cities, not
national. The **schema is the transferable asset even if we never touch the data**: directional
edges with inferred reverses, typed curb interfaces (`raised` / `rolled` / `lowered` /
`flush`) with tactile paving, and a connectivity rule that prevents a real class of routing
bug — crossings exist only curb-to-curb, sidewalks only as centrelines, and the two must be
joined by a plain footway rather than snapped directly. AccessMap's architecture also
suggests a specific high-value idea: connect the pedestrian network to station pathways via
**GTFS `pathways.txt`**, so Transit Score accounts for the real walk from street to platform
instead of teleporting riders to a stop coordinate.

There is **no unified national US sidewalk inventory and none is imminent**. The realistic
design is a tiered, provenance-flagged pedestrian network — TDEI where available, then OSM
sidewalks, then Tile2Net inference, then street-centreline fallback — with the tier exposed
in the API response, because a score computed on a centreline fallback and one computed on a
surveyed sidewalk graph are not the same measurement.

**Mapillary** offers a free `points` layer including crosswalks, street lamps, benches and
**bicycle racks**. Note it is **CC-BY-SA** — share-alike from a second direction — and Meta's
terms describe the access licence as revocable, so do not architect a hard dependency.

### Bike — Level of Traffic Stress

**Conveyal's `LevelOfTrafficStressLabeler`** (MIT, in R5) is a ~200-line algorithm inferring
LTS 1–4 purely from OSM tags we already fetch: explicit `lts` tag → no-car ways are LTS 1 →
residential/living_street LTS 1 → `maxspeed` < 25 mph with <4 lanes LTS 2 →
unclassified/tertiary with <4 lanes or a cycleway tag LTS 2 → cycleway tag LTS 3 → else
LTS 4. Then `applyIntersectionCosts` assigns, at each unsignalised vertex, the **highest LTS
of any edge at that vertex to all edges there** — implementing the crossing-stress effect
that makes quiet suburban streets score correctly instead of generously.

Read the source comments before trusting it: the class header admits "OSM actually doesn't
contain enough data to extract a level of traffic stress" and that the authors never
validated against ground truth. It is still far better than not modelling stress, but it
should not be presented as calibrated.

**PeopleForBikes' Bicycle Network Analysis** (`brokenspoke-analyzer`, **MIT**) provides the
gap-filling defaults for the attributes OSM usually lacks — Primary/Secondary 40 mph 2 lanes,
Tertiary 30 mph, Unclassified/Residential 25 mph 27 ft — plus facility minimum widths and
intersection signal assumptions. Their 2026 methodology update includes two changes we
should adopt directly:

- **A 25% detour cap.** Low-stress routes requiring more than 25% detour versus the direct
  route are excluded. This is Mekuria/Furth's original acceptable-detour criterion, and it
  is the single highest-leverage fix available: a bounded Dijkstra that finds *any*
  low-stress path scores a location as connected even when the path is a 2× detour nobody
  would ride.
- **Retail expanded to all OSM `shop=*` tags** rather than only `landuse=retail` areas,
  reflecting current OSM tagging practice. Worth auditing our own extraction against.

A calibration sanity check from the original Mineta study: in San José, only **0.4% of work
trips under 6 miles were connected at LTS 1 and 4.7% at LTS 2**. Low-stress connectivity is
genuinely scarce, so a Bike Score returning middling values everywhere is almost certainly
wrong — which is precisely our documented symptom.

Note **Strava Metro is closed** to us (partner organisations and an academic program not
currently accepting applications), and there is no free national bicycle-volume dataset.
Validate against PeopleForBikes block-level scores instead — free CSV and per-city
shapefiles at `https://cityratings.peopleforbikes.org/ratings`.

### Transit routing engines

| Engine | License | GTFS | Native isochrones | Verdict |
| --- | --- | --- | --- | --- |
| **Valhalla** | MIT | Yes | **Yes** | **Recommended** |
| R5 / r5py | GPL-3.0 **or MIT** — elect MIT | Yes | Yes | Offline calibration |
| GraphHopper | Apache-2.0 | Yes | Approximate | Viable |
| OSRM | BSD-2 | **No** | **No** | Not applicable |
| OTP2 | LGPL-3.0-only | Yes | **Deprecated** | **Avoid for this** |

**OpenTripPlanner 2 has formally exited accessibility analysis** and its maintainers
explicitly redirect users to R5. A sandbox travel-time endpoint exists but is unmaintained
and may be removed. This is a change from OTP1-era guidance and is easy to get wrong.

Valhalla is the right primary choice for us: MIT, ships as a lean Docker container needing
2–8 GB RAM, exposes `/isochrone` as a first-class endpoint returning GeoJSON (or GeoTIFF for
raw grids), supports `pedestrian` / `bicycle` / `multimodal` costing against the same tile
set with **costing parameters supplied per request** rather than baked at build time, and is
elevation-aware with grade-weighted costing. Calling it over HTTP from TypeScript is trivial.

### Other permissive sources worth noting

- **Microsoft Global ML Building Footprints** — 1.4B footprints with height estimates on a
  growing subset, **CDLA-Permissive-2.0** (several third-party sites incorrectly claim ODbL;
  the repo README is authoritative). Useful for rooftop-centroid geocoding and as a floor-area
  proxy. Take them direct from Microsoft rather than via Overture's `buildings` theme, which
  is ODbL.
- **Wikidata** — **CC0**, the most permissive source in this report. Not a POI discovery
  source (coverage is biased to notable entities) but excellent for disambiguation and for
  **weighting destinations by importance** — `visitors per year`, `students count` — which
  addresses a real Walk Score weakness where every POI counts equally.
- **Mobility Database** — keep it. Metadata is CC0, commercial use explicitly permitted, and
  all historical TransitFeeds data was migrated in December 2025. We under-use its
  **bounding-box filtering** (fetch only feeds intersecting the query area, which fixes silent
  coverage holes) and its **validator reports** (down-weight broken feeds rather than
  silently scoring wrong).
- **Transitland — do not adopt.** Its free tier is now explicitly **non-commercial only**,
  and Professional is $200–250/month. Mobility Database covers the same feeds under CC0.
- **OpenAddresses — highest licensing risk in this report.** It does not relicense from
  sources; many carry attribution *and* share-alike clauses and several are **revocable**.
  Requires per-source license filtering before any production use.

---

# Part 4 — Methodology improvements

Ordered by value per unit of effort. Each states what changes and what it fixes.

## 4.1 Change the decay curve's shape

Our piecewise-linear curve approximates roughly a power/exponential form. Two independent
literatures find this is the worst-fitting common choice. The Dutch commuting study
concludes "neither an exponential nor a power distance-decay function fits the data well"
and that decay is **S-shaped**, adequately described by a **log-logistic** function — which
uses four fewer parameters than a power spline, needs no choice of kink points, and achieves
nearly identical fit. The Canadian transit accessibility work independently found
negative exponential "distances the most from the distribution of our data" with
Log-Logistic and Gaussian CDFs fitting best.

An S-curve is also behaviourally meaningful rather than merely better-fitting: it encodes a
plateau of near-indifference at very short distances (nobody cares whether the coffee shop is
80 m or 150 m) followed by a steep fall near the psychological quarter-mile threshold. Our
current curve is already flat to 0.25 mi, so we have half the shape right by construction.

**Also make decay purpose-specific.** NHTS `TRPMILES` by `TRIPPURP` shows grocery, school and
restaurant trips have materially different acceptable walking distances. We currently apply
one curve to all nine categories.

## 4.2 Rebuild Transit Score as cumulative opportunity

Replace `Σ routes (mode × frequency × decay)` with: **what fraction of the region's jobs (or
categorised destinations) can you reach within T minutes by transit, departing in the
morning peak?**

Three specifics from the literature:

- **Set T to the region's mean commute time, not a fixed national 30 or 45 minutes.** This is
  where correlation with gravity-based measures peaks — 0.97 in the Montreal study at the
  region's 48.8-minute mean. It means T must be region-varying, which is a real
  implementation requirement.
- **Use the morning peak.** Defensible per Boisjoly & El-Geneidy, and far cheaper than
  all-day averaging.
- **Cumulative opportunity is sufficient.** Correlations of 0.90–0.97 with gravity-based
  measures across eight metros mean we get nearly all the fidelity for a fraction of the
  complexity, plus a metric users actually understand: "you can reach 42% of the region's
  jobs in 45 minutes."

This fixes the two structural flaws (no destination awareness, penalising wider stop
spacing), produces a number that means something absolute rather than being anchored to an
arbitrary five-city average from the early 2010s, and — per §6 — computes a fundamentally
different quantity from what the Transit Score patent's independent claims recite.

Denominator options: LODES jobs at block level is the literature standard; Overture places
counts by category is the non-governmental equivalent and fits our stack better.

## 4.3 Reframe Bike Score around Level of Traffic Stress

Port Conveyal's labeler, backfill missing `maxspeed`/`lanes` with BNA's default tables,
implement the intersection-maximum step, and **add the 25% detour cap**. Then ask not "is
there infrastructure here?" but "does a low-stress route exist end to end without an
unacceptable detour?"

This directly targets our documented over-generosity in quiet streetcar suburbs: those
streets are individually low-stress but the intersection-maximum rule and the detour cap
together capture that they do not connect to anything without crossing an arterial.

Where FDOT data exists, compute LTS from real AADT, speed and lane counts rather than
inferring from tags — and prefer DVRPC's open implementation (`dvrpc/gis-lts-calc`) over
inventing our own.

## 4.4 Add urban form as a first-class term

We currently use intersection density only as a ≤10% penalty. Ewing & Cervero rank it among
the top three correlates of walking; Frank weights it **2×**, the heaviest term in his index.
Two additions:

- **Promote intersection density** from penalty to weighted component. Computable exactly and
  cheaply from our existing graph, or free from Overture connectors.
- **Add land-use diversity** (entropy over use types), which we do not measure at all and
  which Ewing & Cervero rank as the *strongest* correlate of walking. Caveat worth designing
  around: the standard entropy formula cannot distinguish 30% residential / 70% retail from
  70% residential / 30% retail, so consider a configuration-aware variant.

Note the blocker: Frank's retail floor-area ratio needs parcel-level floor area, which is a
government product. Microsoft footprints (area × height) joined to Overture places for use
type is an approximation with real error — usable, but we should not call it Frank's index.

Ewing & Cervero's other finding is a useful negative: **density is only weakly associated
with travel behaviour once the other variables are controlled**. Do not chase density.

## 4.5 Score on the n-th nearest amenity, not the nearest

Access to one restaurant is qualitatively different from access to twenty. Our slot system
partly captures this for restaurants (ten slots) and shopping (five), but grocery, parks,
schools, books, entertainment and errands each have a **single** slot, so a neighbourhood
with one park and one with twelve score identically on parks. WAS uses `k=30`; Boeing's
walkability work plots distance to the fifth-nearest amenity for exactly this reason.

## 4.6 Weight destinations by significance

Every POI currently counts equally within its quality multiplier. Overture `basic_category`
plus Wikidata importance claims (`visitors per year`, `students count`) would let a regional
museum outrank a one-room gallery. The St. Lucie parks data makes the same point locally: a
674-acre state park and a 0.2-acre beach access both currently fill the same 1.00-point slot.

## 4.7 Separate utilitarian from recreational walkability

The literature is unanimous that these are different constructs conflated into one number,
and that the objective–subjective divergence in Walk Score is systematic — perceived
walkability matches it well in dense older neighbourhoods where utilitarian walking is
common, and diverges where people assess walkability recreationally. Reporting them
separately would be a genuine methodological advance and is well suited to Overture's
category hierarchy.

---

# Part 5 — Validation: the most important section

Right now we calibrate by scraping a competitor's scores for 38 points. That caps our
accuracy at reproducing a metric with documented pathologies, and it is a fragile runtime-
adjacent dependency on a website we do not control.

Five replacements, all free:

1. **WAS** — peer-reviewed, national, every block group, 1997–2019, published ρ = 0.912
   against Walk Score with tuned parameters (`decay=0.008`, `upper=800m`, `k=30`). This
   becomes the primary regression harness. It also sets a floor: if a Euclidean-distance
   method with k=30 reaches 0.912, our network-based Dijkstra should do better, and if it
   does not, that is a bug signal. Caveat — it was built on proprietary InfoUSA points, so
   the method is reproducible but the input is not; substitute Overture places.
2. **EPA `NatWalkInd`** — free, complete, national, every block group. Rank-correlating
   against it would catch an intersection-density inversion instantly, nationally, in one
   query. Its `D3B` definition is also an independent check on our Trap 1 calibration.
3. **PeopleForBikes block-level scores** — free CSV and per-city shapefiles, ~3,000 cities,
   transparent methodology. The natural Bike Score target.
4. **CNT H+T modelled transportation cost** — semi-independent, because it is *downstream* of
   location efficiency rather than another supply-side re-measurement. That makes it a better
   validity test than another index. Registration and a click-through agreement are required;
   read before commercial use.
5. **Behavioural ground truth** — ACS B08301 walk/bike/transit commute share at block group,
   LATCH `pct_veh_0` car-free household share, NHTS trip diaries, and CDC PLACES physical
   inactivity. All federal, all free. Using them for **offline validation only** keeps the
   runtime pipeline clean.

**And the highest-value validation work available to us, which almost nobody does:** build
explicit regression tests asserting our score is **not** positively correlated with speed
limits, highway density, cul-de-sac counts, or crime. Walk Score demonstrably fails these.
If ours passes, that is a concrete, measurable, publishable claim of superiority — and it can
be computed entirely from data we already have.

---

# Part 6 — Legal and licensing

## 6.1 Patents and trademarks

**Superseded — see `patent-claim-map.md`**, which enumerates the full nine-document portfolio
and maps every independent claim. Three corrections to what this section originally said:

- The portfolio is **seven live patents, not three**. The one that matters most,
  `US 9,677,892` (expiring **2033-03-24**), was missed here entirely. It claims
  batch-precomputing transit scores for many locations and caching them — which describes
  `precompute_grid.py` and `score_cache`.
- This section implied the "transit shed" was disclosed but unclaimed. **It is claimed**, in a
  separate branch of the family: `US 9,195,953`, `US 9,964,410` and `US 10,317,219`. The
  operative element in the broadest of them is emitting **an area**, so counting reachable
  destinations is fine but rendering an isochrone polygon is not.
- Conversely the exposure on the *walkability* patents is lower than implied: all seven
  independent claims across `'422` and `'455` require a **population density metric**, which
  the engine does not compute.

The practical position still holds — methodological divergence is both the better product and
the better defence — but the specific element to diverge on is per-stop distance × frequency
weighting combined into a score. Get counsel; nothing here is legal advice.

## 6.2 ODbL — subtler than it looks

Three categories matter. A **Produced Work** (a single score returned to a single caller)
needs attribution only. A **Derivative Database** triggers share-alike under §4.4 and a
machine-readable copy offer under §4.6. A **Collective Database** does neither.

Where this bites us specifically:

- **Our routing graph is a Derivative Database.** Used only internally to answer live queries,
  no obligation attaches. Distributing it engages §4.4.
- **A precomputed national score table is the danger zone.** The OSMF Geocoding Guideline is
  directly analogous and unusually explicit: individual results are insubstantial extracts,
  but *systematically* accumulating them into a new database that embeds a substantial part
  of OSM makes that new database a Derivative Database. A nationwide address-granularity
  score table derived from the OSM network is a strong candidate. Note the §4.6 remedy is not
  that we open-source our code — it is that we offer the *database* on request. **This is
  worth legal advice before we precompute at national scale**, and it is directly relevant
  given we just started precomputing Fort Pierce.
- **On-the-fly combination is materially safer than precomputation**, which is an argument
  for the caching architecture we already have over a bulk precomputed product.

**The architecture this suggests:** keep the ODbL-encumbered *network* layer as an internal,
query-time-only derivative we never distribute, and source the *POI* layer — the part we most
want to cache, precompute and ship — from **Overture places under CDLA**. The amenity index
becomes freely redistributable; only the routing graph stays encumbered, and only if
distributed.

## 6.3 Risk register

| Source | License | Share-alike | Risk |
| --- | --- | --- | --- |
| Overture `places` | CDLA-Permissive-2.0 / Apache-2.0 | No | 🟢 Best in report |
| Wikidata | CC0 | No | 🟢 None |
| Microsoft Building Footprints | CDLA-Permissive-2.0 | No | 🟢 Low |
| Mobility Database metadata | CC0 | No | 🟢 Low (per-feed terms are ours) |
| Tile2Net / brokenspoke / Valhalla | BSD-3 / MIT / MIT | No | 🟢 Low |
| Federal sources (FTA, BTS, USGS, HPMS, LODES, NAD, FARS, SNAP) | Public domain | No | 🟢 None |
| FDOT / FGDL | No formal licence; liability disclaimer + FL public records law | No | 🟡 Attribution posture |
| r5py / R5 | GPL-3.0 **or** MIT | Elect MIT | 🟡 Elect explicitly |
| OSM / Overture transportation, buildings, base | **ODbL** | **Yes** | 🔴 See §6.2 |
| Mapillary | **CC-BY-SA**, some NC-SA; revocable | **Yes** | 🔴 Avoid hard dependency |
| OpenAddresses | Per-source; some SA, some **revocable** | Varies | 🔴 Needs per-source filtering |
| Pandana | **AGPL-3.0** | Network copyleft | 🔴 Offline calibration only |
| Transitland | Free tier **non-commercial** | — | 🔴 $200–250/mo; skip |
| Signal Four (FL crash) | Statutory restriction | — | ⛔ Closed |
| Strava Metro | Closed program | — | ⛔ Closed |
| Walk Score name/method | Patents to 2030/31/32 + trademarks | — | ⛔ See §6.1 |

---

# Part 7 — What I would do, in order

**Immediate, cheap, high value.** Load the ART GTFS feed and fix the primary market's
Transit Score — scrape `ftis.org/Posts.aspx` for the current id rather than hardcoding
`977A0`, since it is an ASP.NET postback id that changes on each posting, and alert on
failure. Generalise that scraper to the ~40 other Florida agencies on FTDE. Add BTS National
Transit Map as a coverage oracle so we return `null` plus a warning instead of a misleadingly
low score where we have no feed. Fix the six stale rows in `docs/METHODOLOGY.md`. Decide on
naming.

**Next, and these are the real methodology work.** Migrate POIs to Overture `places` before
the September 2026 `categories` removal — biggest quality gain, and it moves the amenity
layer out of ODbL. Port Conveyal's LTS labeler and add the 25% detour cap. Change the decay
curve to log-logistic with purpose-specific parameters from NHTS. Replace the Walk Score
scrape with WAS and `NatWalkInd` as the calibration harness, and add the "not positively
correlated with speed limits and highway density" regression tests.

**Then, architectural.** Move off public Overpass to Geofabrik → osmium → osm2pgsql →
PostGIS, or to Overture transportation locally — this is what removes the H12 timeouts, the
R14 pressure and the multi-hour precompute, and it eliminates silent low-score errors from
truncated Dijkstra searches. Rebuild Transit Score as cumulative opportunity over Valhalla
isochrones with a region-varying threshold. Integrate FDOT bike facilities and AADT. Promote
intersection density to a weighted component and add land-use diversity.

**Differentiating, and deliberately outside the headline number.** Street lighting as a night
walkability sub-score. Park quality weighting. An accessibility-aware score built on the
OpenSidewalks schema — curb ramps, tactile paving, surface, width — which Walk Score has no
answer to at all.

## The three decisions I need from you

1. **Do we match Walk Score, or beat it?** These pull in opposite directions and it is the
   question everything else hangs off. Matching is the migration requirement — DN's six
   consumers should see no visible change at cutover. Beating it means adopting LTS,
   cumulative-opportunity transit, urban form and safety, all of which move us *away* from
   the reference set and will make our calibration numbers look *worse* while the scores get
   better. My recommendation is to ship matching first for a clean cutover, then diverge
   behind a version flag with both available, because the rollback story is what makes the
   integration safe.
2. **Do we take the naming and patent risk seriously now?** Renaming is nearly free today and
   expensive after the marks are on partner sites and in DN's templates.
3. **How much do we care about precomputing at national scale?** It is the main thing that
   would push us into ODbL §4.4 territory, and it is avoidable by keeping combination at
   query time.

---

*All research verified 26 July 2026. The only cited URL that failed to resolve was
`api.peopleforbikes.org` (DNS failure); `stlucietpo.org` serves HTTP only, with no working
TLS. Nothing in this document has been implemented.*
