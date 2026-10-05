import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../src/config/env.js';
import type { ErrorBody } from '../src/http/errors.js';
import { buildApp } from '../src/http/app.js';
import { createDatabase, type Database } from '../src/infrastructure/db/database.js';
import { resetDatabase, TENANTS } from '../src/infrastructure/db/seed.js';
import type { Invoice } from '../src/internal/runs/types.js';

export { TENANTS };

export type ApiError = ErrorBody['error'];

export type Reply<T> = { readonly status: number; readonly data: T; readonly error: null } | { readonly status: number; readonly data: null; readonly error: ApiError };

export interface Client {
  get<T>(url: string): Promise<Reply<T>>;
  post<T>(url: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
}

export interface Harness {
  readonly database: Database;
  tenant(tenantId: string): Client;
  service(): Client;
  finish(): Promise<void>;
}

/**
 * Scenarios and tests call the real HTTP layer in-process (fastify.inject): same validation, same
 * transactions, same row-level security as a request over the network. The database is reset first.
 */
export async function createHarness(): Promise<Harness> {
  const env = loadEnv();
  const database = createDatabase(env);
  await resetDatabase(database);
  const app: FastifyInstance = buildApp({ env: { ...env, LOG_LEVEL: 'silent' }, database });
  await app.ready();

  const client = (identity: Record<string, string>): Client => {
    const call = async <T>(method: 'GET' | 'POST', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> => {
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { ...identity, ...extra, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      const json = res.json<{ data?: T; error?: ApiError }>();
      return json.error === undefined ? { status: res.statusCode, data: json.data as T, error: null } : { status: res.statusCode, data: null, error: json.error };
    };
    return { get: (url) => call('GET', url), post: (url, body, headers) => call('POST', url, body ?? {}, headers) };
  };

  return {
    database,
    tenant: (tenantId) => client({ 'x-tenant-id': tenantId }),
    service: () => client({ 'x-service-token': env.SERVICE_TOKEN }),
    async finish() {
      await app.close();
      await database.close();
    },
  };
}

/** The payload of a successful reply; a failed one is a scenario bug, reported with its code. */
export function data<T>(reply: Reply<T>): T {
  if (reply.error !== null) throw new Error(`request failed with ${reply.status} ${reply.error.code}: ${reply.error.message}`);
  return reply.data;
}

let stepNumber = 0;

export function title(text: string): void {
  stepNumber = 0;
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

export function step(text: string): void {
  stepNumber += 1;
  console.log(`\n--- Step ${stepNumber}: ${text}`);
}

export function say(text: string): void {
  console.log(`    ${text}`);
}

export function show(label: string, value: unknown): void {
  console.log(`    ${label}: ${JSON.stringify(value, null, 2).split('\n').join('\n    ')}`);
}

export function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(`scenario expectation failed: ${message}`);
  say(`[ok] ${message}`);
}

export const short = (id: string): string => id.slice(0, 8);

export const ROSSI_INVOICE: Invoice = {
  vendor: 'Rossi S.p.A.',
  fields: { invoice_number: 'R-1001', total: 1200.5, due_date: '2026-10-01' },
};

export async function main(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error('\nSCENARIO FAILED:', error);
    process.exit(1);
  }
}
