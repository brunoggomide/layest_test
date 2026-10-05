import type { Db } from '../../infrastructure/db/database.js';
import type { RunOutput, RunRequest, RunRow } from './types.js';

const RUN_COLUMNS = 'id, tenant_id, invoice_ref, idempotency_key, input, output, status, created_at';

/** The run and its provenance: every retrieved item and every applied item, with the version it had. */
export async function insertRun(db: Db, request: RunRequest, output: RunOutput): Promise<string> {
  const run = await db.query<{ id: string }>(
    'INSERT INTO runs (tenant_id, invoice_ref, idempotency_key, input, output) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [request.tenantId, request.invoiceRef, request.idempotencyKey, JSON.stringify({ invoice: request.invoice }), JSON.stringify(output)],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) throw new Error('run insert returned no id');

  const rows = [
    ...output.retrieved_knowledge.map((ref) => ({ id: ref.id, version: ref.version, role: 'retrieved' })),
    ...output.applied_knowledge.map((ref) => ({ id: ref.id, version: ref.version, role: 'applied' })),
  ];
  if (rows.length > 0) {
    await db.query(
      `INSERT INTO run_knowledge_trace (run_id, knowledge_item_id, version, role)
       SELECT $1, * FROM unnest($2::uuid[], $3::int[], $4::text[])`,
      [runId, rows.map((r) => r.id), rows.map((r) => r.version), rows.map((r) => r.role)],
    );
  }
  return runId;
}

export async function findRunByIdempotencyKey(db: Db, tenantId: string, key: string): Promise<RunRow | null> {
  const res = await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
  return res.rows[0] ?? null;
}

export async function lockRun(db: Db, id: string): Promise<RunRow | null> {
  return (await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? null;
}

/** Global items the run applied: a tenant connection cannot reinforce those, the service role does. */
export async function appliedGlobalItemIds(db: Db, runId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `SELECT k.id FROM run_knowledge_trace t JOIN knowledge_items k ON k.id = t.knowledge_item_id
     WHERE t.run_id = $1 AND t.role = 'applied' AND k.scope = 'global'`,
    [runId],
  );
  return res.rows.map((row) => row.id);
}

export async function appliedTenantItemIds(db: Db, runId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `SELECT k.id FROM run_knowledge_trace t JOIN knowledge_items k ON k.id = t.knowledge_item_id
     WHERE t.run_id = $1 AND t.role = 'applied' AND k.scope = 'tenant'`,
    [runId],
  );
  return res.rows.map((row) => row.id);
}

export interface RunSummary {
  readonly id: string;
  readonly tenant_id: string;
  readonly invoice_ref: string | null;
  readonly vendor: string;
  readonly account: string;
  readonly status: string;
  readonly created_at: Date;
}

const LIST_LIMIT = 100;

export async function listRuns(db: Db): Promise<RunSummary[]> {
  const res = await db.query<RunSummary>(
    `SELECT id, tenant_id, invoice_ref, input->'invoice'->>'vendor' AS vendor, output->'suggestion'->>'account' AS account, status, created_at
     FROM runs ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
  );
  return res.rows;
}

export interface TraceRow {
  readonly knowledge_item_id: string;
  readonly version: number;
  readonly role: 'retrieved' | 'applied';
  readonly scope: string;
  readonly type: string;
  readonly subject_key: string;
  readonly rule_text: string;
  readonly current_status: string;
  readonly current_version: number;
}

export interface FeedbackSummary {
  readonly id: string;
  readonly kind: string;
  readonly reviewer_id: string;
  readonly diff: unknown;
  readonly error: unknown;
  readonly created_at: Date;
}

export interface RunDetail {
  readonly run: RunRow;
  readonly feedback: FeedbackSummary | null;
  /** Joined with the item's CURRENT status and version: a past run stays explainable after an edit. */
  readonly trace: TraceRow[];
}

export async function getRunDetail(db: Db, id: string): Promise<RunDetail | null> {
  const run = (await db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [id])).rows[0];
  if (run === undefined) return null;
  const feedback = (await db.query<FeedbackSummary>('SELECT id, kind, reviewer_id, diff, error, created_at FROM feedback_events WHERE run_id = $1', [id])).rows[0] ?? null;
  const trace = (
    await db.query<TraceRow>(
      `SELECT t.knowledge_item_id, t.version, t.role, k.scope, k.type, k.subject_key, k.rule_text,
              k.status AS current_status, k.version AS current_version
       FROM run_knowledge_trace t JOIN knowledge_items k ON k.id = t.knowledge_item_id
       WHERE t.run_id = $1
       ORDER BY (t.role = 'applied') DESC, k.confidence DESC`,
      [id],
    )
  ).rows;
  return { run, feedback, trace };
}
