#!/usr/bin/env bash
#
# capture-deploy-state.sh — snapshot the per-deployment state that lives
# OUTSIDE the backend image, so `docker compose up --force-recreate` stops
# being a destructive act.
#
# Four things have no home in admin_module:latest (all excluded by
# ai-admin-module-py/.dockerignore) and all of them fail SILENTLY:
#
#   1. app/config.json        ai_config — BASE_URL + the endpoint list. A fresh
#                             container writes defaults from app/config.py on
#                             the first GET /settings/ai-config. Settings-screen
#                             edits die on recreate.
#   2. app/environment.json   holds the Solutions API token.
#   3. knowledge_base/        flow grounding. Deleted from git in 3a6ea57, so
#                             `COPY . /app` ships nothing; _resolve_kb_root()
#                             logs ONE warning and every lookup returns []/"".
#                             Generation still succeeds — just ungrounded.
#   4. external-db/admin.db   the SQLite database.
#
# Run this ON the deployment host (dx12348), as the compose owner. No sudo
# required: everything here is a read.
#
#   ./capture-deploy-state.sh                 # capture, secrets redacted
#   ./capture-deploy-state.sh --with-secrets  # include token / admin.db
#   ./capture-deploy-state.sh --verify        # container-vs-host check, capture nothing
#   ./capture-deploy-state.sh --dry-run
#
set -euo pipefail

# --------------------------------------------------------------------------- #
# Config (override via environment)
# --------------------------------------------------------------------------- #
COMPOSE_DIR="${COMPOSE_DIR:-/opt/qatlas-admin-backend/stlc-platform}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-stlc-platform}"
# The server runs `admin-module-py_backend-new`, NOT the `admin-module-py_backend`
# the repo's compose file declares. Auto-detected below; this is the fallback.
CONTAINER="${CONTAINER:-admin-module-py_backend-new}"
OUT_ROOT="${OUT_ROOT:-$HOME/deploy-state}"

WITH_SECRETS=0
VERIFY_ONLY=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --with-secrets) WITH_SECRETS=1 ;;
    --verify)       VERIFY_ONLY=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    --out)          OUT_ROOT="$2"; shift ;;
    -h|--help)      sed -n '2,28p' "$0"; exit 0 ;;
    *)              echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;32m[capture]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[capture]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[capture] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '       + %s\n' "$*"; else "$@"; fi; }

command -v docker >/dev/null || die "docker not on PATH"

# --------------------------------------------------------------------------- #
# Resolve the live container — never trust the repo's container_name
# --------------------------------------------------------------------------- #
detected=$(docker ps \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
  --filter "label=com.docker.compose.service=backend" \
  --format '{{.Names}}' | head -1 || true)
[ -n "$detected" ] && CONTAINER="$detected"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' not running"
log "container: $CONTAINER"

# Read the bind mounts off the RUNNING container rather than any compose file.
# The server's compose diverges from this checkout, and the running container is
# the only source of truth for what is actually wired up right now.
MOUNTS=$(docker inspect -f \
  '{{range .Mounts}}{{.Type}}	{{.Source}}	{{.Destination}}	{{.RW}}{{"\n"}}{{end}}' \
  "$CONTAINER")

cin() { docker exec "$CONTAINER" "$@" 2>/dev/null; }   # read inside the container

mount_src() { printf '%s' "$MOUNTS" | awk -F'\t' -v d="$1" '$3==d{print $2}' | head -1; }

# --------------------------------------------------------------------------- #
# --verify: is the state actually wired up, or silently absent?
# --------------------------------------------------------------------------- #
if [ "$VERIFY_ONLY" = 1 ]; then
  rc=0
  echo
  echo "  bind mounts on $CONTAINER:"
  if [ -z "$(printf '%s' "$MOUNTS" | tr -d '[:space:]')" ]; then
    warn "NO MOUNTS AT ALL — every piece of state below is ephemeral"
    rc=1
  else
    printf '%s' "$MOUNTS" | awk -F'\t' 'NF{printf "    %-7s %-52s -> %-26s rw=%s\n",$1,$2,$3,$4}'
  fi

  echo
  echo "  state checks (reading the CONTAINER, not the host checkout):"

  # 1. config.json must be a FILE. Docker creates a DIRECTORY where a
  #    bind-mounted file is missing, and a directory here makes the backend
  #    fail on its first settings read.
  if cin test -f /app/app/config.json; then
    base=$(cin python3 -c 'import json;print(json.load(open("/app/app/config.json")).get("ai_config",{}).get("BASE_URL","<missing>"))' || echo '<unparseable>')
    echo "    [ok]   /app/app/config.json   BASE_URL=$base"
  elif cin test -d /app/app/config.json; then
    echo "    [FAIL] /app/app/config.json is a DIRECTORY — create the host file first"
    rc=1
  else
    echo "    [warn] /app/app/config.json absent — defaults get written, then lost on recreate"
    rc=1
  fi

  # 2. KB. The success path logs at info and nothing configures the root logger,
  #    so a WORKING kb prints nothing at all. Count entries instead of trusting logs.
  kbn=$(cin sh -c 'ls -1 /app/knowledge_base/applications 2>/dev/null | wc -l' || echo 0)
  if [ "${kbn:-0}" -gt 0 ]; then
    echo "    [ok]   /app/knowledge_base/applications  ($kbn entries)"
  else
    echo "    [FAIL] KB empty/absent — generation will SUCCEED but ungrounded (placeholder URLs)"
    rc=1
  fi

  # 3. DB on the mounted volume, not in the writable layer.
  if cin test -f /app/external-db/admin.db; then
    echo "    [ok]   /app/external-db/admin.db  ($(cin stat -c%s /app/external-db/admin.db) bytes)"
  else
    echo "    [FAIL] /app/external-db/admin.db missing"
    rc=1
  fi

  # 4. Drift: container copy vs host bind source.
  hsrc=$(mount_src /app/app/config.json)
  if [ -n "$hsrc" ] && [ -f "$hsrc" ]; then
    a=$(cin sha256sum /app/app/config.json | cut -d' ' -f1)
    b=$(sha256sum "$hsrc" | cut -d' ' -f1)
    if [ "$a" = "$b" ]; then
      echo "    [ok]   config.json host copy matches container"
    else
      echo "    [FAIL] config.json DRIFT: host != container"
      rc=1
    fi
  else
    echo "    [warn] config.json is not bind-mounted — Settings edits are ephemeral"
    rc=1
  fi
  echo
  exit $rc
fi

# --------------------------------------------------------------------------- #
# Capture
# --------------------------------------------------------------------------- #
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_ROOT/$TS"
log "capturing to $OUT"
run mkdir -p "$OUT/config" "$OUT/knowledge_base" "$OUT/db" "$OUT/compose"

# -- the server's compose file AND its resolved form. The resolved output is the
#    one that matters: variables substituted, mounts as compose really sees them.
if [ -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  run cp "$COMPOSE_DIR/docker-compose.yml" "$OUT/compose/docker-compose.server.yml"
  if [ "$DRY_RUN" = 0 ]; then
    ( cd "$COMPOSE_DIR" && docker compose config ) > "$OUT/compose/resolved.yml" 2>/dev/null \
      || warn "docker compose config failed — resolved.yml not written"
  fi
else
  warn "no compose file at $COMPOSE_DIR — skipping"
fi
[ "$DRY_RUN" = 0 ] && printf '%s' "$MOUNTS" > "$OUT/compose/mounts.tsv"

# -- 1. config.json, read from the CONTAINER. Authoritative: the Settings screen
#       writes through the mount, and the container is what actually served it.
if cin test -f /app/app/config.json; then
  [ "$DRY_RUN" = 0 ] && cin cat /app/app/config.json > "$OUT/config/config.json"
  log "config.json captured from container"
else
  warn "config.json absent in container — nothing to capture"
fi

# -- 2. environment.json carries the Solutions API token. Redacted unless asked.
if cin test -f /app/app/environment.json; then
  if [ "$WITH_SECRETS" = 1 ]; then
    [ "$DRY_RUN" = 0 ] && cin cat /app/app/environment.json > "$OUT/config/environment.json"
    warn "environment.json captured WITH the Solutions token"
  else
    if [ "$DRY_RUN" = 0 ]; then
      cin python3 -c 'import json,sys
def red(o):
    if isinstance(o, dict):  return {k: red(v) for k, v in o.items()}
    if isinstance(o, list):  return [red(v) for v in o]
    return "<FILL_ME>" if isinstance(o, str) and o else o
json.dump(red(json.load(open("/app/app/environment.json"))), sys.stdout, indent=2)' \
        > "$OUT/config/environment.json.example"
    fi
    log "environment.json captured (values redacted)"
  fi
fi

# -- 3. KB from the HOST bind source: it is mounted :ro, so the host is
#       authoritative and the container copy can only ever equal it.
kb_src=$(mount_src /app/knowledge_base)
if [ -n "$kb_src" ] && [ -d "$kb_src" ]; then
  run cp -a "$kb_src/." "$OUT/knowledge_base/"
  log "knowledge_base captured from host mount $kb_src"
elif cin test -d /app/knowledge_base; then
  run docker cp "$CONTAINER:/app/knowledge_base/." "$OUT/knowledge_base/"
  warn "KB is NOT bind-mounted — pulled from the image layer; it will not survive a recreate"
else
  warn "no knowledge_base anywhere. Restore it from git with:"
  warn "  git checkout 3a6ea57^ -- ai-admin-module-py/knowledge_base/applications"
fi

# -- 4. admin.db. Never plain-copy a live SQLite file; use the backup API for a
#       consistent snapshot. Holds real user rows (local auth stores plaintext
#       passwords), so it is opt-in.
if [ "$WITH_SECRETS" = 1 ]; then
  if [ "$DRY_RUN" = 0 ]; then
    cin python3 -c 'import sqlite3
s = sqlite3.connect("/app/external-db/admin.db")
d = sqlite3.connect("/tmp/admin.snap.db")
s.backup(d); d.close(); s.close()'
    docker cp "$CONTAINER:/tmp/admin.snap.db" "$OUT/db/admin.db"
    cin rm -f /tmp/admin.snap.db
  fi
  warn "admin.db captured — contains real users; do NOT commit this directory"
else
  log "admin.db skipped (--with-secrets to include)"
fi

# -- 5. .env: key names only. The JWT SECRET_KEY must never land in a snapshot,
#       and an empty SECRET_KEY does not fail loudly — it issues tokens that never
#       validate. Capturing the key LIST is what makes a missing one visible.
if [ -f "$COMPOSE_DIR/ai-admin-module-py/.env" ] && [ "$DRY_RUN" = 0 ]; then
  sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1=<FILL_ME>/' \
    "$COMPOSE_DIR/ai-admin-module-py/.env" > "$OUT/config/env.example"
  log "env.example written (keys only, no values)"
fi

# --------------------------------------------------------------------------- #
# Manifest — what was captured, from which image, with what to know on restore
# --------------------------------------------------------------------------- #
if [ "$DRY_RUN" = 0 ]; then
  img=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
  dig=$(docker inspect -f '{{.Image}}' "$CONTAINER")
  secrets_flag=$([ "$WITH_SECRETS" = 1 ] && echo true || echo false)

  cat > "$OUT/manifest.json" <<MANIFEST
{
  "capturedAt": "$TS",
  "host": "$(hostname)",
  "composeDir": "$COMPOSE_DIR",
  "container": "$CONTAINER",
  "image": "$img",
  "imageId": "$dig",
  "withSecrets": $secrets_flag,
  "excluded": ["JWT SECRET_KEY", "LDAP_* credentials", ".build-proxy"],
  "restoreNotes": [
    "Create host files BEFORE compose up: docker makes a DIRECTORY where a bind-mounted file is missing, and a directory at app/config.json breaks the first settings read.",
    "config.json must be mode 666 - guna cannot chown to uid 10001.",
    "KB mounts at /app/knowledge_base, so AUTOMATION_KB_PATH stays UNSET (the resolver appends applications/ itself).",
    "KB_ROOT_DIR resolves at import: new KB files need a container restart.",
    "Never restore with docker cp - a recreate destroys anything placed that way."
  ]
}
MANIFEST

  ( cd "$OUT" && find . -type f ! -name checksums.sha256 -exec sha256sum {} + > checksums.sha256 )
  ln -sfn "$OUT" "$OUT_ROOT/latest"
  log "done — $OUT ($(du -sh "$OUT" | cut -f1)), symlinked as $OUT_ROOT/latest"
  [ "$WITH_SECRETS" = 1 ] && warn "this snapshot contains secrets: chmod 700 it, keep it out of git"
fi
