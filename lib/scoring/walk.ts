/**
 * Walk Score calculation.
 *
 * The model is the one Walk Score published and that the urban-planning literature has
 * validated: count how many of the things people actually walk to are within a walkable
 * distance, weight them by how far away they are and how much a second one of the same
 * thing is worth, then dock points for street networks that make walking indirect.
 */

import { CATEGORY_LABELS, type AmenityCategory, type AmenityHit, type CategoryBreakdown, type WalkScoreDetail } from "@/lib/types";
import { AMENITY_CATEGORIES } from "@/lib/types";
import { CATEGORY_WEIGHTS, MAX_RAW_POINTS, MAX_WALK_METERS, WALK_BANDS } from "@/lib/scoring/constants";
import { band, decayWeight, pedestrianPenaltyFactor } from "@/lib/scoring/decay";

/** An amenity as handed to the scorer: already classified, already measured. */
export interface ScorableAmenity {
  id: string;
  name: string;
  category: AmenityCategory;
  lat: number;
  lon: number;
  crowMeters: number;
  walkMeters: number;
  /** Category-membership strength from `lib/osm/tags.ts`, in (0,1]. */
  quality: number;
  routed: boolean;
}

export interface WalkScoreInput {
  amenities: ScorableAmenity[];
  intersectionDensity: number | null;
  avgBlockLengthMeters: number | null;
}

/**
 * Score one category.
 *
 * Candidates are ranked by *value* (decay × quality) rather than by raw distance, then
 * paired with the category's weight slots in descending order. This matters: if the
 * nearest grocery is a corner store and a real supermarket sits a little further out, the
 * supermarket should claim the 3-point slot. Ranking by distance alone would hand the
 * slot to the corner store and understate the neighbourhood.
 */
function scoreCategory(category: AmenityCategory, candidates: ScorableAmenity[]): CategoryBreakdown {
  const weights = CATEGORY_WEIGHTS[category];
  const maxPoints = weights.reduce((a, b) => a + b, 0);

  const valued = candidates
    .filter((a) => a.walkMeters <= MAX_WALK_METERS)
    .map((a) => ({ amenity: a, decay: decayWeight(a.walkMeters), value: decayWeight(a.walkMeters) * a.quality }))
    .filter((v) => v.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, weights.length);

  const hits: AmenityHit[] = [];
  let points = 0;

  valued.forEach((v, i) => {
    const earned = weights[i] * v.value;
    points += earned;
    hits.push({
      id: v.amenity.id,
      name: v.amenity.name,
      category,
      lat: v.amenity.lat,
      lon: v.amenity.lon,
      crowMeters: Math.round(v.amenity.crowMeters),
      walkMeters: Math.round(v.amenity.walkMeters),
      decay: Number(v.decay.toFixed(4)),
      points: Number(earned.toFixed(4)),
      routed: v.amenity.routed,
    });
  });

  const nearest = candidates.reduce<number | null>(
    (min, a) => (min === null || a.walkMeters < min ? a.walkMeters : min),
    null
  );

  return {
    category,
    label: CATEGORY_LABELS[category],
    maxPoints: Number(maxPoints.toFixed(4)),
    points: Number(points.toFixed(4)),
    nearestMeters: nearest === null ? null : Math.round(nearest),
    // Report hits nearest-first, which is the order a human wants to read them in.
    hits: hits.sort((a, b) => a.walkMeters - b.walkMeters),
  };
}

/**
 * Fraction of the 15 available category points that `amenities` earns under an arbitrary
 * decay curve, in [0,1].
 *
 * Shared by Walk Score and by the Bike Score destinations component, which uses the same
 * category weights over a flatter curve. Reusing the weighting is deliberate: what counts
 * as somewhere worth going does not change with the mode of travel, only how far away it
 * can be.
 */
export function categoryPointsRatio(
  amenities: ScorableAmenity[],
  decay: (meters: number) => number
): number {
  const byCategory = new Map<AmenityCategory, { value: number }[]>();
  for (const amenity of amenities) {
    const value = decay(amenity.walkMeters) * amenity.quality;
    if (value <= 0) continue;
    const bucket = byCategory.get(amenity.category);
    if (bucket) bucket.push({ value });
    else byCategory.set(amenity.category, [{ value }]);
  }

  let total = 0;
  for (const [category, values] of byCategory) {
    const weights = CATEGORY_WEIGHTS[category];
    values.sort((a, b) => b.value - a.value);
    for (let i = 0; i < Math.min(weights.length, values.length); i++) {
      total += weights[i] * values[i].value;
    }
  }

  return Math.min(1, total / MAX_RAW_POINTS);
}

export function calculateWalkScore(input: WalkScoreInput): WalkScoreDetail {
  const byCategory = new Map<AmenityCategory, ScorableAmenity[]>();
  for (const category of AMENITY_CATEGORIES) byCategory.set(category, []);
  for (const amenity of input.amenities) {
    byCategory.get(amenity.category)?.push(amenity);
  }

  const categories = AMENITY_CATEGORIES.map((c) => scoreCategory(c, byCategory.get(c) ?? []));
  const rawPoints = categories.reduce((sum, c) => sum + c.points, 0);

  const penaltyFactor = pedestrianPenaltyFactor(input.intersectionDensity, input.avgBlockLengthMeters);
  const score = Math.max(0, Math.min(100, Math.round((rawPoints / MAX_RAW_POINTS) * 100 * penaltyFactor)));

  const { label, explanation } = band(WALK_BANDS, score);

  return {
    score,
    description: label,
    explanation,
    rawPoints: Number(rawPoints.toFixed(3)),
    maxPoints: Number(MAX_RAW_POINTS.toFixed(3)),
    categories,
    pedestrianShape: {
      intersectionDensity:
        input.intersectionDensity === null ? null : Number(input.intersectionDensity.toFixed(1)),
      avgBlockLengthMeters:
        input.avgBlockLengthMeters === null ? null : Math.round(input.avgBlockLengthMeters),
      penaltyFactor: Number(penaltyFactor.toFixed(4)),
    },
  };
}
