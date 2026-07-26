"use client";

import { useCallback, useEffect, useState } from "react";
import { ScoreDial } from "@/components/ScoreDial";
import { CONFIDENCE_LABELS, formatDistance, walkMinutes } from "@/components/score";
import type { ScoreResult } from "@/lib/types";

interface Props {
  /** Pre-fill and immediately score this address. */
  initialAddress?: string | null;
  initialLat?: number | null;
  initialLng?: number | null;
  /** Hide the search box — used by the embed when the host page supplied the address. */
  hideSearch?: boolean;
  /** Origin of the API, so an embedded copy can call back to its own host. */
  apiBase?: string;
  compact?: boolean;
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: ScoreResult };

export function ScoreExplorer({
  initialAddress = null,
  initialLat = null,
  initialLng = null,
  hideSearch = false,
  apiBase = "",
  compact = false,
}: Props) {
  const [address, setAddress] = useState(initialAddress ?? "");
  const [state, setState] = useState<State>({ status: "idle" });
  const [expanded, setExpanded] = useState(false);

  const lookup = useCallback(
    async (params: { address?: string; lat?: number; lng?: number }) => {
      setState({ status: "loading" });

      const query = new URLSearchParams();
      if (params.lat !== undefined && params.lng !== undefined) {
        query.set("lat", String(params.lat));
        query.set("lng", String(params.lng));
      } else if (params.address) {
        query.set("address", params.address);
      } else {
        setState({ status: "idle" });
        return;
      }

      try {
        const response = await fetch(`${apiBase}/api/score?${query.toString()}`);
        const json = await response.json();
        if (!response.ok) {
          setState({ status: "error", message: json?.error ?? "Could not score this location." });
          return;
        }
        setState({ status: "ready", result: json as ScoreResult });
      } catch {
        setState({ status: "error", message: "Network error — please try again." });
      }
    },
    [apiBase]
  );

  // Score straight away when the caller already knows where they are.
  useEffect(() => {
    if (initialLat !== null && initialLng !== null) {
      void lookup({ lat: initialLat, lng: initialLng });
    } else if (initialAddress) {
      void lookup({ address: initialAddress });
    }
  }, [initialAddress, initialLat, initialLng, lookup]);

  return (
    <div className="w-full">
      {!hideSearch && (
        <form
          className="mb-6 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup({ address });
          }}
        >
          <input
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Enter a US address, e.g. 1500 N 23rd St, Fort Pierce FL"
            aria-label="Address"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <button
            type="submit"
            disabled={state.status === "loading" || address.trim().length === 0}
            className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50"
          >
            {state.status === "loading" ? "Scoring…" : "Score"}
          </button>
        </form>
      )}

      {state.status === "loading" && <LoadingState />}

      {state.status === "error" && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {state.message}
        </div>
      )}

      {state.status === "ready" && (
        <Result
          result={state.result}
          compact={compact}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex animate-pulse items-center gap-4">
          <div className="h-24 w-24 rounded-full bg-gray-100" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-20 rounded bg-gray-100" />
            <div className="h-4 w-40 rounded bg-gray-100" />
          </div>
        </div>
      ))}
      <p className="pt-2 text-xs text-ink-faint">
        First lookup in a new area takes a few seconds while we read the street network.
      </p>
    </div>
  );
}

function Result({
  result,
  compact,
  expanded,
  onToggle,
}: {
  result: ScoreResult;
  compact: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="space-y-5">
      {result.location.address && (
        <p className="text-sm text-ink-muted">{result.location.address}</p>
      )}

      <div className={compact ? "space-y-4" : "grid gap-5 sm:grid-cols-3"}>
        <ScoreDial
          label="Walk Score"
          score={result.walk.score}
          description={result.walk.description}
          explanation={result.walk.explanation}
          size={compact ? "sm" : "md"}
        />
        <ScoreDial
          label="Bike Score"
          score={result.bike.score}
          description={result.bike.description}
          explanation={result.bike.explanation}
          size={compact ? "sm" : "md"}
        />
        <ScoreDial
          label="Transit Score"
          score={result.transit.score}
          description={result.transit.hasCoverage ? result.transit.description : "No transit data"}
          explanation={
            result.transit.hasCoverage
              ? result.transit.explanation
              : "No schedule feed covers this area yet"
          }
          size={compact ? "sm" : "md"}
        />
      </div>

      {result.summary && (
        <div className="dws-card bg-gray-50">
          <p className="text-sm leading-relaxed text-ink">{result.summary}</p>
        </div>
      )}

      <button
        type="button"
        onClick={onToggle}
        className="text-sm font-semibold text-brand hover:text-brand-dark"
        aria-expanded={expanded}
      >
        {expanded ? "Hide the details" : "Why this score?"}
      </button>

      {expanded && <Breakdown result={result} />}

      <Provenance result={result} />
    </div>
  );
}

function Breakdown({ result }: { result: ScoreResult }) {
  const withHits = result.walk.categories.filter((c) => c.hits.length > 0);
  const missing = result.walk.categories.filter((c) => c.hits.length === 0);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-3 text-sm font-semibold">What is within walking distance</h3>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {withHits.map((category) => {
            const nearest = category.hits[0];
            return (
              <li key={category.category} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{category.label}</div>
                  <div className="truncate text-xs text-ink-muted">
                    {nearest.name} · {category.hits.length} within range
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold">{walkMinutes(nearest.walkMeters)} min</div>
                  <div className="text-xs text-ink-faint">{formatDistance(nearest.walkMeters)}</div>
                </div>
              </li>
            );
          })}
        </ul>
        {missing.length > 0 && (
          <p className="mt-2 text-xs text-ink-muted">
            Nothing within a 30-minute walk for: {missing.map((c) => c.label.toLowerCase()).join(", ")}.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="dws-card">
          <h3 className="mb-2 text-sm font-semibold">Street pattern</h3>
          <dl className="space-y-1 text-sm">
            <Row
              label="Intersections per km²"
              value={result.walk.pedestrianShape.intersectionDensity?.toFixed(0) ?? "—"}
            />
            <Row
              label="Average block"
              value={
                result.walk.pedestrianShape.avgBlockLengthMeters
                  ? `${result.walk.pedestrianShape.avgBlockLengthMeters} m`
                  : "—"
              }
            />
            <Row
              label="Connectivity adjustment"
              value={`×${result.walk.pedestrianShape.penaltyFactor.toFixed(2)}`}
            />
          </dl>
        </div>

        <div className="dws-card">
          <h3 className="mb-2 text-sm font-semibold">Cycling</h3>
          <dl className="space-y-1 text-sm">
            <Row label="Infrastructure" value={fmt(result.bike.components.infrastructure)} />
            <Row label="Terrain" value={fmt(result.bike.components.hills)} />
            <Row label="Destinations" value={fmt(result.bike.components.destinations)} />
            <Row label="Connectivity" value={fmt(result.bike.components.connectivity)} />
            <Row
              label="Protected lanes nearby"
              value={`${(result.bike.infrastructure.protectedLaneMeters / 1000).toFixed(1)} km`}
            />
          </dl>
        </div>
      </div>

      {result.transit.routes.length > 0 && (
        <div className="dws-card">
          <h3 className="mb-2 text-sm font-semibold">Transit routes within a half-mile walk</h3>
          <ul className="space-y-1 text-sm">
            {result.transit.routes.slice(0, 8).map((route) => (
              <li key={route.routeId} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{route.shortName ?? route.longName ?? "Route"}</span>
                  <span className="ml-2 text-xs uppercase text-ink-faint">{route.mode}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-muted">
                  {walkMinutes(route.walkMeters)} min walk
                  {route.tripsPerDay ? ` · ${route.tripsPerDay}/day` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function fmt(value: number | null): string {
  return value === null ? "—" : String(value);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function Provenance({ result }: { result: ScoreResult }) {
  return (
    <div className="border-t border-gray-100 pt-3 text-xs text-ink-faint">
      <p>
        {CONFIDENCE_LABELS[result.confidence] ?? result.confidence} ·{" "}
        {result.provenance.distanceModel === "network"
          ? "distances routed over the street network"
          : "distances estimated"}{" "}
        · {result.provenance.source}
      </p>
      {result.confidenceNotes.length > 0 && (
        <ul className="mt-1 list-inside list-disc">
          {result.confidenceNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <p className="mt-1">
        Built from OpenStreetMap, GTFS and open Census data.{" "}
        <a href="/methodology" className="underline hover:text-ink-muted">
          How these scores are calculated
        </a>
      </p>
    </div>
  );
}
