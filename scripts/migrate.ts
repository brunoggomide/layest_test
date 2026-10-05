import { loadEnv, placeholderWarnings } from '../src/config/env.js';
import { createDatabase } from '../src/infrastructure/db/database.js';
import { applyMigrations, syncRolePasswords } from '../src/infrastructure/db/migrate.js';

const env = loadEnv();
const database = createDatabase(env);
try {
  const applied = await applyMigrations(database);
  console.log(applied.length === 0 ? 'nothing to apply' : `applied: ${applied.join(', ')}`);
  await syncRolePasswords(database, env);
  console.log('role passwords synced from the environment (billay_app, billay_service)');
  for (const warning of placeholderWarnings(env)) console.warn(`warning: ${warning}`);
} finally {
  await database.close();
}
