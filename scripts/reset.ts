import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/infrastructure/db/database.js';
import { resetDatabase } from '../src/infrastructure/db/seed.js';

const database = createDatabase(loadEnv());
try {
  await resetDatabase(database);
  console.log('database reset and tenants re-seeded');
} finally {
  await database.close();
}
