#!/usr/bin/env python3
"""Pre-score a grid over a metro so listing pages never wait on a cold computation.

A first-time score for an unseen area takes several seconds, almost all of it waiting on
Overpass. That is fine for a one-off lookup and unacceptable on a property page. Walking a
grid over the metros we care about ahead of time turns those requests into a single
indexed read.

Scoring lives in TypeScript, so rather than reimplementing it here this drives the running
service over HTTP. One source of truth for the numbers, and the grid is warmed through
exactly the code path that will later serve it.

    # Start the app first, then:
    python3 pipeline/precompute_grid.py --metro chicago
    python3 pipeline/precompute_grid.py --bbox 41.80,-87.75,41.99,-87.55 --name "Chicago north" --spacing 250
    python3 pipeline/precompute_grid.py --list

Spacing is a direct cost/quality dial: halving it quadruples both the cell count and the
time to build.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from common import connect, log, record_refresh

# Bounding boxes for the metros most likely to be worth warming, as
# (south, west, north, east). Kept small and central on purpose: precomputing an entire
# metropolitan area including its exurbs costs far more than it returns, because listing
# traffic concentrates in the core.
METROS: dict[str, tuple[float, float, float, float]] = {
    "nyc": (40.68, -74.03, 40.85, -73.90),
    "chicago": (41.83, -87.75, 42.00, -87.58),
    "sf": (37.73, -122.52, 37.81, -122.38),
    "boston": (42.32, -71.16, 42.40, -71.03),
    "philadelphia": (39.91, -75.24, 40.00, -75.12),
    "seattle": (47.55, -122.42, 47.70, -122.26),
    "portland": (45.48, -122.73, 45.57, -122.60),
    "denver": (39.68, -105.03, 39.79, -104.92),
    "atlanta": (33.72, -84.43, 33.83, -84.33),
    "miami": (25.72, -80.28, 25.85, -80.16),
    "dallas": (32.74, -96.85, 32.83, -96.74),
    "austin": (30.22, -97.79, 30.32, -97.69),
    "minneapolis": (44.92, -93.32, 45.02, -93.21),
    "fort-pierce": (27.40, -80.38, 27.50, -80.28),
}

METERS_PER_DEGREE_LAT = 111_320.0


def grid_points(bbox: tuple[float, float, float, float], spacing_m: int) -> list[tuple[float, float]]:
    south, west, north, east = bbox
    d_lat = spacing_m / METERS_PER_DEGREE_LAT

    points: list[tuple[float, float]] = []
    lat = south
    while lat <= north:
        # Longitude spacing has to be recomputed per row: a degree of longitude shrinks as
        # you move away from the equator, and using one value for the whole box leaves the
        # northern rows over-sampled and the southern rows full of holes.
        d_lon = spacing_m / max(METERS_PER_DEGREE_LAT * math.cos(math.radians(lat)), 1.0)
        lon = west
        while lon <= east:
            points.append((round(lat, 6), round(lon, 6)))
            lon += d_lon
        lat += d_lat

    return points


def score_point(base_url: str, lat: float, lon: float, timeout: int) -> bool:
    url = f"{base_url}/api/score?lat={lat}&lng={lon}&detail=0"
    request = urllib.request.Request(url, headers={"User-Agent": "dream-walk-scores-precompute/0.1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            payload = json.loads(response.read())
            return payload.get("walk", {}).get("score") is not None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return False


def register_region(conn, name: str, bbox: tuple[float, float, float, float], spacing: int, total: int) -> int:
    south, west, north, east = bbox
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into precompute_region (name, bbox, cell_meters, cells_total, cells_done, started_at, status)
            values (%s, st_makeenvelope(%s, %s, %s, %s, 4326), %s, %s, 0, now(), 'running')
            on conflict (name) do update set
                bbox        = excluded.bbox,
                cell_meters = excluded.cell_meters,
                cells_total = excluded.cells_total,
                cells_done  = 0,
                started_at  = now(),
                completed_at = null,
                status      = 'running'
            returning id
            """,
            (name, west, south, east, north, spacing, total),
        )
        region_id = cur.fetchone()[0]
    conn.commit()
    return region_id


def update_progress(conn, region_id: int, done: int, status: str | None = None) -> None:
    with conn.cursor() as cur:
        if status:
            cur.execute(
                "update precompute_region set cells_done = %s, status = %s, "
                "completed_at = case when %s in ('done','failed') then now() else null end where id = %s",
                (done, status, status, region_id),
            )
        else:
            cur.execute("update precompute_region set cells_done = %s where id = %s", (done, region_id))
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-score a grid over a metro area.")
    parser.add_argument("--metro", help=f"A known metro: {', '.join(sorted(METROS))}")
    parser.add_argument("--bbox", help="Custom area as south,west,north,east.")
    parser.add_argument("--name", help="Region name for a custom --bbox.")
    parser.add_argument("--spacing", type=int, default=200, help="Grid spacing in metres (default 200).")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="Running service to drive.")
    parser.add_argument("--concurrency", type=int, default=3, help="Parallel requests (default 3).")
    parser.add_argument("--timeout", type=int, default=120, help="Per-request timeout in seconds.")
    parser.add_argument("--limit", type=int, help="Stop after this many cells — useful for a dry run.")
    parser.add_argument("--list", action="store_true", help="List known metros and exit.")
    args = parser.parse_args()

    if args.list:
        for name, bbox in sorted(METROS.items()):
            count = len(grid_points(bbox, args.spacing))
            print(f"  {name:<16} {bbox}  ~{count} cells at {args.spacing} m")
        return 0

    if args.metro:
        key = args.metro.lower()
        if key not in METROS:
            log(f"unknown metro '{args.metro}'. Known: {', '.join(sorted(METROS))}")
            return 1
        bbox = METROS[key]
        name = key
    elif args.bbox:
        try:
            parts = tuple(float(p) for p in args.bbox.split(","))
        except ValueError:
            log("--bbox must be four comma-separated numbers: south,west,north,east")
            return 1
        if len(parts) != 4:
            log("--bbox must be south,west,north,east")
            return 1
        bbox = parts  # type: ignore[assignment]
        name = args.name or args.bbox
    else:
        parser.error("pass --metro or --bbox")

    points = grid_points(bbox, args.spacing)
    if args.limit:
        points = points[: args.limit]

    log(f"{name}: {len(points)} cells at {args.spacing} m spacing")
    log(f"driving {args.base_url} with {args.concurrency} workers")

    # Concurrency is intentionally low. Every cache miss becomes an Overpass query, and
    # hammering a free community service is both rude and the fastest route to being
    # blocked. This job is meant to run slowly in the background.
    with connect() as conn:
        region_id = register_region(conn, name, bbox, args.spacing, len(points))

        started = time.time()
        done = 0
        succeeded = 0

        try:
            with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                futures = [
                    pool.submit(score_point, args.base_url, lat, lon, args.timeout) for lat, lon in points
                ]
                for future in futures:
                    if future.result():
                        succeeded += 1
                    done += 1

                    if done % 25 == 0 or done == len(points):
                        elapsed = time.time() - started
                        rate = done / elapsed if elapsed > 0 else 0
                        remaining = (len(points) - done) / rate if rate > 0 else 0
                        log(
                            f"  {done}/{len(points)} cells ({succeeded} scored) — "
                            f"{rate:.1f}/s, ~{remaining / 60:.0f} min remaining"
                        )
                        update_progress(conn, region_id, done)
        except KeyboardInterrupt:
            update_progress(conn, region_id, done, "interrupted")
            log("interrupted — progress saved, re-running will reuse everything already cached")
            return 130

        update_progress(conn, region_id, done, "done" if succeeded else "failed")
        record_refresh(
            conn,
            f"precompute:{name}",
            "ok" if succeeded else "error",
            f"{succeeded}/{len(points)} cells scored at {args.spacing} m",
            succeeded,
        )

        log(f"done — {succeeded}/{len(points)} cells scored in {(time.time() - started) / 60:.1f} min")

    return 0


if __name__ == "__main__":
    sys.exit(main())
