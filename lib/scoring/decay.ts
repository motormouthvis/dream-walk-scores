import {
  BIKE_DECAY_ANCHORS,
  BLOCK_LENGTH_PENALTIES,
  CIRCUITY_BY_INTERSECTION_DENSITY,
  DECAY_ANCHORS,
  DEFAULT_CIRCUITY,
  INTERSECTION_DENSITY_PENALTIES,
  METERS_PER_MILE,
} from "@/lib/scoring/constants";

/** Linear interpolation across a (miles, weight) anchor table. */
function interpolate(anchors: [number, number][], meters: number): number {
  if (!Number.isFinite(meters) || meters < 0) return 0;
  const miles = meters / METERS_PER_MILE;

  const last = anchors[anchors.length - 1];
  if (miles >= last[0]) return 0;

  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (miles <= x1) {
      if (x1 === x0) return y1;
      const t = (miles - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 0;
}

/** Distance-decay weight in [0,1] for an amenity `meters` away on foot. */
export function decayWeight(meters: number): number {
  return interpolate(DECAY_ANCHORS, meters);
}

/** Distance-decay weight in [0,1] for an amenity `meters` away by bicycle. */
export function bikeDecayWeight(meters: number): number {
  return interpolate(BIKE_DECAY_ANCHORS, meters);
}

/** Look up a value from an ascending `[threshold, value]` table. */
function fromTable(tables: [number, number][], key: number | null, fallback: number): number {
  if (key === null || !Number.isFinite(key)) return fallback;
  for (const [max, value] of tables) {
    if (key <= max) return value;
  }
  return tables[tables.length - 1][1];
}

/**
 * Multiplier in [0.90, 1.0] applied to the raw walk score, docking points for street
 * networks that make walking indirect.
 *
 * Note the asymmetry between the two tables: intersection density is looked up as
 * "penalty applies below this threshold", so the table is walked in ascending order and
 * the first match wins.
 */
export function pedestrianPenaltyFactor(
  intersectionDensity: number | null,
  avgBlockLengthMeters: number | null
): number {
  const densityPenalty = fromTable(INTERSECTION_DENSITY_PENALTIES, intersectionDensity, 0.03);
  const blockPenalty = fromTable(BLOCK_LENGTH_PENALTIES, avgBlockLengthMeters, 0.03);
  return 1 - (densityPenalty + blockPenalty);
}

/**
 * How much longer a real walking route is than the straight line, inferred from how
 * finely the street network is subdivided.
 */
export function circuityFactor(intersectionDensity: number | null): number {
  return fromTable(CIRCUITY_BY_INTERSECTION_DENSITY, intersectionDensity, DEFAULT_CIRCUITY);
}

/** Pick the band label/explanation for a score from a descending threshold table. */
export function band(
  bands: [min: number, label: string, explanation: string][],
  score: number
): { label: string; explanation: string } {
  for (const [min, label, explanation] of bands) {
    if (score >= min) return { label, explanation };
  }
  const last = bands[bands.length - 1];
  return { label: last[1], explanation: last[2] };
}
