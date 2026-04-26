#!/bin/sh
# Run the PostgreSQL schema migration.
# Usage: DATABASE_URL=postgresql://... ./migrate.sh
# Or:    kubectl run bios-migrate --image=postgres:16-alpine --rm --attach \
#          --env="DATABASE_URL=$DATABASE_URL" -- psql "$DATABASE_URL" -f /schema.sql
set -e
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is required"
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
psql "$DATABASE_URL" -f "$SCRIPT_DIR/schema.sql"
echo "Schema migration complete."
