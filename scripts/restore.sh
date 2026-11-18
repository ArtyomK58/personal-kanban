#!/usr/bin/env bash
# Restore a backup made by backup.sh. Stops the app, replaces the DB in the volume, starts it again.
#   scripts/restore.sh backups/kanban-YYYYmmdd-HHMMSS.db
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=${COMPOSE:-"docker compose"}
SRC=${1:?usage: restore.sh <backup.db>}
[ -s "$SRC" ] || { echo "no such backup: $SRC" >&2; exit 1; }
$COMPOSE stop kanban
# Copy into the stopped container's volume and drop WAL/SHM files from the old database.
$COMPOSE run --rm -T --no-deps --entrypoint sh kanban -c 'cat > /data/kanban.db.restore && mv /data/kanban.db.restore /data/kanban.db && rm -f /data/kanban.db-wal /data/kanban.db-shm' < "$SRC"
$COMPOSE start kanban
echo "restored from $SRC"
