import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';

// src/db or dist/db -> repository root
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../database/migrations');

export async function migrate(db: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const ran = await db.ownerTransaction(async (q) => {
      await q.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await q.query('SELECT pg_advisory_xact_lock(7426001)');
      const done = await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.length > 0) return false;
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}
