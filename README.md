# Any Gateway

**[English](#any-gateway) · [中文](README_CN.md)**

A self-hosted AI API gateway that proxies requests to multiple backend providers (OpenAI, Anthropic, Gemini) with user management, quota control, rate limiting, and audit logging.

![](docs/imgs/snapshot1.png)
![](docs/imgs/snapshot2.png)
![](docs/imgs/snapshot3.png)

## Features

- **Multi-provider routing** — Supports OpenAI-compatible, Anthropic, and Gemini APIs with transparent header proxying
- **Weighted load balancing** — Distribute traffic across channels using configurable weights
- **User group access control** — Assign users to groups with priority-based channel access
- **API key management** — Issue `sk-*` keys with per-key quota limits, expiration, and freeze/unfreeze
- **Quota enforcement** — Per-token USD spend limits enforced before forwarding requests
- **Rate limiting** — DB-backed fixed-window limits on requests, tokens, or spend per group (multi-instance safe, no Redis required)
- **Pricing & billing** — Per-model pricing with per-group multipliers and custom override prices
- **Vouchers** — Redeem codes to top up user quota balances
- **LDAP/AD authentication** — Enterprise login via Active Directory Simple Bind
- **JWT admin auth** — Role-based admin access (`user`, `admin`, `superadmin`)
- **Audit logging** — Brotli-compressed JSONL logs per request, per day
- **React admin dashboard** — Full-featured SPA for managing channels, groups, users, tokens, prices, and vouchers
- **Streaming support** — SSE pass-through for streaming AI responses with usage tracking

## Design Highlights

### 1. Modern Development Efficiency (SQLModel + FastCRUD)
The backend uses **SQLModel**, combining SQLAlchemy's database capabilities with Pydantic's data validation. Paired with **FastCRUD**, boilerplate CRUD code is greatly reduced, letting developers focus on routing and quota logic.

### 2. Concurrency Optimized for AI Workloads (Asyncio + HTTPX)
- **Async proxy:** Uses **httpx** with FastAPI's native async support to efficiently handle large volumes of concurrent AI API requests without blocking.
- **Non-blocking audit logging:** An **asyncio queue (3-consumer pattern)** prevents log writes from becoming a bottleneck under high concurrency. Requests return immediately while **Brotli compression** and file writes happen asynchronously in the background.
- **Fire-and-forget post-processing:** Usage updates, balance deductions, rate limit counter increments, and log writes all run as background tasks after the response is returned.

### 3. Enterprise-grade Security (LDAP + RBAC)
- **Authentication:** LDAP/AD integration via **ldap3** plugs directly into existing Active Directory infrastructure — no user re-registration required.
- **Permission model:** JWT-based RBAC via **python-jose** with clear separation between `user`, `admin`, and `superadmin` roles.

### 4. Dual-mode Rate Limiting (DB Counter + Balance)
- **Group tokens:** Fixed-window counters (request count / token count / spend per window) stored in the main DB via atomic UPSERT — safe for multi-instance and serverless deployments, no Redis required.
- **Personal tokens:** Simple balance check against `User.quota_usd`. Fail-open on DB errors.

### 5. Frontend State and Performance (React 19 + Zustand + Arco Design)
Built with **React 19**, **Vite**, **Arco Design** UI components, and **Zustand** for lightweight global state management.

### 6. Storage and Archiving Design
- **Storage flexibility:** Supports seamless migration from lightweight **SQLite** to production-grade **PostgreSQL**.
- **Compressed archiving:** Logs sharded by day and request, compressed with **Brotli** for higher compression ratios than Gzip.

## Architecture

```
any_gateway/
├── gateway.py               # FastAPI app entry point, routing logic, request forwarding
├── constants.py             # Global constants (ports, limits)
├── log_writer.py            # Async JSONL logger (brotli, asyncio queue, 3 consumers)
├── admin/
│   └── router.py            # Admin endpoints: FastCRUD CRUD + custom business logic
├── db/
│   ├── models.py            # SQLModel data models
│   └── database.py          # Async SQLAlchemy engine
├── middleware/
│   └── auth.py              # API key middleware (validates token, quota, expiry, rate limits)
└── services/
    ├── auth_service.py      # JWT issuance/validation, role management, superadmin init
    ├── ldap_auth.py         # LDAP Simple Bind + emergency fallback key
    ├── quota.py             # Quota check and usage update
    ├── pricing.py           # Cost calculation (group-custom → global fallback × multiplier)
    ├── rate_limit_db.py     # DB fixed-window rate limiting (atomic UPSERT)
    └── rate_limit_service.py # Rate limit decision entry point

apps/react/src/
├── pages/                   # Login, Dashboard, ApiKeys, Chat, Channels, Groups,
│                            # Users, Prices, Vouchers, Logs
├── api/                     # Axios HTTP client modules
├── components/
│   ├── AuthGuard/           # Route protection
│   └── Layout/              # Navigation and main layout
├── router/                  # React Router configuration
└── store/                   # Zustand global state (user, JWT token)
```

## Authentication Layers

| Layer | Method | Scope |
|---|---|---|
| User login | LDAP Simple Bind / fallback key | Issues 24h JWT |
| Admin API | JWT Bearer or `x-admin-key` header | `/admin/*` endpoints |
| AI API calls | `x-api-key: sk-*` or `Authorization: Bearer sk-*` | `/v1/*` endpoints |

### Roles

- `user` — access own tokens (`/user/tokens/*`)
- `admin` — all management functions (`/admin/*`)
- `superadmin` — admin superset + user role management + unrestricted channel access

## Routing Strategy

1. Resolve user's group memberships, ordered by `priority` descending
2. Within the highest-priority group that supports the requested model, select a channel by weighted random
3. Superadmin and `_admin_fallback` bypass group routing and access all enabled channels

Model aliases are resolved via per-channel `model_mapping` (e.g., `{"gpt-4o": "claude-opus-4-5"}`).

## Rate Limiting

Two modes depending on token type:

| Token type | Method | Dimensions |
|---|---|---|
| Group token (has `group_id`) | DB fixed-window counter | requests / tokens / spend per window |
| Personal token (no `group_id`) | Balance check | `User.quota_usd` remaining |

Rate limit rules are configured per group via `/admin/rate-limits`. Counters live in the main database (table `rate_limit_counters`, atomic UPSERT, multi-instance safe); DB errors cause fail-open behavior.

## Prerequisites

- Python 3.12+
- Node.js 18+ (for frontend development)
- MySQL 8 (production, TDSQL-C serverless) / PostgreSQL (also supported) / SQLite (local dev, default)
- LDAP/AD server (or use the mock server for local development)

## Quick Start

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure environment

```bash
cp .env.example .env  # or set variables manually
```

Required environment variables:

```bash
ADMIN_KEY=<admin API key>
JWT_SECRET=<random secret for JWT signing>
ADMIN_FALLBACK_KEY=<emergency login password>
SUPERADMIN_USERNAME=<initial superadmin username>
```

Optional:

```bash
LDAP_SERVER_URL=ldap://dc.company.internal
LDAP_BASE_DN=DC=company,DC=internal
LDAP_DOMAIN=COMPANY
JWT_EXPIRE_HOURS=24
DATABASE_URL=sqlite+aiosqlite:///./data/gateway.db  # default; use mysql+aiomysql://... in production (TDSQL-C)
GATEWAY_PORT=8003
# Audit log storage: local (default, ./data/sessions) | cos (Tencent COS, for serverless/multi-instance)
LOG_STORAGE_BACKEND=local
COS_REGION= / COS_BUCKET= / COS_SECRET_ID= / COS_SECRET_KEY=
```

### 3. Run

```bash
uvicorn any_gateway.gateway:app --host 0.0.0.0 --port 8003 --reload
```

The admin dashboard is served at `http://localhost:8003`.

## Docker

```bash
# With mock LDAP server
docker-compose up

# Gateway + MySQL 8 (production-like, simulates TDSQL-C MySQL serverless)
docker compose --profile mysql up

# Gateway only
docker build -t any_gateway .
docker run -p 8003:8003 \
  -e ADMIN_KEY=your-key \
  -e JWT_SECRET=your-secret \
  -e ADMIN_FALLBACK_KEY=your-fallback \
  -v $(pwd)/data:/app/data \
  any_gateway
```

## Tencent Cloud Serverless Deployment (scale-to-zero)

The gateway is serverless-ready: no local state (DB / rate limiting / config all externalized), billing finalized synchronously before responses complete, audit logs shipped to COS. Idle compute cost is zero.

**Stack**: 云托管 CloudBase Run (container, scale to 0, native SSE) + TDSQL-C **MySQL 8.0** Serverless (auto-pause) + COS (audit logs). No Redis — rate limiting runs in MySQL (atomic `ON DUPLICATE KEY UPDATE` upserts).

> TDSQL-C purchase notes: character set `utf8mb4` (required), collation default `utf8mb4_0900_ai_ci` is fine; enable auto-pause and enable public network access temporarily for data migration, then disable it.

1. **Database**: create a TDSQL-C MySQL Serverless cluster (same region/VPC as CloudBase Run); migrate existing data:
   ```bash
   # 建表（幂等 DDL）
   DATABASE_URL='mysql+aiomysql://root:pass@外网地址:端口/gateway' python -c "import sys; sys.path.insert(0,'any_gateway'); import asyncio; from db.database import init_db; asyncio.run(init_db())"
   # 迁移数据（可重跑；PostgreSQL 目标同样支持）
   DATABASE_URL='mysql+aiomysql://root:pass@外网地址:端口/gateway' python scripts/migrate_db.py
   ```
2. **COS**: create a bucket for audit logs (optional lifecycle rule, e.g. 90d → infrequent access).
3. **云托管**: import the Docker image, listen on port 8003, min instances 0, graceful shutdown ≥ 30s, same VPC as the DB; enable public egress for upstream LLM APIs / LDAP.
4. **Environment**: `DATABASE_URL`, `LOG_STORAGE_BACKEND=cos`, `COS_REGION/COS_BUCKET/COS_SECRET_ID/COS_SECRET_KEY`, plus the usual `ADMIN_KEY` etc.
5. **Post-deploy checklist** (must verify on first deploy):
   - SSE long-stream timeout of the 云托管 gateway (raise platform-side or set min instances = 1 if it cuts long streams)
   - cold-start latency with DB auto-pause wake-up (container 2-5s + DB 1-2s)
   - billing survives instance scale-to-zero (UsageLog / balance / rate-limit counters must not lose rows)

## Frontend Development

```bash
cd apps/react
npm install
npm run dev   # dev server with proxy to :8003
npm run build # production build (output served by gateway)
npm run lint
```

## API Reference

### Health

```
GET /health
```

### AI (OpenAI-compatible)

```
POST /v1/chat/completions
POST /v1/messages          # Anthropic protocol
GET  /v1/models            # optional API key or JWT
```

Authenticate with `x-api-key: sk-*`, `Authorization: Bearer sk-*`, or `x-goog-api-key` (Gemini).

### Auth

```
POST /auth/login           # LDAP login → JWT
GET  /auth/me              # current user info (quota, usage)
```

### User (JWT required)

```
GET    /user/tokens              # list own tokens
POST   /user/tokens              # create token (returns plaintext key once)
DELETE /user/tokens/{id}         # delete token
POST   /user/tokens/{id}/freeze  # freeze token
PATCH  /user/tokens/{id}/freeze  # unfreeze token
GET    /user/logs                # usage logs (paginated, filterable)
GET    /user/logs/{id}/messages  # full request/response for a log entry
POST   /user/vouchers/redeem     # redeem voucher code
GET    /user/groups              # available groups (for token creation)
GET    /user/stats/overview      # today's spend and request count
GET    /user/stats/tokens        # top 10 tokens by spend
GET    /user/stats/models        # top 10 models by requests
```

### Admin (JWT or x-admin-key required)

```
/admin/channels                  # CRUD
/admin/groups                    # CRUD
/admin/users                     # CRUD
/admin/users/{username}/role     # role management (superadmin only)
/admin/rate-limits               # CRUD (per-group rate limit rules)
/admin/prices                    # CRUD (global model prices)
/admin/group-prices              # CRUD (per-group price overrides)
/admin/vouchers                  # CRUD (create and manage vouchers)
GET /admin/stats/overview        # global today's spend
GET /admin/stats/tokens          # global top 10 tokens
GET /admin/stats/models          # global top 10 models
```

## Audit Logs

Request/response pairs are logged asynchronously to:

```
data/sessions/{YYYY_MM_DD}/{request_id}.json.br
```

Each file is Brotli-compressed JSON. One file per request per day. A 3-consumer asyncio queue handles concurrent writes without file locking contention.

## Testing

```bash
# All tests
pytest tests/

# Single file
pytest tests/test_admin_router.py -v

# Single test
pytest tests/test_admin_router.py::test_create_token -v
```

Tests use SQLite in-memory databases and FastAPI's `TestClient`.

## Tech Stack

| Component | Technology |
|---|---|
| Backend framework | FastAPI |
| Database ORM | SQLModel + FastCRUD |
| Database | SQLite (default) / MySQL (TDSQL-C) / PostgreSQL |
| Authentication | ldap3, python-jose |
| Rate limiting | DB fixed-window counters (atomic UPSERT) |
| Audit logging | brotli + local files / Tencent COS |
| HTTP client | httpx |
| Frontend | React 19 + TypeScript + Vite |
| UI components | Arco Design |
| State management | Zustand |
| HTTP requests | axios |
