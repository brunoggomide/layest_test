import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { AcceptOutcome } from '../src/internal/knowledge/lifecycle.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, expect, main, say, show, step, TENANTS, title } from './harness.js';

const DOC = { layout: 'table', header: false, columns: 5 };

await main(async () => {
  const h = await createHarness();
  title('Scenario 2: failed run -> sanitized candidate | transient failure -> nothing | rejected run -> veto');
  const b = h.tenant(TENANTS.B.id);

  step('Tenant B runs a table-layout invoice without a header row');
  const run1 = data(await b.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-77', line_items: 3 }, doc_structure: DOC }, invoice_ref: 'INV-B-77' }));
  show('retrieval anchors (doc_pattern is a sha1 of the sorted structural features)', run1.anchors);

  step('Extraction fails structurally: MISSING_FIELD total_amount. The error payload is deliberately dirty.');
  const failed = data(
    await b.post<FeedbackResult>('/feedback', {
      run_id: run1.run_id,
      kind: 'failed',
      reviewer_id: 'pipeline',
      error: {
        code: 'MISSING_FIELD',
        message: 'total_amount not found. vendor=Bianchi Logistics IBAN IT60X0542811101000000123456 amount 1.234,00 EUR contact ops@bianchi.example',
        missing_field: 'total_amount',
        doc_type: 'Invoice',
        doc_structure: { ...DOC, vendor_hint: 'Bianchi' },
        suggested_recovery: 'sum_line_items',
        raw_invoice_text: 'Bianchi Logistics ... 1.234,00 EUR ...',
      },
    }),
  );
  const pattern = failed.created_items[0];
  if (pattern === undefined) throw new Error('no candidate created');
  show('classification', failed.classification);
  show('candidate', { id: pattern.id, type: pattern.type, subject_key: pattern.subject_key, status: pattern.status, confidence: pattern.confidence, rule: pattern.rule, rule_text: pattern.rule_text, supporting_context: pattern.supporting_context });
  const serialized = JSON.stringify(pattern.rule) + JSON.stringify(pattern.supporting_context) + pattern.rule_text;
  expect(!/Bianchi|IBAN|IT60|1\.234|@|vendor_hint/.test(serialized), 'no vendor name, IBAN, amount, email or unknown feature entered the candidate');
  expect((pattern.rule as { recovery_strategy?: string }).recovery_strategy === 'sum_line_items', 'the suggested recovery is stored as rule.recovery_strategy');

  step('A transient failure (TIMEOUT) is recorded on the run but creates no knowledge');
  const run2 = data(await b.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-78' }, doc_structure: DOC }, invoice_ref: 'INV-B-78' }));
  const timeout = data(await b.post<FeedbackResult>('/feedback', { run_id: run2.run_id, kind: 'failed', reviewer_id: 'pipeline', error: { code: 'TIMEOUT', message: 'upstream OCR timed out after 30s' } }));
  show('result', { classification: timeout.classification, created_items: timeout.created_items.length, notes: timeout.notes });
  expect(timeout.classification === 'transient' && timeout.created_items.length === 0, 'transient: nothing created');

  step('A rejected run (no correction given) creates an account_veto candidate');
  const run3 = data(await b.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-79', total: 480 } }, invoice_ref: 'INV-B-79' }));
  show('suggestion that gets rejected', run3.suggestion);
  const rejected = data(await b.post<FeedbackResult>('/feedback', { run_id: run3.run_id, kind: 'rejected', reviewer_id: 'bruno@beta' }));
  const veto = rejected.created_items[0];
  if (veto === undefined) throw new Error('no veto created');
  show('veto candidate', { id: veto.id, type: veto.type, subject_key: veto.subject_key, confidence: veto.confidence, rule: veto.rule, rule_text: veto.rule_text });
  expect(veto.type === 'account_veto' && veto.confidence === 0.3, 'an account_veto with confidence 0.3');

  step('The reviewer accepts the veto: the agent stops suggesting the forbidden account and asks instead');
  data(await b.post<AcceptOutcome>(`/knowledge/${veto.id}/accept`, { reviewer_id: 'bruno@beta' }));
  const run4 = data(await b.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-80', total: 90 } }, invoice_ref: 'INV-B-80' }));
  show('suggestion', run4.suggestion);
  expect(run4.suggestion.account === 'UNMAPPED', 'forbidden account 6000 replaced by UNMAPPED');

  step('Rejecting an UNMAPPED suggestion teaches nothing new, and says so');
  const again = data(await b.post<FeedbackResult>('/feedback', { run_id: run4.run_id, kind: 'rejected', reviewer_id: 'bruno@beta' }));
  say(again.notes.join('; '));
  expect(again.created_items.length === 0 && again.contested_item_ids.includes(veto.id), 'no candidate; the applied veto is marked as contested for the reviewer to see');

  step('The reviewer accepts the failure pattern; the next run with the same structure carries the recovery strategy');
  const acc = data(await b.post<AcceptOutcome>(`/knowledge/${pattern.id}/accept`, { reviewer_id: 'bruno@beta' }));
  say(`pattern ${pattern.id} -> ${acc.status}`);
  const run5 = data(await b.post<RunResponse>('/runs', { invoice: { vendor: 'Bianchi Logistics', fields: { invoice_number: 'B-81', line_items: 4 }, doc_structure: DOC }, invoice_ref: 'INV-B-81' }));
  show('suggestion', run5.suggestion);
  expect(run5.suggestion.recovery_strategy === 'sum_line_items', 'recovery_strategy applied from the extraction_failure_pattern');
  await h.finish();
});
