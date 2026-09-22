# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY apps/react/package*.json ./
RUN npm ci
COPY apps/react/ ./
RUN npm run build

# Stage 2: Python runtime
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

ENV PYTHONPATH=/app/any_gateway

# Create data directory for SQLite database and logs
RUN mkdir -p /app/data

EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8003/health || exit 1

# 部署时可在镜像内放 /app/deploy.env（不入库），启动时自动注入环境变量；
# 文件不存在时正常启动（环境变量可由平台注入）。2>&1 让平台采集到启动日志。
CMD ["sh", "-c", "set -a && . /app/deploy.env 2>/dev/null; set +a; python -m uvicorn gateway:app --host 0.0.0.0 --port 8003 --app-dir any_gateway 2>&1"]
