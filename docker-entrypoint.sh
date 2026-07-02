#!/bin/sh
set -e

DATA_DIR="/data"
SECRET_KEY_FILE="$DATA_DIR/.secret_key"

# ── Secret key ────────────────────────────────────────────────────────────────
# Use APP_SECRET_KEY if provided; otherwise load or generate a persistent key.
if [ -n "$APP_SECRET_KEY" ]; then
    export PKTSNMP_SECRET_KEY="$APP_SECRET_KEY"
elif [ -f "$SECRET_KEY_FILE" ]; then
    export PKTSNMP_SECRET_KEY=$(cat "$SECRET_KEY_FILE")
else
    export PKTSNMP_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    echo "$PKTSNMP_SECRET_KEY" > "$SECRET_KEY_FILE"
    chmod 600 "$SECRET_KEY_FILE"
    echo "INFO: Generated new secret key → $SECRET_KEY_FILE"
fi

# ── Admin password (first-run guard) ─────────────────────────────────────────
# The app's seed_admin() reads PKTSNMP_ADMIN_PASSWORD and fails if no users
# exist and this variable is blank.
DB_PATH="${PKTSNMP_DB_PATH:-/data/pktsnmp.db}"
if [ ! -f "$DB_PATH" ] && [ -z "$APP_ADMIN_PASSWORD" ]; then
    echo "ERROR: APP_ADMIN_PASSWORD must be set on first run (no database found at $DB_PATH)." >&2
    echo "       Example: -e APP_ADMIN_PASSWORD=changeme" >&2
    exit 1
fi
export PKTSNMP_ADMIN_PASSWORD="$APP_ADMIN_PASSWORD"

# ── Port mapping ──────────────────────────────────────────────────────────────
# APP_HTTP_PORT  → PKTSNMP_PORT      (used when SSL is off)
# APP_HTTPS_PORT → PKTSNMP_HTTPS_PORT (used when SSL is on)
# APP_TRAP_PORT  → PKTSNMP_TRAP_PORT
export PKTSNMP_PORT="${APP_HTTP_PORT:-80}"
export PKTSNMP_HTTPS_PORT="${APP_HTTPS_PORT:-443}"
export PKTSNMP_TRAP_PORT="${APP_TRAP_PORT:-162}"

# ── Ensure data subdirectories ────────────────────────────────────────────────
mkdir -p "$DATA_DIR/ssl" "$DATA_DIR/logs"

# ── Launch ────────────────────────────────────────────────────────────────────
exec python -m app.main "$@"
