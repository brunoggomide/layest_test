import pg from 'pg';
import type { Env } from '../../config/env.js';

// numeric (confidence) arrives as text from the driver.
pg.types.setTypeParser(1700, Number.parseFloat);

export type Db = Pick<pg.PoolClient, 'query' | 'escapeIdentifier' | 'escapeLiteral'>;

export interface Database {
  /** One transaction with `app.tenant_id` set: row-level security scopes every statement inside. */
  withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T>;
  /** One transaction as the platform role (bypasses RLS): global review and the promotion job. */
  withService<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** One transaction as the superuser: migrate, seed and reset only. */
  withAdmin<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function transaction<T>(pool: pg.Pool, setup: (client: pg.PoolClient) => Promise<void>, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const noSetup = async (): Promise<void> => undefined;

export function createDatabase(env: Env): Database {
  const location = { host: env.DATABASE_HOST, port: env.DATABASE_PORT, database: env.DATABASE_NAME };
  const pools = new Map<string, pg.Pool>();
  const pool = (user: string, password: string | undefined, max: number): pg.Pool => {
    if (password === undefined) throw new Error('POSTGRES_PASSWORD is required for migrate, seed and reset');
    let existing = pools.get(user);
    if (existing === undefined) {
      existing = new pg.Pool({ ...location, user, password, max });
      pools.set(user, existing);
    }
    return existing;
  };

  return {
    withTenant: (tenantId, fn) =>
      transaction(
        pool('billay_app', env.BILLAY_APP_PASSWORD, 8),
        // set_config(..., true) is transaction-local: it cannot leak into the next request on this pooled connection.
        async (client) => {
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        },
        fn,
      ),
    withService: (fn) => transaction(pool('billay_service', env.BILLAY_SERVICE_PASSWORD, 4), noSetup, fn),
    withAdmin: (fn) => transaction(pool(env.POSTGRES_USER, env.POSTGRES_PASSWORD, 2), noSetup, fn),
    async close() {
      await Promise.all([...pools.values()].map((p) => p.end()));
      pools.clear();
    },
  };
}
