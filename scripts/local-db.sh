#!/usr/bin/env bash
# Recreate the local database: Supabase shim + all migrations + seed.
# Usage: scripts/local-db.sh [dbname]   (default: intheanswer)
set -euo pipefail
DB="${1:-intheanswer}"
cd "$(dirname "$0")/.."
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
# start a local cluster if one is installed but not running (dev containers)
if ! pg_isready -q 2>/dev/null && command -v pg_ctlcluster >/dev/null; then
  pg_ctlcluster 16 main start 2>/dev/null || true
  for _ in 1 2 3 4 5; do pg_isready -q && break; sleep 1; done
fi
dropdb --if-exists "$DB"
createdb "$DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/local/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/seed.sql
echo "local database $DB ready"
