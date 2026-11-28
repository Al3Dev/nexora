import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import type { TenantAuthContext } from '../auth/auth.types.js';
import { Member, Roles } from '../auth/decorators.js';
import { toInt } from '../common/money.js';
import { zod } from '../common/zod-validation.pipe.js';
import { Database } from '../db/database.js';

const DAY_MS = 86_400_000;
const LOW_STOCK_THRESHOLD = 5;

const summarySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** Gross margin in basis points (1 bp = 0.01 %), or null when there are no sales. */
export function marginBps(salesCents: number, profitCents: number): number | null {
  return salesCents === 0 ? null : Math.round((profitCents * 10_000) / salesCents);
}

/**
 * Financial metrics over paid orders, using the price and cost captured at sale time.
 * Net sales = sum of paid order totals (prices are tax-inclusive; refunds are not yet modelled).
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Roles('owner', 'admin')
  @Get('summary')
  summary(@Member() m: TenantAuthContext, @Query(zod(summarySchema)) query: z.infer<typeof summarySchema>) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) throw new BadRequestException('"from" must be before "to"');
    if (to.getTime() - from.getTime() > 366 * DAY_MS) throw new BadRequestException('Window cannot exceed 366 days');

    return this.db.withContext(m, async (q) => {
      const params = [m.tenantId, from.toISOString(), to.toISOString()];
      const paidInWindow = `o.tenant_id = $1 AND o.status = 'paid' AND o.paid_at >= $2 AND o.paid_at < $3`;

      const [totals] = await q.query(
        `SELECT count(*) AS orders, coalesce(sum(o.total_cents), 0) AS sales, coalesce(sum(o.cost_cents), 0) AS cogs
           FROM orders o WHERE ${paidInWindow}`,
        params,
      );
      const byProduct = await q.query(
        `SELECT i.product_id AS "productId", i.product_name AS name, sum(i.quantity) AS units,
                sum(i.line_total_cents) AS sales, sum(i.quantity * i.unit_cost_cents) AS cogs
           FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
          WHERE ${paidInWindow}
          GROUP BY i.product_id, i.product_name ORDER BY sales DESC`,
        params,
      );
      const byMethod = await q.query(
        `SELECT p.method, count(*) AS payments, sum(p.amount_cents) AS amount
           FROM payments p JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
          WHERE ${paidInWindow} AND p.status = 'confirmed'
          GROUP BY p.method ORDER BY amount DESC`,
        params,
      );
      const lowStock = await q.query(
        `SELECT id, name, stock FROM products WHERE tenant_id = $1 AND active AND stock <= $2 ORDER BY stock, name`,
        [m.tenantId, LOW_STOCK_THRESHOLD],
      );

      const sales = toInt(totals!.sales);
      const cogs = toInt(totals!.cogs);
      return {
        currency: 'MXN',
        window: { from: from.toISOString(), to: to.toISOString() },
        orders: toInt(totals!.orders),
        netSalesCents: sales,
        cogsCents: cogs,
        grossProfitCents: sales - cogs,
        grossMarginBps: marginBps(sales, sales - cogs),
        byProduct: byProduct.map((r) => {
          const s = toInt(r.sales);
          const c = toInt(r.cogs);
          return {
            productId: r.productId,
            name: r.name,
            units: toInt(r.units),
            salesCents: s,
            grossProfitCents: s - c,
            grossMarginBps: marginBps(s, s - c),
          };
        }),
        byPaymentMethod: byMethod.map((r) => ({ method: r.method, payments: toInt(r.payments), amountCents: toInt(r.amount) })),
        lowStock,
      };
    });
  }
}
