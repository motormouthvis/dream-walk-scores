# Deploying

Three ways to get a live instance, in order of least effort.

---

## 1. The script

```bash
heroku login          # or: export HEROKU_API_KEY=...
bash scripts/deploy-heroku.sh
```

Creates the app, sets the buildpacks, provisions Postgres, generates an admin password,
deploys, waits for the app to answer, loads the 25 largest US transit feeds, and prints the
URLs. Roughly ten minutes, most of it downloading GTFS.

Safe to re-run — every step checks for what it needs before creating anything, so a run
that fails partway through can just be run again.

```bash
bash scripts/deploy-heroku.sh my-app-name    # a different app name
GTFS_FEEDS=60 bash scripts/deploy-heroku.sh  # more transit coverage, slower
```

---

## 2. By hand

If you would rather see each step:

```bash
heroku apps:create dream-walk-scores --stack heroku-24

# Order matters. Python first, so pipeline/*.py and psycopg2 exist by the time the
# release phase runs the migration. Node last, so Node boots the web dyno.
heroku buildpacks:add heroku/python
heroku buildpacks:add heroku/nodejs

heroku addons:create heroku-postgresql:essential-0 --wait

heroku config:set \
  PGSSLMODE=require \
  ADMIN_PASSWORD="$(openssl rand -hex 24)" \
  PUBLIC_BASE_URL="https://dream-walk-scores.herokuapp.com"

# Heroku always deploys its own `main`, whatever the local branch is called.
git push heroku cursor/dream-walk-scores-foundation-ebfd:main

# The schema applies automatically in the release phase. Then load transit:
heroku run "python3 pipeline/load_gtfs.py --catalog --top 25"

curl "https://dream-walk-scores.herokuapp.com/api/health"
```

---

## 3. Locally

No cloud account needed, and everything except the public URL works:

```bash
npm install && npm run dev      # http://localhost:3000
```

That alone scores any US address, live from OpenStreetMap. Transit falls back to
OpenStreetMap routes without schedules, and the response says so.

For the full experience:

```bash
createdb dws && psql dws -c 'create extension postgis'
export DATABASE_URL=postgresql://localhost:5432/dws
pip install -r requirements.txt
python3 pipeline/init_db.py
python3 pipeline/load_gtfs.py --catalog --metro Chicago
npm run dev
```

---

## Verifying a deployment

```bash
node scripts/smoke.mjs https://your-app.herokuapp.com
```

68 assertions covering every public surface: the score endpoints, the Walk Score
compatibility shape and its status codes, batch, GraphQL, the widget, CORS, error handling
and caching. Set `ADMIN_PASSWORD` in your shell to include the admin checks.

`GET /api/health` is the quick version — it reports what the deployment can actually do
rather than just `ok`:

```jsonc
{
  "status": "ok",
  "capabilities": {
    "gtfsSchedules": true,     // false: Transit Scores are OpenStreetMap estimates
    "precomputedGrid": false,  // false: first lookup in an area will be slow
    "aiExplanations": false
  },
  "data": { "gtfsFeeds": 25, "gtfsStops": 98431, "cachedScores": 0 }
}
```

---

## What to expect on a fresh deployment

**The first lookup in any area takes several seconds** — three to twenty, depending on
density — because it is waiting on Overpass to return the street network and amenities.
Every subsequent lookup nearby is served from cache in tens of milliseconds.

That is fine for a demo and not fine for a property page, which is what the precompute job
is for:

```bash
heroku run:detached --app <app> \
  "python3 pipeline/precompute_grid.py --metro chicago --base-url https://<app>.herokuapp.com"

python3 pipeline/precompute_grid.py --list   # known metros and their cell counts
```

Run it detached — a metro at 200 m spacing is a few thousand cells and takes hours,
deliberately: each cold cell is an Overpass query, and Overpass is a free community service
that should not be hammered. Progress is checkpointed to `precompute_region`, so an
interrupted run resumes cheaply because everything already scored is cached.

Warming just the neighbourhoods you actually list is much faster than a whole metro:

```bash
python3 pipeline/precompute_grid.py \
  --bbox 27.40,-80.38,27.50,-80.28 --name "Fort Pierce" --spacing 200 \
  --base-url https://<app>.herokuapp.com
```

---

## Costs

| | Monthly |
| --- | --- |
| Heroku Basic dyno | $7 |
| Postgres `essential-0` | $5 |
| OpenStreetMap, GTFS, terrain tiles, Census geocoder | free |
| AI explanations (optional) | ~$0.20 per 1,000 uncached generations |

About **$12/month**, against per-call pricing for the Walk Score API.

Watch the row count rather than storage: `essential-0` caps at 10,000 rows and a
precomputed metro will exceed that on its own. `essential-1` ($9) raises the cap to
1,000,000, which is enough for several metros with room to spare. `/admin` shows the cached
cell count.

---

## Troubleshooting

**Build fails on a Python or Node step.** Check buildpack order — `heroku buildpacks`
should list `heroku/python` first, then `heroku/nodejs`.

**Release phase fails with a psycopg2 import error.** The Python buildpack did not run.
Same cause as above.

**`/api/health` reports `"database": { "reachable": false }`.** Confirm `PGSSLMODE=require`
is set; Heroku Postgres presents a certificate that fails strict verification without it.

**Every Transit Score is null.** No GTFS is loaded. Run the ingest step, then check
`/api/health` shows `gtfsSchedules: true`.

**Scores are slow and `provenance.source` is always `"live"`.** Nothing is cached yet.
Expected on a fresh deploy; run the precompute job for the areas you care about.

**Intermittent 500s under load, mentioning Overpass.** The public mirrors are rate-limiting
you. At real traffic volume, either precompute the areas you serve or run your own
Overpass instance and point `OVERPASS_ENDPOINTS` at it.

---

## Custom domain

```bash
heroku domains:add walkscores.dreamneighborhood.com --app <app>
heroku certs:auto:enable --app <app>
heroku config:set PUBLIC_BASE_URL=https://walkscores.dreamneighborhood.com --app <app>
```

`PUBLIC_BASE_URL` matters: it is what the Walk Score compatibility endpoint puts in the
`ws_link`, `help_link` and `logo_url` fields that consumers render.
