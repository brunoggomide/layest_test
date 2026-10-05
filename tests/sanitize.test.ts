import { describe, expect, it } from 'vitest';
import { sanitizeForGlobal } from '../src/internal/promotion/sanitize.js';

const KNOWN = ['Alpha Srl', 'Rossi S.p.A.', 'Bianchi Logistics'];

describe('global sanitizer', () => {
  it('rejects an account mapping: nothing structural survives the allowlist', () => {
    const result = sanitizeForGlobal({ rule: { account: '6820' }, supporting_context: { vendor: 'Rossi S.p.A.' } }, KNOWN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/empty after stripping/);
      expect(result.stripped).toEqual(expect.arrayContaining(['rule.account', 'supporting_context.vendor']));
    }
  });

  it('rejects prose in a structural slot', () => {
    const result = sanitizeForGlobal({ rule: { doc_structure: { layout: 'table' }, error_signature: 'missing_field', recovery_strategy: 'ask Giovanni for the total' }, supporting_context: {} }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a structural identifier/);
  });

  it('rejects identifiers that are not structure: IBAN, email, amounts, long numbers', () => {
    const cases: Array<[string, RegExp]> = [
      ['it60x0542811101000000123456', /iban/],
      ['ops@bianchi.example', /not a structural identifier/],
      ['123456789', /long_number/],
    ];
    for (const [value, reason] of cases) {
      const result = sanitizeForGlobal({ rule: { doc_structure: { layout: 'table' }, error_signature: 'missing_field', missing_field: value }, supporting_context: {} }, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    }
  });

  it('rejects a known tenant or vendor name that leaked into an allowlisted field', () => {
    const result = sanitizeForGlobal({ rule: { doc_structure: { layout: 'table' }, error_signature: 'missing_field', missing_field: 'total_for_rossi' }, supporting_context: {} }, KNOWN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/known tenant\/vendor name 'rossi'/);
  });

  it('accepts a structural failure pattern, strips the rest and regenerates the text from structure only', () => {
    const result = sanitizeForGlobal(
      {
        rule: { doc_structure: { layout: 'table', header: false, columns: 5, vendor_hint: 'Rossi' }, missing_field: 'total_amount', error_signature: 'missing_field:total_amount', recovery_strategy: 'sum_line_items', invoice_ref: 'INV-1' },
        supporting_context: { doc_type: 'invoice', invoice_total: '1.234,00', vendor: 'Rossi' },
      },
      KNOWN,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rule).toEqual({ doc_structure: { layout: 'table', header: false, columns: 5 }, missing_field: 'total_amount', error_signature: 'missing_field:total_amount', recovery_strategy: 'sum_line_items' });
      expect(result.supporting_context).toEqual({ doc_type: 'invoice' });
      expect(result.rule_text).toBe("Documents with structure {layout=table, header=false, columns=5}; fail with missing_field:total_amount; recover with 'sum_line_items'");
      expect(result.stripped).toEqual(expect.arrayContaining(['rule.invoice_ref', 'rule.doc_structure.vendor_hint', 'supporting_context.invoice_total', 'supporting_context.vendor']));
    }
  });
});
