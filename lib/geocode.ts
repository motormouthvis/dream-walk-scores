/**
 * Address → coordinate resolution, using only free services.
 *
 * The US Census geocoder is tried first: it is free, unmetered, has no key, and is the
 * most accurate source for US street addresses because it is built from the same TIGER
 * data the Postal Service uses. It only knows addresses though, so place names, POIs and
 * partial queries fall through to Nominatim and then Photon.
 */

import { TtlCache } from "@/lib/cache";
import { isValidLatLon } from "@/lib/geo";
import type { GeocodeResult } from "@/lib/types";

const USER_AGENT = "dream-walk-scores/0.1 (+https://github.com/motormouthvis/dream-walk-scores)";
const TIMEOUT_MS = 8_000;

const cache = new TtlCache<GeocodeResult | null>(5000, 24 * 60 * 60 * 1000);

export const geocodeStats = { census: 0, nominatim: 0, photon: 0, cacheHits: 0, failures: 0 };

async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface CensusResponse {
  result?: {
    addressMatches?: {
      matchedAddress?: string;
      coordinates?: { x: number; y: number };
    }[];
  };
}

async function census(address: string): Promise<GeocodeResult | null> {
  const url =
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
    `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;

  const json = await getJson<CensusResponse>(url);
  const match = json?.result?.addressMatches?.[0];
  if (!match?.coordinates) return null;

  const lat = match.coordinates.y;
  const lon = match.coordinates.x;
  if (!isValidLatLon(lat, lon)) return null;

  geocodeStats.census += 1;
  return {
    lat,
    lon,
    displayName: match.matchedAddress ?? address,
    // A Census rooftop/interpolated match on a full street address is high confidence.
    score: 0.95,
    source: "census",
  };
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  importance?: number;
}

async function nominatim(address: string): Promise<GeocodeResult | null> {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us&addressdetails=0`;

  const json = await getJson<NominatimResult[]>(url);
  const match = json?.[0];
  if (!match) return null;

  const lat = Number(match.lat);
  const lon = Number(match.lon);
  if (!isValidLatLon(lat, lon)) return null;

  geocodeStats.nominatim += 1;
  return {
    lat,
    lon,
    displayName: match.display_name,
    score: Math.min(0.9, match.importance ?? 0.5),
    source: "nominatim",
  };
}

interface PhotonResponse {
  features?: {
    geometry?: { coordinates?: [number, number] };
    properties?: Record<string, string>;
  }[];
}

async function photon(address: string): Promise<GeocodeResult | null> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(address)}&limit=1`;
  const json = await getJson<PhotonResponse>(url);
  const feature = json?.features?.[0];
  const coords = feature?.geometry?.coordinates;
  if (!coords) return null;

  const [lon, lat] = coords;
  if (!isValidLatLon(lat, lon)) return null;

  const props = feature.properties ?? {};
  const displayName = [props.name, props.street, props.city, props.state, props.postcode]
    .filter(Boolean)
    .join(", ");

  geocodeStats.photon += 1;
  return { lat, lon, displayName: displayName || address, score: 0.6, source: "photon" };
}

export async function geocode(address: string): Promise<GeocodeResult | null> {
  const key = address.trim().toLowerCase();
  if (!key) return null;

  const cached = cache.get(key);
  if (cached !== undefined) {
    geocodeStats.cacheHits += 1;
    return cached ? { ...cached, source: "cache" } : null;
  }

  // Sequential rather than parallel: the first provider succeeds for the overwhelming
  // majority of real addresses, and firing all three every time would be rude to two free
  // services for no benefit.
  const result = (await census(address)) ?? (await nominatim(address)) ?? (await photon(address));

  if (!result) geocodeStats.failures += 1;
  cache.set(key, result);
  return result;
}

interface ReverseResponse {
  display_name?: string;
  address?: Record<string, string>;
}

/** Coordinate → human-readable address, best effort. */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const key = `rev:${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    geocodeStats.cacheHits += 1;
    return cached?.displayName ?? null;
  }

  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18`;
  const json = await getJson<ReverseResponse>(url);
  const displayName = json?.display_name ?? null;

  cache.set(key, displayName ? { lat, lon, displayName, score: 0.7, source: "nominatim" } : null);
  return displayName;
}
