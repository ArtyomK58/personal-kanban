#!/usr/bin/env bash
# Consistent online backup of the board (SQLite .backup API, safe while the server runs).
#   scripts/backup.sh [out-dir]          → <out-dir>/kanban-YYYYmmdd-HHMMSS.db
# Uses `docker compose` (or $COMPOSE, e.g. COMPOSE=docker-compose).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=${COMPOSE:-"docker compose"}
OUT=${1:-./backups}
mkdir -p "$OUT"
NAME="kanban-$(date +%Y%m%d-%H%M%S).db"
$COMPOSE exec -T kanban node -e "
const D=require('better-sqlite3'); const db=new D('/data/kanban.db',{readonly:true});
db.backup('/tmp/$NAME').then(()=>{console.error('ok');db.close();}).catch(e=>{console.error(e);process.exit(1);});"
$COMPOSE exec -T kanban cat "/tmp/$NAME" > "$OUT/$NAME"
$COMPOSE exec -T kanban rm -f "/tmp/$NAME"
chmod 600 "$OUT/$NAME"
echo "$OUT/$NAME"
