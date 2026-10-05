import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../../config/env.js';
import type { Database } from './database.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

const REGISTRY = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * The files are not idempotent: the registry is what makes a second run safe. Everything happens in
 * one transaction under an advisory lock, so a second migrator started at the same time waits, then
 * finds nothing left to apply, and a failing file leaves no half-applied schema behind.
 */
export async function applyMigrations(database: Database): Promise<string[]> {
  return database.withAdmin(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('schema_migrations'))");
    await db.query(REGISTRY);
    const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
    const pending = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql') && !applied.has(file))
      .sort();
    for (const file of pending) {
      await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    return pending;
  });
}

/** Re-applied on every migrate, so rotating a password is: edit .env, run migrate. */
export async function syncRolePasswords(database: Database, env: Env): Promise<void> {
  const roles = [
    ['billay_app', env.BILLAY_APP_PASSWORD],
    ['billay_service', env.BILLAY_SERVICE_PASSWORD],
  ] as const;
  await database.withAdmin(async (db) => {
    for (const [role, password] of roles) {
      await db.query(`ALTER ROLE ${db.escapeIdentifier(role)} WITH PASSWORD ${db.escapeLiteral(password)}`);
    }
  });
}
