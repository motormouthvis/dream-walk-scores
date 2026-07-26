/**
 * Recover a street address from whatever a partner page gives us.
 *
 * The widget's promise is that a realtor drops in one script tag and the right address
 * appears. That means guessing, from a page we do not control, in whatever shape their
 * CMS produced. Sources are tried in descending order of reliability: structured data a
 * developer wrote on purpose, then meta tags, then the URL slug, then the page title.
 *
 * Everything here runs server-side on strings posted by the SDK, so it never touches a
 * DOM and is straightforward to test.
 */

export interface ExtractInput {
  pageUrl?: string | null;
  pageTitle?: string | null;
  /** Contents of any JSON-LD blocks the SDK found. */
  jsonLd?: string[] | null;
  /** `og:` and other meta tag values, keyed by property name. */
  meta?: Record<string, string> | null;
  /** Text the SDK scraped from likely address elements. */
  candidates?: string[] | null;
}

export interface ExtractResult {
  address: string;
  source: "json-ld" | "meta" | "candidate" | "url-slug" | "title";
  /** Rough 0-1 confidence, used to decide whether to bother geocoding. */
  confidence: number;
}

const STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

/**
 * A US street address: number, street words, then either a state code or a ZIP.
 * Deliberately strict — a false positive shows the visitor a score for the wrong house,
 * which is worse than showing the manual entry box.
 */
const ADDRESS_PATTERN = new RegExp(
  String.raw`\b\d{1,6}\s+[A-Za-z0-9.'\-]+(?:\s+[A-Za-z0-9.'\-]+){0,6}?` +
    String.raw`(?:,\s*[A-Za-z .'\-]{2,30})?` +
    String.raw`,?\s*(?:${STATE_CODES})\b(?:\s+\d{5}(?:-\d{4})?)?`,
  "i"
);

function normalise(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
}

function matchAddress(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = ADDRESS_PATTERN.exec(normalise(text));
  return match ? normalise(match[0]) : null;
}

/** Walk arbitrarily nested JSON-LD for a `PostalAddress`. */
function fromPostalAddress(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = fromPostalAddress(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const type = record["@type"];

  if (type === "PostalAddress" || (typeof record.streetAddress === "string" && record.streetAddress)) {
    const parts = [
      record.streetAddress,
      record.addressLocality,
      record.addressRegion,
      record.postalCode,
    ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
    if (parts.length >= 2) return normalise(parts.join(", "));
  }

  for (const value of Object.values(record)) {
    const hit = fromPostalAddress(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Listing URLs very often encode the address: `/homes/1500-n-23rd-st-fort-pierce-fl-34950`.
 * Turning the slug back into an address is crude but works on a surprising share of the
 * real-estate CMSes realtors actually use.
 */
function fromUrlSlug(pageUrl: string): string | null {
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return null;
  }

  for (const segment of path.split("/").reverse()) {
    if (segment.length < 12) continue;
    const words = decodeURIComponent(segment).replace(/[_+]/g, "-").split("-").filter(Boolean);
    if (words.length < 4) continue;
    // A leading house number is the strongest signal that this slug is an address.
    if (!/^\d{1,6}$/.test(words[0])) continue;

    const hit = matchAddress(words.join(" "));
    if (hit) return hit;
  }
  return null;
}

export function extractAddress(input: ExtractInput): ExtractResult | null {
  for (const block of input.jsonLd ?? []) {
    try {
      const hit = fromPostalAddress(JSON.parse(block));
      if (hit) return { address: hit, source: "json-ld", confidence: 0.95 };
    } catch {
      // Malformed JSON-LD is common; move on to the next source.
    }
  }

  const meta = input.meta ?? {};
  for (const key of ["og:street-address", "street-address", "og:title", "og:description", "description"]) {
    const hit = matchAddress(meta[key]);
    if (hit) return { address: hit, source: "meta", confidence: 0.8 };
  }

  for (const candidate of input.candidates ?? []) {
    const hit = matchAddress(candidate);
    if (hit) return { address: hit, source: "candidate", confidence: 0.75 };
  }

  if (input.pageUrl) {
    const hit = fromUrlSlug(input.pageUrl);
    if (hit) return { address: hit, source: "url-slug", confidence: 0.7 };
  }

  const titleHit = matchAddress(input.pageTitle);
  if (titleHit) return { address: titleHit, source: "title", confidence: 0.65 };

  return null;
}
