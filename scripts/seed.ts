import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/infrastructure/db/database.js';
import { seedTenants } from '../src/infrastructure/db/seed.js';

const database = createDatabase(loadEnv());
try {
  console.log(`seeded ${await seedTenants(database)} tenants`);
} finally {
  await database.close();
}
