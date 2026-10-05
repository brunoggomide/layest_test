import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { KnowledgeItem } from '../src/internal/knowledge/types.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, ROSSI_INVOICE, TENANTS, type Harness } from '../scenarios/harness.js';

describe('POST /feedback', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.finish());

  it('is idempotent on a replay and refuses a different decision for the same run', async () => {
    const a = h.tenant(TENANTS.A.id);
    const run = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const body = { run_id: run.run_id, kind: 'adjusted', diff: { account: { before: '6000', after: '6820' } }, reviewer_id: 'r1' };

    const first = await a.post<FeedbackResult>('/feedback', body);
    expect(first.status).toBe(201);
    expect(first.data?.idempotent_replay).toBe(false);
    expect(first.data?.created_items).toHaveLength(1);

    const replay = await a.post<FeedbackResult>('/feedback', body);
    expect(replay.status).toBe(200);
    expect(replay.data?.idempotent_replay).toBe(true);
    expect(replay.data?.event_id).toBe(first.data?.event_id);

    const other = await a.post<FeedbackResult>('/feedback', { run_id: run.run_id, kind: 'rejected', reviewer_id: 'r1' });
    expect(other.status).toBe(409);
    expect(other.error?.code).toBe('run_already_reviewed');

    const run2 = data(await a.get<{ run: { status: string }; feedback: { kind: string } }>(`/runs/${run.run_id}`));
    expect(run2.run.status).toBe('adjusted');
    expect(run2.feedback.kind).toBe('adjusted');
  });

  it('an identical pending candidate from another run is strengthened, not duplicated', async () => {
    const a = h.tenant(TENANTS.A.id);
    const run = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const result = data(await a.post<FeedbackResult>('/feedback', { run_id: run.run_id, kind: 'adjusted', diff: { account: { before: '6000', after: '6820' } }, reviewer_id: 'r2' }));
    expect(result.created_items).toHaveLength(0);
    expect(result.reinforced_item_ids).toHaveLength(1);
    const items = data(await a.get<KnowledgeItem[]>('/knowledge?status=candidate&subject_key=vendor%3Drossi%7Caccount'));
    expect(items).toHaveLength(1);
    expect(items[0]?.evidence_count).toBe(2);
  });

  it('a correction that equals the active rule reinforces it instead of creating a candidate', async () => {
    const b = h.tenant(TENANTS.B.id);
    const run = data(await b.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const created = data(await b.post<FeedbackResult>('/feedback', { run_id: run.run_id, kind: 'adjusted', diff: { account: { before: '6000', after: '6900' } }, reviewer_id: 'r' }));
    const id = created.created_items[0]?.id;
    data(await b.post(`/knowledge/${id}/accept`, { reviewer_id: 'r' }));
    const run2 = data(await b.post<RunResponse>('/runs', { invoice: { ...ROSSI_INVOICE, vendor: 'ROSSI SpA' } }));
    expect(run2.suggestion.account).toBe('6900');
    // The reviewer "corrects" to what is already active (e.g. a stale client): no duplicate truth.
    const again = data(await b.post<FeedbackResult>('/feedback', { run_id: run2.run_id, kind: 'adjusted', diff: { account: { before: '6000', after: '6900' } }, reviewer_id: 'r' }));
    expect(again.created_items).toHaveLength(0);
    expect(again.reinforced_item_ids).toEqual([id]);
  });

  it('two rejections of different accounts merge into one veto as a new version', async () => {
    const c = h.tenant(TENANTS.C.id);
    const run1 = data(await c.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const veto1 = data(await c.post<FeedbackResult>('/feedback', { run_id: run1.run_id, kind: 'rejected', reviewer_id: 'r' })).created_items[0];
    data(await c.post(`/knowledge/${veto1?.id}/accept`, { reviewer_id: 'r' }));
    // With 6000 vetoed the agent answers UNMAPPED; a reviewer maps to 6100, then another rejects 6100.
    const run2 = data(await c.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const mapping = data(await c.post<FeedbackResult>('/feedback', { run_id: run2.run_id, kind: 'adjusted', diff: { account: { before: 'UNMAPPED', after: '6100' } }, reviewer_id: 'r' })).created_items[0];
    expect(mapping?.supporting_context['conflicts_with']).toBe(veto1?.id);
    data(await c.post(`/knowledge/${mapping?.id}/accept`, { reviewer_id: 'r' }));
    data(await c.post(`/knowledge/${mapping?.id}/resolve-conflict`, { winner: 'new', reviewer_id: 'r' }));
    const run3 = data(await c.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    expect(run3.suggestion.account).toBe('6100');
    const rejected = data(await c.post<FeedbackResult>('/feedback', { run_id: run3.run_id, kind: 'rejected', reviewer_id: 'r' }));
    expect(rejected.contested_item_ids).toEqual([mapping?.id]);
    expect(rejected.created_items[0]).toMatchObject({ type: 'account_veto', rule: { forbidden_accounts: ['6100'] }, supporting_context: { conflicts_with: mapping?.id } });
  });

  it('a run of another tenant is not found', async () => {
    const run = data(await h.tenant(TENANTS.A.id).post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const res = await h.tenant(TENANTS.B.id).post('/feedback', { run_id: run.run_id, kind: 'accepted', reviewer_id: 'intruder' });
    expect(res.status).toBe(404);
  });

  it('validates the payload per kind', async () => {
    const a = h.tenant(TENANTS.A.id);
    const run = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    expect((await a.post('/feedback', { run_id: run.run_id, kind: 'adjusted', reviewer_id: 'r' })).status).toBe(400);
    expect((await a.post('/feedback', { run_id: run.run_id, kind: 'failed', reviewer_id: 'r' })).status).toBe(400);
    expect((await a.post('/feedback', { run_id: run.run_id, kind: 'accepted' })).status).toBe(400);
  });
});
