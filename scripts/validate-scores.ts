/**
 * Score a calibration set of real US locations and print the results.
 *
 * This is the harness used to tune the constants in `lib/scoring/constants.ts`. Each
 * location has an `expect` band derived from published Walk Score values and local
 * knowledge; the script reports where we land relative to it. It hits live Overpass, so
 * it is slow and deliberately not part of the unit test suite.
 *
 *   npx tsx scripts/validate-scores.ts
 *   npx tsx scripts/validate-scores.ts "Times Square"
 */

import { scorePoint } from "@/lib/score";

interface Fixture {
  name: string;
  lat: number;
  lon: number;
  /** Inclusive [min, max] band we expect the Walk Score to land in. */
  walk: [number, number];
  transit?: [number, number];
  note: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "Times Square, New York NY",
    lat: 40.7580,
    lon: -73.9855,
    walk: [95, 100],
    transit: [90, 100],
    note: "Densest amenity cluster in the US; should saturate.",
  },
  {
    name: "North Beach, San Francisco CA",
    lat: 37.8003,
    lon: -122.4090,
    walk: [90, 100],
    transit: [75, 100],
    note: "Walker's paradise with steep terrain — Bike Score should be dragged down by hills.",
  },
  {
    name: "Lincoln Park, Chicago IL",
    lat: 41.9214,
    lon: -87.6513,
    walk: [85, 100],
    transit: [65, 95],
    note: "Classic dense grid neighbourhood.",
  },
  {
    name: "Downtown Portland OR",
    lat: 45.5202,
    lon: -122.6742,
    walk: [88, 100],
    transit: [65, 95],
    note: "Short blocks; the block-length bonus should show.",
  },
  {
    name: "Midtown Atlanta GA",
    lat: 33.7838,
    lon: -84.3830,
    walk: [70, 95],
    note: "Walkable core in an otherwise car-dependent metro.",
  },
  {
    name: "Suburban Plano TX",
    lat: 33.0570,
    lon: -96.7600,
    walk: [10, 45],
    note: "Cul-de-sac subdivision; should be clearly car-dependent.",
  },
  {
    name: "Suburban Phoenix AZ (Ahwatukee)",
    lat: 33.3400,
    lon: -111.9800,
    walk: [5, 45],
    note: "Low-density desert suburb, flat — Bike Score hills component should be near 100.",
  },
  {
    name: "Fort Pierce FL (dream-schools test address)",
    lat: 27.4598,
    lon: -80.3068,
    walk: [15, 60],
    note: "The address the sibling repos use for smoke tests.",
  },
  {
    name: "Rural Vermont (Craftsbury)",
    lat: 44.6470,
    lon: -72.3760,
    walk: [0, 30],
    note: "Genuinely rural; must not crash on a sparse network.",
  },
];

function bar(score: number | null, width = 24): string {
  if (score === null) return "—".padEnd(width);
  const filled = Math.round((score / 100) * width);
  return "█".repeat(filled).padEnd(width, "·");
}

function verdict(score: number | null, expected?: [number, number]): string {
  if (!expected) return "";
  if (score === null) return "  [NULL — expected " + expected.join("-") + "]";
  if (score >= expected[0] && score <= expected[1]) return "  ok";
  return `  OUT OF BAND (expected ${expected[0]}-${expected[1]})`;
}

async function main(): Promise<void> {
  const filter = process.argv[2]?.toLowerCase();
  const fixtures = filter ? FIXTURES.filter((f) => f.name.toLowerCase().includes(filter)) : FIXTURES;

  if (fixtures.length === 0) {
    console.error(`No fixture matches "${filter}".`);
    process.exit(1);
  }

  let failures = 0;

  for (const fixture of fixtures) {
    process.stdout.write(`\n${"=".repeat(78)}\n${fixture.name}\n${fixture.note}\n`);

    const started = Date.now();
    try {
      const result = await scorePoint(fixture.lat, fixture.lon);
      const elapsed = Date.now() - started;

      const walkVerdict = verdict(result.walk.score, fixture.walk);
      const transitVerdict = verdict(result.transit.score, fixture.transit);
      if (walkVerdict.includes("OUT OF BAND") || transitVerdict.includes("OUT OF BAND")) failures += 1;

      console.log(
        `  Walk    ${String(result.walk.score ?? "—").padStart(3)}  ${bar(result.walk.score)}  ${result.walk.description ?? ""}${walkVerdict}`
      );
      console.log(
        `  Bike    ${String(result.bike.score ?? "—").padStart(3)}  ${bar(result.bike.score)}  ${result.bike.description ?? ""}`
      );
      console.log(
        `  Transit ${String(result.transit.score ?? "—").padStart(3)}  ${bar(result.transit.score)}  ${result.transit.description ?? ""}${transitVerdict}`
      );

      const shape = result.walk.pedestrianShape;
      console.log(
        `  network: ${result.provenance.distanceModel}, ${shape.intersectionDensity ?? "?"} int/km², ` +
          `block ${shape.avgBlockLengthMeters ?? "?"} m, penalty ×${shape.penaltyFactor}`
      );
      console.log(
        `  bike:    infra ${result.bike.components.infrastructure ?? "—"}, hills ${result.bike.components.hills ?? "—"} ` +
          `(steep ${result.bike.hills.steepGradePct ?? "—"}%), dest ${result.bike.components.destinations}, conn ${result.bike.components.connectivity ?? "—"}`
      );
      console.log(
        `  transit: ${result.transit.routeCount} routes / ${result.transit.stopCount} stops, raw ${result.transit.rawPoints}`
      );

      const top = result.walk.categories
        .filter((c) => c.nearestMeters !== null)
        .sort((a, b) => (a.nearestMeters ?? 0) - (b.nearestMeters ?? 0))
        .slice(0, 4)
        .map((c) => `${c.category} ${c.nearestMeters}m`);
      console.log(`  nearest: ${top.join(", ") || "nothing in range"}`);
      console.log(`  confidence: ${result.confidence}${result.confidenceNotes.length ? " — " + result.confidenceNotes.join(" ") : ""}`);
      console.log(`  ${elapsed} ms`);
      console.log(`  summary: ${result.summary}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(failures === 0 ? "All fixtures within expected bands." : `${failures} fixture(s) outside expected bands.`);
}

void main();
