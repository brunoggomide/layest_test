import type { Database } from './database.js';

/** Fixed ids so scenarios, tests and curl examples are reproducible. */
export const TENANTS = {
  A: { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Alpha Srl' },
  B: { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Beta GmbH' },
  C: { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Gamma SA' },
  D: { id: 'dddddddd-0000-4000-8000-000000000004', name: 'Delta Ltd' },
  E: { id: 'eeeeeeee-0000-4000-8000-000000000005', name: 'Epsilon BV' },
} as const;

export async function seedTenants(database: Database): Promise<number> {
  await database.withAdmin(async (db) => {
    for (const tenant of Object.values(TENANTS)) {
      await db.query('INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', [tenant.id, tenant.name]);
    }
  });
  return Object.keys(TENANTS).length;
}

/** Development and tests only: wipes every row and re-seeds the tenants. The application never hard-deletes. */
export async function resetDatabase(database: Database): Promise<void> {
  await database.withAdmin(async (db) => {
    await db.query('TRUNCATE run_knowledge_trace, knowledge_evidence, knowledge_items, feedback_events, runs, tenants CASCADE');
  });
  await seedTenants(database);
}
