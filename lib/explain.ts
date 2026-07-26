/**
 * "Why this score?" text generation.
 *
 * Two things matter here and they pull in opposite directions: the text has to read like
 * a person wrote it, and it must never state anything the engine did not actually
 * measure. The resolution is that the LLM is a *writer*, not an analyst — it receives the
 * computed facts and rephrases them, and it never sees a raw data feed it could draw its
 * own conclusions from.
 *
 * The deterministic template is not a degraded fallback, it is the default. AI is opt-in
 * per request, cached hard, and any failure silently returns the template, so an outage
 * at the model provider cannot take down scoring.
 */

import { TtlCache } from "@/lib/cache";
import { CATEGORY_LABELS } from "@/lib/types";
import type { ScoreResult } from "@/lib/types";

const AI_ENABLED = () => Boolean(process.env.OPENAI_API_KEY);
const AI_MODEL = process.env.AI_EXPLAIN_MODEL ?? "gpt-4o-mini";
const AI_BASE_URL = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 8_000);
const AI_MAX_TOKENS = Number(process.env.AI_EXPLAIN_MAX_TOKENS ?? 220);

/**
 * Cost per million tokens, used for the admin dashboard's spend estimate. Override via
 * env when the model changes so the dashboard does not quietly go stale.
 */
const COST_PER_MTOK_IN = Number(process.env.AI_COST_PER_MTOK_IN ?? 0.15);
const COST_PER_MTOK_OUT = Number(process.env.AI_COST_PER_MTOK_OUT ?? 0.6);

export const aiStats = {
  calls: 0,
  cacheHits: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  get estimatedCostUsd(): number {
    return (
      (aiStats.promptTokens / 1_000_000) * COST_PER_MTOK_IN +
      (aiStats.completionTokens / 1_000_000) * COST_PER_MTOK_OUT
    );
  },
};

/**
 * Explanations are cached on the *shape* of the result, not the coordinate.
 *
 * Two addresses on the same block produce identical scores and identical nearby
 * amenities, so they should share one generation. Keying on the facts rather than the
 * location means the cache hit rate stays high across a whole neighbourhood, which is
 * what keeps the AI bill near zero.
 */
const summaryCache = new TtlCache<string>(2000, 24 * 60 * 60 * 1000);

function metersToWalkMinutes(meters: number): number {
  // 1.4 m/s is the standard adult walking speed used in transport planning.
  return Math.max(1, Math.round(meters / 1.4 / 60));
}

function describeDistance(meters: number | null): string | null {
  if (meters === null) return null;
  const minutes = metersToWalkMinutes(meters);
  return `${minutes} min walk`;
}

// ---------------------------------------------------------------------------
// Deterministic template
// ---------------------------------------------------------------------------

/**
 * Build the summary from the numbers alone.
 *
 * Deliberately conservative: it reports what was found and what was not, and it never
 * reaches for a characterisation the data does not support.
 */
export function templateSummary(result: Omit<ScoreResult, "summary" | "summaryFromAi">): string {
  const parts: string[] = [];
  const walk = result.walk;

  if (walk.score !== null) {
    parts.push(`Walk Score ${walk.score} — ${walk.description!.toLowerCase()}. ${walk.explanation}.`);
  }

  // Lead with the categories that actually earned points, nearest first.
  const strong = walk.categories
    .filter((c) => c.points > 0 && c.nearestMeters !== null)
    .sort((a, b) => b.points / b.maxPoints - a.points / a.maxPoints)
    .slice(0, 3);

  if (strong.length > 0) {
    const phrases = strong.map((c) => {
      const nearest = c.hits[0];
      const distance = describeDistance(c.nearestMeters);
      const name = nearest && !nearest.name.startsWith("Unnamed") ? ` (${nearest.name})` : "";
      return `${CATEGORY_LABELS[c.category].toLowerCase()}${name} about a ${distance}`;
    });
    parts.push(`The closest everyday destinations are ${listPhrase(phrases)}.`);
  }

  const missing = walk.categories.filter((c) => c.nearestMeters === null).map((c) => CATEGORY_LABELS[c.category].toLowerCase());
  if (missing.length > 0 && missing.length < 6) {
    parts.push(`Nothing was found within a 30-minute walk for ${listPhrase(missing)}.`);
  }

  const shape = walk.pedestrianShape;
  if (shape.penaltyFactor < 1 && shape.avgBlockLengthMeters !== null) {
    parts.push(
      `Long blocks (averaging ${shape.avgBlockLengthMeters} m) and limited street connections make walking routes less direct here, which lowers the score slightly.`
    );
  }

  if (result.transit.score !== null && result.transit.routeCount > 0) {
    parts.push(
      `Transit Score ${result.transit.score} from ${result.transit.routeCount} route${result.transit.routeCount === 1 ? "" : "s"} within a half-mile walk.`
    );
  } else if (!result.transit.hasCoverage) {
    parts.push("No transit schedule data is available for this area.");
  }

  if (result.bike.score !== null) {
    const hills = result.bike.hills.steepGradePct;
    const hillNote =
      hills === null ? "" : hills < 2 ? " The terrain is flat." : hills > 6 ? " The terrain is notably hilly." : "";
    parts.push(`Bike Score ${result.bike.score} — ${result.bike.description!.toLowerCase()}.${hillNote}`);
  }

  return parts.join(" ");
}

function listPhrase(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// AI rewrite
// ---------------------------------------------------------------------------

/**
 * The facts the model is allowed to talk about.
 *
 * Everything the model could say is in here. It is not given the address, the raw OSM
 * tags, or anything else it might use to pattern-match its way to a claim about the
 * neighbourhood that we did not measure.
 */
function factSheet(result: Omit<ScoreResult, "summary" | "summaryFromAi">): string {
  const lines: string[] = [];

  lines.push(`Walk Score: ${result.walk.score} (${result.walk.description})`);
  lines.push(`Bike Score: ${result.bike.score ?? "not available"} (${result.bike.description ?? "n/a"})`);
  lines.push(`Transit Score: ${result.transit.score ?? "not available"} (${result.transit.description ?? "n/a"})`);

  lines.push("Nearest amenity by category (walking time):");
  for (const category of result.walk.categories) {
    const label = CATEGORY_LABELS[category.category];
    if (category.nearestMeters === null) {
      lines.push(`- ${label}: none within a 30-minute walk`);
      continue;
    }
    const nearest = category.hits[0];
    const name = nearest && !nearest.name.startsWith("Unnamed") ? nearest.name : "unnamed";
    lines.push(
      `- ${label}: ${name}, ${metersToWalkMinutes(category.nearestMeters)} min walk (${category.hits.length} within range)`
    );
  }

  const shape = result.walk.pedestrianShape;
  lines.push(
    `Street pattern: ${shape.intersectionDensity ?? "unknown"} intersections per sq km, average block ${shape.avgBlockLengthMeters ?? "unknown"} m.`
  );

  if (result.bike.hills.steepGradePct !== null) {
    lines.push(`Terrain: typical steep grade ${result.bike.hills.steepGradePct}%.`);
  }
  if (result.bike.infrastructure.totalWayMeters > 0) {
    lines.push(
      `Bike infrastructure nearby: ${result.bike.infrastructure.protectedLaneMeters} m protected, ${result.bike.infrastructure.paintedLaneMeters} m painted lanes.`
    );
  }

  if (result.transit.routes.length > 0) {
    const top = result.transit.routes.slice(0, 6).map((r) => {
      const name = r.shortName ?? r.longName ?? r.routeId;
      const freq = r.tripsPerDay ? `${r.tripsPerDay} trips/weekday` : "frequency unknown";
      return `${name} (${r.mode}, ${metersToWalkMinutes(r.walkMeters)} min walk, ${freq})`;
    });
    lines.push(`Transit routes: ${top.join("; ")}`);
  }

  if (result.confidenceNotes.length > 0) {
    lines.push(`Data caveats: ${result.confidenceNotes.join(" ")}`);
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You write short, plain-spoken explanations of neighbourhood walkability for people browsing real-estate listings.

You will be given a fact sheet produced by a scoring engine. Rules:
- Use ONLY the facts given. Never invent a business, street, landmark, neighbourhood name, or statistic.
- If a fact is missing or marked unavailable, either say so plainly or leave it out. Never guess.
- 2 to 4 sentences. No headings, no bullet points, no markdown.
- Lead with what daily life is actually like here, then the notable specifics.
- Be honest about low scores. A car-dependent area is car-dependent; do not spin it.
- Do not mention "the fact sheet", the scoring engine, or that you are an AI.
- Do not repeat the numeric scores back verbatim; the interface already shows them.`;

async function callModel(facts: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        // Low but not zero: enough variation to avoid every listing reading identically.
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: facts },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      aiStats.failures += 1;
      return null;
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    aiStats.calls += 1;
    aiStats.promptTokens += json.usage?.prompt_tokens ?? 0;
    aiStats.completionTokens += json.usage?.completion_tokens ?? 0;

    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    aiStats.failures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SummaryOptions {
  ai: boolean;
}

export async function buildSummary(
  result: Omit<ScoreResult, "summary" | "summaryFromAi">,
  options: SummaryOptions
): Promise<{ text: string; fromAi: boolean }> {
  const template = templateSummary(result);
  if (!options.ai || !AI_ENABLED()) return { text: template, fromAi: false };

  const facts = factSheet(result);
  const cacheKey = facts;

  const cached = summaryCache.get(cacheKey);
  if (cached) {
    aiStats.cacheHits += 1;
    return { text: cached, fromAi: true };
  }

  const generated = await callModel(facts);
  if (!generated) return { text: template, fromAi: false };

  summaryCache.set(cacheKey, generated);
  return { text: generated, fromAi: true };
}

export function explainCacheSize(): number {
  return summaryCache.size;
}
