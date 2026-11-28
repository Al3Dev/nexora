import { createDatabase } from './create-database.js';
import { migrate } from './migrate.js';

const db = createDatabase({
  DATABASE_URL: process.env.DATABASE_URL,
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR ?? './.data/pglite',
});
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} finally {
  await db.close();
}
