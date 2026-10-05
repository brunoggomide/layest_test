import type { FeedbackResult } from '../src/internal/feedback/ingest.js';
import type { AcceptOutcome } from '../src/internal/knowledge/lifecycle.js';
import type { KnowledgeItem } from '../src/internal/knowledge/types.js';
import type { RunResponse } from '../src/internal/runs/types.js';
import { createHarness, data, expect, main, ROSSI_INVOICE, say, show, step, TENANTS, title } from './harness.js';
import { correctionToTenantKnowledge } from './shared.js';

const summary = (i: KnowledgeItem): Record<string, unknown> => ({ id: i.id, status: i.status, version: i.version, supersedes_id: i.supersedes_id, rule: i.rule });

await main(async () => {
  const h = await createHarness();
  title('Scenario 3: review / edit / reject / disable, conflicts, and immutable version history');
  say('(replaying scenario 1 to obtain an active account_mapping v1 for tenant A)');
  const { itemId: v1 } = await correctionToTenantKnowledge(h);
  const a = h.tenant(TENANTS.A.id);

  step('The reviewer edits v1: 6820 -> 6825 (POST /knowledge/:id/edit) creates a NEW row, v2, as a candidate');
  const edit = data(await a.post<KnowledgeItem>(`/knowledge/${v1}/edit`, { rule: { account: '6825' }, rule_text: 'Vendor Rossi maps to account 6825', reviewer_id: 'anna@alpha' }));
  const v2 = edit.id;
  show('v2', summary(edit));
  expect(edit.version === 2 && edit.supersedes_id === v1 && edit.status === 'candidate', 'v2 is a candidate with version 2 pointing at v1');
  const v1Untouched = data(await a.get<KnowledgeItem>(`/knowledge/${v1}`));
  expect(v1Untouched.status === 'active' && (v1Untouched.rule as { account: string }).account === '6820', 'v1 is untouched: still active, still 6820');

  step('An edit that does not fit the type is refused before it can ever become active');
  const bad = await a.post<KnowledgeItem>(`/knowledge/${v1}/edit`, { rule: { acount: '6825' }, rule_text: 'typo', reviewer_id: 'anna@alpha' });
  expect(bad.status === 400 && bad.error?.code === 'validation_error', `malformed rule rejected with 400 (${bad.error?.message})`);

  step('While v2 is a candidate, runs still use v1');
  const runV1 = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-10' }));
  expect(runV1.suggestion.account === '6820' && runV1.applied_knowledge[0]?.version === 1, 'suggestion 6820 from v1');

  step('The reviewer accepts v2: v2 -> active, v1 -> superseded (an item\'s own predecessor is not a conflict)');
  const acc = data(await a.post<AcceptOutcome>(`/knowledge/${v2}/accept`, { reviewer_id: 'anna@alpha' }));
  show('accept outcome', { status: acc.status, superseded_id: acc.superseded_id });
  const v1After = data(await a.get<KnowledgeItem>(`/knowledge/${v1}`));
  expect(acc.status === 'active' && v1After.status === 'superseded', 'v2 active, v1 superseded');
  const runV2 = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-11' }));
  expect(runV2.suggestion.account === '6825' && runV2.applied_knowledge[0]?.version === 2, 'suggestion 6825 from v2');

  step('A second reviewer corrects to 6830: the candidate is marked as conflicting, never auto-applied');
  const conflicting = data(await a.post<FeedbackResult>('/feedback', { run_id: runV2.run_id, kind: 'adjusted', diff: { account: { before: '6825', after: '6830' } }, reviewer_id: 'marco@alpha' }));
  const c = conflicting.created_items[0];
  if (c === undefined) throw new Error('no conflicting candidate');
  show('candidate', { id: c.id, rule: c.rule, conflicts_with: c.supporting_context['conflicts_with'] });
  expect(c.supporting_context['conflicts_with'] === v2 && conflicting.contested_item_ids.length === 0, 'conflicts_with points at the active v2');
  const held = data(await a.post<AcceptOutcome>(`/knowledge/${c.id}/accept`, { reviewer_id: 'marco@alpha' }));
  expect(held.status === 'accepted' && held.pending_conflict_with === v2, 'accepting it parks it as accepted with pending_conflict_with; v2 stays active');
  const resolved = data(await a.post<AcceptOutcome>(`/knowledge/${c.id}/resolve-conflict`, { winner: 'existing', reviewer_id: 'anna@alpha' }));
  expect(resolved.status === 'rejected', "resolve-conflict {winner: 'existing'} rejects the newcomer; 'new' would supersede v2");

  step('The reviewer rejects a bogus candidate; a rejected item cannot be revived');
  const bogus = data(await a.post<FeedbackResult>('/feedback', { run_id: runV1.run_id, kind: 'adjusted', diff: { cost_center: { before: null, after: 'CC-TEMP' } }, reviewer_id: 'anna@alpha' }));
  const bogusId = bogus.created_items[0]?.id;
  if (bogusId === undefined) throw new Error('no bogus candidate');
  const rejected = data(await a.post<KnowledgeItem>(`/knowledge/${bogusId}/reject`, { reviewer_id: 'anna@alpha' }));
  expect(rejected.status === 'rejected', 'bogus candidate rejected');
  const revive = await a.post<AcceptOutcome>(`/knowledge/${bogusId}/accept`, { reviewer_id: 'anna@alpha' });
  expect(revive.status === 409 && revive.error?.code === 'invalid_transition', 'accepting a rejected item is a 409');

  step('The reviewer disables v2 (soft delete: the row stays, the slot is free, the agent falls back)');
  const disabled = data(await a.post<KnowledgeItem>(`/knowledge/${v2}/disable`, { reviewer_id: 'anna@alpha' }));
  expect(disabled.status === 'disabled', 'v2 disabled');
  const runAfter = data(await a.post<RunResponse>('/runs', { invoice: ROSSI_INVOICE, invoice_ref: 'INV-A-12' }));
  expect(runAfter.suggestion.account === '6000' && runAfter.retrieved_knowledge.length === 0, 'back to the default 6000, nothing retrieved');

  step('GET /knowledge/:id/history walks the version chain from either end');
  const fromV1 = data(await a.get<KnowledgeItem[]>(`/knowledge/${v1}/history`));
  const fromV2 = data(await a.get<KnowledgeItem[]>(`/knowledge/${v2}/history`));
  show('history (from v1)', fromV1.map(summary));
  expect(fromV1.length === 2 && fromV2.length === 2 && fromV1[0]?.id === v1 && fromV1[1]?.id === v2, 'both directions yield [v1 superseded, v2 disabled]');

  step('A past run stays explainable after the edits: its trace pins the version it used');
  const detail = data(await a.get<{ trace: Array<{ knowledge_item_id: string; version: number; role: string; current_status: string }> }>(`/runs/${runV1.run_id}`));
  show('trace of the run that used v1', detail.trace);
  expect(detail.trace.some((t) => t.knowledge_item_id === v1 && t.version === 1 && t.current_status === 'superseded'), 'the run still says "v1", and v1 is now superseded');
  await h.finish();
});
