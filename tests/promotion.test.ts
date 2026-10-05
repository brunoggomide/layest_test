import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docPatternSubject } from '../src/internal/knowledge/keys.js';
import { insertItem } from '../src/internal/knowledge/repository.js';
import type { PromotionReport } from '../src/internal/promotion/promote.js';
import { runPromotion } from '../src/internal/promotion/promote.js';
import { createHarness, TENANTS, type Harness } from '../scenarios/harness.js';

const DOC = { layout: 'table', header: false, columns: 5 };
const PATTERN = docPatternSubject(DOC);

describe('global promotion gates', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.finish());

  const activePattern = (tenantId: string, recovery: string): Promise<unknown> =>
    h.database.withService((db) =>
      insertItem(db, { scope: 'tenant', tenant_id: tenantId, type: 'extraction_failure_pattern', ...PATTERN, rule: { doc_structure: DOC, error_signature: 'missing_field:total_amount', recovery_strategy: recovery }, rule_text: 'x', supporting_context: { doc_type: 'invoice' }, confidence: 0.6, status: 'active' }),
    );
  const promote = (min = 3): Promise<PromotionReport> => h.database.withService((db) => runPromotion(db, min));

  it('skips a pattern below the distinct-tenant threshold', async () => {
    await activePattern(TENANTS.A.id, 'sum_line_items');
    await activePattern(TENANTS.B.id, 'sum_line_items');
    const report = await promote();
    expect(report.decisions).toHaveLength(1);
    expect(report.decisions[0]).toMatchObject({ outcome: 'skipped', tenant_ids: [TENANTS.A.id, TENANTS.B.id] });
    expect(report.decisions[0]?.reason).toMatch(/2\/3 distinct tenants/);
  });

  it('promotes at the threshold as a global CANDIDATE with the lowest confidence of the group, then never twice', async () => {
    await activePattern(TENANTS.C.id, 'sum_line_items');
    const report = await promote();
    const decision = report.decisions[0];
    expect(decision?.outcome).toBe('promoted');
    const global = await h.service().get<{ status: string; confidence: number; distinct_tenant_count: number; evidence_count: number }>(`/knowledge/${decision?.global_item_id}`);
    expect(global.data).toMatchObject({ status: 'candidate', confidence: 0.6, distinct_tenant_count: 3, evidence_count: 3 });
    const again = await promote();
    expect(again.decisions[0]?.outcome).toBe('skipped');
    expect(again.decisions[0]?.reason).toMatch(/already exists/);
  });

  it('refuses the same evidence for an account mapping: it is one tenant\'s chart of accounts', async () => {
    for (const tenant of [TENANTS.A, TENANTS.B, TENANTS.C]) {
      await h.database.withService((db) =>
        insertItem(db, { scope: 'tenant', tenant_id: tenant.id, type: 'account_mapping', anchor: 'vendor=rossi', subject_key: 'vendor=rossi|account', rule: { account: '6820' }, rule_text: 'x', supporting_context: {}, confidence: 0.9, status: 'active' }),
      );
    }
    const report = await promote();
    const mapping = report.decisions.find((d) => d.type === 'account_mapping');
    expect(mapping?.outcome).toBe('refused');
    expect(mapping?.reason).toMatch(/chart of accounts/);
  });

  it('refuses a pattern whose representative carries residue, with the sanitizer reason', async () => {
    const dirty = docPatternSubject({ layout: 'grid' });
    for (const tenant of [TENANTS.A, TENANTS.B, TENANTS.C]) {
      await h.database.withService((db) =>
        insertItem(db, { scope: 'tenant', tenant_id: tenant.id, type: 'extraction_failure_pattern', ...dirty, rule: { doc_structure: { layout: 'grid' }, error_signature: 'ocr', recovery_strategy: 'call Rossi' }, rule_text: 'x', supporting_context: {}, confidence: 0.5, status: 'active' }),
      );
    }
    const report = await promote();
    const decision = report.decisions.find((d) => d.subject_key === dirty.subject_key);
    expect(decision?.outcome).toBe('refused');
    expect(decision?.reason).toMatch(/not a structural identifier/);
  });

  it('the promotion endpoint requires the service token', async () => {
    expect((await h.tenant(TENANTS.A.id).post('/promotion/run')).status).toBe(403);
    expect((await h.service().post<PromotionReport>('/promotion/run')).status).toBe(200);
  });
});
