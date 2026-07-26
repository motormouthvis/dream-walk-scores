/**
 * Scoring constants for Dream Walk Scores.
 *
 * Every magic number in the engine lives here so the methodology stays auditable and
 * tunable in one place. `docs/METHODOLOGY.md` is the prose version of this file and the
 * two must be kept in step.
 */

import type { AmenityCategory } from "@/lib/types";

export const METERS_PER_MILE = 1609.344;

/**
 * Points available per amenity, by rank within its category.
 *
 * The first grocery store is worth 3 points; a second one is worth nothing, because a
 * second grocery store does not make daily life meaningfully easier. Restaurants are the
 * opposite: variety has real value, so ten of them count with a long tail of diminishing
 * weights. These are the weights published by Walk Score, which we match deliberately so
 * our numbers are directly comparable to the product we are replacing.
 *
 * Total available: 15 points.
 */
export const CATEGORY_WEIGHTS: Record<AmenityCategory, number[]> = {
  grocery: [3],
  restaurants: [0.75, 0.45, 0.25, 0.25, 0.225, 0.225, 0.225, 0.225, 0.2, 0.2],
  shopping: [0.5, 0.45, 0.4, 0.35, 0.3],
  coffee: [1.25, 0.75],
  banks: [1],
  parks: [1],
  schools: [1],
  books: [1],
  entertainment: [1],
};

export const MAX_RAW_POINTS = Object.values(CATEGORY_WEIGHTS)
  .flat()
  .reduce((a, b) => a + b, 0);

/**
 * Distance-decay curve, as (miles, weight) anchor points with linear interpolation
 * between them.
 *
 * Anything inside a five-minute walk (0.25 mi) counts fully. Value falls away to nothing
 * at a thirty-minute walk (1.5 mi), which is the point past which people reliably drive
 * instead. A piecewise-linear curve is used rather than a closed-form function because it
 * is trivial to reason about, trivial to re-calibrate against ground truth, and the
 * difference from a smooth curve is far smaller than the error in the underlying data.
 */
export const DECAY_ANCHORS: [miles: number, weight: number][] = [
  [0.0, 1.0],
  [0.25, 1.0],
  [0.5, 0.86],
  [0.75, 0.67],
  [1.0, 0.44],
  [1.25, 0.2],
  [1.5, 0.0],
];

/** Amenities beyond this distance cannot contribute points. */
export const MAX_WALK_METERS = 1.5 * METERS_PER_MILE;

/**
 * One radius is used for the OSM network fetch, the amenity fetch, the street-shape
 * metrics and the bike-infrastructure tally.
 *
 * Using a single radius means a scored point needs exactly one network query and one
 * amenity query, which is the difference between a cheap product and an expensive one.
 * It is set by the walk cutoff because that is the largest distance any component needs.
 */
export const ANALYSIS_RADIUS_METERS = MAX_WALK_METERS;

/**
 * Pedestrian-friendliness penalties.
 *
 * Two places can have identical amenities and feel completely different to walk: a dense
 * grid with short blocks versus a subdivision of cul-de-sacs feeding one arterial. These
 * tables dock up to 10% for street networks that force pedestrians into long detours.
 */
export const INTERSECTION_DENSITY_PENALTIES: [maxPerSqKm: number, penalty: number][] = [
  [60, 0.05],
  [90, 0.03],
  [120, 0.02],
  [150, 0.01],
  [Infinity, 0.0],
];

export const BLOCK_LENGTH_PENALTIES: [maxMeters: number, penalty: number][] = [
  [60, 0.0],
  [120, 0.01],
  [150, 0.02],
  [200, 0.03],
  [Infinity, 0.05],
];

/**
 * Multiplier applied to straight-line distance when we do not have a routable network.
 *
 * Real walking routes are longer than the crow flies. How much longer depends on the
 * street pattern: a tight Manhattan grid adds ~20%, a suburban cul-de-sac network can
 * add 60% or more. We pick the factor from measured intersection density rather than
 * using one global constant, which is the single biggest quality win available without
 * full routing.
 */
export const CIRCUITY_BY_INTERSECTION_DENSITY: [maxPerSqKm: number, factor: number][] = [
  [30, 1.65],
  [60, 1.5],
  [90, 1.38],
  [120, 1.3],
  [150, 1.25],
  [Infinity, 1.2],
];

/** Fallback when intersection density is unknown — the median US value. */
export const DEFAULT_CIRCUITY = 1.42;

// ---------------------------------------------------------------------------
// Transit
// ---------------------------------------------------------------------------

/**
 * Mode weights for Transit Score. Rail is worth more than a bus at equal frequency
 * because it is faster, more reliable, and legible to someone who does not already know
 * the system.
 */
export const TRANSIT_MODE_WEIGHTS: Record<string, number> = {
  rail: 2.0,
  subway: 2.0,
  tram: 1.5,
  ferry: 1.5,
  cable: 1.5,
  bus: 1.0,
  unknown: 1.0,
};

/** Stops further than this from the point are not counted. */
export const TRANSIT_MAX_WALK_METERS = 0.5 * METERS_PER_MILE;

/**
 * Raw transit points that correspond to a score of 100.
 *
 * Calibrated so that the densest US transit neighbourhoods (Midtown Manhattan, downtown
 * SF, the Chicago Loop) land in the 95-100 band and a single hourly bus route lands in
 * the low teens. See `docs/METHODOLOGY.md` for the calibration set.
 */
export const TRANSIT_SATURATION_POINTS = 78;

// ---------------------------------------------------------------------------
// Bike
// ---------------------------------------------------------------------------

/**
 * Bike Score component weights. Infrastructure and destinations dominate; hills matter
 * but are a smaller factor than riders expect, and commute mode share is a lagging
 * indicator so it is deliberately given the least influence.
 */
export const BIKE_COMPONENT_WEIGHTS = {
  infrastructure: 0.3,
  hills: 0.25,
  destinations: 0.3,
  connectivity: 0.15,
} as const;

/**
 * Metres of lane within the analysis radius that saturate the infrastructure sub-score.
 *
 * Scaled to the ~18 km² covered by `ANALYSIS_RADIUS_METERS`. A city that has genuinely
 * committed to cycling carries several kilometres of protected lane through a
 * neighbourhood of that size.
 */
export const BIKE_PROTECTED_SATURATION_METERS = 6000;
export const BIKE_PAINTED_SATURATION_METERS = 12000;

/**
 * Grade thresholds for the hills sub-score. A mean grade at or below `flat` scores 100;
 * at or above `steep` scores 0; linear in between.
 */
export const BIKE_GRADE_FLAT_PCT = 1.0;
export const BIKE_GRADE_STEEP_PCT = 8.0;

// ---------------------------------------------------------------------------
// Score bands — shared with the Dream Neighborhood widget copy
// ---------------------------------------------------------------------------

export const WALK_BANDS: [min: number, label: string, explanation: string][] = [
  [90, "Walker's Paradise", "Daily errands do not require a car"],
  [70, "Very Walkable", "Most errands can be accomplished on foot"],
  [50, "Somewhat Walkable", "Some errands can be accomplished on foot"],
  [25, "Car-Dependent", "Most errands require a car"],
  [0, "Car-Dependent", "Almost all errands require a car"],
];

export const BIKE_BANDS: [min: number, label: string, explanation: string][] = [
  [90, "Biker's Paradise", "Daily errands can be accomplished on a bike"],
  [70, "Very Bikeable", "Biking is convenient for most trips"],
  [50, "Bikeable", "Some bike infrastructure"],
  [0, "Somewhat Bikeable", "Minimal bike infrastructure"],
];

export const TRANSIT_BANDS: [min: number, label: string, explanation: string][] = [
  [90, "Rider's Paradise", "World-class public transportation"],
  [70, "Excellent Transit", "Transit is convenient for most trips"],
  [50, "Good Transit", "Many nearby public transportation options"],
  [25, "Some Transit", "A few nearby public transportation options"],
  [0, "Minimal Transit", "It is possible to get on a bus"],
];
