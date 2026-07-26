/**
 * The calibration set.
 *
 * Chosen to span the full 0-100 range and every settlement pattern that matters in the
 * US: dense pre-war grids, streetcar suburbs, postwar subdivisions, exurbs, small towns
 * and genuinely rural addresses. A calibration set weighted towards cities would produce
 * an engine that is excellent in Manhattan and useless in the places most listings
 * actually are.
 */

export interface CalibrationPoint {
  name: string;
  lat: number;
  lon: number;
  /** Rough settlement pattern, used when analysing where errors cluster. */
  kind: "urban-core" | "urban" | "streetcar-suburb" | "suburb" | "exurb" | "small-town" | "rural";
}

export const CALIBRATION_POINTS: CalibrationPoint[] = [
  // --- Urban cores -----------------------------------------------------------
  { name: "Times Square, New York NY", lat: 40.758, lon: -73.9855, kind: "urban-core" },
  { name: "Financial District, SF CA", lat: 37.7936, lon: -122.3993, kind: "urban-core" },
  { name: "The Loop, Chicago IL", lat: 41.8827, lon: -87.6278, kind: "urban-core" },
  { name: "Back Bay, Boston MA", lat: 42.3503, lon: -71.0810, kind: "urban-core" },
  { name: "Center City, Philadelphia PA", lat: 39.9509, lon: -75.1653, kind: "urban-core" },
  { name: "Downtown Seattle WA", lat: 47.6099, lon: -122.3350, kind: "urban-core" },
  { name: "Downtown Portland OR", lat: 45.5202, lon: -122.6742, kind: "urban-core" },
  { name: "Downtown Denver CO", lat: 39.7472, lon: -104.9938, kind: "urban-core" },

  // --- Urban neighbourhoods ---------------------------------------------------
  { name: "Lincoln Park, Chicago IL", lat: 41.9214, lon: -87.6513, kind: "urban" },
  { name: "Park Slope, Brooklyn NY", lat: 40.6710, lon: -73.9814, kind: "urban" },
  { name: "Capitol Hill, Seattle WA", lat: 47.6205, lon: -122.3212, kind: "urban" },
  { name: "Mission District, SF CA", lat: 37.7599, lon: -122.4148, kind: "urban" },
  { name: "Midtown Atlanta GA", lat: 33.7838, lon: -84.3830, kind: "urban" },
  { name: "Uptown Minneapolis MN", lat: 44.9483, lon: -93.2980, kind: "urban" },
  { name: "Wynwood, Miami FL", lat: 25.8010, lon: -80.1990, kind: "urban" },
  { name: "Deep Ellum, Dallas TX", lat: 32.7840, lon: -96.7830, kind: "urban" },

  // --- Streetcar suburbs ------------------------------------------------------
  { name: "Oak Park IL", lat: 41.8850, lon: -87.7845, kind: "streetcar-suburb" },
  { name: "Somerville MA", lat: 42.3876, lon: -71.0995, kind: "streetcar-suburb" },
  { name: "Decatur GA", lat: 33.7748, lon: -84.2963, kind: "streetcar-suburb" },
  { name: "Alameda CA", lat: 37.7652, lon: -122.2416, kind: "streetcar-suburb" },
  { name: "Cleveland Heights OH", lat: 41.5010, lon: -81.5560, kind: "streetcar-suburb" },

  // --- Postwar suburbs --------------------------------------------------------
  { name: "Plano TX (Steven Dr)", lat: 33.0570, lon: -96.7600, kind: "suburb" },
  { name: "Ahwatukee, Phoenix AZ", lat: 33.3400, lon: -111.9800, kind: "suburb" },
  { name: "Naperville IL", lat: 41.7508, lon: -88.1535, kind: "suburb" },
  { name: "Cary NC", lat: 35.7915, lon: -78.7811, kind: "suburb" },
  { name: "Sandy Springs GA", lat: 33.9304, lon: -84.3733, kind: "suburb" },
  { name: "Chandler AZ", lat: 33.3062, lon: -111.8413, kind: "suburb" },
  { name: "Katy TX", lat: 29.7858, lon: -95.8245, kind: "suburb" },
  { name: "Livonia MI", lat: 42.3684, lon: -83.3527, kind: "suburb" },

  // --- Exurbs -----------------------------------------------------------------
  { name: "Frisco TX (north)", lat: 33.1800, lon: -96.8200, kind: "exurb" },
  { name: "Buckeye AZ", lat: 33.3703, lon: -112.5838, kind: "exurb" },
  { name: "Clermont FL", lat: 28.5494, lon: -81.7729, kind: "exurb" },

  // --- Small towns ------------------------------------------------------------
  { name: "Fort Pierce FL", lat: 27.4598, lon: -80.3068, kind: "small-town" },
  { name: "Bisbee AZ", lat: 31.4482, lon: -109.9284, kind: "small-town" },
  { name: "Galena IL", lat: 42.4167, lon: -90.4290, kind: "small-town" },
  { name: "Brattleboro VT", lat: 42.8509, lon: -72.5579, kind: "small-town" },

  // --- Rural ------------------------------------------------------------------
  { name: "Craftsbury VT", lat: 44.6470, lon: -72.3760, kind: "rural" },
  { name: "Rural Kansas (Ellsworth)", lat: 38.7300, lon: -98.2300, kind: "rural" },
];
