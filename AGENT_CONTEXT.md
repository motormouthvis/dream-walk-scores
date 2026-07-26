# Agent Context & Handoff — Dream Walk Scores

> Persistent memory for Cursor cloud agents working on this project.
> **New agent: read this whole file first**, then pick up the CURRENT TASK section.
> Keep it updated — if you change something structural here, edit this file in the same PR.

---

## What this product is

A self-hosted Walk Score / Bike Score / Transit Score engine, built to replace the paid
[walkscore.com](https://www.walkscore.com) API across the Dream Neighborhood products.
Every data source is free and open, so running it costs about $12/month against per-call
pricing.

Given a US address or coordinate it returns three 0–100 scores, the full breakdown that
produced them, a plain-language explanation, and an honest confidence rating.

---

## Repository state

- **This repo:** `motormouthvis/dream-walk-scores`
- **Working branch:** `cursor/dream-walk-scores-foundation-ebfd` → **PR #1** into `main`
- **`main` is empty** apart from the initial commit. All the work is on the branch above.
  Check it out before doing anything.
- The repo is currently **public**. The owner asked for private; agents cannot change repo
  visibility, so this needs doing by hand in GitHub settings.

### Related repos (read-only reference — never modify)

| Repo | What it is | Relevance |
| --- | --- | --- |
| `motormouthvis/dreamneighborhood` | Django + PostGIS "Neighborhood Explorer" | **The customer.** Currently pays for Walk Score. Migration is one line — see `docs/INTEGRATION.md`. |
| `motormouthvis/dream-schools` | Next.js schools ratings product | **The architectural template.** This repo deliberately mirrors its conventions. |
| `motormouthvis/dream-neighborhood-realty` | Astro listings site | Widget consumer |
| `motormouthvis/dream-neighborhood-marketing-website` | Static marketing site | Widget consumer |

All four were public and clonable as of 2026-07-26.

---

## DEPLOYED — 2026-07-26

**App:** <https://dream-walk-scores-e1295d04a5c0.herokuapp.com>
**Heroku app name:** `dream-walk-scores` (account `bill@motormouth.io`, Basic dyno + `essential-0` Postgres)

| Surface | URL |
| --- | --- |
| Try it | <https://dream-walk-scores-e1295d04a5c0.herokuapp.com> |
| Health | `/api/health` |
| Admin | `/admin` |
| Methodology | `/methodology` |
| Walk Score drop-in | `/api/walkscore` |

Smoke: **68/68** (`ADMIN_PASSWORD=… node scripts/smoke.mjs <url>`).

The admin password is generated and stored only as a Heroku config var — it is deliberately
**not** in this repo, which is public. Read it with:

```bash
heroku config:get ADMIN_PASSWORD --app dream-walk-scores
```

> ⚠️ **Do not regenerate the Heroku API key.** The same key is shared with the
> `dream-schools` and `dreamneighborhood` agents; regenerating breaks both.

### Three things the deploy run corrected

1. **The app URL cannot be derived from the app name.** Heroku gives apps created since
   2023 a random hostname suffix, so `https://<app>.herokuapp.com` does not resolve. The
   deploy script polled that address, never got an answer, and failed a deployment that had
   actually succeeded. It now reads `web_url` back from the platform.
2. **`--top N` seeds the wrong feeds.** It ranks by bounding-box *area*, which measures the
   ground a feed spans rather than the service it carries, so a national-park shuttle
   outranks the New York subway. `--top 25` gave 25 feeds and 2,610 stops with no schedules
   in any city the product serves. Seeding now runs the curated metro list in
   `pipeline/load_calibration_gtfs.sh`: **69 feeds, 162,389 stops**. Times Square transit
   went 79 → 100 as a direct result.
3. **`essential-0` has no row limit.** It is capped at **1 GB of storage**; the 10,000-row
   figure belonged to the retired `hobby-dev` tier. Usage was 17.3 MB right after seeding
   and 88.7 MB (8.7%) once the precompute began filling `score_cache`, so no upgrade is
   needed — but check `heroku pg:info` before precomputing further metros. `essential-1`
   ($9, 10 GB) is a one-command upgrade if the data size ever approaches the cap.

### Live constraints worth knowing

- **Heroku's router hard-caps a request at 30 s.** A cold lookup in an unmapped area can
  exceed that and return `503 H12` — the smoke test fails on exactly this if it is the first
  thing to touch an area. Re-run once the area is warm, or precompute it.
- **The web dyno hits R14 (memory quota) on dense lookups.** `NODE_OPTIONS=
  --max-old-space-size=384` is now set, because V8 otherwise sizes its heap to the host
  rather than the 512 MB dyno and grows past the quota before doing a major GC.
- **Precompute is throttled by that same 30 s cap, badly.** The first Fort Pierce run used
  the default `--concurrency 3` and scored only **268 of 2,800 cells** in 20.5 minutes —
  three workers competing for one 512 MB dyno and for public Overpass pushed most cold
  cells past 30 s, so the router returned `503` and the job moved on. Re-running at
  `--concurrency 1` is slower per pass but completes far more cells, and the job is
  checkpointed to `precompute_region`, so repeated passes are cheap: already-cached cells
  are skipped at ~100/s. Run several passes rather than one.
- **Fort Pierce precompute is running detached** (~2,800 cells, checkpointed). Resume or
  re-run with:

```bash
heroku run:detached --app dream-walk-scores \
  "python3 pipeline/precompute_grid.py --metro fort-pierce --spacing 200 \
   --base-url https://dream-walk-scores-e1295d04a5c0.herokuapp.com"
```

---

## Tech stack & layout

Mirrors `dream-schools` on purpose: Next.js App Router + TypeScript + raw `pg` against
PostGIS, with a Python `pipeline/` for offline ingest, deployed to Heroku on the Python and
Node buildpacks.

```
app/api/…            REST, GraphQL, batch, Walk Score compatibility, embed, admin
app/embed            chrome-less iframe surface        public/embed.js   the one-line SDK
app/admin            operations dashboard              app/methodology   renders docs/METHODOLOGY.md
lib/scoring/         constants.ts, walk.ts, bike.ts, transit.ts, decay.ts  ← the formulas
lib/network.ts       graph build, Dijkstra routing, street-shape metrics
lib/osm/             Overpass client, tag classification
lib/transit/         GTFS queries, OSM fallback, source merge
lib/elevation.ts     terrarium PNG decoder over free AWS terrain tiles
lib/score.ts         orchestrator      lib/scoreService.ts   the cache hierarchy
pipeline/            load_gtfs.py, precompute_grid.py, init_db.py
sql/schema.sql       PostGIS schema (applied by the Heroku release phase)
scripts/             calibrate, validate, inspect-point, smoke, screenshot, deploy-heroku
```

### Deliberate technical decisions — don't undo these without reading why

- **No GeoPandas / OSMnx / Pandana.** The routing needed is one bounded Dijkstra over a few
  thousand nodes: ~400 lines of TypeScript, a couple of milliseconds. The scientific Python
  stack would put a language boundary in the hot path and take the slug from tens of MB to
  several hundred, for nothing the request path uses. Python is used only for batch ingest.
- **The database is optional.** With no `DATABASE_URL` the service still answers every
  request live from Overpass. Keep it that way — it makes review apps and local dev trivial.
- **AI never decides a score.** It rewrites a generated fact sheet into prose and does
  offline POI classification. `ai=1` returns identical numbers, only `summary` differs. A
  model outage must never affect scoring.
- **`null` is not zero.** `transit.score === null` means no data covers the area;
  `0` means covered and genuinely no service. Never collapse the two.

---

## Scoring, and three traps that already caught one agent

Full detail in **`docs/METHODOLOGY.md`**. Constants live in `lib/scoring/constants.ts` and
that file is the single source of truth — the docs describe it, not the reverse.

These three were found by calibrating against real Walk Score values. All are fixed. All
are easy to reintroduce:

1. **Intersection density must be measured over the street network only.** `highway=service`
   covers parking aisles and driveways, so counting all OSM ways makes a strip-mall suburb
   measure denser than Manhattan and inverts every connectivity-derived number. Footways
   stay in the *routing* graph but are excluded from the *shape* metrics.
   Consequence: real densities are much lower than people expect — Midtown Manhattan is
   about **52 intersections/km²**. All the penalty, circuity and connectivity thresholds are
   calibrated to that scale.

2. **The decay curve needs a different slope at each end.** The section out to half a mile
   governs *urban* scores (in a dense area it's the later category slots sitting at
   400–700 m); the fall beyond three quarters of a mile governs *suburban* scores (where the
   nearest supermarket is). A single uniform slope can only ever fix one — steepening it
   uniformly fixed suburbs and cost cities ten points.

3. **Transit sources must be merged, not chosen between.** Large agencies publish per-mode
   and per-borough feeds — the MTA ships nine. Selecting GTFS whenever *any* feed covers the
   point means partial coverage scores worse than no coverage: loading four MTA feeds
   discarded the subway lines OSM knew about and Times Square scored 50.

### Current accuracy

Against a 38-point reference set with 44 GTFS feeds loaded:

| | MAE | Bias | r | Within 10 |
| --- | --- | --- | --- | --- |
| Walk | 6.2 | −1.3 | 0.927 | 82% |
| Bike | 11.0 | +2.8 | 0.822 | 61% |
| Transit | 13.3 | −10.1 | 0.892 | 42% |

Transit's negative bias is **feed coverage, not formula** — metros with fully loaded feeds
land within a few points. Loading more feeds improves it without touching the scoring.

**Re-run `npm run calibrate` after any change to `lib/scoring/constants.ts`.** It scrapes
public reference values, so it is a development tool only, never a runtime dependency.

---

## Setting up a fresh dev VM

A new cloud-agent VM has none of this. Roughly ten minutes:

```bash
# Postgres + PostGIS
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  postgresql postgresql-contrib postgis postgresql-16-postgis-3 python3-psycopg2
sudo service postgresql start
sudo -u postgres psql -c "create user dws with password 'dws' superuser;"
sudo -u postgres createdb -O dws dws

export DATABASE_URL="postgresql://dws:dws@127.0.0.1:5432/dws"
python3 pipeline/init_db.py

# App
npm install
npm run build

# Transit for the calibration metros (~10 min, 44 feeds, ~160k stops)
bash pipeline/load_calibration_gtfs.sh
```

Chrome for screenshots is at `/usr/bin/google-chrome-stable` on the standard image.

If you find yourself doing this often, propose an env setup agent at
[cursor.com/onboard](https://cursor.com/onboard) to bake it into the base image.

---

## Testing

```bash
npm test                                  # 63 unit tests, offline, no network
npm run typecheck
npm run build

node scripts/smoke.mjs                    # 68 end-to-end assertions vs localhost:3000
node scripts/smoke.mjs https://<app>...   # ...or a live deployment
ADMIN_PASSWORD=… node scripts/smoke.mjs   # includes the admin checks

npm run inspect -- 40.758 -73.9855        # full breakdown for one point — use this to
                                          # explain any calibration delta
npm run calibrate                         # compare against published reference scores
node scripts/screenshot.mjs               # captures every surface incl. the widget on a
                                          # synthetic partner page
```

**Screenshot the UI after visual changes.** Doing so caught score labels truncating to
"Car-Depende…" and the widget iframe clipping its own content — neither of which any
assertion would have flagged.

**Serve test partner pages over HTTP, not `file://`.** A `file://` page has a null origin
and makes the widget look broken for reasons that cannot happen in production.
`scripts/screenshot.mjs` spins up a throwaway HTTP server for exactly this.

---

## Integration with the sibling products

`docs/INTEGRATION.md` is the full guide. The headline:

**`dreamneighborhood` is a one-line change.** All six of its Walk Score consumers flow
through `get_mobility_data()` in `apps/widget/services.py`, which flows through one HTTP
call in `apps/widget/utils/get_walk_score_utils.py`:

```python
base_url = settings.DREAM_WALK_SCORES_URL   # https://<app>/api/walkscore
```

`/api/walkscore` returns the exact upstream response shape and status codes, and
accepts-and-ignores `wsapikey`, `format`, `transit` and `bike`. Keeping the URL in a Django
setting makes both cutover and rollback a config var change with no deploy.

After cutover, the Walk Score® attribution in `dreamneighborhood` needs replacing —
`templates/core/data_sources.html`, `assets/javascript/widget/full_script.js`, and
`templates/reports/neighborhood_report.html`.

---

## Conventions

| Concern | Convention |
| --- | --- |
| Branches | `cursor/<name>-<suffix>`, one commit per logical change, never force-push or amend |
| Score colours | Same bands as dream-schools rating chips (`components/score.ts`) |
| Brand accent | `#1fa55f` |
| Missing data | `null` / "not rated", never a fabricated zero |
| API key header | `Authorization: Api-Key <key>`, matching the DN public API |
| Errors | `{ "error": "...", "code": "..." }` |
| Comments | Explain *why*, never narrate *what*. No "// increment the counter". |

**Ask the owner before:** anything destructive, anything paid beyond the ~$12/month
baseline, changing a public API contract, or touching a reference repo.

---

## Known gaps / next tasks

- [x] **Deploy** — done, see the section at the top.
- [ ] Make the repository private (needs a human; agents can't change repo visibility).
- [ ] **Evaluate serving geometry from Overture instead of Overpass.** `dreamneighborhood`
      already holds the full Overture dataset in PostGIS via GeoDjango. Every latency
      problem above — 3–20 s cold lookups, `503 H12`, the multi-hour precompute, the R14
      pressure from parsing Overpass JSON — is a symptom of fetching geometry over HTTP per
      cell, and a local spatial query removes it. The seam is small: `lib/osm/overpass.ts`
      exposes only `fetchAmenities`, `fetchWalkNetwork` and `fetchTransit`, all returning
      `OsmElement[]`, so an Overture provider is an adapter behind that interface with
      Overpass retained as the fallback for uncovered areas.
      **Do not swap the data source without re-calibrating.** The constants in
      `lib/scoring/constants.ts` are tuned to OSM's way segmentation and tag vocabulary —
      trap 1 below depends on `highway=service` being excludable, and Overture's
      transportation theme segments and classifies roads differently. Reusing the OSM
      thresholds against Overture geometry would silently reintroduce exactly the
      intersection-density inversion that trap describes. Re-run `npm run calibrate` and
      expect a separate constants set.
      Note also the dependency direction: DN is meant to *consume* this service, so read
      Overture from a replica or copy the tables in, rather than making the scoring service
      depend on DN's runtime database.
- [ ] Broaden GTFS coverage. 44 feeds cover the calibration metros; there are ~3,400 US
      feeds in the Mobility Database. `pipeline/load_gtfs.py --catalog` scales it up.
- [ ] Bike Score still reads generous in quiet streetcar suburbs with no bike network —
      the low-stress-street measure gives more credit than the reference does.
- [ ] Precompute the metros the Dream products actually list in, once those are known.
- [ ] Self-hosted Overpass. The public mirrors are the only real scaling constraint;
      `OVERPASS_ENDPOINTS` already accepts a private instance.
- [ ] `main` still needs PR #1 merged into it.

---

*Last updated 2026-07-26 by the agent that deployed to Heroku (PR #1).*
