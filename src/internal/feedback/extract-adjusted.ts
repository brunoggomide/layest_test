import { jsonEqual, type JsonValue } from '../../shared/json.js';
import { accountSubject, bookingSubject, fieldMappingSubject, namingSubject } from '../knowledge/keys.js';
import type { KnowledgeCandidate } from '../knowledge/types.js';
import type { Invoice, RunRow } from '../runs/types.js';
import type { ExtractionResult } from './extract.js';
import type { FeedbackDiff } from './types.js';

/**
 * What a correction teaches, from the narrowest reading to the widest:
 *   account changed            -> account_mapping for the vendor
 *   value equals another field -> field_mapping for the vendor (the field is derived from that one)
 *   text embeds invoice values -> naming_convention for the tenant (a template, not the literal)
 *   anything else              -> booking_rule for the vendor (a literal value)
 * Never wider than the vendor unless a template proves the value is derived, not copied.
 */
const CANDIDATE_CONFIDENCE = 0.5;
const MIN_TOKEN_LENGTH = 3;

type Change = FeedbackDiff[string];

function accountCandidate(invoice: Invoice, change: Change): KnowledgeCandidate | null {
  const after = typeof change.after === 'number' ? String(change.after) : change.after;
  if (typeof after !== 'string' || after.trim() === '') return null;
  const account = after.trim();
  return {
    type: 'account_mapping',
    ...accountSubject(invoice.vendor),
    rule: { account },
    rule_text: `Vendor ${invoice.vendor} maps to account ${account} (reviewer changed ${String(change.before)} -> ${account})`,
    supporting_context: { source: 'reviewer_diff', field: 'account', before: change.before, after: account },
    confidence: CANDIDATE_CONFIDENCE,
  };
}

function sourceFieldOf(invoice: Invoice, field: string, value: JsonValue): string | null {
  for (const [name, candidate] of Object.entries(invoice.fields)) {
    if (name !== field && candidate !== null && jsonEqual(candidate, value)) return name;
  }
  return null;
}

interface Segment {
  readonly text: string;
  readonly literal: boolean;
}

/** 'Rossi S.p.A. - R-1001' with invoice values {vendor, invoice_number} -> '{vendor} - {invoice_number}'. */
export function inferTemplate(value: string, invoice: Invoice): string | null {
  const sources = [['vendor', invoice.vendor] as const, ...Object.entries(invoice.fields).flatMap(([name, v]) => (typeof v === 'string' || typeof v === 'number' ? [[name, String(v)] as const] : []))]
    .filter(([, source]) => source.length >= MIN_TOKEN_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  let segments: Segment[] = [{ text: value, literal: true }];
  let replaced = false;
  for (const [name, source] of sources) {
    segments = segments.flatMap((segment) => {
      if (!segment.literal || !segment.text.includes(source)) return [segment];
      replaced = true;
      return segment.text.split(source).flatMap((part, index) => (index === 0 ? [{ text: part, literal: true }] : [{ text: `{${name}}`, literal: false }, { text: part, literal: true }]));
    });
  }
  return replaced ? segments.map((segment) => segment.text).join('') : null;
}

function fieldCandidate(invoice: Invoice, field: string, change: Change): KnowledgeCandidate {
  const context = { source: 'reviewer_diff', field, before: change.before, after: change.after };
  const from = change.after === null ? null : sourceFieldOf(invoice, field, change.after);
  if (from !== null) {
    return {
      type: 'field_mapping',
      ...fieldMappingSubject(invoice.vendor, field),
      rule: { from, to: field },
      rule_text: `For vendor ${invoice.vendor}, field '${field}' takes its value from '${from}'`,
      supporting_context: context,
      confidence: CANDIDATE_CONFIDENCE,
    };
  }
  const template = typeof change.after === 'string' ? inferTemplate(change.after, invoice) : null;
  if (template !== null) {
    return {
      type: 'naming_convention',
      ...namingSubject(field),
      rule: { field, template },
      rule_text: `Field '${field}' follows the naming template '${template}'`,
      supporting_context: context,
      confidence: CANDIDATE_CONFIDENCE,
    };
  }
  return {
    type: 'booking_rule',
    ...bookingSubject(invoice.vendor, field),
    rule: { field, value: change.after },
    rule_text: `For vendor ${invoice.vendor}, field '${field}' is booked as ${JSON.stringify(change.after)}`,
    supporting_context: context,
    confidence: CANDIDATE_CONFIDENCE,
  };
}

export function extractAdjusted(run: RunRow, diff: FeedbackDiff): ExtractionResult {
  const invoice = run.input.invoice;
  const candidates: KnowledgeCandidate[] = [];
  const notes: string[] = [];
  for (const [field, change] of Object.entries(diff)) {
    if (jsonEqual(change.before, change.after)) {
      notes.push(`field '${field}': before equals after, ignored`);
      continue;
    }
    const candidate = field === 'account' ? accountCandidate(invoice, change) : fieldCandidate(invoice, field, change);
    if (candidate === null) notes.push(`field '${field}': no usable account value, ignored`);
    else candidates.push(candidate);
  }
  if (candidates.length === 0) notes.push('the adjustment carried no effective change');
  return { candidates, notes };
}
