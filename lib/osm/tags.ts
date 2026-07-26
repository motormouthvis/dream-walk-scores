/**
 * OpenStreetMap tag → amenity category mapping.
 *
 * OSM tagging is inconsistent by nature: the same corner store might be `shop=convenience`
 * in one city and `shop=grocery` in another, and a "restaurant" can be anything from a
 * white-tablecloth dining room to a hot dog cart. This module is the one place where that
 * mess is normalised into the nine categories the scoring engine understands.
 *
 * Where a tag is a weaker member of its category (a convenience store is not a grocery
 * store) we keep it but attach a `quality` multiplier rather than dropping it, because
 * dropping it produces badly wrong scores in rural and low-density areas where the corner
 * store genuinely is the grocery store.
 */

import type { AmenityCategory } from "@/lib/types";

export interface TagRule {
  key: string;
  value: string;
  category: AmenityCategory;
  /** Multiplier in (0,1] applied to the points this POI earns. */
  quality: number;
}

const RULES: TagRule[] = [
  // --- Grocery ---------------------------------------------------------------
  { key: "shop", value: "supermarket", category: "grocery", quality: 1.0 },
  { key: "shop", value: "grocery", category: "grocery", quality: 1.0 },
  { key: "shop", value: "greengrocer", category: "grocery", quality: 0.8 },
  { key: "shop", value: "butcher", category: "grocery", quality: 0.5 },
  { key: "shop", value: "bakery", category: "grocery", quality: 0.4 },
  { key: "shop", value: "deli", category: "grocery", quality: 0.5 },
  { key: "shop", value: "farm", category: "grocery", quality: 0.5 },
  { key: "amenity", value: "marketplace", category: "grocery", quality: 0.7 },
  // A convenience store covers some but not all of what a supermarket does.
  { key: "shop", value: "convenience", category: "grocery", quality: 0.45 },
  { key: "shop", value: "general", category: "grocery", quality: 0.45 },

  // --- Restaurants -----------------------------------------------------------
  { key: "amenity", value: "restaurant", category: "restaurants", quality: 1.0 },
  { key: "amenity", value: "fast_food", category: "restaurants", quality: 0.8 },
  { key: "amenity", value: "food_court", category: "restaurants", quality: 0.9 },
  { key: "amenity", value: "pub", category: "restaurants", quality: 0.7 },
  { key: "amenity", value: "biergarten", category: "restaurants", quality: 0.6 },

  // --- Coffee ----------------------------------------------------------------
  { key: "amenity", value: "cafe", category: "coffee", quality: 1.0 },
  { key: "shop", value: "coffee", category: "coffee", quality: 0.9 },
  { key: "shop", value: "tea", category: "coffee", quality: 0.7 },

  // --- Shopping --------------------------------------------------------------
  { key: "shop", value: "department_store", category: "shopping", quality: 1.0 },
  { key: "shop", value: "mall", category: "shopping", quality: 1.0 },
  { key: "shop", value: "clothes", category: "shopping", quality: 0.9 },
  { key: "shop", value: "shoes", category: "shopping", quality: 0.7 },
  { key: "shop", value: "hardware", category: "shopping", quality: 0.9 },
  { key: "shop", value: "doityourself", category: "shopping", quality: 0.9 },
  { key: "shop", value: "electronics", category: "shopping", quality: 0.8 },
  { key: "shop", value: "furniture", category: "shopping", quality: 0.6 },
  { key: "shop", value: "variety_store", category: "shopping", quality: 0.8 },
  { key: "shop", value: "florist", category: "shopping", quality: 0.5 },
  { key: "shop", value: "gift", category: "shopping", quality: 0.5 },
  { key: "shop", value: "jewelry", category: "shopping", quality: 0.5 },
  { key: "shop", value: "sports", category: "shopping", quality: 0.7 },
  { key: "shop", value: "toys", category: "shopping", quality: 0.6 },
  { key: "shop", value: "optician", category: "shopping", quality: 0.5 },
  { key: "shop", value: "hairdresser", category: "shopping", quality: 0.6 },
  { key: "shop", value: "beauty", category: "shopping", quality: 0.5 },
  { key: "shop", value: "laundry", category: "shopping", quality: 0.7 },
  { key: "shop", value: "dry_cleaning", category: "shopping", quality: 0.6 },

  // --- Errands & banking -----------------------------------------------------
  { key: "amenity", value: "bank", category: "banks", quality: 1.0 },
  { key: "amenity", value: "post_office", category: "banks", quality: 0.9 },
  { key: "amenity", value: "pharmacy", category: "banks", quality: 1.0 },
  { key: "shop", value: "chemist", category: "banks", quality: 0.8 },
  { key: "amenity", value: "atm", category: "banks", quality: 0.35 },
  { key: "amenity", value: "clinic", category: "banks", quality: 0.6 },
  { key: "amenity", value: "doctors", category: "banks", quality: 0.6 },

  // --- Parks -----------------------------------------------------------------
  { key: "leisure", value: "park", category: "parks", quality: 1.0 },
  { key: "leisure", value: "garden", category: "parks", quality: 0.6 },
  { key: "leisure", value: "nature_reserve", category: "parks", quality: 0.7 },
  { key: "leisure", value: "playground", category: "parks", quality: 0.7 },
  { key: "leisure", value: "recreation_ground", category: "parks", quality: 0.8 },
  { key: "leisure", value: "dog_park", category: "parks", quality: 0.6 },
  { key: "landuse", value: "recreation_ground", category: "parks", quality: 0.7 },

  // --- Schools ---------------------------------------------------------------
  { key: "amenity", value: "school", category: "schools", quality: 1.0 },
  { key: "amenity", value: "kindergarten", category: "schools", quality: 0.7 },
  { key: "amenity", value: "college", category: "schools", quality: 0.8 },
  { key: "amenity", value: "university", category: "schools", quality: 0.8 },

  // --- Books & libraries -----------------------------------------------------
  { key: "amenity", value: "library", category: "books", quality: 1.0 },
  { key: "shop", value: "books", category: "books", quality: 0.9 },
  { key: "shop", value: "newsagent", category: "books", quality: 0.4 },

  // --- Entertainment ---------------------------------------------------------
  { key: "amenity", value: "cinema", category: "entertainment", quality: 1.0 },
  { key: "amenity", value: "theatre", category: "entertainment", quality: 1.0 },
  { key: "amenity", value: "arts_centre", category: "entertainment", quality: 0.8 },
  { key: "amenity", value: "nightclub", category: "entertainment", quality: 0.7 },
  { key: "amenity", value: "bar", category: "entertainment", quality: 0.7 },
  { key: "amenity", value: "community_centre", category: "entertainment", quality: 0.6 },
  { key: "tourism", value: "museum", category: "entertainment", quality: 0.9 },
  { key: "tourism", value: "gallery", category: "entertainment", quality: 0.6 },
  { key: "leisure", value: "fitness_centre", category: "entertainment", quality: 0.8 },
  { key: "leisure", value: "sports_centre", category: "entertainment", quality: 0.8 },
  { key: "leisure", value: "swimming_pool", category: "entertainment", quality: 0.6 },
  { key: "leisure", value: "bowling_alley", category: "entertainment", quality: 0.6 },
];

/** Indexed as `key=value` for O(1) classification. */
const RULE_INDEX = new Map<string, TagRule>(RULES.map((r) => [`${r.key}=${r.value}`, r]));

/** Distinct OSM values per key, used to build tight Overpass regex filters. */
export const OSM_FILTERS: Record<string, string[]> = RULES.reduce(
  (acc, r) => {
    (acc[r.key] ??= []).push(r.value);
    return acc;
  },
  {} as Record<string, string[]>
);

/**
 * Classify an OSM tag bag. Returns the highest-quality matching rule, or null when the
 * feature is not an amenity we score.
 */
export function classify(tags: Record<string, string> | undefined): TagRule | null {
  if (!tags) return null;

  // A POI can match several rules (a `shop=bakery` that is also `amenity=cafe`). Take the
  // strongest match so a real café is not scored as a weak grocery.
  let best: TagRule | null = null;
  for (const [key, value] of Object.entries(tags)) {
    const rule = RULE_INDEX.get(`${key}=${value}`);
    if (rule && (!best || rule.quality > best.quality)) best = rule;
  }

  // Disused, abandoned and vacant features are tagged but should not count.
  if (best) {
    if (tags["disused"] === "yes" || tags["abandoned"] === "yes") return null;
    for (const k of Object.keys(tags)) {
      if (k.startsWith("disused:") || k.startsWith("abandoned:") || k.startsWith("was:")) return null;
    }
    if (tags["opening_hours"] === "closed" || tags["access"] === "private") return null;
  }
  return best;
}

/** A readable name for a POI, falling back to its category when unnamed. */
export function displayName(tags: Record<string, string> | undefined, category: AmenityCategory): string {
  const name = tags?.["name"] ?? tags?.["brand"] ?? tags?.["operator"];
  if (name) return name;
  return `Unnamed ${category}`;
}

// ---------------------------------------------------------------------------
// Street network classification
// ---------------------------------------------------------------------------

/** Highway values that a pedestrian can legally and comfortably use. */
export const WALKABLE_HIGHWAYS = [
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "pedestrian",
  "footway",
  "path",
  "steps",
  "track",
  "service",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

/**
 * Highway values that count as an actual street when measuring how connected a place is.
 *
 * Deliberately excludes `service`, which in OSM covers parking aisles, driveways and
 * alleys. Including them is the classic mistake: a big-box store's parking lot contains
 * dozens of junctions, so a strip-mall suburb measures denser than Manhattan and every
 * connectivity-derived number comes out backwards. Footways and paths are excluded for
 * the same reason — they are real for routing, but a park's path network is not evidence
 * of a fine-grained street grid.
 */
export const STREET_HIGHWAYS = [
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "pedestrian",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

const STREET_SET = new Set(STREET_HIGHWAYS);

export function isStreet(highway: string | undefined): boolean {
  return highway !== undefined && STREET_SET.has(highway);
}

/** Highway values usable by a bicycle. Excludes footways and steps, includes cycleway. */
export const BIKEABLE_HIGHWAYS = [
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "cycleway",
  "path",
  "track",
  "service",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

export type BikeStress = "protected" | "painted" | "lowStress" | "highStress";

/**
 * Classify how comfortable a way is to ride, which is what actually drives whether people
 * cycle. A painted line on a 45 mph arterial is not the same product as a protected lane.
 */
export function bikeStress(tags: Record<string, string> | undefined): BikeStress {
  if (!tags) return "highStress";
  const hw = tags["highway"];

  const cyclewayTags = [
    tags["cycleway"],
    tags["cycleway:both"],
    tags["cycleway:left"],
    tags["cycleway:right"],
  ].filter(Boolean) as string[];

  if (hw === "cycleway") return "protected";
  if (cyclewayTags.some((v) => v === "track" || v === "separate")) return "protected";
  if (tags["bicycle"] === "designated" && (hw === "path" || hw === "footway")) return "protected";

  if (cyclewayTags.some((v) => v === "lane" || v === "opposite_lane" || v === "shared_lane")) {
    return "painted";
  }

  // Quiet residential streets are comfortable to ride without any bike infrastructure.
  if (hw === "residential" || hw === "living_street" || hw === "unclassified") {
    const maxspeed = parseInt(tags["maxspeed"] ?? "", 10);
    if (!Number.isFinite(maxspeed) || maxspeed <= 30) return "lowStress";
  }
  if (hw === "track" || hw === "path") return "lowStress";

  return "highStress";
}
