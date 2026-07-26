#!/usr/bin/env node
/**
 * End-to-end smoke test against a running instance.
 *
 * Exercises every public surface and asserts the contracts that consumers actually depend
 * on — the Walk Score compatibility shape, null-versus-zero on transit, CORS on the embed
 * endpoints, and that caching is doing its job. Intended to be run against a review app or
 * production after a deploy, not just locally.
 *
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs https://dream-walk-scores.herokuapp.com
 *   ADMIN_PASSWORD=… node scripts/smoke.mjs
 */

const BASE = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";

// Somewhere dense, well mapped, and with loaded transit — a failure here is a real failure
// rather than a gap in the data.
const URBAN = { lat: 40.758, lng: -73.9855, name: "Times Square" };

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function get(path, init) {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
  let body = null;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body, ms: Date.now() - started };
}

async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (error) {
    failed++;
    failures.push(`${title} threw: ${error.message}`);
    console.log(`  FAIL ${title} threw — ${error.message}`);
  }
}

async function main() {
  console.log(`Smoke testing ${BASE}\n${"=".repeat(70)}`);

  await section("health", async () => {
    const { response, body } = await get("/api/health");
    check("responds 200", response.status === 200, `got ${response.status}`);
    check("reports a status", body?.status === "ok" || body?.status === "degraded");
    check("declares its capabilities", typeof body?.capabilities?.gtfsSchedules === "boolean");
  });

  await section("score by coordinate", async () => {
    const { response, body, ms } = await get(`/api/score?lat=${URBAN.lat}&lng=${URBAN.lng}`);
    check("responds 200", response.status === 200, `got ${response.status}`);
    check("returns a walk score in range", body?.walk?.score >= 0 && body.walk.score <= 100, `got ${body?.walk?.score}`);
    check("scores a dense urban point highly", body?.walk?.score >= 80, `got ${body?.walk?.score}`);
    check("returns a bike score", typeof body?.bike?.score === "number");
    check("labels the score", typeof body?.walk?.description === "string");
    check("returns all nine amenity categories", body?.walk?.categories?.length === 9, `got ${body?.walk?.categories?.length}`);
    check("names the amenities that earned points", body?.walk?.categories?.some((c) => c.hits.length > 0));
    check("routes distances over the network", body?.provenance?.distanceModel === "network", body?.provenance?.distanceModel);
    check("reports confidence", ["high", "medium", "low"].includes(body?.confidence));
    check("writes a summary", typeof body?.summary === "string" && body.summary.length > 40);
    check("snaps to the street network", typeof body?.location?.snappedLat === "number");
    check("sets a CDN cache header", /s-maxage/.test(response.headers.get("cache-control") ?? ""));
    console.log(`       (${ms} ms)`);
  });

  await section("caching", async () => {
    // The first call above warmed the cell; a second must be served from cache.
    const { body, ms } = await get(`/api/score?lat=${URBAN.lat}&lng=${URBAN.lng}`);
    check("second lookup is served from cache", body?.provenance?.source !== "live", body?.provenance?.source);
    check("cached lookup is fast enough for a listing page", ms < 1000, `${ms} ms`);

    // A few metres away must land in the same grid cell.
    const nearby = await get(`/api/score?lat=${URBAN.lat + 0.00005}&lng=${URBAN.lng + 0.00005}`);
    check("a neighbouring point shares the cache cell", nearby.body?.provenance?.source !== "live", nearby.body?.provenance?.source);
  });

  await section("score by address", async () => {
    const { response, body } = await get("/api/score?address=1500%20N%2023rd%20St%2C%20Fort%20Pierce%20FL");
    check("responds 200", response.status === 200, `got ${response.status}`);
    check("echoes the resolved address", typeof body?.location?.address === "string");
    check("returns a score", typeof body?.walk?.score === "number");
  });

  await section("detail=0", async () => {
    const { body } = await get(`/api/score?lat=${URBAN.lat}&lng=${URBAN.lng}&detail=0`);
    check("omits the amenity breakdown", body?.walk?.categories === undefined);
    check("keeps the headline score", typeof body?.walk?.score === "number");
  });

  await section("Walk Score compatibility", async () => {
    const { response, body } = await get(`/api/walkscore?lat=${URBAN.lat}&lon=${URBAN.lng}&wsapikey=ignored&transit=1&bike=1`);
    check("responds 200", response.status === 200);
    check("reports status 1 on success", body?.status === 1, `got ${body?.status}`);
    check("returns `walkscore`", typeof body?.walkscore === "number");
    check("returns `description`", typeof body?.description === "string");
    check("nests the bike score", typeof body?.bike?.score === "number");
    check("nests the transit score with a summary", typeof body?.transit?.summary === "string");
    check("returns snapped coordinates", typeof body?.snapped_lat === "number");
    check("provides the documented links", typeof body?.ws_link === "string" && typeof body?.help_link === "string");
    check("adds the dws extension block", body?.dws?.provider === "dream-walk-scores");

    // Errors are reported in the body with a 200, exactly as Walk Score does.
    const bad = await get("/api/walkscore?lat=999&lon=999");
    check("uses status 30 for bad coordinates", bad.body?.status === 30, `got ${bad.body?.status}`);
    check("still responds 200 on an error", bad.response.status === 200);

    const abroad = await get("/api/walkscore?lat=51.5074&lon=-0.1278");
    check("uses status 2 outside coverage", abroad.body?.status === 2, `got ${abroad.body?.status}`);
  });

  await section("batch", async () => {
    const { response, body } = await get("/api/score/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          { id: "a", lat: URBAN.lat, lng: URBAN.lng },
          { id: "b", lat: 27.4598, lng: -80.3068 },
          { id: "bad", lat: 999, lng: 999 },
        ],
      }),
    });
    check("responds 200", response.status === 200, `got ${response.status}`);
    check("returns one result per point, in order", body?.results?.length === 3 && body.results[0].id === "a");
    check("scores the valid points", body?.succeeded === 2, `succeeded ${body?.succeeded}`);
    check("isolates the invalid point", body?.results?.[2]?.error?.code === "out_of_coverage", body?.results?.[2]?.error?.code);

    const tooMany = await get("/api/score/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: Array.from({ length: 500 }, () => ({ lat: 40, lng: -74 })) }),
    });
    check("rejects an oversized batch", tooMany.response.status === 400);
  });

  await section("GraphQL", async () => {
    const sdl = await get("/api/graphql");
    check("serves the schema on GET", sdl.response.status === 200 && String(sdl.body).includes("type Score"));

    const { response, body } = await get("/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ score(lat: ${URBAN.lat}, lng: ${URBAN.lng}) {
                   walk { score description }
                   transit { score hasCoverage }
                   confidence
                 } }`,
      }),
    });
    check("responds 200", response.status === 200);
    check("returns no errors", body?.errors === undefined, JSON.stringify(body?.errors ?? []).slice(0, 200));
    check("returns the requested fields", typeof body?.data?.score?.walk?.score === "number");
    check("omits fields that were not requested", body?.data?.score?.bike === undefined);

    const bad = await get("/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ score(lat: 51.5, lng: -0.12) { walk { score } } }" }),
    });
    check("surfaces out-of-coverage as a GraphQL error", Array.isArray(bad.body?.errors));
  });

  await section("geocode", async () => {
    const { response, body } = await get("/api/geocode?address=1500%20N%2023rd%20St%2C%20Fort%20Pierce%20FL");
    check("responds 200", response.status === 200);
    check("returns a coordinate", typeof body?.lat === "number" && typeof body?.lon === "number");
    check("names its source", typeof body?.source === "string");

    const missing = await get("/api/geocode");
    check("requires an address", missing.response.status === 400);
  });

  await section("embed", async () => {
    const sdk = await fetch(`${BASE}/embed.js`);
    check("serves embed.js", sdk.status === 200);
    check("allows cross-origin loading", sdk.headers.get("access-control-allow-origin") === "*");
    const source = await sdk.text();
    check("ships the SDK body", source.includes("__DREAM_WALK_SCORES_LOADED__"));

    const config = await get("/api/embed/config?host=example.com");
    check("resolves config for an unregistered host", config.body?.enabled === true);
    check("sets CORS on the config endpoint", config.response.headers.get("access-control-allow-origin") === "*");

    const scrape = await get("/api/embed/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageUrl: "https://example.com/homes/1500-n-23rd-st-fort-pierce-fl-34950",
        pageTitle: "1500 N 23rd St, Fort Pierce, FL 34950",
        host: "example.com",
      }),
    });
    check("extracts an address from a listing page", scrape.body?.found === true, JSON.stringify(scrape.body).slice(0, 120));

    const frame = await fetch(`${BASE}/embed?lat=${URBAN.lat}&lng=${URBAN.lng}`);
    check("serves the iframe surface", frame.status === 200);
    check("permits framing on any origin", /frame-ancestors \*/.test(frame.headers.get("content-security-policy") ?? ""));
  });

  await section("errors", async () => {
    const noParams = await get("/api/score");
    check("rejects a request with no location", noParams.response.status === 400);
    check("returns a machine-readable code", noParams.body?.code === "bad_request", noParams.body?.code);

    const badLat = await get("/api/score?lat=abc&lng=-74");
    check("rejects a non-numeric coordinate", badLat.response.status === 400);

    const abroad = await get("/api/score?lat=51.5074&lng=-0.1278");
    check("rejects a point outside coverage", abroad.response.status === 422, `got ${abroad.response.status}`);
    check("explains why", abroad.body?.code === "out_of_coverage");
  });

  await section("admin", async () => {
    const unauthorised = await get("/api/admin/stats");
    check("requires a password", [401, 503].includes(unauthorised.response.status), `got ${unauthorised.response.status}`);

    if (!ADMIN_PASSWORD) {
      console.log("       (set ADMIN_PASSWORD to test the authenticated path)");
      return;
    }

    const { response, body } = await get("/api/admin/stats", {
      headers: { Authorization: `Bearer ${ADMIN_PASSWORD}` },
    });
    check("authenticates with the password", response.status === 200, `got ${response.status}`);
    check("reports cache effectiveness", typeof body?.scoring?.cacheHitRate === "number" || body?.scoring?.cacheHitRate === null);
    check("reports cost per thousand scores", typeof body?.cost?.marginalUsdPerThousandScores === "number");
    check("reports upstream call volume", typeof body?.upstream?.overpass?.requests === "number");
  });

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  · ${failure}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke run crashed:", error);
  process.exit(1);
});
