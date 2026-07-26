/** Small geodesy helpers. Kept dependency-free so the pipeline and the app agree exactly. */

const EARTH_RADIUS_M = 6371008.8;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Metres per degree of longitude at a given latitude. */
export function metersPerDegreeLon(lat: number): number {
  return (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(toRadians(lat));
}

export const METERS_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

/** A latitude/longitude bounding box that encloses a radius around a point. */
export function boundingBox(
  lat: number,
  lon: number,
  radiusMeters: number
): { south: number; west: number; north: number; east: number } {
  const dLat = radiusMeters / METERS_PER_DEGREE_LAT;
  const dLon = radiusMeters / Math.max(metersPerDegreeLon(lat), 1);
  return {
    south: lat - dLat,
    west: lon - dLon,
    north: lat + dLat,
    east: lon + dLon,
  };
}

export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Rough US bounds including Alaska and Hawaii, used to reject obviously out-of-scope points. */
export function isInUnitedStates(lat: number, lon: number): boolean {
  const conus = lat >= 24.4 && lat <= 49.4 && lon >= -125.0 && lon <= -66.9;
  const alaska = lat >= 51.2 && lat <= 71.5 && lon >= -179.2 && lon <= -129.9;
  const hawaii = lat >= 18.9 && lat <= 22.3 && lon >= -160.3 && lon <= -154.8;
  const pr = lat >= 17.8 && lat <= 18.6 && lon >= -67.3 && lon <= -65.2;
  return conus || alaska || hawaii || pr;
}

/**
 * Snap a coordinate to a fixed grid, returning the cell's south-west corner.
 *
 * Used as a cache key so that two lookups a few metres apart share one computation, which
 * only works if the grid is genuinely fixed. Cell width therefore has to be derived from
 * the *snapped* latitude rather than the input latitude: metres per degree of longitude
 * varies with latitude, so sizing the cell from the raw input gives two neighbouring
 * points slightly different grid spacings and lands them in different cells. That failure
 * is invisible — every answer is still correct — but it quietly destroys the cache hit
 * rate the cost model depends on.
 */
export function snapToGrid(lat: number, lon: number, cellMeters: number): { lat: number; lon: number } {
  const dLat = cellMeters / METERS_PER_DEGREE_LAT;
  const snappedLat = Math.floor(lat / dLat) * dLat;

  const dLon = cellMeters / Math.max(metersPerDegreeLon(snappedLat), 1);
  return {
    lat: snappedLat,
    lon: Math.floor(lon / dLon) * dLon,
  };
}

/** Perpendicular distance in metres from a point to a line segment, plus the closest point. */
export function pointToSegmentMeters(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number
): { meters: number; lat: number; lon: number } {
  // Project to a local equirectangular plane; over a few hundred metres the error is negligible.
  const mPerLon = metersPerDegreeLon(lat);
  const px = (lon - aLon) * mPerLon;
  const py = (lat - aLat) * METERS_PER_DEGREE_LAT;
  const bx = (bLon - aLon) * mPerLon;
  const by = (bLat - aLat) * METERS_PER_DEGREE_LAT;

  const lenSq = bx * bx + by * by;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  const cx = bx * t;
  const cy = by * t;

  return {
    meters: Math.hypot(px - cx, py - cy),
    lat: aLat + cy / METERS_PER_DEGREE_LAT,
    lon: aLon + cx / mPerLon,
  };
}
