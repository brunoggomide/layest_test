import { describe, expect, it } from 'vitest';
import { deterministicExtractor } from '../src/internal/feedback/extract.js';
import { inferTemplate } from '../src/internal/feedback/extract-adjusted.js';
import { parseRule } from '../src/internal/knowledge/rules.js';
import type { KnowledgeCandidate } from '../src/internal/knowledge/types.js';
import type { Invoice, RunRow, Suggestion } from '../src/internal/runs/types.js';

const ROSSI: Invoice = { vendor: 'Rossi S.p.A.', fields: { invoice_number: 'R-1001', total: 1200.5, net_total: 1000, due_date: '2026-10-01' } };

function run(invoice: Invoice, suggestion: Partial<Suggestion> = {}): RunRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    invoice_ref: 'INV-1',
    idempotency_key: null,
    input: { invoice },
    output: { suggestion: { account: '6000', fields: { ...invoice.fields }, notes: [], ...suggestion }, anchors: [], applied_knowledge: [], retrieved_knowledge: [], shadowed_global_knowledge: [] },
    status: 'pending_review',
    created_at: new Date(),
  };
}

async function adjusted(diff: Record<string, { before: unknown; after: unknown }>, invoice: Invoice = ROSSI): Promise<KnowledgeCandidate[]> {
  const result = await deterministicExtractor.extract({ kind: 'adjusted', run: run(invoice), diff: diff as never, error: null });
  // Every candidate the extractor emits must be a rule the agent can apply.
  for (const candidate of result.candidates) parseRule(candidate.type, candidate.rule);
  return result.candidates;
}

describe('adjusted runs', () => {
  it('an account change is a vendor-scoped account mapping', async () => {
    const [candidate] = await adjusted({ account: { before: '6000', after: 6820 } });
    expect(candidate).toMatchObject({ type: 'account_mapping', anchor: 'vendor=rossi', subject_key: 'vendor=rossi|account', rule: { account: '6820' }, confidence: 0.5 });
  });

  it('a field value is a booking rule for THAT vendor, never for the whole tenant', async () => {
    const [candidate] = await adjusted({ cost_center: { before: null, after: 'CC-7' } });
    expect(candidate).toMatchObject({ type: 'booking_rule', subject_key: 'vendor=rossi|booking:cost_center', rule: { field: 'cost_center', value: 'CC-7' } });
  });

  it('text that embeds invoice values becomes a tenant-wide template, longest values first', async () => {
    const [candidate] = await adjusted({ booking_text: { before: null, after: 'Rossi S.p.A. - R-1001 (1001)' } });
    expect(candidate).toMatchObject({ type: 'naming_convention', anchor: 'tenant', subject_key: 'tenant|naming:booking_text', rule: { field: 'booking_text', template: '{vendor} - {invoice_number} (1001)' } });
  });

  it('a value copied from another field is a field mapping', async () => {
    const [candidate] = await adjusted({ amount: { before: null, after: 1000 } });
    expect(candidate).toMatchObject({ type: 'field_mapping', subject_key: 'vendor=rossi|field_mapping:amount', rule: { from: 'net_total', to: 'amount' } });
  });

  it('ignores no-op changes and unusable accounts, and explains why', async () => {
    const result = await deterministicExtractor.extract({ kind: 'adjusted', run: run(ROSSI), diff: { total: { before: 1, after: 1 }, account: { before: '6000', after: null } }, error: null });
    expect(result.candidates).toHaveLength(0);
    expect(result.notes.join(' ')).toMatch(/before equals after/);
    expect(result.notes.join(' ')).toMatch(/no usable account value/);
  });

  it('template inference never substitutes inside an already placed placeholder', () => {
    const invoice: Invoice = { vendor: 'Alpha', fields: { kind: 'vendor', ref: 'Alpha-77' } };
    expect(inferTemplate('Alpha-77 vendor', invoice)).toBe('{ref} {kind}');
    expect(inferTemplate('nothing known here', invoice)).toBeNull();
  });
});

describe('rejected runs', () => {
  it('a rejected account becomes a veto for the vendor', async () => {
    const result = await deterministicExtractor.extract({ kind: 'rejected', run: run(ROSSI), diff: null, error: null });
    expect(result.candidates[0]).toMatchObject({ type: 'account_veto', subject_key: 'vendor=rossi|account', rule: { forbidden_accounts: ['6000'] }, confidence: 0.3 });
  });

  it('a rejected UNMAPPED suggestion has nothing to forbid', async () => {
    const result = await deterministicExtractor.extract({ kind: 'rejected', run: run(ROSSI, { account: 'UNMAPPED' }), diff: null, error: null });
    expect(result.candidates).toHaveLength(0);
    expect(result.notes[0]).toMatch(/no account to forbid/);
  });
});

describe('failed runs', () => {
  const DOC = { layout: 'Table', header: false, columns: 5, vendor_hint: 'Rossi' };

  it('a transient error creates nothing', async () => {
    const result = await deterministicExtractor.extract({ kind: 'failed', run: run(ROSSI), diff: null, error: { code: 'timeout', message: 'slow' } });
    expect(result.candidates).toHaveLength(0);
    expect(result.notes[0]).toMatch(/transient/);
  });

  it('a structural error keeps structural facts only, lower-cased, and drops prose', async () => {
    const error = { code: 'MISSING_FIELD', message: 'IBAN IT60X0542811101000000123456 for Rossi', missing_field: 'Total Amount', doc_type: 'Invoice', doc_structure: DOC, suggested_recovery: 'Sum Line Items' };
    const [candidate] = (await deterministicExtractor.extract({ kind: 'failed', run: run(ROSSI), diff: null, error })).candidates;
    expect(candidate?.anchor).toMatch(/^doc_pattern=[0-9a-f]{40}$/);
    expect(candidate?.rule).toEqual({ doc_structure: { layout: 'table', header: false, columns: 5 }, error_signature: 'missing_field' });
    expect(candidate?.supporting_context).toEqual({ doc_type: 'invoice' });
    expect(JSON.stringify(candidate)).not.toMatch(/Rossi|IBAN|vendor_hint|Total Amount|Sum Line/);
  });

  it('identifiers survive: missing_field and recovery are kept when they are identifiers', async () => {
    const error = { code: 'MISSING_FIELD', missing_field: 'total_amount', doc_structure: DOC, suggested_recovery: 'sum_line_items' };
    const [candidate] = (await deterministicExtractor.extract({ kind: 'failed', run: run(ROSSI), diff: null, error })).candidates;
    expect(candidate?.rule).toMatchObject({ error_signature: 'missing_field:total_amount', missing_field: 'total_amount', recovery_strategy: 'sum_line_items' });
    if (candidate !== undefined) parseRule(candidate.type, candidate.rule);
  });

  it('the same structure yields the same pattern whatever the key order or the extra keys', async () => {
    const a = (await deterministicExtractor.extract({ kind: 'failed', run: run(ROSSI), diff: null, error: { code: 'X', doc_structure: { columns: 5, header: false, layout: 'table' } } })).candidates[0];
    const b = (await deterministicExtractor.extract({ kind: 'failed', run: run(ROSSI), diff: null, error: { code: 'X', doc_structure: DOC } })).candidates[0];
    expect(a?.subject_key).toBe(b?.subject_key);
  });
});
