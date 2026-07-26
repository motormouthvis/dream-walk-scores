# API reference

Base URL: your deployment's origin. All endpoints are read-only and CORS-open.

**Authentication** is optional. Unset, the API is open and rate-limited per IP. Set
`REQUIRE_API_KEY=1` to require a key:

```
Authorization: Api-Key <key>
```

`Bearer <key>`, an `X-API-Key` header, and an `api_key` query parameter are also accepted —
the last for the embed surface, which cannot set headers.

**Rate limits** are returned on every response as `X-RateLimit-Limit` and
`X-RateLimit-Remaining`. Exceeding one gives a `429` with `Retry-After`.

**Errors** are `{ "error": "human readable", "code": "machine_readable" }` with a matching
HTTP status. Codes: `bad_request`, `unauthorized`, `rate_limited`, `not_found`,
`out_of_coverage`, `upstream_unavailable`, `internal_error`.

---

## `GET /api/score`

The primary endpoint.

| Parameter | Description |
| --- | --- |
| `lat`, `lng` | Coordinate. `lon` is accepted as an alias for `lng`. |
| `address` | Address to geocode. Used when `lat`/`lng` are absent. |
| `ai` | `1` to have the summary written by an LLM instead of the template. |
| `detail` | `0` to omit amenity lists and breakdowns. Default `1`. |
| `fresh` | `1` to bypass every cache and recompute. |

```bash
curl "https://<host>/api/score?lat=40.758&lng=-73.9855"
curl "https://<host>/api/score?address=1500%20N%2023rd%20St,%20Fort%20Pierce%20FL&ai=1"
```

### Response

```jsonc
{
  "location": {
    "lat": 40.758,
    "lon": -73.9855,
    "address": null,
    // The point snapped to the nearest walkable street — this is what was scored.
    "snappedLat": 40.75797,
    "snappedLon": -73.98554
  },

  "walk": {
    "score": 95,
    "description": "Walker's Paradise",
    "explanation": "Daily errands do not require a car",
    "rawPoints": 14.409,
    "maxPoints": 15,
    "categories": [
      {
        "category": "grocery",
        "label": "Grocery",
        "maxPoints": 3,
        "points": 2.658,
        "nearestMeters": 533,
        "hits": [
          {
            "id": "osm:node/3921047",
            "name": "Key Food",
            "category": "grocery",
            "lat": 40.7612,
            "lon": -73.9891,
            "crowMeters": 486,
            "walkMeters": 533,
            "decay": 0.8859,
            "points": 2.658,
            // false means the distance was estimated rather than routed.
            "routed": true
          }
        ]
      }
      // …eight more categories
    ],
    "pedestrianShape": {
      "intersectionDensity": 51.9,   // per km², street network only
      "avgBlockLengthMeters": 126,
      "penaltyFactor": 0.99          // multiplier applied for connectivity
    }
  },

  "bike": {
    "score": 92,
    "description": "Biker's Paradise",
    "explanation": "Daily errands can be accomplished on a bike",
    "components": { "infrastructure": 82, "hills": 91, "destinations": 100, "connectivity": 100 },
    "infrastructure": {
      "protectedLaneMeters": 5140,
      "paintedLaneMeters": 8820,
      "lowStressMeters": 12400,
      "totalWayMeters": 96300
    },
    "hills": { "meanGradePct": 0.94, "steepGradePct": 1.65, "reliefMeters": 22 }
  },

  "transit": {
    "score": 100,
    "description": "Rider's Paradise",
    "explanation": "World-class public transportation",
    "rawPoints": 144.31,
    "stopCount": 195,
    "routeCount": 47,
    "routes": [
      {
        "routeId": "12:R",
        "shortName": "R",
        "longName": "Broadway Local",
        "agency": "MTA",
        "mode": "subway",
        "walkMeters": 242,
        "tripsPerDay": 1304
      }
    ],
    // false means no feed covers this area — which is not the same as no transit existing.
    "hasCoverage": true
  },

  "confidence": "high",
  "confidenceNotes": [],
  "summary": "Daily errands here do not require a car…",
  "summaryFromAi": false,

  "provenance": {
    "osmSnapshot": "2026-07-26T03:12:04.738Z",
    "gtfsSnapshot": "2026-07-26T02:54:58.215Z",
    "distanceModel": "network",        // or "circuity-estimate"
    "source": "cache",                 // or "precomputed-grid" | "live"
    "computeMs": 12
  }
}
```

### Reading the response correctly

**`null` is not zero.** `transit.score` is `null` when no data covers the area and `0` when
the area is covered and genuinely has no service. Rendering `null` as `0` tells a user
something false.

**Check `confidence` before presenting a bare number.** `confidenceNotes` explains every
downgrade in plain language, suitable for showing to an end user as-is.

**`routed: false`** on an amenity means the distance is a circuity-adjusted straight line
rather than a real route — accurate to maybe ±20%, and only happens where OpenStreetMap has
no usable street network.

---

## `POST /api/score/batch`

Up to 100 points per request.

```json
{
  "points": [
    { "id": "mls-1001", "lat": 40.758, "lng": -73.9855 },
    { "id": "mls-1002", "address": "1500 N 23rd St, Fort Pierce FL" }
  ],
  "detail": false,
  "ai": false
}
```

```jsonc
{
  "count": 2,
  "succeeded": 2,
  "failed": 0,
  "elapsedMs": 84,
  "results": [
    { "id": "mls-1001", "score": { /* compact unless detail:true */ } },
    { "id": "mls-1002", "error": { "message": "Could not geocode …", "code": "not_found" } }
  ]
}
```

Individual failures do not fail the batch — one bad address cannot cost you the other
ninety-nine results. Order is preserved, and `id` defaults to the array index.

Cold points are scored at limited concurrency to avoid hammering Overpass, so a batch of
addresses in an unscored area can take a while. For a whole metro, use
`pipeline/precompute_grid.py` instead.

---

## `POST /api/graphql`

```bash
curl -X POST https://<host>/api/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ score(lat: 40.758, lng: -73.9855) { walk { score description } transit { score hasCoverage } summary } }"}'
```

Queries: `score(lat, lng, ai)`, `scoreAddress(address, ai)`, `scoreBatch(points, ai)`,
`geocode(address)`. No mutations — this service computes, it does not store user data.

`GET /api/graphql` returns the SDL. There is no GraphiQL console: an interactive query
builder on a public endpoint invites exactly the unbounded queries this service should not
be running.

---

## `GET /api/walkscore`

Walk Score API compatibility. Returns the exact response shape of `api.walkscore.com/score`
so an existing integration migrates with a base URL change. Fully documented in
[`INTEGRATION.md`](INTEGRATION.md).

```bash
curl "https://<host>/api/walkscore?lat=40.758&lon=-73.9855&transit=1&bike=1&wsapikey=ignored"
```

`format`, `wsapikey`, `transit` and `bike` are accepted and ignored, so callers do not have
to change their parameter construction either.

---

## `GET /api/geocode`

```bash
curl "https://<host>/api/geocode?address=1500 N 23rd St, Fort Pierce FL"
```

```json
{
  "lat": 27.4598,
  "lon": -80.3068,
  "displayName": "1500 N 23RD ST, FORT PIERCE, FL, 34950",
  "score": 0.95,
  "source": "census"
}
```

Tries the US Census geocoder first — free, unmetered, and the most accurate source for US
street addresses — then Nominatim, then Photon.

---

## `GET /api/embed/config`

Resolves widget configuration for a partner host. Called by `embed.js`; documented here
because partners occasionally want to inspect it.

```bash
curl "https://<host>/api/embed/config?host=example.com"
```

Unregistered hosts get a working default rather than an error.

---

## `POST /api/embed/scrape`

Takes what the SDK could see on a partner page and returns a geocoded address. Not intended
for direct use.

---

## `GET /api/health`

```jsonc
{
  "status": "ok",
  "version": "a1b2c3d",
  "database": { "configured": true, "reachable": true },
  "capabilities": {
    "precomputedGrid": true,
    "gtfsSchedules": true,      // false means Transit Scores are OSM estimates
    "aiExplanations": false,
    "apiKeysEnforced": false
  },
  "data": { "gtfsFeeds": 47, "gtfsStops": 159740, "cachedScores": 12043 }
}
```

Returns `503` only when a database is configured but unreachable. Having no database at all
is a supported configuration, not an error.

---

## `GET /api/admin/stats`

Operations telemetry behind `ADMIN_PASSWORD`:

```bash
curl -H "Authorization: Bearer $ADMIN_PASSWORD" https://<host>/api/admin/stats
```

Cache hit rates, Overpass volume and failures, GTFS staleness, pipeline run status, AI spend
and cost per thousand scores. Rendered by `/admin`.

---

## Performance

| Path | Typical |
| --- | --- |
| Precomputed grid or warm cache | 5–30 ms |
| Cold point, cached OSM tile nearby | 1–3 s |
| Cold point, unseen area | 3–20 s |

Nearly all of the cold-path time is waiting on Overpass. A metro that has been through
`precompute_grid.py` serves listing pages from the first tier.

Responses carry `Cache-Control: s-maxage=3600, stale-while-revalidate=36000`, so a CDN in
front of the service absorbs most repeat traffic before it reaches a dyno.
