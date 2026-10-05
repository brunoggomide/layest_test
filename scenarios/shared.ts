import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { AcceptOutcome } from '../src/internal/knowledge/lifecycle.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { data, expect, ROSSI_INVOICE, short, show, step, TENANTS, type Harness } from './harness.js';

/** The core of scenario 1, replayed by scenario 3: returns the active account_mapping of tenant A for vendor Rossi. */
export async function correctionToTenantKnowledge(h: Harness): Promise<{ itemId: string; runId: string }> {
  const a = h.tenant(TENANTS.A.id);

  step('Tenant A runs an invoice from vendor Rossi with no prior knowledge');
  const run1 = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-1' }));
  show('suggestion', run1.suggestion);
  show('retrieval anchors', run1.anchors);
  expect(run1.suggestion.account === '6000', 'the agent falls back to its default account 6000');
  expect(run1.applied_knowledge.length === 0, 'no knowledge applied: nothing learned yet');

  step('The reviewer corrects the account 6000 -> 6820 (POST /feedback kind=adjusted)');
  const feedback = data(
    await a.post<FeedbackResult>('/feedback', {
      run_id: run1.run_id,
      kind: 'adjusted',
      diff: { account: { before: '6000', after: '6820' } },
      reviewer_id: 'anna@alpha',
    }),
  );
  const candidate = feedback.created_items[0];
  if (candidate === undefined) throw new Error('no candidate created');
  show('candidate produced by the extractor', { id: candidate.id, type: candidate.type, subject_key: candidate.subject_key, status: candidate.status, rule: candidate.rule, rule_text: candidate.rule_text, confidence: candidate.confidence });
  expect(candidate.type === 'account_mapping' && candidate.status === 'candidate', 'an account_mapping candidate, not active knowledge');

  step('A candidate is inert: the same invoice still yields 6000');
  const run2 = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-2' }));
  expect(run2.suggestion.account === '6000' && run2.retrieved_knowledge.length === 0, 'candidates never influence a run before review');

  step('The reviewer accepts the candidate (POST /knowledge/:id/accept)');
  const accepted = data(await a.post<AcceptOutcome>(`/knowledge/${candidate.id}/accept`, { reviewer_id: 'anna@alpha' }));
  show('accept outcome', { status: accepted.status, item: { id: accepted.item.id, status: accepted.item.status, version: accepted.item.version, activated_at: accepted.item.activated_at } });
  expect(accepted.status === 'active', 'no other active item holds the slot, so accepted -> active immediately');

  step('Tenant A runs the same vendor again');
  const run3 = data(await a.post<RunResponse>('/runs', { invoice: { ...ROSSI_INVOICE, fields: { ...ROSSI_INVOICE.fields, invoice_number: 'R-1002' } }, invoice_ref: 'INV-A-3' }));
  show('suggestion', run3.suggestion);
  show('applied_knowledge', run3.applied_knowledge);
  expect(run3.suggestion.account === '6820', 'the agent now suggests 6820');
  expect(run3.applied_knowledge.some((k) => k.id === candidate.id && k.version === 1), `the trace names item ${short(candidate.id)} v1 as applied`);
  return { itemId: candidate.id, runId: run3.run_id };
}
