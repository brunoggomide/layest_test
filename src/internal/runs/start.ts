import type { Database } from '../../infrastructure/db/database.js';
import { executeRun } from './graph.js';
import { findRunByIdempotencyKey } from './repository.js';
import type { RunRequest, RunResponse, RunRow } from './types.js';

const IDEMPOTENCY_CONSTRAINT = 'runs_tenant_idempotency_key';

function isIdempotencyCollision(error: unknown): boolean {
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === IDEMPOTENCY_CONSTRAINT;
}

const replay = (run: RunRow): RunResponse => ({ run_id: run.id, replayed: true, ...run.output });

/**
 * Runs the agent once per idempotency key. A retry with the same key returns the run it already
 * created, including under a race: the second of two concurrent calls loses on the unique constraint
 * and then reads the winner. Without a key every call is a new run, which is what a reprocessing is.
 */
export async function startRun(database: Database, request: RunRequest): Promise<RunResponse> {
  const { tenantId, idempotencyKey } = request;
  if (idempotencyKey !== null) {
    const existing = await database.withTenant(tenantId, (db) => findRunByIdempotencyKey(db, tenantId, idempotencyKey));
    if (existing !== null) return replay(existing);
  }
  try {
    const { runId, output } = await database.withTenant(tenantId, (db) => executeRun(db, request));
    return { run_id: runId, replayed: false, ...output };
  } catch (error) {
    if (idempotencyKey === null || !isIdempotencyCollision(error)) throw error;
    const winner = await database.withTenant(tenantId, (db) => findRunByIdempotencyKey(db, tenantId, idempotencyKey));
    if (winner === null) throw error;
    return replay(winner);
  }
}
