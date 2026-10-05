import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, ROSSI_INVOICE, TENANTS, type Harness } from '../scenarios/harness.js';

describe('POST /runs with an Idempotency-Key', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.finish());

  it('a retry with the same key returns the same run with replayed=true and creates no second row', async () => {
    const a = h.tenant(TENANTS.A.id);
    const headers = { 'idempotency-key': 'inv-1:attempt' };
    const first = await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-1' }, headers);
    const retry = await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-1' }, headers);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.data?.run_id).toBe(first.data?.run_id);
    expect(retry.data?.replayed).toBe(true);
    expect(retry.data?.suggestion).toEqual(first.data?.suggestion);
    const rows = await h.database.withService(async (db) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE idempotency_key = 'inv-1:attempt'")).rows[0]?.n);
    expect(rows).toBe(1);
  });

  it('the key is scoped to the tenant: another tenant with the same key gets its own run', async () => {
    const headers = { 'idempotency-key': 'shared-key' };
    const runA = data(await h.tenant(TENANTS.A.id).post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }, headers));
    const runB = data(await h.tenant(TENANTS.B.id).post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }, headers));
    expect(runB.run_id).not.toBe(runA.run_id);
    expect(runB.replayed).toBe(false);
  });

  it('two concurrent calls with the same key end with one run: the loser of the race replays the winner', async () => {
    const a = h.tenant(TENANTS.A.id);
    const headers = { 'idempotency-key': 'race' };
    const [x, y] = await Promise.all([a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }, headers), a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }, headers)]);
    expect(x.data?.run_id).toBeDefined();
    expect(x.data?.run_id).toBe(y.data?.run_id);
    expect([x.data?.replayed, y.data?.replayed].filter(Boolean)).toHaveLength(1);
  });

  it('without a key every call is a new run; a malformed key is refused', async () => {
    const a = h.tenant(TENANTS.A.id);
    const one = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    const two = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
    expect(two.run_id).not.toBe(one.run_id);
    const bad = await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }, { 'idempotency-key': 'has spaces' });
    expect(bad.status).toBe(400);
    expect(bad.error?.code).toBe('validation_error');
  });

  it('the stored output is what the run returned, so the replay and the run detail agree', async () => {
    const a = h.tenant(TENANTS.A.id);
    const run = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }, { 'idempotency-key': 'detail' }));
    const detail = data(await a.get<{ run: { idempotency_key: string | null; output: { anchors: string[] } } }>(`/runs/${run.run_id}`));
    expect(detail.run.idempotency_key).toBe('detail');
    expect(detail.run.output.anchors).toEqual(run.anchors);
  });
});
