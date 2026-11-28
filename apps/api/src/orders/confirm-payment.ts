import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Queryable } from '../db/database.js';

export type PaymentMethod = 'cash' | 'codi_qr' | 'payment_link';

export interface ConfirmPaymentInput {
  tenantId: string;
  orderId: string;
  method: PaymentMethod;
  amountCents: number;
  currency: string;
  /** Null for cash. For provider payments: provider name and its unique reference. */
  provider?: string;
  providerReference?: string;
  /** User who recorded the payment; null when confirmed by a provider notification. */
  confirmedBy?: string;
}

/**
 * Marks a pending order as paid, records the payment and decrements stock, all in
 * the caller's transaction. Safe against double confirmation: the order row is
 * locked and must still be pending, and a partial unique index allows only one
 * confirmed payment per order.
 *
 * Reconciliation: amount and currency must match the order exactly. Provider
 * integrations (Pey/CoDi) must verify the notification's authenticity before
 * calling this.
 */
export async function confirmOrderPayment(q: Queryable, input: ConfirmPaymentInput) {
  const [order] = await q.query<{ status: string; total_cents: number; created_by: string }>(
    'SELECT status, total_cents, created_by FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [input.tenantId, input.orderId],
  );
  if (!order) throw new NotFoundException('Order not found');
  if (order.status !== 'pending') throw new ConflictException(`Order is already ${order.status}`);
  if (input.currency !== 'MXN' || input.amountCents !== order.total_cents) {
    throw new ConflictException('Payment amount or currency does not match the order');
  }

  const items = await q.query<{ product_id: string; product_name: string; quantity: number }>(
    'SELECT product_id, product_name, quantity FROM order_items WHERE tenant_id = $1 AND order_id = $2',
    [input.tenantId, input.orderId],
  );
  const needed = new Map<string, { name: string; quantity: number }>();
  for (const item of items) {
    const prev = needed.get(item.product_id);
    needed.set(item.product_id, { name: item.product_name, quantity: (prev?.quantity ?? 0) + item.quantity });
  }

  // Lock in a stable order to avoid deadlocks between concurrent confirmations.
  const stock = await q.query<{ id: string; stock: number }>(
    'SELECT id, stock FROM products WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE',
    [input.tenantId, [...needed.keys()]],
  );
  const available = new Map(stock.map((p) => [p.id, p.stock]));
  for (const [productId, { name, quantity }] of needed) {
    if ((available.get(productId) ?? 0) < quantity) {
      throw new ConflictException(`Insufficient stock for ${name}`);
    }
  }

  const movedBy = input.confirmedBy ?? order.created_by;
  for (const [productId, { quantity }] of needed) {
    await q.query('UPDATE products SET stock = stock - $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [
      input.tenantId,
      productId,
      quantity,
    ]);
    await q.query(
      `INSERT INTO stock_movements (tenant_id, product_id, delta, reason, order_id, created_by)
       VALUES ($1, $2, $3, 'sale', $4, $5)`,
      [input.tenantId, productId, -quantity, input.orderId, movedBy],
    );
  }

  const [payment] = await q.query(
    `INSERT INTO payments (tenant_id, order_id, method, status, amount_cents, currency, provider, provider_reference, created_by, confirmed_at)
     VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, now())
     RETURNING id, method, status, amount_cents AS "amountCents", currency, confirmed_at AS "confirmedAt"`,
    [
      input.tenantId,
      input.orderId,
      input.method,
      input.amountCents,
      input.currency,
      input.provider ?? null,
      input.providerReference ?? null,
      input.confirmedBy ?? null,
    ],
  );
  await q.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE tenant_id = $1 AND id = $2", [
    input.tenantId,
    input.orderId,
  ]);
  return payment;
}
