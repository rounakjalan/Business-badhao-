#!/usr/bin/env bash
# Applies all Supabase migrations to a scratch Postgres database (with a
# minimal stand-in for Supabase's `auth` schema) and runs the RLS/tenant
# isolation test suite in supabase/tests/. This is a plain-Postgres
# approximation used for fast local iteration; it does not require Docker.
#
# For a full, higher-fidelity check against the real Supabase stack
# (real GoTrue auth, real API layer), use `supabase test db` instead, which
# requires Docker (see supabase start / supabase test db in the CLI docs).
#
# Usage:
#   ./scripts/test-rls.sh
#
# Respects standard libpq environment variables (PGHOST, PGPORT, PGUSER,
# PGPASSWORD, ...). Defaults to connecting as the `postgres` superuser on
# localhost, which is how the project's sandbox/dev container is set up.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PSQL=${TEST_RLS_PSQL:-psql}
DB_NAME=${TEST_RLS_DB:-bb_rls_test}

run() {
  $PSQL -v ON_ERROR_STOP=1 "$@"
}

echo "==> Recreating scratch database '$DB_NAME'"
run -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"
run -d postgres -c "CREATE DATABASE ${DB_NAME};"
run -d "$DB_NAME" -c "create extension if not exists pgcrypto;"

echo "==> Applying local auth schema stub"
run -d "$DB_NAME" -f scripts/dev/pg-auth-stub.sql > /dev/null

echo "==> Applying migrations"
for f in supabase/migrations/*.sql; do
  echo "    $f"
  run -d "$DB_NAME" -f "$f" > /dev/null
done

echo "==> Running RLS/tenant isolation tests"
test_failed=0
for f in supabase/tests/*.test.sql; do
  echo "--- $f ---"
  output=$(run -d "$DB_NAME" -f "$f" 2>&1) || test_failed=1
  echo "$output" | grep -E "NOTICE:|ERROR:|result" || true
  if [ "$test_failed" = "1" ]; then
    echo "$output"
    break
  fi
done

echo "==> Cleaning up scratch database"
run -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"

if [ "$test_failed" = "1" ]; then
  echo "RLS test suite FAILED."
  exit 1
fi

echo "All RLS tests passed."
