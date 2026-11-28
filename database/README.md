# Database

PostgreSQL schema as plain SQL migrations in `migrations/`, applied in filename order by `apps/api` (`npm run migrate`, or automatically on start when using the embedded dev database). Applied files are recorded in `schema_migrations`; never edit an applied migration, add a new one.

## Model (`001_init.sql`)

- `tenants`, `memberships` (roles `owner` / `admin` / `cashier`; `user_id` is the identity provider's `sub`).
- `products`: price and cost in integer centavos, non-negative stock.
- `orders` → `order_items` (price, cost and name copied at order time), `payments`, `stock_movements`.
- Composite foreign keys `(tenant_id, id)` keep child rows in their parent's tenant.
- At most one confirmed payment per order; `(provider, provider_reference)` is unique so provider notifications can be deduplicated.

## Tenant isolation

Every business table has `FORCE ROW LEVEL SECURITY` with policies on `app_current_tenant()`. The API runs each request as the `nexora_app` role (`SET LOCAL ROLE`), which has no `DELETE` privilege. Creating a tenant goes through the `create_tenant_with_owner` `SECURITY DEFINER` function. The connecting role in `DATABASE_URL` must be able to `SET ROLE nexora_app`; the migration grants it.

Seed data is synthetic only (`apps/api/scripts/seed-demo.ts`).
