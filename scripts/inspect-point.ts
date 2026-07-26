/**
 * Dump the full scoring breakdown for one point.
 *
 * The tool to reach for when a calibration delta needs explaining: it shows which
 * categories earned what, how far away each nearest amenity is, and how the street-shape
 * penalty landed, which together account for every point of the final score.
 *
 *   npx tsx scripts/inspect-point.ts 40.758 -73.9855
 */

import { scorePoint } from "@/lib/score";
import { MAX_RAW_POINTS } from "@/lib/scoring/constants";

async function main(): Promise<void> {
  const lat = Number(process.argv[2]);
  const lon = Number(process.argv[3]);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error("usage: npx tsx scripts/inspect-point.ts <lat> <lon>");
    process.exit(1);
  }

  const result = await scorePoint(lat, lon);

  console.log(`\n${lat}, ${lon}`);
  console.log(
    `Walk ${result.walk.score}  Bike ${result.bike.score}  Transit ${result.transit.score ?? "—"}  (${result.confidence})`
  );
  console.log(`raw ${result.walk.rawPoints} / ${MAX_RAW_POINTS.toFixed(2)} points\n`);

  console.log("category         earned/max   nearest   decay   top amenity");
  console.log("-".repeat(86));
  for (const category of result.walk.categories) {
    const nearest = category.hits[0];
    console.log(
      category.category.padEnd(16) +
        `${category.points.toFixed(2).padStart(5)}/${category.maxPoints.toFixed(2).padEnd(5)}` +
        `${(nearest ? `${nearest.walkMeters} m` : "none").padStart(10)}` +
        `${(nearest ? nearest.decay.toFixed(3) : "—").padStart(8)}   ` +
        (nearest ? `${nearest.name} (${category.hits.length} in range)` : "")
    );
  }

  const shape = result.walk.pedestrianShape;
  console.log(
    `\nstreet shape: ${shape.intersectionDensity ?? "?"} intersections/km², ` +
      `mean block ${shape.avgBlockLengthMeters ?? "?"} m, penalty ×${shape.penaltyFactor}`
  );
  console.log(
    `bike: infra ${result.bike.components.infrastructure} · hills ${result.bike.components.hills} ` +
      `(steep ${result.bike.hills.steepGradePct}%) · dest ${result.bike.components.destinations} · ` +
      `conn ${result.bike.components.connectivity}`
  );
  console.log(
    `transit: ${result.transit.routeCount} routes, ${result.transit.stopCount} stops, ` +
      `raw ${result.transit.rawPoints}, coverage ${result.transit.hasCoverage}`
  );
  for (const route of result.transit.routes.slice(0, 10)) {
    console.log(
      `   ${(route.shortName ?? route.longName ?? route.routeId).slice(0, 28).padEnd(30)} ` +
        `${route.mode.padEnd(8)} ${String(route.walkMeters).padStart(4)} m  ` +
        `${route.tripsPerDay ?? "?"} trips/day  ${route.points.toFixed(2)} pts`
    );
  }
  console.log(`\nprovenance: ${JSON.stringify(result.provenance)}`);
  console.log(`\n${result.summary}\n`);
}

void main();
