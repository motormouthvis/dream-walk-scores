import fs from "node:fs";
import path from "node:path";

export const metadata = {
  title: "Methodology — Dream Walk Scores",
  description: "Exactly how Dream Walk Scores computes Walk, Bike and Transit scores.",
};

/**
 * Renders `docs/METHODOLOGY.md` as the public methodology page.
 *
 * Serving the same file the engineers edit means the published explanation cannot drift
 * away from the one in the repository, which is the usual fate of a methodology page.
 */
export default function MethodologyPage() {
  const source = path.join(process.cwd(), "docs", "METHODOLOGY.md");
  let markdown = "";
  try {
    markdown = fs.readFileSync(source, "utf8");
  } catch {
    markdown = "# Methodology\n\nThe methodology document could not be loaded.";
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <a href="/" className="text-sm text-brand hover:text-brand-dark">
        ← Dream Walk Scores
      </a>
      <article className="mt-6 whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-ink">
        {markdown}
      </article>
    </main>
  );
}
