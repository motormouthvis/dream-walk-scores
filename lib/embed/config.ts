/**
 * Per-host widget configuration.
 *
 * A partner's host name resolves to their accent colour, popup position and fallback
 * address. Unregistered hosts get a permissive default rather than an error: the widget
 * working the moment the script tag is pasted, before anyone has configured anything, is
 * what makes it adoptable.
 */

import { TtlCache } from "@/lib/cache";
import { hasDatabase, query, tableExists } from "@/lib/db";

export interface EmbedConfig {
  host: string;
  enabled: boolean;
  partnerId: string | null;
  accentColor: string;
  position: "left" | "right";
  bottomOffset: number;
  showHeader: boolean;
  defaultAddress: string | null;
  defaultLat: number | null;
  defaultLng: number | null;
  /** True when this came from a configured partner row rather than the default. */
  registered: boolean;
}

const DEFAULT_CONFIG: Omit<EmbedConfig, "host"> = {
  enabled: true,
  partnerId: null,
  accentColor: "#1fa55f",
  position: "right",
  bottomOffset: 20,
  showHeader: true,
  defaultAddress: null,
  defaultLat: null,
  defaultLng: null,
  registered: false,
};

// Short TTL: an admin changing a colour should see it within a minute, and the row is
// tiny so re-reading it costs nothing.
const cache = new TtlCache<EmbedConfig>(500, 60_000);

/** Reduce a host to its registrable form so `www.` and bare domains share one config. */
export function normaliseHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      // Fall through and treat it as a literal host.
    }
  }
  host = host.split(":")[0];
  return host.startsWith("www.") ? host.slice(4) : host;
}

interface PartnerRow {
  host: string;
  partner_id: string | null;
  enabled: boolean;
  accent_color: string;
  position: string;
  bottom_offset: number;
  show_header: boolean;
  default_address: string | null;
  default_lat: number | null;
  default_lng: number | null;
}

export async function resolveEmbedConfig(rawHost: string): Promise<EmbedConfig> {
  const host = normaliseHost(rawHost);
  if (!host) return { host: "", ...DEFAULT_CONFIG };

  const cached = cache.get(host);
  if (cached) return cached;

  let config: EmbedConfig = { host, ...DEFAULT_CONFIG };

  if (hasDatabase() && (await tableExists("embed_partner"))) {
    try {
      const rows = await query<PartnerRow>(
        `select host, partner_id, enabled, accent_color, position, bottom_offset,
                show_header, default_address, default_lat, default_lng
           from embed_partner
          where host = $1
          limit 1`,
        [host]
      );

      const row = rows[0];
      if (row) {
        config = {
          host,
          enabled: row.enabled,
          partnerId: row.partner_id,
          accentColor: row.accent_color,
          position: row.position === "left" ? "left" : "right",
          bottomOffset: row.bottom_offset,
          showHeader: row.show_header,
          defaultAddress: row.default_address,
          defaultLat: row.default_lat,
          defaultLng: row.default_lng,
          registered: true,
        };
      }
    } catch {
      // A database blip must not stop the widget rendering; the default is a fine answer.
    }
  }

  cache.set(host, config);
  return config;
}

/** Count a widget impression. Best effort — never blocks or fails the response. */
export function recordEmbedView(host: string): void {
  if (!hasDatabase()) return;
  void query("update embed_partner set view_count = view_count + 1 where host = $1", [
    normaliseHost(host),
  ]).catch(() => undefined);
}
