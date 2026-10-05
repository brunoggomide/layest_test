import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { AcceptOutcome } from '../src/internal/knowledge/lifecycle.js';
import type { KnowledgeItem } from '../src/internal/knowledge/types.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, ROSSI_INVOICE, TENANTS, type Harness } from '../scenarios/harness.js';

const SLOT = 'vendor%3Drossi%7Caccount';

async function candidateFor(h: Harness, tenantId: string, account: string): Promise<string> {
  const t = h.tenant(tenantId);
  const run = data(await t.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
  const fb = data(await t.post<FeedbackResult>('/feedback', { run_id: run.run_id, kind: 'adjusted', diff: { account: { before: '6000', after: account } }, reviewer_id: 'r' }));
  const id = fb.created_items[0]?.id;
  if (id === undefined) throw new Error('no candidate');
  return id;
}

describe('knowledge lifecycle', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.finish());

  it('a second rule for the same slot is held as a pending conflict until a reviewer resolves it', async () => {
    const a = h.tenant(TENANTS.A.id);
    const c1 = await candidateFor(h, TENANTS.A.id, '6820');
    const c2 = await candidateFor(h, TENANTS.A.id, '6830');

    expect(data(await a.post<AcceptOutcome>(`/knowledge/${c1}/accept`, { reviewer_id: 'r' })).status).toBe('active');
    const second = data(await a.post<AcceptOutcome>(`/knowledge/${c2}/accept`, { reviewer_id: 'r' }));
    expect(second.status).toBe('accepted');
    expect(second.pending_conflict_with).toBe(c1);
    expect(data(await a.get<KnowledgeItem[]>(`/knowledge?status=active&subject_key=${SLOT}`)).map((i) => i.id)).toEqual([c1]);

    const resolved = data(await a.post<AcceptOutcome>(`/knowledge/${c2}/resolve-conflict`, { winner: 'new', reviewer_id: 'r' }));
    expect(resolved.status).toBe('active');
    expect(resolved.superseded_id).toBe(c1);
    expect(data(await a.get<KnowledgeItem>(`/knowledge/${c1}`)).status).toBe('superseded');
  });

  it('the database enforces one active truth per slot even for the service role', async () => {
    const superseded = await h.database.withService(async (db) => (await db.query<{ id: string }>("SELECT id FROM knowledge_items WHERE status = 'superseded'")).rows[0]?.id);
    expect(superseded).toBeDefined();
    await expect(h.database.withService((db) => db.query("UPDATE knowledge_items SET status = 'active' WHERE id = $1", [superseded]))).rejects.toMatchObject({ code: '23505' });
  });

  it('an edit is a new version; accepting it supersedes its predecessor without a conflict', async () => {
    const a = h.tenant(TENANTS.A.id);
    const active = data(await a.get<KnowledgeItem[]>(`/knowledge?status=active&subject_key=${SLOT}`))[0];
    if (active === undefined) throw new Error('no active item');
    const edited = data(await a.post<KnowledgeItem>(`/knowledge/${active.id}/edit`, { rule: { account: '6840' }, rule_text: 'Rossi -> 6840', reviewer_id: 'r' }));
    expect(edited.version).toBe(active.version + 1);
    expect(edited.supersedes_id).toBe(active.id);
    const accepted = data(await a.post<AcceptOutcome>(`/knowledge/${edited.id}/accept`, { reviewer_id: 'r' }));
    expect(accepted.status).toBe('active');
    expect(accepted.superseded_id).toBe(active.id);
    const history = data(await a.get<KnowledgeItem[]>(`/knowledge/${active.id}/history`));
    expect(history.at(-1)?.id).toBe(edited.id);
  });

  it('refuses an edit whose rule does not fit the type, and review actions without a reviewer', async () => {
    const a = h.tenant(TENANTS.A.id);
    const active = data(await a.get<KnowledgeItem[]>(`/knowledge?status=active&subject_key=${SLOT}`))[0];
    const bad = await a.post(`/knowledge/${active?.id}/edit`, { rule: { account: 42 }, rule_text: 'x', reviewer_id: 'r' });
    expect(bad.status).toBe(400);
    expect(bad.error?.code).toBe('validation_error');
    expect((await a.post(`/knowledge/${active?.id}/disable`, {})).status).toBe(400);
  });

  it('a candidate accepted with valid_until in the past is active but never retrieved', async () => {
    const d = h.tenant(TENANTS.D.id);
    const id = await candidateFor(h, TENANTS.D.id, '6850');
    const outcome = data(await d.post<AcceptOutcome>(`/knowledge/${id}/accept`, { reviewer_id: 'r', valid_until: '2020-01-01T00:00:00Z' }));
    expect(outcome.status).toBe('active');
    const run = data(await d.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    expect(run.suggestion.account).toBe('6000');
    expect(run.retrieved_knowledge).toHaveLength(0);
  });

  it('a tenant cannot review a global item; the service can', async () => {
    const globalId = await h.database.withService(async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO knowledge_items (scope, tenant_id, type, anchor, subject_key, rule, rule_text, supporting_context, confidence)
         VALUES ('global', NULL, 'extraction_failure_pattern', 'doc_pattern=g', 'doc_pattern=g|failure', '{"doc_structure":{"layout":"table"},"error_signature":"X"}', 'g', '{}', 0.5) RETURNING id`,
      );
      return res.rows[0]?.id;
    });
    const denied = await h.tenant(TENANTS.A.id).post(`/knowledge/${globalId}/accept`, { reviewer_id: 'r' });
    expect(denied.status).toBe(403);
    expect(data(await h.service().post<AcceptOutcome>(`/knowledge/${globalId}/accept`, { reviewer_id: 'platform' })).status).toBe('active');
  });
});
