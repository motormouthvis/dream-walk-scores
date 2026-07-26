import { scoreTone, TONE_CLASSES } from "@/components/score";

interface Props {
  label: string;
  score: number | null;
  description: string | null;
  explanation?: string | null;
  size?: "sm" | "md";
}

/**
 * A single score as a ring gauge.
 *
 * A null score renders as "NR" rather than zero. The distinction matters: no transit data
 * for a region is a different statement from a region with no transit, and collapsing the
 * two is how a scoring product loses trust.
 */
export function ScoreDial({ label, score, description, explanation, size = "md" }: Props) {
  const tone = TONE_CLASSES[scoreTone(score)];
  const dimension = size === "sm" ? 72 : 96;
  const stroke = size === "sm" ? 7 : 9;
  const radius = (dimension - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = score === null ? 0 : (score / 100) * circumference;

  return (
    <div className="flex items-center gap-4">
      <svg
        width={dimension}
        height={dimension}
        viewBox={`0 0 ${dimension} ${dimension}`}
        role="img"
        aria-label={`${label}: ${score ?? "not rated"}`}
        className="shrink-0 -rotate-90"
      >
        <circle
          cx={dimension / 2}
          cy={dimension / 2}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={stroke}
        />
        {score !== null && (
          <circle
            cx={dimension / 2}
            cy={dimension / 2}
            r={radius}
            fill="none"
            stroke={tone.stroke}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference - filled}`}
          />
        )}
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className={`rotate-90 origin-center font-semibold ${tone.text}`}
          style={{ fontSize: size === "sm" ? 22 : 28 }}
          fill="currentColor"
        >
          {score ?? "NR"}
        </text>
      </svg>

      <div className="min-w-0">
        <div className="dws-label">{label}</div>
        <div className={`truncate text-base font-semibold ${tone.text}`}>
          {description ?? "Not rated"}
        </div>
        {explanation && <p className="mt-0.5 text-sm text-ink-muted">{explanation}</p>}
      </div>
    </div>
  );
}
