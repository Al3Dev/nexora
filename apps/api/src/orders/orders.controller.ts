import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import type { TenantAuthContext } from '../auth/auth.types.js';
import { Member, Roles } from '../auth/decorators.js';
import { MAX_INT4, MAX_UNIT_CENTS } from '../common/money.js';
import { zod } from '../common/zod-validation.pipe.js';
import { Database, type Queryable } from '../db/database.js';
import { confirmOrderPayment } from './confirm-payment.js';

const createSchema = z
  .object({
    items: z
      .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(1000) }).strict())
      .min(1)
      .max(100),
    /** Client-generated key so a retried request does not create a second order. */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

const cashSchema = z
  .object({
    /** Cash handed over by the customer, to compute change. Defaults to the exact total. */
    amountReceivedCents: z.number().int().min(0).max(MAX_UNIT_CENTS).optional(),
  })
  .strict();

const listSchema = z.object({ status: z.enum(['pending', 'paid', 'cancelled']).optional() });

const ORDER_COLUMNS = `id, status, total_cents AS "totalCents", created_by AS "createdBy",
  created_at AS "createdAt", paid_at AS "paidAt", cancelled_at AS "cancelledAt"`;

@Controller('orders')
export class OrdersController {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Create a pending order. Prices and costs always come from the catalog, never from the client. */
  @Post()
  create(@Member() m: TenantAuthContext, @Body(zod(createSchema)) body: z.infer<typeof createSchema>) {
    return this.db.withContext(m, async (q) => {
      if (body.idempotencyKey) {
        const [existing] = await q.query<{ id: string }>(
          'SELECT id FROM orders WHERE tenant_id = $1 AND idempotency_key = $2',
          [m.tenantId, body.idempotencyKey],
        );
        if (existing) return this.load(q, m.tenantId, existing.id);
      }

      const quantities = new Map<string, number>();
      for (const item of body.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);

      const products = await q.query<{ id: string; name: string; price_cents: number; cost_cents: number }>(
        'SELECT id, name, price_cents, cost_cents FROM products WHERE tenant_id = $1 AND active AND id = ANY($2::uuid[])',
        [m.tenantId, [...quantities.keys()]],
      );
      if (products.length !== quantities.size) throw new BadRequestException('Unknown or inactive product in order');

      let total = 0;
      let cost = 0;
      const lines = products.map((p) => {
        const quantity = quantities.get(p.id)!;
        const lineTotal = quantity * p.price_cents;
        total += lineTotal;
        cost += quantity * p.cost_cents;
        return { ...p, quantity, lineTotal };
      });
      if (total > MAX_INT4 || cost > MAX_INT4) throw new BadRequestException('Order total is too large');

      const [order] = await q.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, total_cents, cost_cents, idempotency_key, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [m.tenantId, total, cost, body.idempotencyKey ?? null, m.userId],
      );
      for (const line of lines) {
        await q.query(
          `INSERT INTO order_items (tenant_id, order_id, product_id, product_name, quantity, unit_price_cents, unit_cost_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [m.tenantId, order!.id, line.id, line.name, line.quantity, line.price_cents, line.cost_cents, line.lineTotal],
        );
      }
      return this.load(q, m.tenantId, order!.id);
    });
  }

  @Get()
  list(@Member() m: TenantAuthContext, @Query(zod(listSchema)) query: z.infer<typeof listSchema>) {
    return this.db.withContext(m, (q) =>
      q.query(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC LIMIT 100`,
        [m.tenantId, query.status ?? null],
      ),
    );
  }

  @Get(':id')
  get(@Member() m: TenantAuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(m, (q) => this.load(q, m.tenantId, id));
  }

  /** Record a cash payment at the counter. Confirms the order and decrements stock atomically. */
  @Post(':id/cash-payment')
  @HttpCode(200)
  payCash(
    @Member() m: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(cashSchema)) body: z.infer<typeof cashSchema>,
  ) {
    return this.db.withContext(m, async (q) => {
      const order = await this.load(q, m.tenantId, id);
      const received = body.amountReceivedCents ?? order.totalCents;
      if (received < order.totalCents) throw new BadRequestException('Amount received is less than the order total');
      const payment = await confirmOrderPayment(q, {
        tenantId: m.tenantId,
        orderId: id,
        method: 'cash',
        amountCents: order.totalCents,
        currency: 'MXN',
        confirmedBy: m.userId,
      });
      return { order: await this.load(q, m.tenantId, id), payment, changeCents: received - order.totalCents };
    });
  }

  @Roles('owner', 'admin')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Member() m: TenantAuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withContext(m, async (q) => {
      const rows = await q.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
        [m.tenantId, id],
      );
      if (rows.length === 0) {
        await this.load(q, m.tenantId, id); // 404 if it does not exist
        throw new ConflictException('Only pending orders can be cancelled');
      }
      return this.load(q, m.tenantId, id);
    });
  }

  private async load(q: Queryable, tenantId: string, id: string) {
    const [order] = await q.query<{ id: string; totalCents: number }>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    if (!order) throw new NotFoundException('Order not found');
    const items = await q.query(
      `SELECT product_id AS "productId", product_name AS "productName", quantity,
              unit_price_cents AS "unitPriceCents", line_total_cents AS "lineTotalCents"
         FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY product_name`,
      [tenantId, id],
    );
    const payments = await q.query(
      `SELECT id, method, status, amount_cents AS "amountCents", currency, confirmed_at AS "confirmedAt"
         FROM payments WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at`,
      [tenantId, id],
    );
    return { ...order, items, payments };
  }
}
