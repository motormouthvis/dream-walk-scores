import { ScoreExplorer } from "@/components/ScoreExplorer";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <header className="mb-10">
        <p className="dws-label mb-2">Dream Neighborhood</p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Dream Walk Scores</h1>
        <p className="mt-3 text-ink-muted">
          Walk, Bike and Transit scores for any US address — computed from OpenStreetMap, published
          transit schedules and open Census data, with the reasoning shown.
        </p>
      </header>

      <ScoreExplorer />

      <section className="mt-16 grid gap-6 sm:grid-cols-3">
        <Feature
          title="Real walking distances"
          body="Scores are computed over the actual pedestrian street network, not straight lines, so a shop across an unbridged highway counts as far away."
        />
        <Feature
          title="Schedule-aware transit"
          body="Transit Score weights each nearby route by mode and by how many times it actually runs, read from published GTFS feeds."
        />
        <Feature
          title="Honest about gaps"
          body="Where the underlying data is thin we say so, and report confidence separately from the score itself."
        />
      </section>

      <footer className="mt-16 border-t border-gray-100 pt-6 text-sm text-ink-muted">
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <a className="hover:text-ink" href="/methodology">
            Methodology
          </a>
          <a className="hover:text-ink" href="/api/graphql">
            GraphQL schema
          </a>
          <a className="hover:text-ink" href="/api/health">
            Service health
          </a>
          <a
            className="hover:text-ink"
            href="https://github.com/motormouthvis/dream-walk-scores"
          >
            Source
          </a>
        </nav>
        <p className="mt-4 text-xs text-ink-faint">
          Data © OpenStreetMap contributors (ODbL), transit agencies via GTFS, and the US Census
          Bureau. Not affiliated with Walk Score®.
        </p>
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-ink-muted">{body}</p>
    </div>
  );
}
