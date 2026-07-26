/**
 * The chrome-less surface loaded inside the partner iframe.
 *
 * Kept deliberately plain: no navigation, no footer links that would take a visitor off
 * the partner's site, and an accent colour supplied by the host so the widget reads as
 * part of their page rather than as an advert for ours.
 */

import { EmbedAutoHeight } from "@/components/EmbedAutoHeight";
import { ScoreExplorer } from "@/components/ScoreExplorer";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reject anything that is not a plain hex colour before it reaches an inline style. */
function safeAccent(value: string | null): string {
  return value && /^#?[0-9a-fA-F]{6}$/.test(value)
    ? value.startsWith("#")
      ? value
      : `#${value}`
    : "#1fa55f";
}

export default async function EmbedPage({ searchParams }: Props) {
  const params = await searchParams;

  const address = first(params.address);
  const lat = num(first(params.lat));
  const lng = num(first(params.lng) ?? first(params.lon));
  const accent = safeAccent(first(params.accent));
  const showHeader = first(params.header) === "1";

  return (
    <div
      className="dws-embed px-4 py-4"
      style={{ ["--dws-accent" as string]: accent }}
    >
      <EmbedAutoHeight />

      {showHeader && (
        <header className="mb-4">
          <h1 className="text-base font-semibold">Getting around</h1>
          {address && <p className="text-xs text-ink-muted">{address}</p>}
        </header>
      )}

      <ScoreExplorer
        initialAddress={address}
        initialLat={lat}
        initialLng={lng}
        hideSearch={Boolean(address || (lat !== null && lng !== null))}
        // The header already names the property; repeating it wastes the little vertical
        // space an inline embed gets.
        hideAddress={showHeader}
        compact
      />
    </div>
  );
}
