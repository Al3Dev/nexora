// Creates the synthetic "Café Demo" tenant owned by the given user, with the same
// catalog the web demo shows. Synthetic data only.
//
//   npm run seed -- <owner-user-uuid>
import { z } from 'zod';
import { createDatabase } from '../src/db/create-database.js';
import { migrate } from '../src/db/migrate.js';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-demo is disabled when NODE_ENV=production');
  process.exit(1);
}
const owner = z.uuid().safeParse(process.argv[2]);
if (!owner.success) {
  console.error('Usage: npm run seed -- <owner-user-uuid>   (get one with: npm run dev-token)');
  process.exit(1);
}

const products = [
  { sku: 'LAT-CAR', name: 'Latte caramelo', priceCents: 6500, costCents: 2000, stock: 24 },
  { sku: 'CLD-BRW', name: 'Cold Brew', priceCents: 5500, costCents: 1800, stock: 16 },
  { sku: 'PAN-PLT', name: 'Pan de plátano', priceCents: 4500, costCents: 1700, stock: 4 },
  { sku: 'CMB-DES', name: 'Combo desayuno', priceCents: 12900, costCents: 5000, stock: 12 },
];

const db = createDatabase({
  DATABASE_URL: process.env.DATABASE_URL,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR ?? './.data/pglite',
});
try {
  await migrate(db);
  const tenantId = await db.withContext({ userId: owner.data }, async (q) => {
    const [row] = await q.query<{ id: string }>("SELECT create_tenant_with_owner('Café Demo') AS id");
    return row!.id;
  });
  await db.withContext({ userId: owner.data, tenantId }, async (q) => {
    for (const p of products) {
      const [created] = await q.query<{ id: string }>(
        'INSERT INTO products (tenant_id, sku, name, price_cents, cost_cents, stock) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [tenantId, p.sku, p.name, p.priceCents, p.costCents, p.stock],
      );
      await q.query(
        "INSERT INTO stock_movements (tenant_id, product_id, delta, reason, created_by) VALUES ($1, $2, $3, 'restock', $4)",
        [tenantId, created!.id, p.stock, owner.data],
      );
    }
  });
  console.log(`Seeded tenant "Café Demo": ${tenantId}`);
} finally {
  await db.close();
}
