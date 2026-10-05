import type { Db } from '../../infrastructure/db/database.js';
import type { JsonObject } from '../../shared/json.js';
import type { KnowledgeCandidate, KnowledgeItem, KnowledgeStatus, KnowledgeType, Scope } from './types.js';

export const ITEM_COLUMNS = `id, scope, tenant_id, type, anchor, subject_key, rule, rule_text, supporting_context, status,
  confidence, evidence_count, contested_count, distinct_tenant_count, source_event_id, source_run_id,
  version, supersedes_id, created_at, reviewed_at, reviewed_by, activated_at, valid_until`;

/** Each accepted run adds a step; the cap keeps confidence a ranking signal, never a certainty. */
const CONFIDENCE_STEP = 0.05;
const CONFIDENCE_CAP = 0.99;

export async function getItem(db: Db, id: string): Promise<KnowledgeItem | null> {
  return (await db.query<KnowledgeItem>(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id = $1`, [id])).rows[0] ?? null;
}

/** Row lock: concurrent reviewer actions on the same item serialize. */
export async function lockItem(db: Db, id: string): Promise<KnowledgeItem | null> {
  return (await db.query<KnowledgeItem>(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id = $1 FOR UPDATE`, [id])).rows[0] ?? null;
}

export async function findActive(db: Db, scope: Scope, tenantId: string | null, subjectKey: string): Promise<KnowledgeItem | null> {
  const res = await db.query<KnowledgeItem>(
    `SELECT ${ITEM_COLUMNS} FROM knowledge_items
     WHERE status = 'active' AND scope = $1 AND tenant_id IS NOT DISTINCT FROM $2::uuid AND subject_key = $3`,
    [scope, tenantId, subjectKey],
  );
  return res.rows[0] ?? null;
}

/** Candidates and accepted-but-held items of one tenant for a slot: what a new candidate may duplicate. */
export async function findPending(db: Db, tenantId: string, type: KnowledgeType, subjectKey: string): Promise<KnowledgeItem[]> {
  const res = await db.query<KnowledgeItem>(
    `SELECT ${ITEM_COLUMNS} FROM knowledge_items
     WHERE scope = 'tenant' AND tenant_id = $1 AND type = $2 AND subject_key = $3 AND status IN ('candidate', 'accepted')`,
    [tenantId, type, subjectKey],
  );
  return res.rows;
}

export interface InsertItem extends KnowledgeCandidate {
  readonly scope: Scope;
  readonly tenant_id: string | null;
  readonly status?: KnowledgeStatus;
  readonly source_event_id?: string | null;
  readonly source_run_id?: string | null;
  readonly version?: number;
  readonly supersedes_id?: string | null;
  readonly evidence_count?: number;
  readonly distinct_tenant_count?: number;
  readonly reviewed_by?: string | null;
}

export async function insertItem(db: Db, input: InsertItem): Promise<KnowledgeItem> {
  const res = await db.query<KnowledgeItem>(
    `INSERT INTO knowledge_items
       (scope, tenant_id, type, anchor, subject_key, rule, rule_text, supporting_context, status, confidence,
        evidence_count, distinct_tenant_count, source_event_id, source_run_id, version, supersedes_id, reviewed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING ${ITEM_COLUMNS}`,
    [
      input.scope,
      input.tenant_id,
      input.type,
      input.anchor,
      input.subject_key,
      JSON.stringify(input.rule),
      input.rule_text,
      JSON.stringify(input.supporting_context),
      input.status ?? 'candidate',
      input.confidence,
      input.evidence_count ?? 1,
      input.distinct_tenant_count ?? 1,
      input.source_event_id ?? null,
      input.source_run_id ?? null,
      input.version ?? 1,
      input.supersedes_id ?? null,
      input.reviewed_by ?? null,
    ],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}

export interface StatusChange {
  readonly reviewer?: string;
  readonly activated?: boolean;
  readonly supportingContext?: JsonObject;
  readonly supersedesId?: string;
  readonly validUntil?: Date | null;
}

export async function updateStatus(db: Db, id: string, status: KnowledgeStatus, change: StatusChange = {}): Promise<KnowledgeItem> {
  const res = await db.query<KnowledgeItem>(
    `UPDATE knowledge_items SET
       status = $2,
       reviewed_at = CASE WHEN $3::text IS NULL THEN reviewed_at ELSE now() END,
       reviewed_by = COALESCE($3, reviewed_by),
       activated_at = CASE WHEN $4 THEN now() ELSE activated_at END,
       supporting_context = COALESCE($5::jsonb, supporting_context),
       supersedes_id = COALESCE($6::uuid, supersedes_id),
       valid_until = CASE WHEN $7 THEN $8::timestamptz ELSE valid_until END
     WHERE id = $1
     RETURNING ${ITEM_COLUMNS}`,
    [
      id,
      status,
      change.reviewer ?? null,
      change.activated ?? false,
      change.supportingContext === undefined ? null : JSON.stringify(change.supportingContext),
      change.supersedesId ?? null,
      change.validUntil !== undefined,
      change.validUntil ?? null,
    ],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error(`update of ${id} affected no row`);
  return row;
}

/** Only rows visible and writable to the current role are touched; the ids actually updated are returned. */
export async function reinforceItems(db: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await db.query<{ id: string }>(
    `UPDATE knowledge_items SET evidence_count = evidence_count + 1, confidence = LEAST($2, confidence + $3)
     WHERE id = ANY($1::uuid[]) RETURNING id`,
    [ids, CONFIDENCE_CAP, CONFIDENCE_STEP],
  );
  return res.rows.map((row) => row.id);
}

export async function contestItems(db: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await db.query<{ id: string }>(
    'UPDATE knowledge_items SET contested_count = contested_count + 1 WHERE id = ANY($1::uuid[]) RETURNING id',
    [ids],
  );
  return res.rows.map((row) => row.id);
}

export async function addEvidence(db: Db, itemId: string, eventId: string, tenantId: string): Promise<void> {
  await db.query(
    'INSERT INTO knowledge_evidence (knowledge_item_id, feedback_event_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [itemId, eventId, tenantId],
  );
}

export interface ListFilters {
  readonly status?: KnowledgeStatus | undefined;
  readonly scope?: Scope | undefined;
  readonly tenant_id?: string | undefined;
  readonly type?: KnowledgeType | undefined;
  readonly subject_key?: string | undefined;
}

const LIST_LIMIT = 500;

export async function listItems(db: Db, filters: ListFilters): Promise<KnowledgeItem[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params.push(value);
    where.push(`${column} = $${params.length}${column === 'tenant_id' ? '::uuid' : ''}`);
  }
  const sql = `SELECT ${ITEM_COLUMNS} FROM knowledge_items ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, version DESC LIMIT ${LIST_LIMIT}`;
  return (await db.query<KnowledgeItem>(sql, params)).rows;
}

/** The whole supersedes chain, walked up and down from any member, oldest version first. */
export async function getHistory(db: Db, id: string): Promise<KnowledgeItem[]> {
  const res = await db.query<KnowledgeItem>(
    `WITH RECURSIVE up AS (
        SELECT id, supersedes_id FROM knowledge_items WHERE id = $1
        UNION ALL
        SELECT k.id, k.supersedes_id FROM knowledge_items k JOIN up ON k.id = up.supersedes_id
     ), down AS (
        SELECT id FROM knowledge_items WHERE id = $1
        UNION ALL
        SELECT k.id FROM knowledge_items k JOIN down ON k.supersedes_id = down.id
     )
     SELECT ${ITEM_COLUMNS} FROM knowledge_items
     WHERE id IN (SELECT id FROM up UNION SELECT id FROM down)
     ORDER BY version ASC, created_at ASC`,
    [id],
  );
  return res.rows;
}
