# How Dream Walk Scores are calculated

Every number this service returns comes from open data and a published formula. Nothing is
proprietary, nothing is a black box, and the constants that drive it all live in one file —
`lib/scoring/constants.ts` — which this document describes in prose. If the two ever
disagree, the code is right and this document is stale; please fix it.

Scores are **deterministic**. The same coordinate produces the same numbers on every run.
AI is used to *write* explanations and to help classify messy source data, never to decide
a score. That is a deliberate constraint: a score that changes because a model was
retrained is not a score anyone can build a business on.

---

## Walk Score (0–100)

### The idea

Walkability is a question about daily life: can you get to the things you need on foot?
So the score counts the things people actually walk to, weights each one by how far away it
is and by how much a second one of the same kind is worth, and then adjusts for whether the
street network lets you walk there directly.

### Step 1 — Find the amenities

Every point of interest within a **1.5 mile radius** is pulled from OpenStreetMap and
sorted into nine categories:

| Category | Examples |
| --- | --- |
| Grocery | Supermarkets, greengrocers, markets, convenience stores |
| Restaurants | Restaurants, fast food, pubs, food courts |
| Shopping | Department stores, clothing, hardware, pharmacy-adjacent retail |
| Coffee | Cafés, coffee shops |
| Errands & banking | Banks, post offices, pharmacies, clinics |
| Parks | Parks, gardens, playgrounds, recreation grounds |
| Schools | Schools, kindergartens, colleges |
| Books & libraries | Libraries, bookshops |
| Entertainment | Cinemas, theatres, museums, gyms, bars |

OpenStreetMap tagging is inconsistent, so each mapping rule carries a **quality
multiplier**. A `shop=supermarket` is a grocery store at full strength (1.0); a
`shop=convenience` is one at 0.45. The weaker members are kept rather than discarded
because in rural and low-density areas the corner store genuinely *is* the grocery store,
and dropping it produces badly wrong scores exactly where accuracy is hardest to come by.

Features tagged as disused, abandoned, closed or private are excluded.

### Step 2 — Measure the walking distance

Distance is measured **along the pedestrian street network**, not as the crow flies.

A routable graph is built from OpenStreetMap ways — including footpaths, which pedestrians
use even though they are not streets — and a single bounded Dijkstra search runs from the
query point out to 1.5 miles. Every amenity is then snapped to its nearest graph node and
takes that node's distance.

This matters more than any other single implementation choice. A shop 200 m away across an
unbridged motorway is a twenty-minute walk, and a system measuring straight lines will call
that neighbourhood walkable.

Where the OpenStreetMap network is too sparse to route on — genuinely rural areas, mostly —
the straight-line distance is multiplied by a **circuity factor** between 1.20 and 1.65,
chosen from the local intersection density. A tight grid adds about 20% to a straight line;
a cul-de-sac subdivision can add 65%. Responses say which method was used in
`provenance.distanceModel`, and estimated results are flagged as lower confidence.

### Step 3 — Apply the distance decay

An amenity's value falls with distance:

| Walking distance | Weight |
| --- | --- |
| 0 – 0.25 mi (up to a 5-minute walk) | 1.00 |
| 0.50 mi | 0.65 |
| 0.75 mi | 0.40 |
| 1.00 mi | 0.22 |
| 1.25 mi | 0.09 |
| 1.50 mi and beyond | 0.00 |

Values in between are interpolated linearly.

The steep fall between a quarter and half a mile is the most consequential part of the
whole model. Dense urban points score much the same under any curve, because everything is
within five minutes either way. It is suburban points — where the supermarket is
three-quarters of a mile off — that separate a calibrated engine from a generous one.
Flattening this curve inflates suburban scores by twenty points or more.

### Step 4 — Weight by category

Each category has a fixed number of point-earning slots, in descending weight. **15 points
are available in total.**

| Category | Slot weights | Max |
| --- | --- | --- |
| Grocery | 3.00 | 3.00 |
| Restaurants | .75 .45 .25 .25 .225 .225 .225 .225 .20 .20 | 2.75 |
| Shopping | .50 .45 .40 .35 .30 | 2.00 |
| Coffee | 1.25 .75 | 2.00 |
| Errands & banking | 1.00 | 1.00 |
| Parks | 1.00 | 1.00 |
| Schools | 1.00 | 1.00 |
| Books & libraries | 1.00 | 1.00 |
| Entertainment | 1.00 | 1.00 |

The asymmetry is the point. A second grocery store is worth nothing — you only shop at one —
so grocery has a single 3-point slot. Restaurant variety has real value, so restaurants get
ten slots with a long tail of diminishing weights.

Candidates within a category are ranked by **value** (decay × quality), not by raw distance,
and then paired with the slots in descending order. If the nearest grocery is a corner store
and a real supermarket sits a little further out, the supermarket claims the 3-point slot.
Ranking by distance alone would hand it to the corner store and understate the
neighbourhood.

### Step 5 — Adjust for the street network

Two places can have identical amenities and feel completely different to walk. A dense grid
of short blocks lets you go straight there; a subdivision of cul-de-sacs feeding one
arterial does not.

Two measurements, taken over the **street network only**:

- **Intersection density** — junctions of three or more streets per km²
- **Mean block length** — the distance between consecutive junctions

| Intersections / km² | Penalty | Mean block | Penalty |
| --- | --- | --- | --- |
| under 15 | 5% | over 230 m | 5% |
| 15 – 25 | 3% | 180 – 230 m | 3% |
| 25 – 35 | 2% | 140 – 180 m | 2% |
| 35 – 45 | 1% | 100 – 140 m | 1% |
| 45 and above | 0% | under 100 m | 0% |

Maximum combined penalty: 10%.

**Service roads, driveways, parking aisles and footpaths are excluded from these two
measurements**, though they remain in the routing graph. Including them is the classic
error in this kind of analysis: a big-box store's parking lot contains dozens of junctions,
so a strip-mall suburb measures denser than Manhattan and every connectivity-derived number
comes out backwards.

The thresholds above are calibrated to that street-only measure, which runs far lower than
people expect. Midtown Manhattan's grid of long east–west blocks works out to roughly **52
intersections per km²** — a table written for all-ways densities penalises one of the most
walkable places in the country as though it were sprawl.

### Step 6 — Normalise

```
Walk Score = round( (earned points / 15) × 100 × penalty factor )
```

| Score | Label |
| --- | --- |
| 90–100 | Walker's Paradise — daily errands do not require a car |
| 70–89 | Very Walkable — most errands can be accomplished on foot |
| 50–69 | Somewhat Walkable — some errands can be accomplished on foot |
| 25–49 | Car-Dependent — most errands require a car |
| 0–24 | Car-Dependent — almost all errands require a car |

---

## Transit Score (0–100)

What makes transit useful is not how many stops are nearby but how much **service** those
stops receive and how far it can take you. A shelter served twice a day is scenery.

### Data

Schedules come from **GTFS feeds**, indexed through the free
[Mobility Database](https://mobilitydatabase.org) catalogue of roughly 3,400 US feeds. The
pipeline flattens each feed's timetable into a single `trips_per_day` figure per route/stop
pair for a representative weekday, so scoring is one spatial join rather than a timetable
computation.

Where a feed has not been loaded, transit routes are read from OpenStreetMap instead. OSM
knows where the stops are and which routes call at them but carries no schedule, so
frequency is estimated and the result is marked lower confidence.

The two sources are **merged**, not chosen between. Large agencies publish separate feeds
per mode or per borough — the MTA ships nine — and picking GTFS whenever *any* feed covers
a point means partial coverage scores worse than no coverage at all. Merging means adding a
feed can only ever improve the answer. Routes appearing in more than one source are
de-duplicated on mode and designation.

### Formula

Each route within a **half-mile walk** contributes:

```
route value = mode weight × frequency factor × distance decay
```

**Mode weight** — rail is worth more than a bus at equal frequency because it is faster,
more reliable, and legible to someone who does not already know the system:

| Mode | Weight |
| --- | --- |
| Subway, heavy rail | 2.0 |
| Light rail, tram, ferry, cable | 1.5 |
| Bus | 1.0 |

**Frequency factor** — `min(2.0, √(trips per weekday / 60))`. Diminishing returns:
improving a route from every 30 minutes to every 15 transforms it; going from every 5 to
every 2.5 barely registers. A route with no schedule data gets 0.6.

**Distance decay** — 1.0 within 200 m, falling linearly to 0 at half a mile. People will
walk further for a train than for a sandwich, but the tolerance drops off sharply.

```
Transit Score = round( 100 × √( min(1, total value / 78) ) )
```

The square root spreads out the low end. A linear map would score a neighbourhood with one
hourly bus at 1 — indistinguishable from having nothing — when having one bus is
meaningfully different from having none.

| Score | Label |
| --- | --- |
| 90–100 | Rider's Paradise |
| 70–89 | Excellent Transit |
| 50–69 | Good Transit |
| 25–49 | Some Transit |
| 0–24 | Minimal Transit |

**No score is returned at all** when no feed and no OSM data cover the area. `null` is not
zero: "we do not know" and "there is no transit here" are different statements and the API
reports them differently.

---

## Bike Score (0–100)

Four things decide whether a place is good to ride, and they are not interchangeable. All
four are reported alongside the score, because a flat city with no bike lanes and a hilly
one criss-crossed with protected paths can land on the same number for opposite reasons.

| Component | Weight |
| --- | --- |
| Destinations | 30% |
| Infrastructure | 30% |
| Terrain | 25% |
| Connectivity | 15% |

**Destinations** — the same nine amenity categories and slot weights as Walk Score, scored
over a **cycling decay curve**: full weight out to 1 mile, tapering to zero at 3. A bicycle
turns a twenty-minute walk into a five-minute ride, so destinations that are marginal on
foot are genuinely convenient on a bike. This is a distance-weighted measure, not a count —
a suburb ringed by big-box retail has plenty of destinations, and their distance is exactly
the point.

**Infrastructure** — every way within the radius is graded by how comfortable it is to ride,
because a painted line on a 45 mph arterial is not the same product as a protected lane:

- *Protected* — `highway=cycleway`, `cycleway=track`, separated paths (55% of the sub-score)
- *Painted* — `cycleway=lane`, shared-lane markings (25%)
- *Low stress* — quiet residential streets at 30 mph or below (20%)

**Terrain** — grades are sampled along street segments using free
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/). The **85th-percentile
grade** drives the score, not the mean: averages lie about hills, and a flat neighbourhood
with one brutal climb between you and the shops averages out to "gently rolling" when the
climb is what decides whether you ride. 100 at or below 1% grade, 0 at or above 8%, linear
between.

**Connectivity** — intersection density over the street network, saturating at 50 per km².

Components that cannot be measured are **dropped and the remainder re-weighted**. If
elevation lookup fails, the score comes from the other three rather than silently treating
the place as pancake-flat.

| Score | Label |
| --- | --- |
| 90–100 | Biker's Paradise |
| 70–89 | Very Bikeable |
| 50–69 | Bikeable |
| 0–49 | Somewhat Bikeable |

---

## Confidence

Reported separately from the score, and driven by **data coverage, not by the score
itself**. A genuinely car-dependent place gets a high-confidence 8.

Confidence drops when:

- The street network was unavailable or too sparse to route on
- Fewer than four amenities were found nearby, suggesting thin OpenStreetMap coverage
- No transit schedule data covers the area
- Transit came from OpenStreetMap without frequencies
- Elevation was unavailable

`high` with no caveats, `medium` with one or two, `low` beyond that. Every response
includes the specific reasons in `confidenceNotes`.

---

## Where AI is used, and where it is not

**Used for:**

- **Writing the "why this score" summary.** The model receives a fact sheet generated from
  the computed breakdown and rewrites it as prose. It never sees the raw data, so it has
  nothing to draw its own conclusions from, and it is instructed to state plainly when
  something is missing rather than guess. Results are cached on the shape of the fact sheet,
  so a whole neighbourhood shares one generation and the marginal cost is effectively zero.
- **Classifying ambiguous OpenStreetMap features** during ingest, offline, with results
  stored. Never at request time.

**Not used for:**

- Deciding any score, sub-score or weight
- Estimating a distance, a frequency, or a grade
- Filling in a missing value

A request with `ai=1` returns the same numbers as one without; only `summary` differs. If
the model provider is down, slow, or unconfigured, the deterministic template is returned
and `summaryFromAi` is false. Scoring cannot fail because of an AI outage.

---

## Calibration

`scripts/calibrate.ts` scores a 38-point reference set spanning urban cores, streetcar
suburbs, postwar subdivisions, exurbs, small towns and rural addresses, and compares against
published reference values. It reports mean absolute error, bias, correlation and the share
of points within 10 and 20 points.

The set is deliberately weighted away from city centres. A calibration set full of downtowns
produces an engine that is excellent in Manhattan and useless in the places most listings
actually are.

Run it after any change to `lib/scoring/constants.ts`:

```bash
DATABASE_URL=... npx tsx scripts/calibrate.ts
```

`scripts/inspect-point.ts` dumps the complete breakdown for a single coordinate, which is
how a calibration delta gets explained.

---

## Data sources

| Source | Used for | Cost | Licence |
| --- | --- | --- | --- |
| OpenStreetMap via Overpass | Amenities, street network, bike infrastructure, transit stops | Free | ODbL |
| GTFS feeds via Mobility Database | Transit routes and frequencies | Free | Per agency, generally open |
| AWS Terrain Tiles | Elevation and grades | Free | Public domain / CC-BY per source |
| US Census Geocoder | Address to coordinate | Free | Public domain |
| Nominatim / Photon | Geocoding fallback | Free | ODbL |

Every source is free. The only variable cost of running this service is compute, plus
optional AI explanations.

---

## Known limitations

- **OpenStreetMap coverage varies.** Dense urban areas are mapped exhaustively; rural areas
  and some sunbelt suburbs are not. Where amenity counts look implausibly low we lower
  confidence rather than pretending otherwise.
- **Reference scores compress at the top.** A great many genuinely excellent places are
  published as exactly 100, so agreement in the 95–100 band means less than it appears.
- **GTFS is loaded per metro, not nationwide.** Areas without a loaded feed fall back to
  OpenStreetMap, and the response says so.
- **Grades come from a ~30 m raster.** Fine for characterising a neighbourhood, too coarse
  for a specific short, steep block.
- **United States only.** The engine is country-agnostic — OpenStreetMap and GTFS are global
  — but the calibration, the geocoder and the score bands are not, so non-US coordinates are
  rejected rather than answered with unearned precision.
