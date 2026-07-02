# ── Stage 1: Frontend build ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# Install OS packages needed by pysnmp and cryptography libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl-dev \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application source
COPY app/        ./app/
COPY migrations/ ./migrations/

# Built frontend
COPY --from=frontend-builder /build/dist ./frontend/dist

# Entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Persistent data directory (mounted as a named volume)
RUN mkdir -p /data/ssl /data/logs

# ── Environment defaults ───────────────────────────────────────────────────────
# APP_* vars are Docker-facing; entrypoint translates them to PKTSNMP_* vars.
# APP_ADMIN_PASSWORD is REQUIRED on first run (fails loud if blank + no DB).
# APP_SECRET_KEY is auto-generated and persisted to /data/.secret_key if unset.
ENV APP_HTTP_PORT=80 \
    APP_HTTPS_PORT=443 \
    APP_TRAP_PORT=162 \
    APP_ADMIN_PASSWORD="" \
    APP_SECRET_KEY="" \
    PKTSNMP_DB_PATH=/data/pktsnmp.db \
    PKTSNMP_DUCKDB_PATH=/data/snmp.duckdb \
    PKTSNMP_LOG_FILE=/data/logs/pktsnmp.log \
    PKTSNMP_HOST=0.0.0.0

EXPOSE 80 443 162/udp

VOLUME ["/data"]

ENTRYPOINT ["/docker-entrypoint.sh"]
