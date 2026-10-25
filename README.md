# Frozen Shake Cash Tracker

A daily cash book for running several milkshake shops. For each shop you record
one revenue total per day, the day's expenses, and cash handed to partners. The
app shows **cash in hand = revenue − expenses − handovers**.

It's an installable PWA that works offline, backed by a Go API and PostgreSQL.

```
React PWA (Vite + React Router, TypeScript)   Today · History · Partners · Settings
   │  service worker: app shell + cached reads · offline write queue (src/sync.ts)
   ▼
Go REST API (net/http, pgx)                   auth · shop isolation · validation
   ▼
PostgreSQL                                    NUMERIC money · per-shop constraints
```

## Quick start (Docker)

```bash
cp .env.example .env        # optional; defaults work for local use
docker compose up --build
```

Open <http://localhost:8080> and create an account. Your first shop starts with
the default categories and partners already set up.

Password-reset emails go out over SMTP when `SMTP_HOST` is set. Without it, the
reset link is printed to the API log: `docker compose logs api | grep reset`.

## Local development

Requirements: Go 1.26+, Node 22+, Docker (for Postgres).

```bash
# 1. Database
docker run -d --name fs-dev-db -p 55433:5432 \
  -e POSTGRES_USER=frozen -e POSTGRES_PASSWORD=frozen -e POSTGRES_DB=frozen postgres:17-alpine

# 2. API on :8080 (migrations run automatically at startup)
cd backend
DATABASE_URL='postgres://frozen:frozen@localhost:55433/frozen?sslmode=disable' go run .

# 3. Web on :5173 (proxies /api to :8080)
cd frontend
npm install
npm run dev
```

The service worker only registers in production builds. To test offline mode
locally, use `npm run build && npm run preview`, which serves on :4173 and
proxies `/api` the same way.

### Tests

```bash
# Backend integration tests: tenant isolation, cash math, idempotent replay, auth.
# They DROP the public schema of the target DB, so use a throwaway database.
docker exec fs-dev-db psql -U frozen -c 'CREATE DATABASE frozen_test'
cd backend
TEST_DATABASE_URL='postgres://frozen:frozen@localhost:55433/frozen_test?sslmode=disable' go test ./...

# Frontend unit tests: paise math, timezone dates
cd frontend && npm test
```

## Configuration (API)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://frozen:frozen@localhost:55433/frozen?sslmode=disable` | |
| `ADDR` | `:8080` | Listen address |
| `APP_URL` | `http://localhost:5173` | Public app URL, used in reset links |
| `COOKIE_SECURE` | `false` | Set to `true` behind HTTPS |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | – | Password-reset email |

## Production deployment

Free deployment guides:
- [docs/DEPLOY.md](docs/DEPLOY.md): Render + Neon. No card needed. Uses the
  root `Dockerfile`, where one container serves the API and the PWA, together
  with `render.yaml`.
- [docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md): your own always-on VM (Oracle
  Always Free) with Docker Compose + Caddy.

`web` is nginx. It serves the built PWA, proxies `/api` to the `api` service on
the same origin, sends security headers and a CSP, and stops `sw.js` and the
manifest from being cached so updates roll out. `docker-compose.prod.yml` adds
Caddy in front for automatic HTTPS.

## How it works

**Multi-shop isolation.** Every `/api/shops/{shopId}/…` request first goes
through one membership check (`backend/shops.go` → `shop()`). Another user's
shop id returns 404. Each query is then scoped by `shop_id`. Composite foreign
keys `(shop_id, category_id)` and `(shop_id, partner_id)` make cross-shop
references impossible at the database level. `TestTenantIsolation` covers this.

**Money and dates.** Amounts are validated as decimal strings and stored as
`NUMERIC(12,2)`. The client does its math in integer paise. Business dates are
plain `DATE` values. "Today" is computed in the shop's timezone (Asia/Kolkata
by default) and never derived from UTC.

**History survives renames.** Each expense and handover stores a copy of the
category or partner name it was recorded with. Categories and partners are only
ever deactivated, never deleted.

**Offline.**
- The service worker (`frontend/public/sw.js`) precaches the app shell and
  serves API reads network-first with a cache fallback, so screens you've opened
  before stay readable offline.
- Every write goes through a local queue (`frontend/src/sync.ts`) stored on the
  device. The queue shows pending changes immediately and replays them in order
  when the connection returns.
- Replays are idempotent: client UUIDs act as idempotency keys, revenue is an
  upsert, and deletes are idempotent. Retrying never creates duplicates.
- Changes the server rejects stay on the device and are marked **Not saved**,
  so you can retry or discard them. Nothing is dropped silently.

API reference: [docs/API.md](docs/API.md).

## Project layout

```
backend/            Go API
  main.go           config, migrations runner, routes
  auth.go           register/login/logout/reset, sessions
  shops.go          shop CRUD + tenant middleware + default seeds
  records.go        revenue, expenses, handovers, categories, partners, history
  httpx.go          JSON/errors/validation helpers
  migrations/       SQL migrations (embedded)
  api_test.go       integration tests
frontend/           React PWA
  public/           manifest, service worker, icons
  src/pages/        Today, History, Partners, Settings, auth screens
  src/sync.ts       offline queue
  src/lib.ts        money/date helpers (+ lib.test.ts)
docker-compose.yml  db + api + web
```
