# Integrating with the Dream Neighborhood products

How to move each sibling product off the paid Walk Score API and onto this service.

The short version: **`dreamneighborhood` is a one-line change.** The compatibility endpoint
returns the exact response shape of `api.walkscore.com/score`, so nothing downstream of the
HTTP call has to change.

---

## dreamneighborhood (Django)

### What is there now

The Explorer widget calls Walk Score from exactly one place, and every consumer flows
through one normalisation function:

```
apps/widget/utils/get_walk_score_utils.py   get_walk_score()   ← the only HTTP call
apps/widget/services.py                     get_mobility_data() ← normalises to 9 fields
   ├── apps/api/views.py                    GET /api/v1/neighborhood/mobility/
   ├── apps/widget/views.py                 POST widget-api-mobility
   ├── apps/reports/tasks.py                PDF neighbourhood reports
   ├── mcp_server/server.py                 the neighborhood_mobility MCP tool
   ├── apps/widget/utils/chat_tools.py      the Ask AI function-calling tool
   └── assets/javascript/widget/*.js        the mobility tab
```

Six consumers, one seam. `get_mobility_data()` reads exactly these keys off the response:

`status`, `walkscore`, `description`, `bike.score`, `bike.description`, `transit.score`,
`transit.description` — plus `walk_explanation`, `bike_explanation` and `transit_explanation`,
which that module derives locally from the numeric scores.

### The change

In `apps/widget/utils/get_walk_score_utils.py`:

```python
# base_url = "https://api.walkscore.com/score"
base_url = settings.DREAM_WALK_SCORES_URL  # e.g. https://dream-walk-scores.herokuapp.com/api/walkscore
```

And in `settings.py`:

```python
DREAM_WALK_SCORES_URL = env("DREAM_WALK_SCORES_URL", default="https://api.walkscore.com/score")
```

Nothing else changes. The existing `wsapikey`, `format`, `transit` and `bike` query
parameters are accepted and ignored, so even the parameter construction can stay as it is.

Keeping the URL in a setting means the cutover and the rollback are both a config var
change, with no deploy.

### What the compatibility endpoint returns

```jsonc
{
  "status": 1,                         // 1 ok · 2 unavailable · 30 bad coords · 31 error
  "walkscore": 95,
  "description": "Walker's Paradise",
  "updated": "2026-07-26T03:12:04.738Z",
  "snapped_lat": 40.75797,
  "snapped_lon": -73.98554,
  "bike":    { "score": 92, "description": "Biker's Paradise" },
  "transit": { "score": 100, "description": "Rider's Paradise", "summary": "95 routes at 195 stops within a half-mile walk." },
  "ws_link": "…/score?lat=…&lng=…",
  "help_link": "…/methodology",
  "logo_url": "…/badge/logo.svg",
  "more_info_link": "…/methodology",

  // Additive. Existing parsers ignore it; new callers can use it without a second request.
  "dws": {
    "provider": "dream-walk-scores",
    "confidence": "high",
    "confidence_notes": [],
    "summary": "Daily errands here do not require a car…",
    "source": "cache"
  }
}
```

Two behaviours worth knowing, both matching Walk Score exactly:

- `bike` and `transit` are **omitted entirely** rather than sent as `null` when
  unavailable, because the existing code checks for key presence.
- Errors come back with HTTP 200 and a `status` code in the body.

### Attribution

Walk Score's terms require their branding wherever their scores appear. Once switched over
that requirement no longer applies, and the following need updating:

- `templates/core/data_sources.html` — the Walk Score® attribution block
- `assets/javascript/widget/full_script.js` — score bar branding and logo links
- `templates/reports/neighborhood_report.html` — the PDF mobility section

Replace with attribution to OpenStreetMap contributors (ODbL), transit agencies via GTFS,
and the US Census Bureau.

### Optional improvements after the cutover

The `dws` block carries things the Walk Score API never returned:

- **`confidence` and `confidence_notes`** — show "limited data here" instead of an
  unqualified number when OpenStreetMap coverage is thin.
- **`summary`** — a ready-made "why this score" paragraph for the mobility tab. Request it
  by calling `/api/score?ai=1` directly rather than the compatibility endpoint.
- The full `/api/score` response includes every amenity that earned points, which would let
  the mobility tab list what is actually nearby rather than only showing three numbers.

### The Ask AI tool and the MCP server

Both call `get_mobility_data()`, so both pick up the new provider with no change. If you
want the richer data in the agent's context, point `chat_tools.py` and `mcp_server/server.py`
at `/api/score` and pass the category breakdown through — the agent can then answer "how far
is the nearest grocery store" rather than only reporting a score.

---

## dream-schools (Next.js)

`lib/neighborhoodInsights.ts` currently mentions Walk Score as an upsell pointing at the
Explorer product. It can now show real scores instead.

Same stack, so the client is a few lines:

```ts
// lib/walkScores.ts
export interface MobilityScores {
  walk: number | null;
  bike: number | null;
  transit: number | null;
  summary: string | null;
}

const BASE = process.env.DREAM_WALK_SCORES_URL ?? "https://dream-walk-scores.herokuapp.com";

export async function getMobilityScores(lat: number, lon: number): Promise<MobilityScores | null> {
  try {
    const response = await fetch(`${BASE}/api/score?lat=${lat}&lng=${lon}&detail=0`, {
      // Scores change on the timescale neighbourhoods change.
      next: { revalidate: 86_400 },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      walk: data.walk.score,
      bike: data.bike.score,
      transit: data.transit.score,
      summary: data.summary,
    };
  } catch {
    // A scores outage must not take down the schools lookup.
    return null;
  }
}
```

`components/score.ts` in this repository uses the same colour bands as dream-schools'
rating chips, so the two sets of numbers sit together without restyling.

For a whole results page, use `POST /api/score/batch` — one request for up to a hundred
listings.

---

## dream-neighborhood-realty (Astro)

Static site, so the widget is the right integration:

```html
<div id="dream-walk-scores"></div>
<script src="https://dream-walk-scores.herokuapp.com/embed.js" async></script>
```

The SDK reads the address off the listing page. If the Astro templates already emit JSON-LD
with a `PostalAddress` — the usual case for a listing — extraction is reliable. Otherwise
pass it explicitly:

```html
<script
  src="https://dream-walk-scores.herokuapp.com/embed.js"
  data-address="1500 N 23rd St, Fort Pierce FL"
  data-accent-color="#1fa55f"
  async
></script>
```

---

## dream-neighborhood-marketing-website

Static HTML with an existing `embed/` directory. Same one-line snippet as above. Use
`data-position="left"` if it would otherwise collide with the existing Explorer popup —
both widgets are fixed-position and default to the right.

---

## Running both widgets on one page

`dreamneighborhood`'s Explorer SDK sets `window.__DN_EXPLORER_API_BASE__` and
`dream-schools`' sets `__DN_NEIGHBORHOOD_EXPLORER_READY__`. This SDK uses
`window.__DREAM_WALK_SCORES_LOADED__`, so the three do not collide.

They will overlap visually if more than one renders as a floating popup in the same corner.
Either give them different `data-position` values, or use inline containers, which is the
better presentation on a listing page anyway.

---

## Shared conventions

Things kept aligned with the sibling repositories on purpose:

| Concern | Convention |
| --- | --- |
| Score colour bands | Same thresholds as dream-schools rating chips (`components/score.ts`) |
| Brand accent | `#1fa55f` |
| Missing data | `null` and "not rated", never a fabricated zero |
| API key header | `Authorization: Api-Key <key>`, matching the Dream Neighborhood public API |
| Error shape | `{ "error": "...", "code": "..." }` |
| Deployment | Heroku, `Procfile` + `app.json`, Python and Node buildpacks |
| Pipeline | Python under `pipeline/`, mirroring dream-schools |

---

## Rollout

1. Deploy this service and load GTFS for the metros you serve.
2. Warm those metros with `precompute_grid.py` so the first real request is not a cold one.
3. Point `DREAM_WALK_SCORES_URL` at it for a subset of traffic and compare against the Walk
   Score values you are already receiving. `scripts/calibrate.ts` does this systematically.
4. Cut over by config var. Roll back the same way if anything looks wrong.
5. Update the attribution in `dreamneighborhood`.
6. Cancel the Walk Score subscription.

Steps 3 and 4 are deliberately reversible. Nothing about the cutover requires a deploy or a
schema change on the consuming side.
