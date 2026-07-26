"""Shared helpers for the Dream Walk Scores data pipeline.

The pipeline is Python for the same reason it is in `dream-schools`: the ingest work is
CSV wrangling and geospatial batch processing, which Python does well, while the request
path stays in TypeScript. The two never share code, only the database schema.
"""

from __future__ import annotations

import os
import sys
import time
from contextlib import contextmanager
from typing import Iterator

import psycopg2
import psycopg2.extras


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit(
            "DATABASE_URL is not set.\n"
            "Local:  export DATABASE_URL=postgresql://dws:dws@localhost:5432/dws\n"
            "Heroku: heroku config:get DATABASE_URL -a <app>"
        )
    return url


@contextmanager
def connect() -> Iterator[psycopg2.extensions.connection]:
    """A database connection with SSL negotiated the way managed providers expect."""
    url = database_url()
    # Heroku and Supabase present certificates that fail strict verification, and neither
    # supports turning that off server-side.
    sslmode = "require" if any(h in url for h in ("amazonaws.com", "herokuapp.com", "supabase.co")) else "prefer"

    conn = psycopg2.connect(url, sslmode=sslmode)
    try:
        yield conn
    finally:
        conn.close()


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def record_refresh(
    conn: psycopg2.extensions.connection,
    source: str,
    status: str,
    detail: str = "",
    record_count: int | None = None,
) -> None:
    """Stamp the freshness table so the admin dashboard can report on this source."""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into data_refresh (source, last_run_at, last_success_at, status, detail, record_count)
            values (%s, now(), case when %s = 'ok' then now() else null end, %s, %s, %s)
            on conflict (source) do update set
                last_run_at     = now(),
                last_success_at = case when excluded.status = 'ok' then now()
                                       else data_refresh.last_success_at end,
                status          = excluded.status,
                detail          = excluded.detail,
                record_count    = coalesce(excluded.record_count, data_refresh.record_count)
            """,
            (source, status, status, detail[:2000], record_count),
        )
    conn.commit()


def batch_insert(
    conn: psycopg2.extensions.connection,
    sql: str,
    rows: list[tuple],
    page_size: int = 5000,
) -> None:
    """Insert rows in pages. `execute_values` is an order of magnitude faster than
    executemany over a network connection, which matters for feeds with 100k stop_times."""
    if not rows:
        return
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, sql, rows, page_size=page_size)
