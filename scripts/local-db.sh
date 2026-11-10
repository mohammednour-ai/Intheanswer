#!/usr/bin/env bash
# Recreate the local database: Supabase shim + all migrations + seed.
# Usage: scripts/local-db.sh [dbname]   (default: intheanswer)
set -euo pipefail
DB="${1:-intheanswer}"
cd "$(dirname "$0")/.."
export PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
dropdb --if-exists "$DB"
createdb "$DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/local/00_supabase_shim.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/seed.sql
echo "local database $DB ready"
