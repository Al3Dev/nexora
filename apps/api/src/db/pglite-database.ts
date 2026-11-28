import { PGlite } from '@electric-sql/pglite';
import { Database, type Queryable, type Row } from './database.js';

/**
 * Embedded PostgreSQL (WASM) for local development and tests when no
 * PostgreSQL server is available. Not for production.
 */
export class PgliteDatabase extends Database {
  private readonly db: PGlite;

  constructor(dataDir?: string) {
    super();
    this.db = new PGlite(dataDir);
  }

  ownerTransaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      fn({
        query: async <R extends Row>(sql: string, params: unknown[] = []) =>
          (await tx.query<R>(sql, params)).rows,
        exec: async (sql: string) => {
          await tx.exec(sql);
        },
      }),
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
