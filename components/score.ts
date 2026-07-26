/**
 * Presentation helpers for scores.
 *
 * Colour bands match the ones `dream-schools` uses for its ratings, so a listing page
 * showing both a school rating and a walk score reads as one product.
 */

export type Tone = "emerald" | "lime" | "amber" | "orange" | "rose" | "slate";

export function scoreTone(score: number | null): Tone {
  if (score === null) return "slate";
  if (score >= 90) return "emerald";
  if (score >= 70) return "lime";
  if (score >= 50) return "amber";
  if (score >= 25) return "orange";
  return "rose";
}

/** Tailwind classes per tone. Written out in full because Tailwind cannot see
 *  dynamically constructed class names at build time. */
export const TONE_CLASSES: Record<Tone, { text: string; bg: string; ring: string; stroke: string }> = {
  emerald: { text: "text-emerald-700", bg: "bg-emerald-50", ring: "ring-emerald-200", stroke: "#059669" },
  lime: { text: "text-lime-700", bg: "bg-lime-50", ring: "ring-lime-200", stroke: "#65a30d" },
  amber: { text: "text-amber-700", bg: "bg-amber-50", ring: "ring-amber-200", stroke: "#d97706" },
  orange: { text: "text-orange-700", bg: "bg-orange-50", ring: "ring-orange-200", stroke: "#ea580c" },
  rose: { text: "text-rose-700", bg: "bg-rose-50", ring: "ring-rose-200", stroke: "#e11d48" },
  slate: { text: "text-slate-500", bg: "bg-slate-50", ring: "ring-slate-200", stroke: "#94a3b8" },
};

/** Walking time in whole minutes at 1.4 m/s, the standard planning speed. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 1.4 / 60));
}

export function formatDistance(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters)} m`;
  return `${miles.toFixed(1)} mi`;
}

export const CONFIDENCE_LABELS: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};
