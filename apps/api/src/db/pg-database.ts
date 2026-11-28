import pg from 'pg';
import { Database, type Queryable, type Row } from './database.js';

export class PgDatabase extends Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    super();
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async ownerTransaction<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: Queryable = {
      query: async <R extends Row>(sql: string, params: unknown[] = []) =>
        (await client.query<R>(sql, params)).rows,
      exec: async (sql: string) => {
        await client.query(sql);
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
