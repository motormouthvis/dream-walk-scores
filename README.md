# Dream Walk Scores

Walk, Bike and Transit scores for any US address — computed from OpenStreetMap, published
transit schedules and open Census data.

Built to replace the paid Walk Score API across the Dream Neighborhood products. Every
upstream data source is free, so the marginal cost of a score is compute plus, optionally, a
fraction of a cent for an AI-written explanation.

```bash
curl "http://localhost:3000/api/score?address=1500 N 23rd St, Fort Pierce FL"
```

```jsonc
{
  "location": { "lat": 27.4598, "lon": -80.3068, "address": "1500 N 23RD ST, FORT PIERCE, FL, 34950" },
  "walk":    { "score": 28, "description": "Car-Dependent",   "explanation": "Most errands require a car" },
  "bike":    { "score": 60, "description": "Bikeable" },
  "transit": { "score": 12, "description": "Minimal Transit", "hasCoverage": true },
  "confidence": "high",
  "summary": "Almost everything here needs a car…"
}
```

---

## Why this exists

Walk Score is a good product with expensive per-call pricing, and the Dream Neighborhood
Explorer calls it on every neighbourhood lookup. The underlying data — amenity locations,
street networks, transit timetables — is all public. This service computes the same three
numbers from that public data, exposes them through the same response shape, and is free to
run.

It is also **better in a few specific ways**: distances are routed over the real pedestrian
network, transit is weighted by actual published frequency, and every score ships with the
breakdown that produced it plus an honest confidence rating.

---

## Architecture

Deliberately the same shape as [`dream-schools`](https://github.com/motormouthvis/dream-schools),
which solves the same problem — address in, geospatial lookup, deterministic score, JSON
out, embeddable widget — so anyone who knows one repository knows both.

```
Next.js App Router (TypeScript)          the whole request path
├── app/api/…                            REST, GraphQL, batch, Walk Score compatibility
├── app/embed, public/embed.js           the embeddable widget
├── app/admin                            operations dashboard
└── lib/                                 scoring engine, data layer, caching

Python pipeline (pipeline/*.py)          offline ingest only
├── load_gtfs.py                         transit schedules from the Mobility Database
├── precompute_grid.py                   warms metros so listing pages never wait
└── init_db.py                           schema, run on Heroku release

Postgres + PostGIS                       optional — see below
```

**The database is optional.** With no `DATABASE_URL` the service still answers every
request by computing live from Overpass. Adding Postgres buys three things: the shared score
cache, the precomputed grid, and GTFS-backed Transit Scores. Review apps and local
development work without it.

### Why not GeoPandas, OSMnx and Pandana

The obvious stack for this problem is the Python geospatial one, and it is not used here.
The routing this service needs is a single bounded Dijkstra over a few thousand nodes, which
is ~400 lines of TypeScript in `lib/network.ts` and runs in a couple of milliseconds. Pulling
in the scientific Python stack would put a language boundary in the middle of the hot path,
take the Heroku slug from tens of megabytes to several hundred, and slow every deploy — in
exchange for nothing the request path actually needs.

Python is used where it earns its place: batch ingest of CSV and zip archives, where it is
genuinely the better tool.

### Cost model

| Source | Used for | Cost |
| --- | --- | --- |
| OpenStreetMap / Overpass | Amenities, streets, bike lanes, transit stops | Free |
| GTFS via Mobility Database | Transit routes and frequencies | Free |
| AWS Terrain Tiles | Elevation and gradients | Free |
| US Census Geocoder | Address lookup | Free |
| LLM explanations | Optional `summary` prose | ~$0.0002 per uncached generation |

Caching is layered so that Overpass is reached only when everything else misses: process
memory keyed to a 25 m grid, then Postgres shared across dynos, then the precomputed grid.
In a warmed metro almost every lookup is an indexed read.

---

## Quick start

```bash
npm install
npm run dev
# http://localhost:3000
```

That is enough to score any US address. For the full setup:

```bash
# Postgres with PostGIS
createdb dws && psql dws -c 'create extension postgis'
export DATABASE_URL=postgresql://localhost:5432/dws
python3 pipeline/init_db.py

# Transit schedules for a metro
pip install -r requirements.txt
python3 pipeline/load_gtfs.py --catalog --metro Chicago

# Pre-score a metro so listing pages are instant
python3 pipeline/precompute_grid.py --metro chicago --spacing 200
```

### Development commands

```bash
npm test                                   # 62 unit tests, no network required
npm run typecheck
npm run inspect -- 40.758 -73.9855         # full breakdown for one point
npm run validate                           # sanity-check a fixture set
npm run calibrate                          # compare against published reference scores
```

---

## API

Full reference: [`docs/API.md`](docs/API.md). Integration guide for the sibling Dream
products: [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

### `GET /api/score`

```
/api/score?lat=40.758&lng=-73.9855
/api/score?address=1500 N 23rd St, Fort Pierce FL
/api/score?lat=…&lng=…&ai=1          AI-written summary
/api/score?lat=…&lng=…&detail=0      headline numbers only
```

Returns the scores plus the complete breakdown: every amenity that earned points and how
far away it is, the street-network measurements, bike sub-scores, nearby transit routes with
their frequencies, confidence with reasons, and data provenance.

### `POST /api/score/batch`

Up to 100 points per request, for a search results page or an MLS sync. One bad address
does not fail the batch — each entry carries either a `score` or an `error`.

### `POST /api/graphql`

Same data, letting a client ask for only the fields it renders. `GET /api/graphql` returns
the schema.

### `GET /api/walkscore` — drop-in Walk Score replacement

Returns the exact response shape of `api.walkscore.com/score`, including its status codes.
Migrating an existing integration is a one-line base URL change. See
[`docs/INTEGRATION.md`](docs/INTEGRATION.md).

### `GET /api/health`

Reports what the deployment can actually do — whether GTFS is loaded, whether the grid is
warm — rather than just `ok`.

---

## Embeddable widget

One line on a partner page:

```html
<script src="https://<host>/embed.js" async></script>
```

Renders a floating panel, or an inline one if a container is present:

```html
<div id="dream-walk-scores"></div>
<script src="https://<host>/embed.js" async></script>
```

The SDK reads the property address off the page — JSON-LD, then meta tags, then likely DOM
elements, then the URL slug, then the title — and falls back to the partner's configured
default address, then to a manual search box. Per-host configuration (accent colour,
position, default address) resolves server-side from the `embed_partner` table;
unregistered hosts get a working default so the widget works the moment the tag is pasted.

Overrides go on the script tag: `data-accent-color`, `data-position`, `data-address`,
`data-lat` / `data-lng`, `data-show-header`, `data-require-address`, `data-min-height`.

---

## Deployment

Heroku, with the Python and Node buildpacks. `app.json` is complete enough for review apps.

```bash
heroku create dream-walk-scores
heroku buildpacks:add heroku/python
heroku buildpacks:add heroku/nodejs
heroku addons:create heroku-postgresql:essential-0
heroku config:set PGSSLMODE=require ADMIN_PASSWORD="$(openssl rand -hex 24)"
git push heroku main

# Schema runs automatically on release. Then load transit and warm a metro:
heroku run "python3 pipeline/load_gtfs.py --catalog --top 25"
heroku run "python3 pipeline/precompute_grid.py --metro chicago --base-url https://<app>.herokuapp.com"
```

Every environment variable is optional and documented in `.env.example`. The ones that
matter:

| Variable | Effect |
| --- | --- |
| `DATABASE_URL` | Enables the score cache, precomputed grid and GTFS transit |
| `ADMIN_PASSWORD` | Enables `/admin`; the dashboard is unavailable until set |
| `OPENAI_API_KEY` | Enables AI summaries on `ai=1` requests |
| `REQUIRE_API_KEY` | Locks the API down; unset, it is open |
| `OVERPASS_ENDPOINTS` | Point at a self-hosted Overpass at real traffic volume |
| `SCORE_CELL_METERS` | Cache grid resolution; larger is cheaper and coarser |

### Heavy jobs

Bulk ingest and national precomputes should not run on a web dyno. Use a one-off dyno
(`heroku run:detached`) or a temporary VM, and note that `precompute_grid.py` drives the
running service over HTTP, so it can be pointed at production from anywhere.

---

## Admin dashboard

`/admin`, gated by `ADMIN_PASSWORD`. Shows score coverage and freshness, cache hit rate,
Overpass call volume and failures, GTFS feed staleness, pipeline run status, and cost per
thousand scores.

---

## Scoring methodology

[`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) documents every formula, weight and threshold,
and the same file is served at `/methodology` so the published explanation cannot drift from
the one in the repository.

The short version: amenities in nine weighted categories, distance-decayed over real
network walking distance, adjusted for street connectivity; transit weighted by mode and
published frequency; cycling from infrastructure, terrain, destinations and connectivity.
All deterministic. AI writes explanations, never scores.

### Accuracy

Measured against published reference scores across a 38-point set spanning urban cores
through rural addresses — see `scripts/calibration-set.ts`. Walk Score tracks reference
values closely; Transit Score accuracy depends on GTFS coverage for the metro in question
and degrades gracefully to OpenStreetMap where a feed has not been loaded.

Re-run `npm run calibrate` after touching `lib/scoring/constants.ts`.

---

## Repository layout

```
app/            Next.js routes — pages and API handlers
components/     React UI, shared by the site and the embed iframe
lib/
  scoring/      the formulas: walk.ts, bike.ts, transit.ts, constants.ts, decay.ts
  osm/          Overpass client, tag classification
  transit/      GTFS queries, OSM fallback, source merge
  network.ts    graph construction, Dijkstra routing, street-shape metrics
  elevation.ts  terrarium PNG decoding over free AWS terrain tiles
  explain.ts    explanation templates and the grounded AI rewrite
  score.ts      the orchestrator
  scoreService.ts  the cache hierarchy in front of it
pipeline/       Python ingest: GTFS, schema, grid precompute
sql/schema.sql  PostGIS schema
scripts/        calibration and inspection tools
tests/          unit tests for the pure logic
docs/           methodology, API reference, integration guide
```

---

## Licence and attribution

Data © OpenStreetMap contributors ([ODbL](https://www.openstreetmap.org/copyright)), transit
agencies via GTFS, and the US Census Bureau. Not affiliated with or endorsed by Walk Score®.
