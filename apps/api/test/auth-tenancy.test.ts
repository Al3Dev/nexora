import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actor, addMember, createProduct, ownerWithTenant, setup, token, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

describe('authentication', () => {
  it('serves /health without a token', async () => {
    await env.http.get('/health').expect(200, { status: 'ok' });
  });

  it('rejects requests without a bearer token', async () => {
    await env.http.get('/me').expect(401);
  });

  it('rejects tokens signed with another secret', async () => {
    const forged = await token(randomUUID(), 'another-secret-that-is-at-least-32-chars!!');
    await env.http.get('/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('rejects expired tokens', async () => {
    const expired = await token(randomUUID(), undefined, '-1m');
    await env.http.get('/me').set('Authorization', `Bearer ${expired}`).expect(401);
  });

  it('rejects tokens whose subject is not a uuid', async () => {
    const bad = await token('not-a-uuid');
    await env.http.get('/me').set('Authorization', `Bearer ${bad}`).expect(401);
  });
});

describe('tenants and roles', () => {
  it('makes the creator the owner and lists the tenant in /me', async () => {
    const { tenantId, owner } = await ownerWithTenant(env, 'Café Uno');
    const me = await env.http.get('/me').set(owner.headers).expect(200);
    expect(me.body.tenants).toEqual([{ id: tenantId, name: 'Café Uno', currency: 'MXN', role: 'owner' }]);
  });

  it('requires the X-Tenant-Id header on tenant routes', async () => {
    const user = await actor();
    await env.http.get('/products').set(user.headers).expect(403);
  });

  it('lets a cashier read products but not create them', async () => {
    const { tenantId, owner } = await ownerWithTenant(env);
    const cashier = await addMember(env, owner, tenantId, 'cashier');
    await env.http.get('/products').set(cashier.headers).expect(200);
    await env.http.post('/products').set(cashier.headers).send({ name: 'X', priceCents: 100, costCents: 50 }).expect(403);
  });

  it('only lets the owner manage members and never demotes the owner', async () => {
    const { tenantId, owner } = await ownerWithTenant(env);
    const admin = await addMember(env, owner, tenantId, 'admin');
    await env.http.put('/members').set(admin.headers).send({ userId: randomUUID(), role: 'admin' }).expect(403);
    await env.http.put('/members').set(owner.headers).send({ userId: owner.userId, role: 'cashier' }).expect(409);
  });
});

describe('cross-tenant isolation', () => {
  it('denies access to a tenant the caller does not belong to', async () => {
    const a = await ownerWithTenant(env, 'A');
    const b = await ownerWithTenant(env, 'B');
    const intruder = { ...b.owner, headers: { ...b.owner.headers, 'X-Tenant-Id': a.tenantId } };
    await env.http.get('/products').set(intruder.headers).expect(403);
  });

  it("returns 404 for another tenant's product id and never lists it", async () => {
    const a = await ownerWithTenant(env, 'A');
    const b = await ownerWithTenant(env, 'B');
    const product = await createProduct(env, a.owner, { name: 'Secreto', priceCents: 1000, costCents: 400, stock: 3 });

    await env.http.patch(`/products/${product.id}`).set(b.owner.headers).send({ priceCents: 1 }).expect(404);
    await env.http.post(`/products/${product.id}/stock`).set(b.owner.headers).send({ delta: 5, reason: 'restock' }).expect(404);
    const listB = await env.http.get('/products').set(b.owner.headers).expect(200);
    expect(listB.body).toEqual([]);
    await env.http.post('/orders').set(b.owner.headers).send({ items: [{ productId: product.id, quantity: 1 }] }).expect(400);
  });

  it('enforces row level security in the database even if the API forgot a tenant filter', async () => {
    const a = await ownerWithTenant(env, 'A');
    const b = await ownerWithTenant(env, 'B');
    await createProduct(env, a.owner, { name: 'Solo A', priceCents: 1000, costCents: 400 });

    // Deliberately unfiltered query, run as tenant B through the app role.
    const rows = await env.db.withContext({ userId: b.owner.userId, tenantId: b.tenantId }, (q) =>
      q.query<{ name: string }>('SELECT name FROM products'),
    );
    expect(rows.map((r) => r.name)).not.toContain('Solo A');

    // Writing a row for another tenant is rejected by the policy's WITH CHECK.
    await expect(
      env.db.withContext({ userId: b.owner.userId, tenantId: b.tenantId }, (q) =>
        q.query("INSERT INTO products (tenant_id, name, price_cents, cost_cents) VALUES ($1, 'Inyectado', 1, 1)", [a.tenantId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('gives the app role no DELETE privilege', async () => {
    const a = await ownerWithTenant(env, 'A');
    await expect(
      env.db.withContext({ userId: a.owner.userId, tenantId: a.tenantId }, (q) => q.query('DELETE FROM products')),
    ).rejects.toThrow(/permission denied/);
  });
});
