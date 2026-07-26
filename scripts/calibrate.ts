/**
 * Calibration harness: compare Dream Walk Scores against published Walk Score values.
 *
 * DEVELOPMENT TOOL ONLY. This fetches the public score page for each calibration point to
 * recover the reference Walk/Bike/Transit values, then runs our engine over the same
 * coordinate and reports the deltas. It exists so that the constants in
 * `lib/scoring/constants.ts` are tuned against ground truth rather than intuition.
 *
 * It is not imported by the application, it is not part of the deployed build, and it is
 * rate-limited to be a negligible load. Run it when changing scoring constants:
 *
 *   npx tsx scripts/calibrate.ts
 *   npx tsx scripts/calibrate.ts --only=walk
 */

import { scorePoint } from "@/lib/score";
import { CALIBRATION_POINTS, type CalibrationPoint } from "@/scripts/calibration-set";

const REFERENCE_DELAY_MS = 1500;

interface Reference {
  walk: number | null;
  bike: number | null;
  transit: number | null;
}

const BADGE = /pp\.walk\.sc\/badge\/(walk|transit|bike)\/score\/(\d+)\./g;

async function fetchReference(lat: number, lon: number): Promise<Reference | null> {
  const url = `https://www.walkscore.com/score/loc/lat=${lat}/lng=${lon}`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) return null;

    const html = await response.text();
    const out: Reference = { walk: null, bike: null, transit: null };

    for (const match of html.matchAll(BADGE)) {
      const kind = match[1] as "walk" | "transit" | "bike";
      const value = Number(match[2]);
      // The page repeats each badge; the first occurrence is the headline score.
      if (out[kind] === null) out[kind] = value;
    }

    return out.walk === null ? null : out;
  } catch {
    return null;
  }
}

interface Row {
  point: CalibrationPoint;
  reference: Reference;
  ours: Reference;
}

function stats(rows: Row[], kind: keyof Reference): string {
  const pairs = rows
    .map((r) => ({ ref: r.reference[kind], ours: r.ours[kind] }))
    .filter((p): p is { ref: number; ours: number } => p.ref !== null && p.ours !== null);

  if (pairs.length === 0) return `${kind}: no comparable pairs`;

  const errors = pairs.map((p) => p.ours - p.ref);
  const mae = errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length;
  const bias = errors.reduce((a, b) => a + b, 0) / errors.length;
  const within10 = errors.filter((e) => Math.abs(e) <= 10).length;
  const within20 = errors.filter((e) => Math.abs(e) <= 20).length;

  // Pearson correlation: are we ranking places in the same order, even if offset?
  const meanRef = pairs.reduce((a, p) => a + p.ref, 0) / pairs.length;
  const meanOurs = pairs.reduce((a, p) => a + p.ours, 0) / pairs.length;
  const cov = pairs.reduce((a, p) => a + (p.ref - meanRef) * (p.ours - meanOurs), 0);
  const varRef = Math.sqrt(pairs.reduce((a, p) => a + (p.ref - meanRef) ** 2, 0));
  const varOurs = Math.sqrt(pairs.reduce((a, p) => a + (p.ours - meanOurs) ** 2, 0));
  const r = varRef > 0 && varOurs > 0 ? cov / (varRef * varOurs) : 0;

  return [
    `${kind.padEnd(8)} n=${String(pairs.length).padStart(3)}`,
    `MAE ${mae.toFixed(1).padStart(5)}`,
    `bias ${(bias >= 0 ? "+" : "") + bias.toFixed(1)}`.padEnd(12),
    `r ${r.toFixed(3)}`,
    `within10 ${((within10 / pairs.length) * 100).toFixed(0)}%`,
    `within20 ${((within20 / pairs.length) * 100).toFixed(0)}%`,
  ].join("  ");
}

async function main(): Promise<void> {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const points = onlyArg
    ? CALIBRATION_POINTS.filter((p) => p.name.toLowerCase().includes(onlyArg.toLowerCase()))
    : CALIBRATION_POINTS;

  console.log(`Calibrating against ${points.length} reference points.\n`);
  console.log(
    "point".padEnd(38) + "  " + "walk ref/ours  Δ".padEnd(20) + "bike ref/ours  Δ".padEnd(20) + "transit ref/ours  Δ"
  );
  console.log("-".repeat(116));

  const rows: Row[] = [];

  for (const point of points) {
    const [reference] = await Promise.all([
      fetchReference(point.lat, point.lon),
      new Promise((resolve) => setTimeout(resolve, REFERENCE_DELAY_MS)),
    ]);

    if (!reference) {
      console.log(`${point.name.padEnd(38)}  reference unavailable`);
      continue;
    }

    let ours: Reference;
    try {
      const result = await scorePoint(point.lat, point.lon);
      ours = { walk: result.walk.score, bike: result.bike.score, transit: result.transit.score };
    } catch (error) {
      console.log(`${point.name.padEnd(38)}  FAILED: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    rows.push({ point, reference, ours });

    const cell = (ref: number | null, our: number | null): string => {
      const delta = ref !== null && our !== null ? our - ref : null;
      const flag = delta === null ? "" : Math.abs(delta) > 20 ? " !!" : Math.abs(delta) > 10 ? " !" : "";
      return `${String(ref ?? "—").padStart(3)}/${String(our ?? "—").padStart(3)}  ${
        delta === null ? "    " : (delta >= 0 ? "+" : "") + String(delta).padStart(3)
      }${flag}`.padEnd(20);
    };

    console.log(
      point.name.padEnd(38) +
        "  " +
        cell(reference.walk, ours.walk) +
        cell(reference.bike, ours.bike) +
        cell(reference.transit, ours.transit)
    );
  }

  console.log("\n" + "=".repeat(116));
  console.log(stats(rows, "walk"));
  console.log(stats(rows, "bike"));
  console.log(stats(rows, "transit"));

  // Dump the raw pairs so a tuning session can fit curves offline.
  if (process.argv.includes("--json")) {
    console.log("\n" + JSON.stringify(rows, null, 2));
  }
}

void main();
