/**
 * Elevation sampling from AWS Terrain Tiles.
 *
 * `s3.amazonaws.com/elevation-tiles-prod` publishes global terrain as "terrarium" PNGs:
 * free, no API key, no rate limit, no attribution requirement beyond the underlying
 * sources. Each pixel encodes metres above sea level in its RGB channels.
 *
 * The PNG is decoded here rather than with `sharp` or `pngjs` because those pull native
 * binaries that complicate the Heroku build for what amounts to a hundred lines of
 * inflate-and-unfilter. Terrain tiles are always 8-bit non-interlaced RGB(A), so the
 * decoder only needs to handle that case.
 */

import { inflateSync } from "node:zlib";
import { TtlCache } from "@/lib/cache";
import { toRadians } from "@/lib/geo";

const TILE_BASE =
  process.env.TERRAIN_TILE_BASE ?? "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

/** Zoom 12 is ~38 m per pixel at mid-latitudes: plenty to characterise a neighbourhood's hills. */
const ZOOM = Number(process.env.TERRAIN_TILE_ZOOM ?? 12);
const TILE_SIZE = 256;

/** Terrain never changes; the only reason to expire is to bound memory. */
const tileCache = new TtlCache<Int16Array | null>(64, 24 * 60 * 60 * 1000);

export const elevationStats = { tileFetches: 0, cacheHits: 0, failures: 0 };

// ---------------------------------------------------------------------------
// Minimal PNG decode
// ---------------------------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;

    if (type === "IHDR") {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }

    // length + type + data + CRC
    offset = start + length + 4;
  }

  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  // Reverse the per-scanline filters. Each scanline is prefixed with its filter byte.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const left = x >= channels ? out[dst + x - channels] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prev + x - channels] : 0;

      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
      out[dst + x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

// ---------------------------------------------------------------------------
// Tile maths
// ---------------------------------------------------------------------------

function lonToTileX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * Math.pow(2, zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const rad = toRadians(lat);
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom);
}

async function loadTile(tx: number, ty: number, zoom: number): Promise<Int16Array | null> {
  const key = `${zoom}/${tx}/${ty}`;
  const cached = tileCache.get(key);
  if (cached !== undefined) {
    elevationStats.cacheHits += 1;
    return cached;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(`${TILE_BASE}/${zoom}/${tx}/${ty}.png`, {
      signal: controller.signal,
      headers: { "User-Agent": "dream-walk-scores/0.1" },
    }).finally(() => clearTimeout(timer));

    elevationStats.tileFetches += 1;
    if (!response.ok) {
      // Ocean and out-of-coverage tiles legitimately 404. Cache the miss.
      tileCache.set(key, null);
      return null;
    }

    const png = decodePng(Buffer.from(await response.arrayBuffer()));
    const out = new Int16Array(png.width * png.height);

    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * png.channels;
      const r = png.data[o];
      const g = png.data[o + 1];
      const b = png.data[o + 2];
      // Terrarium encoding: (R * 256 + G + B / 256) - 32768 metres.
      out[i] = Math.round(r * 256 + g + b / 256 - 32768);
    }

    tileCache.set(key, out);
    return out;
  } catch {
    elevationStats.failures += 1;
    tileCache.set(key, null, 60_000);
    return null;
  }
}

/**
 * Elevations in metres for a batch of coordinates.
 *
 * Points are grouped by tile so a neighbourhood-sized sample costs one or two fetches.
 * Returns `null` for any point we could not resolve rather than guessing.
 */
export async function sampleElevations(
  points: { lat: number; lon: number }[]
): Promise<(number | null)[]> {
  if (points.length === 0) return [];

  const byTile = new Map<string, number[]>();
  const coords = points.map((p) => {
    const fx = lonToTileX(p.lon, ZOOM);
    const fy = latToTileY(p.lat, ZOOM);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    return {
      tx,
      ty,
      px: Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((fx - tx) * TILE_SIZE))),
      py: Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((fy - ty) * TILE_SIZE))),
    };
  });

  coords.forEach((c, i) => {
    const key = `${c.tx}/${c.ty}`;
    const bucket = byTile.get(key);
    if (bucket) bucket.push(i);
    else byTile.set(key, [i]);
  });

  const result: (number | null)[] = new Array(points.length).fill(null);

  await Promise.all(
    [...byTile.entries()].map(async ([key, indices]) => {
      const [tx, ty] = key.split("/").map(Number);
      const tile = await loadTile(tx, ty, ZOOM);
      if (!tile) return;
      for (const i of indices) {
        const c = coords[i];
        const value = tile[c.py * TILE_SIZE + c.px];
        // -32768 is the terrarium "no data" sentinel; anything below sea-floor is bogus.
        result[i] = value <= -12000 ? null : value;
      }
    })
  );

  return result;
}
