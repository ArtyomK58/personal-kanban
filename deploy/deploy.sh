#!/usr/bin/env bash
# Deploy a commit of personal-kanban to /opt/personal-kanban with backup, dry-run migration and rollback.
#   deploy/deploy.sh <git-repo-path> <commit>
# Env: COMPOSE (default "docker compose"), KANBAN_ROOT (default /opt/personal-kanban), KANBAN_PORT (18490)
set -euo pipefail
REPO=${1:?repo path}; REV=${2:?commit}
ROOT=${KANBAN_ROOT:-/opt/personal-kanban}
COMPOSE=${COMPOSE:-"docker compose"}
PORT=${KANBAN_PORT:-18490}
SHA=$(git -C "$REPO" rev-parse --short=12 "$REV")
TS=$(date -u +%Y%m%dT%H%M%SZ)
log() { echo "[deploy $TS] $*"; }
umask 077
mkdir -p "$ROOT"/{releases,backups,state}
chmod 700 "$ROOT/backups" "$ROOT/state"

# 1. build the image from an exact git archive of the commit
REL="$ROOT/releases/$SHA"
if [ ! -d "$REL" ]; then
  mkdir -p "$REL"
  git -C "$REPO" archive "$SHA" | tar -x -C "$REL"
fi
chmod -R go+rX "$REL"
log "building personal-kanban:$SHA"
docker build -q -t "personal-kanban:$SHA" "$REL" >/dev/null
install -m 0644 "$REL/deploy/compose.prod.yaml" "$ROOT/compose.yaml"
cd "$ROOT"
PREV=$(sed -n 's/^KANBAN_IMAGE_TAG=//p' .env 2>/dev/null || true)
dc() { $COMPOSE --project-directory "$ROOT" -f "$ROOT/compose.yaml" "$@"; }

# 2. consistent online backup of the current DB (SQLite backup API handles WAL)
BK=""
if [ -n "$PREV" ] && dc ps --status running --services 2>/dev/null | grep -qx kanban; then
  BK="$ROOT/backups/kanban-$TS-before-$SHA.db"
  dc exec -T kanban node -e "
    const D=require('better-sqlite3');const db=new D('/data/kanban.db',{readonly:true});
    db.backup('/tmp/pre.db').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});"
  dc exec -T kanban cat /tmp/pre.db > "$BK"
  dc exec -T kanban rm -f /tmp/pre.db
  log "backup: $BK ($(stat -c %s "$BK") bytes)"
fi

# 3. dry-run the migrations of the new image on a copy of the backup
if [ -n "$BK" ]; then
  cp "$BK" "$ROOT/state/dryrun.db"
  docker run --rm --network none --user root -v "$ROOT/state:/check" --entrypoint node "personal-kanban:$SHA" -e "
    import('/app/dist/server/db.js').then(({openDb})=>{const db=openDb('/check/dryrun.db');
    const ok=db.pragma('integrity_check',{simple:true});const v=db.pragma('user_version',{simple:true});db.close();
    console.log('dry-run migration: integrity',ok,'schema',v); if(ok!=='ok')process.exit(1);});"
  rm -f "$ROOT/state/dryrun.db"*
fi

# 4. switch
echo "KANBAN_IMAGE_TAG=$SHA" > .env.next
echo "KANBAN_PORT=$PORT" >> .env.next
mv .env.next .env
dc up -d --remove-orphans
ok=""
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ -z "$ok" ]; then
  log "health check FAILED — rolling back"
  dc logs --no-color --tail 50 kanban | sed -E 's/pk_[A-Za-z0-9_-]{20,}/pk_<redacted>/g' || true
  if [ -n "$PREV" ]; then
    dc stop kanban || true
    if [ -n "$BK" ]; then
      dc run --rm -T --no-deps --entrypoint sh kanban -c 'cat > /data/kanban.db.rb && mv /data/kanban.db.rb /data/kanban.db && rm -f /data/kanban.db-wal /data/kanban.db-shm' < "$BK"
    fi
    printf 'KANBAN_IMAGE_TAG=%s\nKANBAN_PORT=%s\n' "$PREV" "$PORT" > .env
    dc up -d
  fi
  exit 1
fi
echo "$PREV" > state/previous-tag
echo "$SHA" > state/current-tag
log "deployed $SHA (previous: ${PREV:-none}); health ok"
