import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { KnowledgeItem } from '../src/internal/knowledge/types.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, expect, main, ROSSI_INVOICE, say, show, step, TENANTS, title } from './harness.js';
import { correctionToTenantKnowledge } from './shared.js';

await main(async () => {
  const h = await createHarness();
  title('Scenario 1: correction -> tenant knowledge -> improved next run');
  const { itemId, runId } = await correctionToTenantKnowledge(h);
  const a = h.tenant(TENANTS.A.id);

  step('The reviewer accepts the improved run (kind=accepted): applied knowledge is reinforced');
  const accepted = data(await a.post<FeedbackResult>('/feedback', { run_id: runId, kind: 'accepted', reviewer_id: 'anna@alpha' }));
  const item = data(await a.get<KnowledgeItem>(`/knowledge/${itemId}`));
  show('reinforced', { reinforced_item_ids: accepted.reinforced_item_ids, evidence_count: item.evidence_count, confidence: item.confidence });
  expect(item.evidence_count === 2 && item.confidence > 0.5, 'evidence_count and confidence increased');

  step('The same feedback sent twice is idempotent; a different decision for the same run is refused');
  const replay = data(await a.post<FeedbackResult>('/feedback', { run_id: runId, kind: 'accepted', reviewer_id: 'anna@alpha' }));
  say(replay.notes.join('; '));
  const after = data(await a.get<KnowledgeItem>(`/knowledge/${itemId}`));
  expect(replay.idempotent_replay && after.evidence_count === 2, 'the replay changed nothing');
  const contradiction = await a.post<FeedbackResult>('/feedback', { run_id: runId, kind: 'rejected', reviewer_id: 'anna@alpha' });
  expect(contradiction.status === 409 && contradiction.error?.code === 'run_already_reviewed', 'a second, different decision for the run is a 409');

  step('A retried run with the same Idempotency-Key returns the run already created, nothing executes twice');
  const key = { 'idempotency-key': 'inv-a-7-attempt' };
  const first = await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-7' }, key);
  const retry = await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-7' }, key);
  show('first / retry', { first: { status: first.status, run_id: first.data?.run_id, replayed: first.data?.replayed }, retry: { status: retry.status, run_id: retry.data?.run_id, replayed: retry.data?.replayed } });
  expect(first.status === 201 && retry.status === 200 && first.data?.run_id === retry.data?.run_id && retry.data?.replayed === true, 'same run id, 201 then 200 with replayed=true');

  step('One correction can teach three different things: an account, a vendor booking value and a naming template');
  const run = data(await a.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-77', total: 480 } }, invoice_ref: 'INV-A-4' }));
  const learned = data(
    await a.post<FeedbackResult>('/feedback', {
      run_id: run.run_id,
      kind: 'adjusted',
      reviewer_id: 'anna@alpha',
      diff: {
        account: { before: '6000', after: '6100' },
        cost_center: { before: null, after: 'CC-LOGISTICS' },
        booking_text: { before: null, after: 'Bianchi Logistics / B-77' },
      },
    }),
  );
  show(
    'candidates',
    learned.created_items.map((c) => ({ type: c.type, subject_key: c.subject_key, rule: c.rule })),
  );
  const byType = new Map(learned.created_items.map((c) => [c.type, c]));
  expect(byType.get('account_mapping')?.subject_key === 'vendor=bianchi-logistics|account', 'the account is a vendor-scoped mapping');
  expect(byType.get('booking_rule')?.subject_key === 'vendor=bianchi-logistics|booking:cost_center', 'the cost center is a vendor-scoped booking rule, never a tenant-wide one');
  expect((byType.get('naming_convention')?.rule as { template: string }).template === '{vendor} / {invoice_number}', 'the booking text became a template, not the literal text');
  for (const candidate of learned.created_items) data(await a.post(`/knowledge/${candidate.id}/accept`, { reviewer_id: 'anna@alpha' }));

  step('The next Bianchi invoice gets all three, with the template rendered from ITS values');
  const next = data(await a.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-78', total: 90 } }, invoice_ref: 'INV-A-5' }));
  show('suggestion', next.suggestion);
  expect(next.suggestion.account === '6100' && next.suggestion.fields['cost_center'] === 'CC-LOGISTICS', 'account and cost center applied');
  expect(next.suggestion.fields['booking_text'] === 'Bianchi Logistics / B-78', 'booking text rendered for invoice B-78, not copied from B-77');

  step('The naming template is tenant-wide; the booking value is not: a Rossi invoice gets the text but not the cost center');
  const rossi = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-6' }));
  show('suggestion', rossi.suggestion);
  expect(rossi.suggestion.fields['booking_text'] === 'Rossi S.p.A. / R-1001' && rossi.suggestion.fields['cost_center'] === undefined, 'template applied, Bianchi cost center not applied');

  step('Tenant B never sees tenant A knowledge');
  const b = h.tenant(TENANTS.B.id);
  const runB = data(await b.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-B-1' }));
  expect(runB.suggestion.account === '6000' && runB.retrieved_knowledge.length === 0, 'tenant B still gets 6000 and retrieves nothing (row-level security)');
  await h.finish();
});
