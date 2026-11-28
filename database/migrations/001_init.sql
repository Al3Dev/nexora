-- NEXORA initial schema.
-- Money is stored in integer centavos (MXN). Every business table carries tenant_id
-- and is protected by row level security (RLS) as defense in depth; the API also
-- checks membership and roles before every operation.
--
-- Request transactions run as the NOLOGIN role nexora_app (SET LOCAL ROLE) with
-- app.user_id / app.tenant_id set via set_config(..., true). Table owners and
-- superusers bypass RLS, so the API must never query business tables without
-- switching to nexora_app first.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexora_app') THEN
    CREATE ROLE nexora_app NOLOGIN;
  END IF;
  EXECUTE format('GRANT nexora_app TO %I', current_user);
END
$$;

CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  currency    char(3) NOT NULL DEFAULT 'MXN' CHECK (currency = 'MXN'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- user_id is the subject (sub) of the identity provider's JWT.
CREATE TABLE memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'cashier')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  sku         text CHECK (sku IS NULL OR length(sku) BETWEEN 1 AND 64),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  cost_cents  integer NOT NULL CHECK (cost_cents >= 0),
  stock       integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku)
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  total_cents      integer NOT NULL CHECK (total_cents >= 0),
  cost_cents       integer NOT NULL CHECK (cost_cents >= 0),
  idempotency_key  text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 128),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz,
  cancelled_at     timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX orders_tenant_paid_idx ON orders (tenant_id, paid_at) WHERE status = 'paid';

-- Price and cost are copied at order time so later catalog edits never rewrite history.
CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  order_id          uuid NOT NULL,
  product_id        uuid NOT NULL,
  product_name      text NOT NULL,
  quantity          integer NOT NULL CHECK (quantity > 0),
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  unit_cost_cents   integer NOT NULL CHECK (unit_cost_cents >= 0),
  line_total_cents  integer NOT NULL CHECK (line_total_cents = quantity * unit_price_cents),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX order_items_order_idx ON order_items (tenant_id, order_id);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  order_id            uuid NOT NULL,
  method              text NOT NULL CHECK (method IN ('cash', 'codi_qr', 'payment_link')),
  status              text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  amount_cents        integer NOT NULL CHECK (amount_cents >= 0),
  currency            char(3) NOT NULL DEFAULT 'MXN',
  provider            text,
  provider_reference  text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  UNIQUE (provider, provider_reference)
);
-- At most one confirmed payment per order.
CREATE UNIQUE INDEX payments_one_confirmed_per_order ON payments (tenant_id, order_id) WHERE status = 'confirmed';

CREATE TABLE stock_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  product_id  uuid NOT NULL,
  delta       integer NOT NULL CHECK (delta <> 0),
  reason      text NOT NULL CHECK (reason IN ('sale', 'restock', 'adjustment')),
  order_id    uuid,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id)
);

-- Row level security ---------------------------------------------------------

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_member_read ON tenants FOR SELECT TO nexora_app
  USING (id IN (SELECT tenant_id FROM memberships WHERE user_id = app_current_user()));

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
-- A user can see their own memberships (to pick a tenant) and the members of the active tenant.
CREATE POLICY memberships_read ON memberships FOR SELECT TO nexora_app
  USING (user_id = app_current_user() OR tenant_id = app_current_tenant());
CREATE POLICY memberships_write ON memberships FOR INSERT TO nexora_app
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY memberships_update ON memberships FOR UPDATE TO nexora_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products', 'orders', 'order_items', 'payments', 'stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO nexora_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- Creating a tenant is the only operation that happens before the caller has a
-- membership, so it goes through a narrowly scoped SECURITY DEFINER function.
CREATE FUNCTION create_tenant_with_owner(tenant_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := app_current_user();
  tid uuid;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'app.user_id is not set';
  END IF;
  INSERT INTO tenants (name) VALUES (tenant_name) RETURNING id INTO tid;
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (tid, uid, 'owner');
  RETURN tid;
END
$$;

-- Privileges: no DELETE anywhere; history is corrected with new rows, not erased.
GRANT USAGE ON SCHEMA public TO nexora_app;
GRANT SELECT ON tenants TO nexora_app;
GRANT SELECT, INSERT, UPDATE ON memberships, products, orders, order_items, payments, stock_movements TO nexora_app;
REVOKE ALL ON FUNCTION create_tenant_with_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_tenant_with_owner(text) TO nexora_app;
GRANT EXECUTE ON FUNCTION app_current_tenant(), app_current_user() TO nexora_app;
