#!/usr/bin/env python3
"""Apply `sql/schema.sql`.

Idempotent — every statement is `create ... if not exists`, so this runs safely on every
deploy. Wired to Heroku's `release` phase in `app.json`.

    python3 pipeline/init_db.py
"""

from __future__ import annotations

import pathlib
import sys

from common import connect, log, record_refresh

SCHEMA = pathlib.Path(__file__).resolve().parent.parent / "sql" / "schema.sql"


def main() -> int:
    if not SCHEMA.exists():
        log(f"schema not found at {SCHEMA}")
        return 1

    sql = SCHEMA.read_text()

    with connect() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(sql)
            except Exception as exc:  # noqa: BLE001 — report and fail the release
                conn.rollback()
                log(f"schema failed: {exc}")
                return 1
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                """
                select table_name from information_schema.tables
                 where table_schema = 'public' order by table_name
                """
            )
            tables = [r[0] for r in cur.fetchall()]

        log(f"schema applied — {len(tables)} tables: {', '.join(tables)}")
        record_refresh(conn, "schema", "ok", f"{len(tables)} tables", len(tables))

    return 0


if __name__ == "__main__":
    sys.exit(main())
