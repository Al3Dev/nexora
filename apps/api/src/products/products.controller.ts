import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { TenantAuthContext } from '../auth/auth.types.js';
import { Member, Roles } from '../auth/decorators.js';
import { centsSchema } from '../common/money.js';
import { zod } from '../common/zod-validation.pipe.js';
import { Database } from '../db/database.js';

const PRODUCT_COLUMNS = `id, sku, name, price_cents AS "priceCents", cost_cents AS "costCents", stock, active,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const createSchema = z.object({
  sku: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120),
  priceCents: centsSchema,
  costCents: centsSchema,
  stock: z.number().int().min(0).max(1_000_000).default(0),
});

const updateSchema = z
  .object({
    sku: z.string().trim().min(1).max(64).nullable(),
    name: z.string().trim().min(1).max(120),
    priceCents: centsSchema,
    costCents: centsSchema,
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

const stockSchema = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((d) => d !== 0, 'delta cannot be 0'),
  reason: z.enum(['restock', 'adjustment']),
});

const COLUMN_FOR: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  priceCents: 'price_cents',
  costCents: 'cost_cents',
  active: 'active',
};

@Controller('products')
export class ProductsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get()
  list(@Member() m: TenantAuthContext) {
    return this.db.withContext(m, (q) =>
      q.query(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE tenant_id = $1 ORDER BY name`, [m.tenantId]),
    );
  }

  @Roles('owner', 'admin')
  @Post()
  create(@Member() m: TenantAuthContext, @Body(zod(createSchema)) body: z.infer<typeof createSchema>) {
    return this.db.withContext(m, async (q) => {
      const [product] = await q.query<{ id: string }>(
        `INSERT INTO products (tenant_id, sku, name, price_cents, cost_cents, stock)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PRODUCT_COLUMNS}`,
        [m.tenantId, body.sku ?? null, body.name, body.priceCents, body.costCents, body.stock],
      );
      if (body.stock > 0) {
        await q.query(
          `INSERT INTO stock_movements (tenant_id, product_id, delta, reason, created_by) VALUES ($1, $2, $3, 'restock', $4)`,
          [m.tenantId, product!.id, body.stock, m.userId],
        );
      }
      return product;
    });
  }

  @Roles('owner', 'admin')
  @Patch(':id')
  async update(
    @Member() m: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    // Column names come from a fixed allow-list; values are always parameters.
    const entries = Object.entries(body);
    const sets = entries.map(([key], i) => `${COLUMN_FOR[key]} = $${i + 3}`);
    const rows = await this.db.withContext(m, (q) =>
      q.query(
        `UPDATE products SET ${sets.join(', ')}, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING ${PRODUCT_COLUMNS}`,
        [m.tenantId, id, ...entries.map(([, v]) => v)],
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Product not found');
    return rows[0];
  }

  /** Restock or adjust inventory; every change is recorded as a stock movement. */
  @Roles('owner', 'admin')
  @Post(':id/stock')
  adjustStock(
    @Member() m: TenantAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zod(stockSchema)) body: z.infer<typeof stockSchema>,
  ) {
    return this.db.withContext(m, async (q) => {
      const [current] = await q.query<{ stock: number }>(
        'SELECT stock FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [m.tenantId, id],
      );
      if (!current) throw new NotFoundException('Product not found');
      if (current.stock + body.delta < 0) throw new ConflictException('Stock cannot become negative');
      const [product] = await q.query(
        `UPDATE products SET stock = stock + $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING ${PRODUCT_COLUMNS}`,
        [m.tenantId, id, body.delta],
      );
      await q.query(
        'INSERT INTO stock_movements (tenant_id, product_id, delta, reason, created_by) VALUES ($1, $2, $3, $4, $5)',
        [m.tenantId, id, body.delta, body.reason, m.userId],
      );
      return product;
    });
  }
}
