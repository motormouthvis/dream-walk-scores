/**
 * Turn whatever a caller sent us — coordinates, an address, or both — into a point to
 * score. Shared by every surface so `?address=` behaves identically everywhere.
 */

import { geocode } from "@/lib/geocode";
import { isInUnitedStates } from "@/lib/geo";
import { ApiFailure, ERROR_CODES, parseLatLng } from "@/lib/api/respond";

export interface ResolvedPoint {
  lat: number;
  lon: number;
  address: string | null;
}

export async function resolvePoint(url: URL): Promise<ResolvedPoint> {
  const coords = parseLatLng(url);
  const address = url.searchParams.get("address")?.trim() ?? null;

  if (coords) {
    assertInCoverage(coords.lat, coords.lon);
    return { ...coords, address };
  }

  if (!address) {
    throw new ApiFailure(
      400,
      ERROR_CODES.badRequest,
      "Provide either `lat` and `lng`, or an `address` to geocode."
    );
  }

  const geocoded = await geocode(address);
  if (!geocoded) {
    throw new ApiFailure(404, ERROR_CODES.notFound, `Could not geocode "${address}".`);
  }

  assertInCoverage(geocoded.lat, geocoded.lon);
  return { lat: geocoded.lat, lon: geocoded.lon, address: geocoded.displayName };
}

/**
 * Reject points outside the United States.
 *
 * The engine itself is country-agnostic — OSM and GTFS are global — but the calibration,
 * the Census geocoder and the score bands are all US-specific, so returning a number for
 * a European address would imply an accuracy we have not established.
 */
export function assertInCoverage(lat: number, lon: number): void {
  if (!isInUnitedStates(lat, lon)) {
    throw new ApiFailure(
      422,
      ERROR_CODES.outOfCoverage,
      "Dream Walk Scores currently covers the United States only."
    );
  }
}
