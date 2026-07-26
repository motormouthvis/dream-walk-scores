#!/usr/bin/env python3
"""Ingest GTFS feeds so Transit Score reflects real service levels.

Transit Score is only as good as its frequency data. OpenStreetMap knows where the bus
stops are but not how often the bus comes, and the difference between a route every six
minutes and a route twice a day is the entire question. This loader flattens each feed's
timetable into a single `trips_per_day` number per route/stop pair, which is all the
scorer needs and costs one spatial join at request time.

Feeds come from the Mobility Database catalog: an open, free, community-maintained index
of ~3,400 GTFS feeds with bounding boxes and stable mirrors. No key, no cost.

    python3 pipeline/load_gtfs.py --catalog --state Illinois
    python3 pipeline/load_gtfs.py --catalog --metro Chicago --limit 5
    python3 pipeline/load_gtfs.py --url https://www.transitchicago.com/downloads/sch_data/google_transit.zip
    python3 pipeline/load_gtfs.py --catalog --top 40      # the 40 geographically widest feeds
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict

from common import batch_insert, connect, log, record_refresh

CATALOG_URL = "https://bit.ly/catalogs-csv"
USER_AGENT = "dream-walk-scores/0.1 (+https://github.com/motormouthvis/dream-walk-scores)"

# GTFS route_type -> the coarse mode taxonomy the scorer weights by. Mirrors
# `gtfsRouteTypeToMode` in lib/scoring/transit.ts; the two must stay in step.
ROUTE_TYPE_MODE = {
    0: "tram", 1: "subway", 2: "rail", 3: "bus", 4: "ferry",
    5: "cable", 6: "cable", 7: "rail", 11: "bus", 12: "rail",
}


def route_type_to_mode(value: str) -> str:
    try:
        rt = int(value)
    except (TypeError, ValueError):
        return "unknown"
    if rt in ROUTE_TYPE_MODE:
        return ROUTE_TYPE_MODE[rt]
    # Extended route types are grouped in hundreds.
    for lo, hi, mode in (
        (100, 200, "rail"), (200, 300, "bus"), (400, 500, "subway"),
        (700, 800, "bus"), (900, 1000, "tram"), (1000, 1100, "ferry"),
        (1200, 1300, "ferry"), (1300, 1400, "cable"),
    ):
        if lo <= rt < hi:
            return mode
    return "unknown"


def fetch(url: str, timeout: int = 180) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return response.read()


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


def load_catalog() -> list[dict]:
    log("fetching Mobility Database catalog")
    text = fetch(CATALOG_URL).decode("utf-8", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    log(f"catalog has {len(rows)} entries")
    return rows


def select_feeds(
    catalog: list[dict],
    state: str | None,
    metro: str | None,
    limit: int | None,
    top: int | None,
) -> list[dict]:
    """Pick feeds to ingest, preferring the catalog's stable mirror over the operator URL."""
    selected = []

    for row in catalog:
        if row.get("data_type") != "gtfs":
            continue
        if row.get("location.country_code") != "US":
            continue
        # `status` is blank for active feeds; anything else is deprecated or inactive.
        if (row.get("status") or "").strip() in {"inactive", "deprecated"}:
            continue

        if state and state.lower() not in (row.get("location.subdivision_name") or "").lower():
            continue
        if metro:
            haystack = " ".join(
                filter(None, [row.get("location.municipality"), row.get("provider"), row.get("name")])
            ).lower()
            if metro.lower() not in haystack:
                continue

        # The catalog's hosted mirror is preferred — it is stable and always reachable —
        # but entries do go missing from it, so keep the operator's own URL as a fallback
        # rather than dropping the feed. Losing SFMTA this way costs San Francisco most of
        # its Transit Score.
        urls = [
            (row.get("urls.latest") or "").strip(),
            (row.get("urls.direct_download") or "").strip(),
        ]
        urls = [u for u in urls if u]
        if not urls:
            continue
        url = urls[0]
        # Feeds behind an API key are not free to us; skip rather than fail later.
        if (row.get("urls.authentication_type") or "").strip() not in {"", "0"}:
            continue

        row["_url"] = url
        row["_fallback_urls"] = urls[1:]
        selected.append(row)

    if top:
        # Bounding-box area measures how much *ground* a feed spans, which is not the same
        # as how much *service* it carries: a national-park shuttle with twelve stops
        # outranks the entire New York subway. Use --metro to seed dense systems.
        def area(row: dict) -> float:
            try:
                return abs(
                    (float(row["location.bounding_box.maximum_latitude"]) - float(row["location.bounding_box.minimum_latitude"]))
                    * (float(row["location.bounding_box.maximum_longitude"]) - float(row["location.bounding_box.minimum_longitude"]))
                )
            except (KeyError, TypeError, ValueError):
                return 0.0

        selected.sort(key=area, reverse=True)
        selected = selected[:top]

    if limit:
        selected = selected[:limit]

    return selected


# ---------------------------------------------------------------------------
# GTFS parsing
# ---------------------------------------------------------------------------


def _clean(row: dict) -> dict:
    """Strip whitespace from keys and values.

    The GTFS spec says fields are comma-separated with no padding, and a good number of
    published feeds ignore that — Metra, for one, pads every column, so `service_id`
    arrives as `' service_id'` mapping to `' A1'`. Left alone, every join silently matches
    nothing and the feed loads as an empty timetable.
    """
    return {
        (k.strip() if isinstance(k, str) else k): (v.strip() if isinstance(v, str) else v)
        for k, v in row.items()
    }


def read_csv(archive: zipfile.ZipFile, name: str) -> list[dict]:
    if name not in archive.namelist():
        return []
    with archive.open(name) as handle:
        text = io.TextIOWrapper(handle, encoding="utf-8-sig", errors="replace")
        return [_clean(row) for row in csv.DictReader(text)]


def iter_csv(archive: zipfile.ZipFile, name: str):
    """Stream a large table instead of materialising it. `stop_times.txt` routinely runs
    to several million rows and will exhaust a small dyno if read whole."""
    if name not in archive.namelist():
        return
    with archive.open(name) as handle:
        text = io.TextIOWrapper(handle, encoding="utf-8-sig", errors="replace")
        for row in csv.DictReader(text):
            yield _clean(row)


def active_weekday_services(archive: zipfile.ZipFile) -> set[str]:
    """Service ids running on a representative weekday.

    Feeds express service in two different ways and plenty use both. `calendar.txt` gives
    day-of-week flags over a date range; `calendar_dates.txt` lists explicit dates. We
    prefer the former and fall back to picking the single busiest date from the latter,
    which is what feeds built entirely from exceptions require.
    """
    today = dt.date.today()
    services: set[str] = set()

    calendar = read_csv(archive, "calendar.txt")
    if calendar:
        in_window = set()
        any_weekday = set()

        for row in calendar:
            if row.get("wednesday") != "1":
                continue
            service_id = row.get("service_id")
            if not service_id:
                continue
            any_weekday.add(service_id)
            try:
                start = dt.datetime.strptime(row["start_date"], "%Y%m%d").date()
                end = dt.datetime.strptime(row["end_date"], "%Y%m%d").date()
            except (KeyError, ValueError):
                continue
            if start <= today <= end:
                in_window.add(service_id)

        # An expired feed still describes real service levels; better to score from
        # slightly stale data than to report no transit at all. Staleness surfaces via
        # `valid_to` on gtfs_feed.
        services = in_window or any_weekday

    if services:
        return services

    dates = read_csv(archive, "calendar_dates.txt")
    if not dates:
        return set()

    by_date: dict[str, set[str]] = defaultdict(set)
    for row in dates:
        if row.get("exception_type") != "1":
            continue
        date_str = row.get("date") or ""
        try:
            parsed = dt.datetime.strptime(date_str, "%Y%m%d").date()
        except ValueError:
            continue
        if parsed.weekday() >= 5:  # weekends have atypical service
            continue
        by_date[date_str].add(row["service_id"])

    if not by_date:
        return set()

    busiest = max(by_date.items(), key=lambda item: len(item[1]))
    return busiest[1]


def frequency_multipliers(archive: zipfile.ZipFile) -> dict[str, float]:
    """Trips represented by each frequency-based trip.

    A trip listed in `frequencies.txt` stands in for a whole span of service — one row in
    `trips.txt` can mean sixty actual departures. Counting it once would understate a
    high-frequency corridor by an order of magnitude, which is exactly the signal Transit
    Score depends on.
    """
    multipliers: dict[str, float] = defaultdict(float)

    for row in iter_csv(archive, "frequencies.txt"):
        trip_id = row.get("trip_id")
        headway = row.get("headway_secs")
        if not trip_id or not headway:
            continue
        try:
            headway_secs = int(headway)
            if headway_secs <= 0:
                continue
            start = parse_gtfs_time(row.get("start_time", ""))
            end = parse_gtfs_time(row.get("end_time", ""))
        except (TypeError, ValueError):
            continue
        if start is None or end is None or end <= start:
            continue
        multipliers[trip_id] += (end - start) / headway_secs

    return multipliers


def parse_gtfs_time(value: str) -> int | None:
    """GTFS times may exceed 24 hours to express service past midnight."""
    parts = value.strip().split(":")
    if len(parts) != 3:
        return None
    try:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------


def ingest_feed(
    conn,
    feed_key: str,
    url: str,
    agency_hint: str | None,
    fallback_urls: list[str] | None = None,
) -> bool:
    payload = None
    for candidate in [url, *(fallback_urls or [])]:
        log(f"  downloading {candidate}")
        try:
            payload = fetch(candidate)
            url = candidate
            break
        except Exception as exc:  # noqa: BLE001 — one bad feed must not stop the run
            log(f"  download failed: {exc}")

    if payload is None:
        return False

    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile:
        log("  not a valid zip")
        return False

    stops = read_csv(archive, "stops.txt")
    routes = read_csv(archive, "routes.txt")
    if not stops or not routes:
        log("  missing stops.txt or routes.txt")
        return False

    services = active_weekday_services(archive)
    log(f"  {len(stops)} stops, {len(routes)} routes, {len(services)} weekday services")

    # trip_id -> route_id, restricted to the representative weekday.
    trip_route: dict[str, str] = {}
    for row in iter_csv(archive, "trips.txt"):
        service_id = row.get("service_id")
        if services and service_id not in services:
            continue
        trip_id = row.get("trip_id")
        route_id = row.get("route_id")
        if trip_id and route_id:
            trip_route[trip_id] = route_id

    if not trip_route:
        log("  no trips on a representative weekday")
        return False

    multipliers = frequency_multipliers(archive)

    # (route_id, stop_id) -> weekday departures.
    counts: Counter[tuple[str, str]] = Counter()
    rows_seen = 0
    for row in iter_csv(archive, "stop_times.txt"):
        rows_seen += 1
        trip_id = row.get("trip_id")
        route_id = trip_route.get(trip_id or "")
        if not route_id:
            continue
        stop_id = row.get("stop_id")
        if not stop_id:
            continue
        counts[(route_id, stop_id)] += multipliers.get(trip_id, 1.0)

    log(f"  scanned {rows_seen} stop_times rows -> {len(counts)} route/stop pairs")
    if not counts:
        return False

    # Only persist stops that some counted route actually calls at. A large agency feed
    # can list thousands of stops that no weekday service touches.
    used_stops = {stop_id for _, stop_id in counts}
    used_routes = {route_id for route_id, _ in counts}

    stop_rows = []
    lats, lons = [], []
    for row in stops:
        stop_id = row.get("stop_id")
        if stop_id not in used_stops:
            continue
        try:
            lat = float(row["stop_lat"])
            lon = float(row["stop_lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        stop_rows.append((stop_id, row.get("stop_name"), lon, lat))
        lats.append(lat)
        lons.append(lon)

    if not stop_rows:
        log("  no usable stop coordinates")
        return False

    agency_rows = read_csv(archive, "agency.txt")
    agency_name = agency_hint or (agency_rows[0].get("agency_name") if agency_rows else None)

    route_rows = []
    for row in routes:
        route_id = row.get("route_id")
        if route_id not in used_routes:
            continue
        route_rows.append((
            route_id,
            row.get("route_short_name") or None,
            row.get("route_long_name") or None,
            agency_name,
            int(row["route_type"]) if (row.get("route_type") or "").isdigit() else None,
            route_type_to_mode(row.get("route_type", "")),
        ))

    valid_from, valid_to = feed_validity(archive)

    with conn.cursor() as cur:
        # Replacing the feed wholesale is simpler and safer than diffing: GTFS ids are not
        # stable between publications, so a merge would strand orphaned rows.
        cur.execute("delete from gtfs_feed where feed_key = %s", (feed_key,))
        cur.execute(
            """
            insert into gtfs_feed
                (feed_key, agency_name, source_url, valid_from, valid_to, stop_count, route_count, bbox)
            values (%s, %s, %s, %s, %s, %s, %s,
                    st_makeenvelope(%s, %s, %s, %s, 4326))
            returning id
            """,
            (
                feed_key, agency_name, url, valid_from, valid_to,
                len(stop_rows), len(route_rows),
                min(lons), min(lats), max(lons), max(lats),
            ),
        )
        feed_id = cur.fetchone()[0]

    batch_insert(
        conn,
        "insert into gtfs_stop (feed_id, stop_id, name, geom) values %s",
        [(feed_id, s[0], s[1], f"SRID=4326;POINT({s[2]} {s[3]})") for s in stop_rows],
    )
    batch_insert(
        conn,
        "insert into gtfs_route (feed_id, route_id, short_name, long_name, agency_name, route_type, mode) values %s",
        [(feed_id, *r) for r in route_rows],
    )
    conn.commit()

    # Resolve the natural GTFS ids to surrogate keys for the join table.
    with conn.cursor() as cur:
        cur.execute("select stop_id, id from gtfs_stop where feed_id = %s", (feed_id,))
        stop_pk = dict(cur.fetchall())
        cur.execute("select route_id, id from gtfs_route where feed_id = %s", (feed_id,))
        route_pk = dict(cur.fetchall())

    join_rows = [
        (route_pk[route_id], stop_pk[stop_id], int(round(trips)))
        for (route_id, stop_id), trips in counts.items()
        if route_id in route_pk and stop_id in stop_pk
    ]

    batch_insert(
        conn,
        "insert into gtfs_route_stop (route_pk, stop_pk, trips_per_day) values %s "
        "on conflict (route_pk, stop_pk) do update set trips_per_day = excluded.trips_per_day",
        join_rows,
    )
    conn.commit()

    log(f"  loaded {len(stop_rows)} stops, {len(route_rows)} routes, {len(join_rows)} pairs")
    return True


def feed_validity(archive: zipfile.ZipFile) -> tuple[dt.date | None, dt.date | None]:
    """The date range the feed claims to describe, for staleness reporting."""
    info = read_csv(archive, "feed_info.txt")
    if info:
        row = info[0]
        try:
            return (
                dt.datetime.strptime(row["feed_start_date"], "%Y%m%d").date(),
                dt.datetime.strptime(row["feed_end_date"], "%Y%m%d").date(),
            )
        except (KeyError, ValueError):
            pass

    starts, ends = [], []
    for row in read_csv(archive, "calendar.txt"):
        try:
            starts.append(dt.datetime.strptime(row["start_date"], "%Y%m%d").date())
            ends.append(dt.datetime.strptime(row["end_date"], "%Y%m%d").date())
        except (KeyError, ValueError):
            continue

    return (min(starts) if starts else None, max(ends) if ends else None)


def main() -> int:
    parser = argparse.ArgumentParser(description="Load GTFS feeds into Postgres.")
    parser.add_argument("--url", help="Ingest a single GTFS zip from this URL.")
    parser.add_argument("--key", help="Feed key for --url (defaults to the URL).")
    parser.add_argument("--catalog", action="store_true", help="Select feeds from the Mobility Database.")
    parser.add_argument("--state", help="Filter the catalog by state/subdivision.")
    parser.add_argument("--metro", help="Filter the catalog by municipality, provider or feed name.")
    parser.add_argument("--limit", type=int, help="Cap the number of feeds ingested.")
    parser.add_argument(
        "--top",
        type=int,
        help="Take the N feeds spanning the widest bounding box. This favours sparse "
        "regional feeds over dense city systems — prefer --metro for seeding.",
    )
    parser.add_argument("--list", action="store_true", help="Print matching feeds without ingesting.")
    args = parser.parse_args()

    if not args.url and not args.catalog:
        parser.error("pass --url or --catalog")

    with connect() as conn:
        loaded = failed = 0

        if args.url:
            key = args.key or args.url
            log(f"ingesting {key}")
            if ingest_feed(conn, key, args.url, None):
                loaded += 1
            else:
                failed += 1
        else:
            feeds = select_feeds(load_catalog(), args.state, args.metro, args.limit, args.top)
            log(f"{len(feeds)} feeds selected")

            if args.list:
                for feed in feeds:
                    log(f"  {feed.get('provider')} — {feed.get('location.municipality')} — {feed['_url']}")
                return 0

            for index, feed in enumerate(feeds, start=1):
                key = f"mdb:{feed.get('mdb_source_id')}"
                log(f"[{index}/{len(feeds)}] {feed.get('provider')} ({feed.get('location.municipality')})")
                try:
                    if ingest_feed(
                        conn, key, feed["_url"], feed.get("provider"), feed.get("_fallback_urls")
                    ):
                        loaded += 1
                    else:
                        failed += 1
                except Exception as exc:  # noqa: BLE001
                    conn.rollback()
                    failed += 1
                    log(f"  failed: {exc}")

        with conn.cursor() as cur:
            cur.execute("select count(*) from gtfs_stop")
            total_stops = cur.fetchone()[0]

        record_refresh(
            conn, "gtfs", "ok" if loaded else "error",
            f"{loaded} feeds loaded, {failed} failed", total_stops,
        )
        log(f"done — {loaded} loaded, {failed} failed, {total_stops} stops in database")

    return 0 if loaded else 1


if __name__ == "__main__":
    sys.exit(main())
