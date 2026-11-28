import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marginBps } from '../src/metrics/metrics.controller.js';
import { addMember, createProduct, ownerWithTenant, setup, type Actor, type TestEnv } from './helpers.js';

let env: TestEnv;
let tenantId: string;
let owner: Actor;
let cashier: Actor;
let latte: { id: string };
let pan: { id: string };

beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  ({ tenantId, owner } = await ownerWithTenant(env, 'Café Demo'));
  cashier = await addMember(env, owner, tenantId, 'cashier');
  latte = await createProduct(env, owner, { name: 'Latte', priceCents: 6500, costCents: 2000, stock: 10 });
  pan = await createProduct(env, owner, { name: 'Pan', priceCents: 4500, costCents: 1700, stock: 2 });
});

const stockOf = async (id: string) => {
  const res = await env.http.get('/products').set(owner.headers).expect(200);
  return (res.body as { id: string; stock: number }[]).find((p) => p.id === id)!.stock;
};

describe('orders', () => {
  it('computes totals from catalog prices and ignores client-sent prices', async () => {
    await env.http
      .post('/orders')
      .set(cashier.headers)
      .send({ items: [{ productId: latte.id, quantity: 2, priceCents: 1 }] })
      .expect(400); // unknown field rejected (strict schema)

    const res = await env.http
      .post('/orders')
      .set(cashier.headers)
      .send({ items: [{ productId: latte.id, quantity: 2 }, { productId: pan.id, quantity: 1 }, { productId: latte.id, quantity: 1 }] })
      .expect(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.totalCents).toBe(3 * 6500 + 4500);
    expect(res.body.items).toHaveLength(2); // duplicate lines merged
  });

  it('rejects invalid quantities and empty orders', async () => {
    for (const items of [[], [{ productId: latte.id, quantity: 0 }], [{ productId: latte.id, quantity: 1.5 }], [{ productId: 'x', quantity: 1 }]]) {
      await env.http.post('/orders').set(cashier.headers).send({ items }).expect(400);
    }
  });

  it('returns the same order for a repeated idempotency key', async () => {
    const body = { items: [{ productId: latte.id, quantity: 1 }], idempotencyKey: randomUUID() };
    const first = await env.http.post('/orders').set(cashier.headers).send(body).expect(201);
    const second = await env.http.post('/orders').set(cashier.headers).send(body).expect(201);
    expect(second.body.id).toBe(first.body.id);
    const all = await env.http.get('/orders').set(owner.headers).expect(200);
    expect(all.body).toHaveLength(1);
  });

  it('does not touch stock until the order is paid', async () => {
    await env.http.post('/orders').set(cashier.headers).send({ items: [{ productId: latte.id, quantity: 3 }] }).expect(201);
    expect(await stockOf(latte.id)).toBe(10);
  });
});

describe('cash payment', () => {
  it('confirms the order, decrements stock, records movements and returns change', async () => {
    const order = await env.http.post('/orders').set(cashier.headers).send({ items: [{ productId: latte.id, quantity: 3 }] }).expect(201);
    const paid = await env.http
      .post(`/orders/${order.body.id}/cash-payment`)
      .set(cashier.headers)
      .send({ amountReceivedCents: 20000 })
      .expect(200);

    expect(paid.body.order.status).toBe('paid');
    expect(paid.body.payment).toMatchObject({ method: 'cash', status: 'confirmed', amountCents: 19500, currency: 'MXN' });
    expect(paid.body.changeCents).toBe(500);
    expect(await stockOf(latte.id)).toBe(7);

    const movements = await env.db.withContext({ userId: owner.userId, tenantId }, (q) =>
      q.query<{ delta: number; reason: string }>('SELECT delta, reason FROM stock_movements WHERE order_id = $1', [order.body.id]),
    );
    expect(movements).toEqual([{ delta: -3, reason: 'sale' }]);
  });

  it('refuses to confirm the same order twice (no double stock decrement)', async () => {
    const order = await env.http.post('/orders').set(cashier.headers).send({ items: [{ productId: latte.id, quantity: 1 }] }).expect(201);
    await env.http.post(`/orders/${order.body.id}/cash-payment`).set(cashier.headers).send({}).expect(200);
    await env.http.post(`/orders/${order.body.id}/cash-payment`).set(cashier.headers).send({}).expect(409);
    expect(await stockOf(latte.id)).toBe(9);
  });

  it('rejects insufficient cash and insufficient stock without side effects', async () => {
    const order = await env.http.post('/orders').set(cashier.headers).send({ items: [{ productId: pan.id, quantity: 3 }] }).expect(201);
    await env.http.post(`/orders/${order.body.id}/cash-payment`).set(cashier.headers).send({ amountReceivedCents: 100 }).expect(400);
    await env.http.post(`/orders/${order.body.id}/cash-payment`).set(cashier.headers).send({}).expect(409);

    const after = await env.http.get(`/orders/${order.body.id}`).set(cashier.headers).expect(200);
    expect(after.body.status).toBe('pending');
    expect(after.body.payments).toEqual([]);
    expect(await stockOf(pan.id)).toBe(2);
  });

  it('cannot pay a cancelled order; cashiers cannot cancel', async () => {
    const order = await env.http.post('/orders').set(cashier.headers).send({ items: [{ productId: latte.id, quantity: 1 }] }).expect(201);
    await env.http.post(`/orders/${order.body.id}/cancel`).set(cashier.headers).expect(403);
    await env.http.post(`/orders/${order.body.id}/cancel`).set(owner.headers).expect(200);
    await env.http.post(`/orders/${order.body.id}/cash-payment`).set(cashier.headers).send({}).expect(409);
  });
});

describe('inventory', () => {
  it('restocks with a movement and refuses negative stock', async () => {
    const res = await env.http.post(`/products/${pan.id}/stock`).set(owner.headers).send({ delta: 5, reason: 'restock' }).expect(201);
    expect(res.body.stock).toBe(7);
    await env.http.post(`/products/${pan.id}/stock`).set(owner.headers).send({ delta: -8, reason: 'adjustment' }).expect(409);
    await env.http.post(`/products/${pan.id}/stock`).set(owner.headers).send({ delta: 0, reason: 'restock' }).expect(400);
  });

  it('rejects negative or fractional prices', async () => {
    await env.http.post('/products').set(owner.headers).send({ name: 'X', priceCents: -1, costCents: 0 }).expect(400);
    await env.http.post('/products').set(owner.headers).send({ name: 'X', priceCents: 10.5, costCents: 0 }).expect(400);
  });
});

describe('metrics', () => {
  it('reports net sales, COGS, gross profit and margin from paid orders only', async () => {
    const paidOrder = await env.http
      .post('/orders')
      .set(cashier.headers)
      .send({ items: [{ productId: latte.id, quantity: 2 }, { productId: pan.id, quantity: 1 }] })
      .expect(201);
    await env.http.post(`/orders/${paidOrder.body.id}/cash-payment`).set(cashier.headers).send({}).expect(200);
    await env.http.post('/orders').set(cashier.headers).send({ items: [{ productId: latte.id, quantity: 5 }] }).expect(201); // stays pending

    // Changing the catalog cost afterwards must not rewrite historic profit.
    await env.http.patch(`/products/${latte.id}`).set(owner.headers).send({ costCents: 6000 }).expect(200);

    const res = await env.http.get('/metrics/summary').set(owner.headers).expect(200);
    const sales = 2 * 6500 + 4500; // 17,500
    const cogs = 2 * 2000 + 1700; // 5,700
    expect(res.body).toMatchObject({
      currency: 'MXN',
      orders: 1,
      netSalesCents: sales,
      cogsCents: cogs,
      grossProfitCents: sales - cogs,
      grossMarginBps: marginBps(sales, sales - cogs), // 6743 = 67.43 %
      byPaymentMethod: [{ method: 'cash', payments: 1, amountCents: sales }],
    });
    expect(res.body.grossMarginBps).toBe(6743);
    expect(res.body.byProduct[0]).toMatchObject({ name: 'Latte', units: 2, salesCents: 13000, grossProfitCents: 9000 });
    expect(res.body.lowStock).toEqual([{ id: pan.id, name: 'Pan', stock: 1 }]);
  });

  it('is restricted to owners and admins and validates the window', async () => {
    await env.http.get('/metrics/summary').set(cashier.headers).expect(403);
    await env.http.get('/metrics/summary?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z').set(owner.headers).expect(400);
    await env.http.get('/metrics/summary?from=yesterday').set(owner.headers).expect(400);
  });

  it('reports a null margin when there are no sales', async () => {
    const res = await env.http.get('/metrics/summary').set(owner.headers).expect(200);
    expect(res.body).toMatchObject({ orders: 0, netSalesCents: 0, grossMarginBps: null });
  });
});
