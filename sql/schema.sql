-- Dream Walk Scores — database schema.
--
-- Everything here is optional to the running service: with no DATABASE_URL the API still
-- answers by computing live from Overpass. The database buys three things — the
-- precomputed score grid that makes listing pages fast, GTFS schedules that make Transit
-- Score accurate, and the operational tables behind the admin dashboard.
--
-- Applied by `pipeline/init_db.py`, which is idempotent and safe to re-run.

create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- GTFS
-- ---------------------------------------------------------------------------

-- One row per ingested transit feed. `bbox` is what lets the API distinguish "there is
-- no transit here" from "we have not loaded a feed for this metro" — an important
-- difference to report honestly rather than scoring a covered area as zero.
create table if not exists gtfs_feed (
    id              bigserial primary key,
    feed_key        text not null unique,
    agency_name     text,
    source_url      text,
    fetched_at      timestamptz not null default now(),
    -- Service calendar window declared by the feed, used to spot stale data.
    valid_from      date,
    valid_to        date,
    stop_count      integer not null default 0,
    route_count     integer not null default 0,
    bbox            geometry(Polygon, 4326)
);

create index if not exists gtfs_feed_bbox_idx on gtfs_feed using gist (bbox);

create table if not exists gtfs_stop (
    id              bigserial primary key,
    feed_id         bigint not null references gtfs_feed(id) on delete cascade,
    stop_id         text not null,
    name            text,
    geom            geometry(Point, 4326) not null,
    unique (feed_id, stop_id)
);

create index if not exists gtfs_stop_geom_idx on gtfs_stop using gist (geom);

create table if not exists gtfs_route (
    id              bigserial primary key,
    feed_id         bigint not null references gtfs_feed(id) on delete cascade,
    route_id        text not null,
    short_name      text,
    long_name       text,
    agency_name     text,
    route_type      integer,
    -- Coarse mode taxonomy the scorer weights by; see lib/scoring/transit.ts.
    mode            text not null default 'unknown',
    unique (feed_id, route_id)
);

-- The join table the request path actually reads. `trips_per_day` is precomputed by the
-- pipeline from trips + stop_times + calendar so that scoring never has to touch a
-- timetable at request time.
create table if not exists gtfs_route_stop (
    route_pk        bigint not null references gtfs_route(id) on delete cascade,
    stop_pk         bigint not null references gtfs_stop(id) on delete cascade,
    trips_per_day   integer not null default 0,
    primary key (route_pk, stop_pk)
);

create index if not exists gtfs_route_stop_stop_idx on gtfs_route_stop (stop_pk);

-- ---------------------------------------------------------------------------
-- Score cache / precomputed grid
-- ---------------------------------------------------------------------------

-- Shared across dynos and populated both by live requests and by
-- `pipeline/precompute_grid.py`. The scalar score columns are duplicated out of `payload`
-- so the admin dashboard and any coverage analysis can aggregate without parsing JSON.
create table if not exists score_cache (
    cell_key        text primary key,
    geom            geometry(Point, 4326) not null,
    walk_score      integer,
    bike_score      integer,
    transit_score   integer,
    payload         jsonb not null,
    computed_at     timestamptz not null default now()
);

create index if not exists score_cache_geom_idx on score_cache using gist (geom);
create index if not exists score_cache_computed_idx on score_cache (computed_at);

-- Metros that have been precomputed, so the dashboard can report coverage and staleness.
create table if not exists precompute_region (
    id              bigserial primary key,
    name            text not null unique,
    bbox            geometry(Polygon, 4326) not null,
    cell_meters     integer not null,
    cells_total     integer not null default 0,
    cells_done      integer not null default 0,
    started_at      timestamptz,
    completed_at    timestamptz,
    status          text not null default 'pending'
);

create index if not exists precompute_region_bbox_idx on precompute_region using gist (bbox);

-- ---------------------------------------------------------------------------
-- API keys and usage
-- ---------------------------------------------------------------------------

-- Only the SHA-256 hash is stored; a leaked database cannot be used to call the API.
create table if not exists api_key (
    id                      uuid primary key default gen_random_uuid(),
    label                   text not null,
    key_hash                text not null unique,
    key_prefix              text,
    rate_limit_per_minute   integer,
    request_count           bigint not null default 0,
    created_at              timestamptz not null default now(),
    last_used_at            timestamptz,
    revoked_at              timestamptz
);

-- Rolled up per hour rather than per request: the dashboard needs trends, and writing a
-- row per score would cost more than the scoring does.
create table if not exists usage_hourly (
    hour            timestamptz not null,
    api_key_id      uuid references api_key(id) on delete set null,
    surface         text not null,
    requests        bigint not null default 0,
    cache_hits      bigint not null default 0,
    computed        bigint not null default 0,
    overpass_calls  bigint not null default 0,
    ai_calls        bigint not null default 0,
    ai_cost_usd     numeric(12, 6) not null default 0,
    primary key (hour, api_key_id, surface)
);

-- ---------------------------------------------------------------------------
-- Embeddable widget
-- ---------------------------------------------------------------------------

-- Per-host widget configuration, resolved server-side by the embed SDK.
create table if not exists embed_partner (
    id                  bigserial primary key,
    host                text not null unique,
    partner_id          text,
    label               text,
    enabled             boolean not null default true,
    accent_color        text not null default '#1fa55f',
    position            text not null default 'right',
    bottom_offset       integer not null default 20,
    show_header         boolean not null default true,
    default_address     text,
    default_lat         double precision,
    default_lng         double precision,
    view_count          bigint not null default 0,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Data freshness
-- ---------------------------------------------------------------------------

-- One row per data source, updated by each pipeline run. Drives the freshness panel on
-- the admin dashboard so nobody has to guess how old the OSM extract is.
create table if not exists data_refresh (
    source          text primary key,
    last_run_at     timestamptz,
    last_success_at timestamptz,
    status          text,
    detail          text,
    record_count    bigint
);
