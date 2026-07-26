"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Operations dashboard.
 *
 * Answers three questions at a glance: are the scores fresh, is the cache doing its job,
 * and what is this costing. Password-gated by `ADMIN_PASSWORD`; the password is held in
 * component state only and sent as a bearer token, never written to storage.
 */

interface Stats {
  generatedAt: string;
  scoring: {
    memoryHits: number;
    dbHits: number;
    computed: number;
    totalLookups: number;
    cacheHitRate: number | null;
    memoryCacheEntries: number;
    dbWriteFailures: number;
  };
  upstream: {
    overpass: {
      requests: number;
      cacheHits: number;
      failures: number;
      averageMs: number | null;
    };
    geocoder: Record<string, number>;
    elevation: Record<string, number>;
  };
  ai: {
    enabled: boolean;
    model: string;
    calls: number;
    cacheHits: number;
    estimatedCostUsd: number;
  };
  cost: { marginalUsdPerThousandScores: number; note: string };
  database: { configured: boolean; reachable: boolean; error?: string };
  scoreCache?: { total: string; fresh_7d: string; precomputed: string; avg_walk: string | null } | null;
  gtfs?: { feeds: string; stops: string; routes: string; stale: string } | null;
  freshness?: {
    source: string;
    last_success_at: string | null;
    status: string | null;
    detail: string | null;
    record_count: string | null;
  }[];
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (secret: string) => {
      setError(null);
      try {
        const response = await fetch("/api/admin/stats", {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (response.status === 401) {
          setError("Incorrect password.");
          setAuthed(false);
          return;
        }
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          setError(body?.error ?? `Request failed (${response.status}).`);
          return;
        }
        setStats((await response.json()) as Stats);
        setAuthed(true);
      } catch {
        setError("Could not reach the API.");
      }
    },
    []
  );

  // Refresh while the tab is open so the dashboard is usable during a deploy or a load test.
  useEffect(() => {
    if (!authed) return;
    const timer = setInterval(() => void load(password), 15_000);
    return () => clearInterval(timer);
  }, [authed, password, load]);

  if (!authed) {
    return (
      <main className="mx-auto max-w-sm px-5 py-24">
        <h1 className="mb-1 text-xl font-bold">Dream Walk Scores admin</h1>
        <p className="mb-6 text-sm text-ink-muted">Operational monitoring.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load(password);
          }}
          className="space-y-3"
        >
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Admin password"
            aria-label="Admin password"
            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            Sign in
          </button>
          {error && <p className="text-sm text-rose-700">{error}</p>}
        </form>
      </main>
    );
  }

  if (!stats) return <main className="p-10 text-sm text-ink-muted">Loading…</main>;

  const hitRate = stats.scoring.cacheHitRate;

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Dream Walk Scores admin</h1>
        <span className="text-xs text-ink-faint">
          updated {new Date(stats.generatedAt).toLocaleTimeString()}
        </span>
      </header>

      {error && <p className="mb-4 text-sm text-rose-700">{error}</p>}

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Scores served"
          value={stats.scoring.totalLookups.toLocaleString()}
          detail={`${stats.scoring.computed.toLocaleString()} computed from source`}
        />
        <Metric
          label="Cache hit rate"
          value={hitRate === null ? "—" : `${(hitRate * 100).toFixed(1)}%`}
          detail={`${stats.scoring.memoryHits.toLocaleString()} memory · ${stats.scoring.dbHits.toLocaleString()} database`}
          tone={hitRate !== null && hitRate < 0.5 ? "warn" : "ok"}
        />
        <Metric
          label="Cost per 1,000 scores"
          value={`$${stats.cost.marginalUsdPerThousandScores.toFixed(4)}`}
          detail="All upstream data sources are free"
          tone="ok"
        />
        <Metric
          label="Overpass calls"
          value={stats.upstream.overpass.requests.toLocaleString()}
          detail={`${stats.upstream.overpass.failures} failed · avg ${stats.upstream.overpass.averageMs ?? "—"} ms`}
          tone={stats.upstream.overpass.failures > 10 ? "warn" : "ok"}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Score coverage">
          {stats.scoreCache ? (
            <dl className="space-y-1.5 text-sm">
              <Row label="Cached cells" value={Number(stats.scoreCache.total).toLocaleString()} />
              <Row
                label="Computed in last 7 days"
                value={Number(stats.scoreCache.fresh_7d).toLocaleString()}
              />
              <Row
                label="From the precomputed grid"
                value={Number(stats.scoreCache.precomputed).toLocaleString()}
              />
              <Row label="Mean Walk Score" value={stats.scoreCache.avg_walk ?? "—"} />
            </dl>
          ) : (
            <Empty>No score cache table — the service is computing everything live.</Empty>
          )}
        </Panel>

        <Panel title="Transit data">
          {stats.gtfs ? (
            <dl className="space-y-1.5 text-sm">
              <Row label="Feeds loaded" value={Number(stats.gtfs.feeds).toLocaleString()} />
              <Row label="Stops" value={Number(stats.gtfs.stops).toLocaleString()} />
              <Row label="Routes" value={Number(stats.gtfs.routes).toLocaleString()} />
              <Row
                label="Expired feeds"
                value={stats.gtfs.stale}
                tone={Number(stats.gtfs.stale) > 0 ? "warn" : "ok"}
              />
            </dl>
          ) : (
            <Empty>
              No GTFS loaded. Transit Scores fall back to OpenStreetMap routes with estimated
              frequency.
            </Empty>
          )}
        </Panel>

        <Panel title="Data freshness">
          {stats.freshness && stats.freshness.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {stats.freshness.map((row) => (
                <li key={row.source} className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{row.source}</div>
                    <div className="text-xs text-ink-muted">{row.detail}</div>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <div className={row.status === "ok" ? "text-emerald-700" : "text-rose-700"}>
                      {row.status ?? "unknown"}
                    </div>
                    <div className="text-ink-faint">
                      {row.last_success_at
                        ? new Date(row.last_success_at).toLocaleDateString()
                        : "never"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No pipeline runs recorded yet.</Empty>
          )}
        </Panel>

        <Panel title="AI explanations">
          <dl className="space-y-1.5 text-sm">
            <Row label="Enabled" value={stats.ai.enabled ? "yes" : "no"} />
            <Row label="Model" value={stats.ai.model} />
            <Row label="Generations" value={stats.ai.calls.toLocaleString()} />
            <Row label="Served from cache" value={stats.ai.cacheHits.toLocaleString()} />
            <Row label="Estimated spend" value={`$${stats.ai.estimatedCostUsd.toFixed(4)}`} />
          </dl>
          <p className="mt-3 text-xs text-ink-faint">{stats.cost.note}</p>
        </Panel>
      </div>
    </main>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "ok",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="dws-card">
      <div className="dws-label">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone === "warn" ? "text-amber-700" : "text-ink"}`}>
        {value}
      </div>
      {detail && <div className="mt-1 text-xs text-ink-muted">{detail}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="dws-card">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`font-medium ${tone === "warn" ? "text-amber-700" : ""}`}>{value}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-muted">{children}</p>;
}
