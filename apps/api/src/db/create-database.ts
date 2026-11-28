import type { Config } from '../config.js';
import type { Database } from './database.js';
import { PgDatabase } from './pg-database.js';
import { PgliteDatabase } from './pglite-database.js';

export function createDatabase(config: Pick<Config, 'DATABASE_URL' | 'PGLITE_DATA_DIR'>): Database {
  if (config.DATABASE_URL) return new PgDatabase(config.DATABASE_URL);
  return new PgliteDatabase(config.PGLITE_DATA_DIR);
}
