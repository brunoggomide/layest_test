import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { AcceptOutcome } from '../src/internal/knowledge/lifecycle.js';
import type { KnowledgeItem } from '../src/internal/knowledge/types.js';
import type { PromotionReport } from '../src/internal/promotion/promote.js';
import { formatPromotionReport } from '../src/internal/promotion/report.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, expect, main, ROSSI_INVOICE, say, show, step, TENANTS, title, type Harness } from './harness.js';

const DOC = { layout: 'table', header: false, columns: 5 };
const SOURCES = [
  { tenant: TENANTS.B, vendor: 'Bianchi Logistics' },
  { tenant: TENANTS.C, vendor: 'Chen Trading Co' },
  { tenant: TENANTS.D, vendor: 'Dupont SARL' },
] as const;

async function tenantLearnsFailurePattern(h: Harness, tenantId: string, vendor: string): Promise<string> {
  const t = h.tenant(tenantId);
  const run = data(await t.post<RunResponse>('/runs', { invoice: { vendor, fields: { invoice_number: `${vendor.slice(0, 2).toUpperCase()}-1`, line_items: 3 }, doc_structure: DOC } }));
  const fb = data(
    await t.post<FeedbackResult>('/feedback', {
      run_id: run.run_id,
      kind: 'failed',
      reviewer_id: 'pipeline',
      error: { code: 'MISSING_FIELD', missing_field: 'total_amount', doc_type: 'invoice', doc_structure: DOC, suggested_recovery: 'sum_line_items', message: `vendor ${vendor} total missing` },
    }),
  );
  const id = fb.created_items[0]?.id;
  if (id === undefined) throw new Error('no candidate');
  data(await t.post(`/knowledge/${id}/accept`, { reviewer_id: 'reviewer' }));
  return id;
}

async function tenantMapsRossi(h: Harness, tenantId: string): Promise<void> {
  const t = h.tenant(tenantId);
  const run = data(await t.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE }));
  const fb = data(await t.post<FeedbackResult>('/feedback', { run_id: run.run_id, kind: 'adjusted', diff: { account: { before: '6000', after: '6820' } }, reviewer_id: 'reviewer' }));
  const id = fb.created_items[0]?.id;
  if (id === undefined) throw new Error('no candidate');
  data(await t.post(`/knowledge/${id}/accept`, { reviewer_id: 'reviewer' }));
}

await main(async () => {
  const h = await createHarness();
  title('Scenario 4: a safely generalized global item, and a refused counter-example');
  const platform = h.service();

  step('Tenants B, C and D independently hit the same structural failure; each reviewer accepts the tenant pattern');
  for (const source of SOURCES) say(`${source.tenant.name}: active extraction_failure_pattern ${await tenantLearnsFailurePattern(h, source.tenant.id, source.vendor)}`);

  step('The platform runs the promotion job (POST /promotion/run, service token; also `npm run promote`)');
  const report = data(await platform.post<PromotionReport>('/promotion/run'));
  for (const line of formatPromotionReport(report)) say(line);
  const promoted = report.decisions.find((d) => d.outcome === 'promoted');
  if (promoted?.global_item_id === undefined) throw new Error('nothing promoted');
  expect(promoted.tenant_ids.length === 3 && promoted.sanitizer?.ok === true, 'cross-tenant gate (3 distinct tenants) and sanitizer passed');

  step('The global candidate as stored: scope=global, tenant_id=null, structural facts only');
  const g = data(await platform.get<KnowledgeItem>(`/knowledge/${promoted.global_item_id}`));
  show('global candidate', { id: g.id, scope: g.scope, tenant_id: g.tenant_id, status: g.status, distinct_tenant_count: g.distinct_tenant_count, evidence_count: g.evidence_count, subject_key: g.subject_key, rule: g.rule, rule_text: g.rule_text, supporting_context: g.supporting_context });
  expect(g.scope === 'global' && g.tenant_id === null && g.status === 'candidate', 'global, tenant-less, and still a candidate: the human gate remains');
  expect(!/Bianchi|Chen|Dupont|Beta|Gamma|Delta/.test(JSON.stringify(g)), 'no tenant or vendor name in the global item');

  step('A tenant reviewer cannot accept a global item; the platform reviewer can');
  const denied = await h.tenant(TENANTS.B.id).post<AcceptOutcome>(`/knowledge/${g.id}/accept`, { reviewer_id: 'bruno@beta' });
  expect(denied.status === 403, `tenant accept refused with 403 (${denied.error?.code})`);
  const activated = data(await platform.post<AcceptOutcome>(`/knowledge/${g.id}/accept`, { reviewer_id: 'platform-reviewer' }));
  expect(activated.status === 'active', 'service accept -> global active');

  step('Tenant E, which never saw this document type, runs an invoice with the same structure');
  const runE = data(await h.tenant(TENANTS.E.id).post<RunResponse>('/runs', { invoice: { vendor: 'Evergreen Farms', fields: { invoice_number: 'EV-1', line_items: 6 }, doc_structure: DOC } }));
  show('suggestion', runE.suggestion);
  show('applied_knowledge', runE.applied_knowledge.map((k) => ({ id: k.id, scope: k.scope, type: k.type, version: k.version })));
  expect(runE.suggestion.recovery_strategy === 'sum_line_items' && runE.applied_knowledge.some((k) => k.id === g.id && k.scope === 'global'), 'the recovery strategy came from GLOBAL knowledge, and the trace says so');

  step('Tenant B keeps its own pattern: on the same slot the tenant item shadows the global one');
  const runB = data(await h.tenant(TENANTS.B.id).post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-9', line_items: 2 }, doc_structure: DOC } }));
  expect(runB.applied_knowledge[0]?.scope === 'tenant' && runB.shadowed_global_knowledge.some((k) => k.id === g.id), 'tenant item applied; the global item reported as shadowed');

  step('Tenant E accepts the run: the global item is reinforced too (by the service role, never by the tenant connection)');
  const okE = data(await h.tenant(TENANTS.E.id).post<FeedbackResult>('/feedback', { run_id: runE.run_id, kind: 'accepted', reviewer_id: 'eve@epsilon' }));
  const gAfter = data(await platform.get<KnowledgeItem>(`/knowledge/${g.id}`));
  expect(okE.reinforced_item_ids.includes(g.id) && gAfter.evidence_count === g.evidence_count + 1, `global evidence_count ${g.evidence_count} -> ${gAfter.evidence_count}`);

  step('Counter-example: tenants B, C and D all map vendor Rossi to 6820. Same evidence, refused.');
  for (const source of SOURCES) await tenantMapsRossi(h, source.tenant.id);
  const second = data(await platform.post<PromotionReport>('/promotion/run'));
  for (const line of formatPromotionReport(second)) say(line);
  const refused = second.decisions.find((d) => d.type === 'account_mapping');
  expect(refused?.outcome === 'refused', `account_mapping refused: ${refused?.reason ?? 'n/a'}`);
  const skipped = second.decisions.find((d) => d.type === 'extraction_failure_pattern');
  expect(skipped?.outcome === 'skipped', 'the document pattern is skipped: a global item already exists for the slot');
  await h.finish();
});
