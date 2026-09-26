# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY apps/react/package*.json ./
RUN npm ci
COPY apps/react/ ./
RUN npm run build

# Stage 2: Build Caddy with Cloudflare DNS plugin (used by the built-in HTTPS reverse proxy)
FROM caddy:2-builder AS caddy-builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

# Stage 3: Python runtime
FROM python:3.12-slim

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple
RUN pip install --no-cache-dir -r requirements.txt

COPY any_gateway/ ./any_gateway/
COPY apps/ ./apps/
# Override source files with production build output
COPY --from=frontend-builder /frontend/dist ./apps/react/dist

# Built-in HTTPS reverse proxy (started by entrypoint only when ACME env vars are set)
COPY --from=caddy-builder /usr/bin/caddy /usr/local/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Keep Caddy certificates/state on the mounted ./data volume so they survive recreation
ENV XDG_DATA_HOME=/app/data/caddy \
    XDG_CONFIG_HOME=/app/data/caddy_config

ENV PYTHONPATH=/app/any_gateway

# Create data directory for SQLite database and logs
RUN mkdir -p /app/data

EXPOSE 8003 8443

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8003/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "gateway:app", "--host", "0.0.0.0", "--port", "8003", "--app-dir", "any_gateway"]
