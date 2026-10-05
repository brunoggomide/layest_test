import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docPatternSubject } from '../src/internal/knowledge/keys.js';
import { insertItem, type InsertItem } from '../src/internal/knowledge/repository.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, TENANTS, type Harness } from '../scenarios/harness.js';

const DOC = { layout: 'table', header: false, columns: 5 };

describe('retrieval: anchors, precedence and expiry', () => {
  let h: Harness;
  let globalId: string;
  let tenantId: string;
  beforeAll(async () => {
    h = await createHarness();
    const pattern = docPatternSubject(DOC);
    const base: Omit<InsertItem, 'scope' | 'tenant_id' | 'rule' | 'rule_text' | 'confidence'> = { type: 'extraction_failure_pattern', ...pattern, supporting_context: {}, status: 'active' };
    await h.database.withService(async (db) => {
      globalId = (await insertItem(db, { ...base, scope: 'global', tenant_id: null, rule: { doc_structure: DOC, error_signature: 'X', recovery_strategy: 'global_strategy' }, rule_text: 'g', confidence: 0.9 })).id;
      tenantId = (await insertItem(db, { ...base, scope: 'tenant', tenant_id: TENANTS.A.id, rule: { doc_structure: DOC, error_signature: 'X', recovery_strategy: 'tenant_strategy' }, rule_text: 't', confidence: 0.4 })).id;
      await insertItem(db, { scope: 'tenant', tenant_id: TENANTS.B.id, type: 'booking_rule', anchor: 'vendor=rossi', subject_key: 'vendor=rossi|booking:cost_center', rule: { field: 'cost_center', value: 'CC-9' }, rule_text: 'b', supporting_context: {}, confidence: 0.5, status: 'active' });
      await db.query("UPDATE knowledge_items SET valid_until = now() - interval '1 day' WHERE subject_key = 'vendor=rossi|booking:cost_center'");
    });
  });
  afterAll(() => h.finish());

  it('a tenant item wins over a global item on the same slot even with lower confidence, and the global one is reported as shadowed', async () => {
    const run = data(await h.tenant(TENANTS.A.id).post<RunResponse>('/runs', { invoice: { vendor: 'X', fields: {}, doc_structure: DOC } }));
    expect(run.suggestion.recovery_strategy).toBe('tenant_strategy');
    expect(run.applied_knowledge.map((k) => k.id)).toEqual([tenantId]);
    expect(run.retrieved_knowledge.some((k) => k.id === globalId)).toBe(false);
    expect(run.shadowed_global_knowledge.map((k) => k.id)).toEqual([globalId]);
  });

  it('a tenant without its own item falls back to the global item', async () => {
    const run = data(await h.tenant(TENANTS.B.id).post<RunResponse>('/runs', { invoice: { vendor: 'X', fields: {}, doc_structure: DOC } }));
    expect(run.suggestion.recovery_strategy).toBe('global_strategy');
    expect(run.applied_knowledge.map((k) => k.id)).toEqual([globalId]);
  });

  it('expired items (valid_until in the past) are not retrieved', async () => {
    const run = data(await h.tenant(TENANTS.B.id).post<RunResponse>('/runs', { invoice: { vendor: 'Rossi', fields: { total: 1 } } }));
    expect(run.retrieved_knowledge).toHaveLength(0);
    expect(run.suggestion.fields['cost_center']).toBeUndefined();
  });

  it('a rule that adds a field the invoice does not carry is still found: retrieval is by vendor, not by field', async () => {
    await h.database.withService((db) =>
      insertItem(db, { scope: 'tenant', tenant_id: TENANTS.C.id, type: 'booking_rule', anchor: 'vendor=rossi', subject_key: 'vendor=rossi|booking:cost_center', rule: { field: 'cost_center', value: 'CC-1' }, rule_text: 'c', supporting_context: {}, confidence: 0.5, status: 'active' }),
    );
    const run = data(await h.tenant(TENANTS.C.id).post<RunResponse>('/runs', { invoice: { vendor: 'Rossi S.p.A.', fields: { total: 1 } } }));
    expect(run.anchors).toEqual(['vendor=rossi', 'tenant']);
    expect(run.suggestion.fields['cost_center']).toBe('CC-1');
  });
});
