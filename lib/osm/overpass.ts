/**
 * Overpass API client.
 *
 * Overpass is free but it is a shared community resource that will rate-limit or ban
 * abusive clients, and it is the slowest thing in our request path by an order of
 * magnitude. Everything here exists to hit it as rarely as possible: results are keyed to
 * a coarse grid so nearby lookups share a fetch, concurrent identical fetches are
 * collapsed, and failures fall back across mirrors before giving up.
 */

import { TtlCache, SingleFlight } from "@/lib/cache";
import { boundingBox, snapToGrid } from "@/lib/geo";
import { OSM_FILTERS, WALKABLE_HIGHWAYS } from "@/lib/osm/tags";

const ENDPOINTS = (
  process.env.OVERPASS_ENDPOINTS ??
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.osm.jp/api/interpreter"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const USER_AGENT = "dream-walk-scores/0.1 (+https://github.com/motormouthvis/dream-walk-scores)";
const TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS ?? 45_000);

/**
 * Fetches are keyed to a 500 m grid. Two addresses on the same block therefore share one
 * Overpass round trip, and the extra data pulled in at the edges is data we would have
 * needed for the neighbours anyway.
 */
const FETCH_GRID_METERS = 500;

/** OSM changes slowly. An hour in memory is conservative. */
const POI_TTL_MS = Number(process.env.OSM_CACHE_TTL_MS ?? 60 * 60 * 1000);

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  nodes?: number[];
  tags?: Record<string, string>;
}

export interface OverpassResult {
  elements: OsmElement[];
  /** When the data was fetched. */
  fetchedAt: string;
}

const poiCache = new TtlCache<OverpassResult>(500, POI_TTL_MS);
const networkCache = new TtlCache<OverpassResult>(300, POI_TTL_MS * 6);
const transitCache = new TtlCache<OverpassResult>(300, POI_TTL_MS * 6);
const flight = new SingleFlight<OverpassResult>();

/** Counters surfaced on the admin dashboard so we can see what the cache is saving us. */
export const overpassStats = {
  requests: 0,
  cacheHits: 0,
  failures: 0,
  totalMs: 0,
};

class OverpassError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "OverpassError";
  }
}

async function runQuery(query: string): Promise<OverpassResult> {
  let lastError: unknown = null;

  for (const endpoint of ENDPOINTS) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      overpassStats.requests += 1;
      overpassStats.totalMs += Date.now() - started;

      // 429 and 504 are Overpass telling us to back off; try the next mirror immediately
      // rather than sleeping, since the mirrors have independent budgets.
      if (response.status === 429 || response.status === 504) {
        lastError = new OverpassError(`rate limited by ${endpoint}`, response.status);
        continue;
      }
      if (!response.ok) {
        lastError = new OverpassError(`${endpoint} returned ${response.status}`, response.status);
        continue;
      }

      const json = (await response.json()) as { elements?: OsmElement[] };
      return { elements: json.elements ?? [], fetchedAt: new Date().toISOString() };
    } catch (error) {
      overpassStats.totalMs += Date.now() - started;
      lastError = error;
    }
  }

  overpassStats.failures += 1;
  throw new OverpassError(
    `all Overpass endpoints failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

function bboxClause(lat: number, lon: number, radiusMeters: number): string {
  const b = boundingBox(lat, lon, radiusMeters);
  return `(${b.south},${b.west},${b.north},${b.east})`;
}

/** Build the regex alternation Overpass uses to filter a tag key. */
function alternation(values: string[]): string {
  return `^(${values.join("|")})$`;
}

/**
 * All scoreable POIs within `radiusMeters` of a point.
 *
 * Ways and relations are returned with `out center`, so a park polygon collapses to a
 * single representative point. That is the right call for scoring — what matters is
 * whether a park is reachable, not its exact boundary.
 */
export async function fetchAmenities(
  lat: number,
  lon: number,
  radiusMeters: number
): Promise<OverpassResult> {
  const cell = snapToGrid(lat, lon, FETCH_GRID_METERS);
  const key = `poi:${cell.lat.toFixed(4)},${cell.lon.toFixed(4)}:${Math.round(radiusMeters)}`;

  const cached = poiCache.get(key);
  if (cached) {
    overpassStats.cacheHits += 1;
    return cached;
  }

  return flight.run(key, async () => {
    // Re-check: another caller may have populated the cache while we queued.
    const raced = poiCache.get(key);
    if (raced) {
      overpassStats.cacheHits += 1;
      return raced;
    }

    // Pad the bbox by the grid size so a point at the edge of its cell still sees
    // everything within the true radius.
    const bbox = bboxClause(cell.lat, cell.lon, radiusMeters + FETCH_GRID_METERS);
    const clauses = Object.entries(OSM_FILTERS)
      .map(([tagKey, values]) => `  nwr["${tagKey}"~"${alternation(values)}"]${bbox};`)
      .join("\n");

    const query = `[out:json][timeout:${Math.floor(TIMEOUT_MS / 1000)}];\n(\n${clauses}\n);\nout center tags;`;

    const result = await runQuery(query);
    poiCache.set(key, result);
    return result;
  });
}

/**
 * The walkable street network within `radiusMeters`.
 *
 * Returned with full geometry so we can measure block lengths, count real intersections
 * and build a routable graph. This is a much heavier query than the POI one, which is why
 * it is cached six times as long — street layouts effectively do not change.
 */
export async function fetchWalkNetwork(
  lat: number,
  lon: number,
  radiusMeters: number
): Promise<OverpassResult> {
  const cell = snapToGrid(lat, lon, FETCH_GRID_METERS);
  const key = `net:${cell.lat.toFixed(4)},${cell.lon.toFixed(4)}:${Math.round(radiusMeters)}`;

  const cached = networkCache.get(key);
  if (cached) {
    overpassStats.cacheHits += 1;
    return cached;
  }

  return flight.run(key, async () => {
    const raced = networkCache.get(key);
    if (raced) {
      overpassStats.cacheHits += 1;
      return raced;
    }

    const bbox = bboxClause(cell.lat, cell.lon, radiusMeters + FETCH_GRID_METERS);
    const query = [
      `[out:json][timeout:${Math.floor(TIMEOUT_MS / 1000)}];`,
      `way["highway"~"${alternation(WALKABLE_HIGHWAYS)}"]["area"!~"yes"]${bbox};`,
      `out geom tags;`,
    ].join("\n");

    const result = await runQuery(query);
    networkCache.set(key, result);
    return result;
  });
}

/**
 * Transit stops and the routes that serve them, from OSM.
 *
 * This is the fallback for regions where we have not loaded a GTFS feed. OSM knows where
 * the stops are and which routes call at them, but it has no schedule, so the resulting
 * Transit Score is frequency-blind and marked lower-confidence. Where GTFS is available
 * (`lib/transit/gtfs.ts`) it always wins.
 */
export async function fetchTransit(lat: number, lon: number, radiusMeters: number): Promise<OverpassResult> {
  const cell = snapToGrid(lat, lon, FETCH_GRID_METERS);
  const key = `transit:${cell.lat.toFixed(4)},${cell.lon.toFixed(4)}:${Math.round(radiusMeters)}`;

  const cached = transitCache.get(key);
  if (cached) {
    overpassStats.cacheHits += 1;
    return cached;
  }

  return flight.run(key, async () => {
    const raced = transitCache.get(key);
    if (raced) {
      overpassStats.cacheHits += 1;
      return raced;
    }

    const bbox = bboxClause(cell.lat, cell.lon, radiusMeters + FETCH_GRID_METERS);
    const query = [
      `[out:json][timeout:${Math.floor(TIMEOUT_MS / 1000)}];`,
      `(`,
      `  node["highway"="bus_stop"]${bbox};`,
      `  node["public_transport"~"^(platform|stop_position|station)$"]${bbox};`,
      `  node["railway"~"^(station|halt|tram_stop)$"]${bbox};`,
      `)->.stops;`,
      `.stops out body;`,
      // Route relations that include any of those stops carry the mode and route name.
      `rel(bn.stops)["route"~"^(bus|tram|subway|train|light_rail|ferry|trolleybus|monorail)$"];`,
      `out body;`,
    ].join("\n");

    const result = await runQuery(query);
    transitCache.set(key, result);
    return result;
  });
}

/** Representative point for an element, handling nodes, `out center` and raw geometry. */
export function elementPoint(el: OsmElement): { lat: number; lon: number } | null {
  if (typeof el.lat === "number" && typeof el.lon === "number") {
    return { lat: el.lat, lon: el.lon };
  }
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  if (el.geometry?.length) {
    // Centroid of the vertex ring is good enough for a park or a mall.
    const n = el.geometry.length;
    const sum = el.geometry.reduce((acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }), {
      lat: 0,
      lon: 0,
    });
    return { lat: sum.lat / n, lon: sum.lon / n };
  }
  return null;
}

export function clearOverpassCaches(): void {
  poiCache.clear();
  networkCache.clear();
  transitCache.clear();
}

export function overpassCacheSizes(): { poi: number; network: number; transit: number; inFlight: number } {
  return {
    poi: poiCache.size,
    network: networkCache.size,
    transit: transitCache.size,
    inFlight: flight.pending,
  };
}
