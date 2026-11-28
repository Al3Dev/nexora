# NEXORA API

Modular NestJS 12 backend (ESM, TypeScript strict) over PostgreSQL. Money is always integer centavos (MXN).

## Run locally

Requires Node.js 22+. Without `DATABASE_URL` the API uses an embedded PostgreSQL (PGlite, WASM) stored in `./.data/pglite` and applies migrations on start, so no database server is needed for development.

```bash
cd apps/api
npm install
export AUTH_JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

TOKEN=$(npm run -s dev-token)          # prints a dev token; the user id goes to stderr
npm run seed -- <user-id-from-above>   # creates the synthetic "Café Demo" tenant
npm run dev                            # http://localhost:3000
```

Stop the dev server before running `seed` again: PGlite allows only one process per data directory.

With a real PostgreSQL server, set `DATABASE_URL` and run `npm run migrate` before `npm start`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch mode with tsx |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm test` | Integration tests (Vitest + Supertest) against in-memory PostgreSQL |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Apply `database/migrations/*.sql` |
| `npm run seed -- <uuid>` | Synthetic demo tenant (refuses to run in production) |
| `npm run dev-token -- [uuid]` | Local-only HS256 token (refuses to run in production) |

## Authentication and tenancy

Every route except `GET /health` needs `Authorization: Bearer <jwt>`. Tokens are HS256, verified with `AUTH_JWT_SECRET` (optionally `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE`). `sub` must be a UUID: this matches Supabase Auth's access tokens, the planned identity provider. **Sign-up/login is not implemented here yet**; for development, `dev-token` mints tokens.

Tenant routes also need `X-Tenant-Id`. The global `AuthGuard` checks membership and role on every request. Each request runs in one transaction as the `nexora_app` role with `app.user_id` / `app.tenant_id` set, so PostgreSQL row level security isolates tenants even if a query forgets its `tenant_id` filter.

Roles: `owner` (everything, manages members), `admin` (catalog, inventory, cancellations, metrics), `cashier` (sees products, creates and charges orders).

## Endpoints

| Method | Path | Roles | Description |
| --- | --- | --- | --- |
| GET | `/health` | public | Database liveness |
| GET | `/me` | any user | Tenants and roles of the caller |
| POST | `/tenants` | any user | Create a tenant; caller becomes owner |
| GET | `/members` | owner, admin | Members of the tenant |
| PUT | `/members` | owner | Add a member or change role (`admin`/`cashier`) |
| GET | `/products` | member | Catalog with stock |
| POST | `/products` | owner, admin | Create a product (`priceCents`, `costCents`, `stock`) |
| PATCH | `/products/:id` | owner, admin | Edit name, SKU, price, cost or active flag |
| POST | `/products/:id/stock` | owner, admin | Restock/adjust (`delta`, `reason`); recorded as a movement |
| POST | `/orders` | member | Create a pending order; prices come from the catalog. Optional `idempotencyKey` |
| GET | `/orders`, `/orders/:id` | member | Orders with items and payments |
| POST | `/orders/:id/cash-payment` | member | Record cash; atomically confirms, decrements stock, returns change |
| POST | `/orders/:id/cancel` | owner, admin | Cancel a pending order |
| GET | `/metrics/summary?from&to` | owner, admin | Net sales, COGS, gross profit, margin (basis points), by product and method, low stock |

## Payments

`src/orders/confirm-payment.ts` is the only place an order becomes paid: it locks the order, reconciles amount and currency, checks and decrements stock, writes stock movements and the payment in the caller's transaction. Cash uses it today. The Pey/CoDi webhook must verify the notification with the provider's documented mechanism and then call this function. **No Pey/CoDi integration exists yet.**

## Known limitations

- No sign-up/login, MFA or session revocation yet (identity provider pending).
- No rate limiting or security headers middleware yet.
- No refunds, taxes breakdown, discounts or customers (CRM) yet.
- Stock is checked at payment time, not reserved when an order is created.
- Tests run on PGlite (PostgreSQL 17 in WASM); run them against a PostgreSQL server too before production.
