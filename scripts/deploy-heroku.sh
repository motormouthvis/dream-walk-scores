#!/usr/bin/env bash
#
# Create and deploy a Dream Walk Scores app on Heroku, end to end.
#
# Safe to re-run: every step checks for what it needs before creating anything, so a run
# that fails partway through can simply be run again.
#
#   heroku login                      # or export HEROKU_API_KEY=...
#   bash scripts/deploy-heroku.sh
#   bash scripts/deploy-heroku.sh my-app-name
#
# Takes roughly ten minutes, most of it downloading transit feeds.

set -euo pipefail

APP="${1:-${HEROKU_APP:-dream-walk-scores}}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# Seeding runs the curated major-metro list rather than a slice of the whole catalog.
# Set GTFS_SEED=skip to deploy without transit data and load it later.
GTFS_SEED="${GTFS_SEED:-metros}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------

step "Checking prerequisites"

command -v heroku >/dev/null 2>&1 || die \
  "The Heroku CLI is not installed. See https://devcenter.heroku.com/articles/heroku-cli"

command -v node >/dev/null 2>&1 || die "Node is required to read the Heroku CLI's JSON output."

if ! heroku auth:whoami >/dev/null 2>&1; then
  die "Not logged in to Heroku. Run 'heroku login', or export HEROKU_API_KEY."
fi
info "authenticated as $(heroku auth:whoami)"
info "deploying branch '${BRANCH}' to app '${APP}'"

# ---------------------------------------------------------------------------

step "Creating the app"

if heroku apps:info --app "$APP" >/dev/null 2>&1; then
  info "app '${APP}' already exists — reusing it"
else
  heroku apps:create "$APP" --stack heroku-24
  info "created"
fi

# Heroku gives apps created since 2023 a random suffix in their hostname, so the URL cannot
# be derived from the app name — it has to be read back from the platform.
BASE="$(heroku apps:info --app "$APP" --json 2>/dev/null | node -e '
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    try { process.stdout.write(((JSON.parse(s).app || {}).web_url || "").replace(/\/$/, "")); }
    catch { /* leave empty; the caller reports it */ }
  });
')"
[ -n "$BASE" ] || die "Could not read the URL of app '${APP}' from the Heroku API."
info "url ${BASE}"

# ---------------------------------------------------------------------------

step "Configuring buildpacks"

# Order matters. Python must run first so that `pipeline/*.py` and its dependencies exist
# by the time the release phase runs the schema migration; Node must run last so that the
# Node process is what boots the web dyno.
current_buildpacks="$(heroku buildpacks --app "$APP" 2>/dev/null || true)"

if echo "$current_buildpacks" | grep -q "heroku/python" && \
   echo "$current_buildpacks" | grep -q "heroku/nodejs"; then
  info "buildpacks already set"
else
  heroku buildpacks:clear --app "$APP" >/dev/null 2>&1 || true
  heroku buildpacks:add heroku/python --app "$APP"
  heroku buildpacks:add heroku/nodejs --app "$APP"
fi

# ---------------------------------------------------------------------------

step "Provisioning Postgres"

if heroku addons --app "$APP" 2>/dev/null | grep -q "heroku-postgresql"; then
  info "Postgres already attached"
else
  # essential-0 is the cheapest tier that includes PostGIS. The score cache and GTFS
  # tables are small; the row limit is the constraint to watch, not storage.
  heroku addons:create heroku-postgresql:essential-0 --app "$APP" --wait
fi

# ---------------------------------------------------------------------------

step "Setting config vars"

ADMIN_PASSWORD_VALUE="$(heroku config:get ADMIN_PASSWORD --app "$APP" 2>/dev/null || true)"
if [ -z "$ADMIN_PASSWORD_VALUE" ]; then
  ADMIN_PASSWORD_VALUE="$(openssl rand -hex 24)"
  GENERATED_PASSWORD=1
fi

heroku config:set \
  PGSSLMODE=require \
  ADMIN_PASSWORD="$ADMIN_PASSWORD_VALUE" \
  PUBLIC_BASE_URL="$BASE" \
  --app "$APP" >/dev/null

info "PGSSLMODE, ADMIN_PASSWORD and PUBLIC_BASE_URL set"

# ---------------------------------------------------------------------------

step "Deploying"

# `heroku git:remote` is idempotent.
heroku git:remote --app "$APP" --remote heroku >/dev/null

# Heroku always deploys its own `main`, whatever the local branch is called.
git push heroku "${BRANCH}:main" --force-with-lease 2>&1 | sed 's/^/    /'

# ---------------------------------------------------------------------------

step "Waiting for the app to come up"

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 15 "${BASE}/api/health" >/dev/null 2>&1; then
    info "responding after ${attempt} attempt(s)"
    break
  fi
  [ "$attempt" -eq 30 ] && die "app did not respond. Check: heroku logs --tail --app ${APP}"
  sleep 5
done

curl -fsS "${BASE}/api/health" | sed 's/^/    /'

# ---------------------------------------------------------------------------

step "Loading transit feeds (this is the slow part)"

if [ "$GTFS_SEED" = "skip" ]; then
  info "skipped (GTFS_SEED=skip) — Transit Scores will fall back to OpenStreetMap"
else
  # The major metros, not a slice of the catalog. Selecting feeds by bounding-box area
  # ("--top N") sorts national-park shuttles above the New York subway, which leaves a
  # walkability product with no schedules anywhere that people actually walk.
  info "ingesting the major metro feeds; roughly ten to fifteen minutes"
  heroku run --exit-code --app "$APP" \
    "bash pipeline/load_calibration_gtfs.sh" 2>&1 | tail -30
fi

# ---------------------------------------------------------------------------

step "Verifying"

curl -fsS "${BASE}/api/health" | sed 's/^/    /'
echo
info "Times Square:"
curl -fsS "${BASE}/api/score?lat=40.758&lng=-73.9855&detail=0" | sed 's/^/    /'

# ---------------------------------------------------------------------------

step "Done"

cat <<EOF

    App           ${BASE}
    Try it        ${BASE}
    Admin         ${BASE}/admin
    Methodology   ${BASE}/methodology
    Health        ${BASE}/api/health

    Score an address
      curl "${BASE}/api/score?address=1500+N+23rd+St,+Fort+Pierce+FL"

    Walk Score drop-in replacement — point dreamneighborhood at this:
      ${BASE}/api/walkscore

    Embed on any page
      <script src="${BASE}/embed.js" async></script>

EOF

if [ "${GENERATED_PASSWORD:-0}" = "1" ]; then
  echo "    Admin password (generated, save this): ${ADMIN_PASSWORD_VALUE}"
  echo
fi

cat <<EOF
    Optional next steps
      # Pre-score a metro so listing pages are instant (run locally, targets production)
      heroku run:detached --app ${APP} \\
        "python3 pipeline/precompute_grid.py --metro chicago --base-url ${BASE}"

      # Enable AI-written summaries on ai=1 requests
      heroku config:set OPENAI_API_KEY=sk-... --app ${APP}

EOF
