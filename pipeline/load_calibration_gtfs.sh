#!/usr/bin/env bash
# Load the GTFS feeds covering the calibration set in `scripts/calibration-set.ts`.
#
# Transit Score cannot be calibrated against reference values without schedule data for
# the metros being compared, so this is a prerequisite for any transit tuning work. It is
# also a reasonable "seed the major metros" step for a fresh environment.
#
#   DATABASE_URL=... bash pipeline/load_calibration_gtfs.sh
set -uo pipefail

cd "$(dirname "$0")"

METROS=(
  "MTA"                 # New York City subway and bus
  "SFMTA"               # San Francisco Muni
  "Bay Area Rapid"      # BART
  "AC Transit"          # Oakland and Alameda
  "Chicago Transit"     # CTA
  "Metra"               # Chicago commuter rail
  "Pace"                # Chicago suburbs, incl. Naperville
  "MBTA"                # Boston and Somerville
  "SEPTA"               # Philadelphia
  "King County"         # Seattle
  "Sound Transit"       # Puget Sound regional
  "TriMet"              # Portland
  "Regional Transportation District" # Denver RTD
  "Metro Transit"       # Minneapolis
  "Miami-Dade"          # Miami
  "Dallas Area Rapid"   # DART, incl. Plano
  "MARTA"               # Atlanta and Decatur
  "Greater Cleveland"   # Cleveland RTA
  "Valley Metro"        # Phoenix
  "GoTriangle"          # Raleigh and Cary
  "GoCary"
  "Metropolitan Transit Authority of Harris" # Houston, incl. Katy
  "SMART"               # Detroit suburbs, incl. Livonia
  "DDOT"                # Detroit
  "Community Transit"
)

loaded=0
failed=0

for metro in "${METROS[@]}"; do
  echo "=== ${metro} ==="
  # Large systems publish one feed per mode or per borough — New York alone has nine — so
  # the per-metro limit has to be generous or big cities silently load partial service.
  if python3 load_gtfs.py --catalog --metro "${metro}" --limit 12; then
    loaded=$((loaded + 1))
  else
    failed=$((failed + 1))
  fi
done

echo "=== finished: ${loaded} metro queries loaded, ${failed} with no usable feed ==="
