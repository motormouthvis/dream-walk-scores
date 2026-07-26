/**
 * Bike Score calculation.
 *
 * Whether a place is good to ride comes down to four things, and they are not
 * interchangeable: is there anywhere to ride *to*, is there anywhere safe to ride *on*,
 * how much climbing is involved, and does the street grid actually connect. A flat city
 * with no bike lanes and a hilly city criss-crossed with protected paths can land on the
 * same number for very different reasons, so all four components are reported alongside
 * the score.
 */

import {
  BIKE_BANDS,
  BIKE_COMPONENT_WEIGHTS,
  BIKE_GRADE_FLAT_PCT,
  BIKE_GRADE_STEEP_PCT,
  BIKE_PAINTED_SATURATION_METERS,
  BIKE_PROTECTED_SATURATION_METERS,
} from "@/lib/scoring/constants";
import { band } from "@/lib/scoring/decay";
import type { BikeInfrastructure, BikeScoreDetail, HillMetrics } from "@/lib/types";

export interface BikeScoreInput {
  infrastructure: BikeInfrastructure;
  hills: HillMetrics;
  /**
   * Fraction of the available amenity-category points earned under the cycling decay
   * curve, in [0,1]. A distance-weighted measure rather than a raw count: a suburb ringed
   * by big-box retail has plenty of destinations, but their distance is the whole point.
   */
  destinationRatio: number;
  /** Intersections per square kilometre, measured over the street network only. */
  intersectionDensity: number | null;
}

/**
 * Intersection density that saturates the connectivity sub-score.
 *
 * Measured over real streets — service roads and parking aisles are excluded upstream in
 * `networkShape` — so the numbers are far lower, and far more meaningful, than a naive
 * count over every OSM way. 50 per km² is a thoroughly connected grid: Midtown Manhattan
 * measures about 52.
 */
const CONNECTIVITY_SATURATION = 50;

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * How much usable bike infrastructure exists.
 *
 * Protected lanes dominate the weighting because they are the only intervention that
 * reliably brings out riders who are not already committed cyclists. Painted lanes help;
 * quiet residential streets help more than people credit, which is why they carry real
 * weight rather than being ignored.
 */
export function infrastructureScore(infra: BikeInfrastructure): number | null {
  if (infra.totalWayMeters <= 0) return null;

  const protectedRatio = Math.min(1, infra.protectedLaneMeters / BIKE_PROTECTED_SATURATION_METERS);
  const paintedRatio = Math.min(1, infra.paintedLaneMeters / BIKE_PAINTED_SATURATION_METERS);
  const lowStressShare = Math.min(1, infra.lowStressMeters / infra.totalWayMeters);

  return clamp100(100 * (0.55 * protectedRatio + 0.25 * paintedRatio + 0.2 * lowStressShare));
}

/**
 * Terrain penalty, driven by the 85th-percentile grade rather than the mean.
 *
 * Averages lie about hills: a flat neighbourhood with one brutal climb between you and
 * the shops averages out to "gently rolling", but the climb is what decides whether you
 * ride. We use the steep-tail figure when we have it and fall back to the mean when we
 * do not.
 */
export function hillScore(hills: HillMetrics): number | null {
  const grade = hills.steepGradePct ?? hills.meanGradePct;
  if (grade === null || !Number.isFinite(grade)) return null;

  if (grade <= BIKE_GRADE_FLAT_PCT) return 100;
  if (grade >= BIKE_GRADE_STEEP_PCT) return 0;

  const span = BIKE_GRADE_STEEP_PCT - BIKE_GRADE_FLAT_PCT;
  return clamp100(100 * (1 - (grade - BIKE_GRADE_FLAT_PCT) / span));
}

export function destinationScore(ratio: number): number {
  return clamp100(100 * Math.max(0, Math.min(1, ratio)));
}

export function connectivityScore(intersectionDensity: number | null): number | null {
  if (intersectionDensity === null || !Number.isFinite(intersectionDensity)) return null;
  return clamp100(100 * Math.min(1, intersectionDensity / CONNECTIVITY_SATURATION));
}

export function calculateBikeScore(input: BikeScoreInput): BikeScoreDetail {
  const components = {
    infrastructure: infrastructureScore(input.infrastructure),
    hills: hillScore(input.hills),
    destinations: destinationScore(input.destinationRatio),
    connectivity: connectivityScore(input.intersectionDensity),
  };

  /**
   * Re-normalise across whichever components we could actually measure. If elevation
   * lookup failed we would rather score on the other three than silently treat the place
   * as pancake-flat, which is what leaving a null at zero-weight would do.
   */
  let weighted = 0;
  let weightUsed = 0;
  for (const [key, weight] of Object.entries(BIKE_COMPONENT_WEIGHTS)) {
    const value = components[key as keyof typeof components];
    if (value === null) continue;
    weighted += value * weight;
    weightUsed += weight;
  }

  if (weightUsed === 0) {
    return {
      score: null,
      description: null,
      explanation: null,
      components,
      infrastructure: input.infrastructure,
      hills: input.hills,
    };
  }

  const score = Math.round(clamp100(weighted / weightUsed));
  const { label, explanation } = band(BIKE_BANDS, score);

  return {
    score,
    description: label,
    explanation,
    components: {
      infrastructure: components.infrastructure === null ? null : Math.round(components.infrastructure),
      hills: components.hills === null ? null : Math.round(components.hills),
      destinations: Math.round(components.destinations),
      connectivity: components.connectivity === null ? null : Math.round(components.connectivity),
    },
    infrastructure: input.infrastructure,
    hills: input.hills,
  };
}
