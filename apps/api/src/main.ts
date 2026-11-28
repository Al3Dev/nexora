import { loadConfig } from './config.js';
import { createApp } from './create-app.js';
import { createDatabase } from './db/create-database.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const db = createDatabase(config);

if (!config.DATABASE_URL) {
  // Embedded database for local development: apply migrations automatically.
  const applied = await migrate(db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  console.warn(`Using embedded PGlite at ${config.PGLITE_DATA_DIR} (development only). Set DATABASE_URL for PostgreSQL.`);
}

const app = await createApp(config, db);
await app.listen(config.PORT);
console.log(`NEXORA API listening on http://localhost:${config.PORT}`);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
