import type { JsonObject, JsonValue } from '../../shared/json.js';
import { accountSubject, docPatternSubject } from '../knowledge/keys.js';
import type { KnowledgeItem, KnowledgeType } from '../knowledge/types.js';
import type { AppliedRef, Invoice, Suggestion } from './types.js';

/** The mock's own guess when nothing is known. */
const DEFAULT_ACCOUNT = '6000';
/** Emitted instead of a vetoed account: the agent asks the reviewer rather than guessing. */
export const UNMAPPED_ACCOUNT = 'UNMAPPED';

export interface AgentOutput {
  readonly suggestion: Suggestion;
  readonly applied: AppliedRef[];
}

/** Rules are applied in this order: renames first, so later rules see the final field names; vetoes last. */
const PHASES: readonly KnowledgeType[] = ['field_mapping', 'booking_rule', 'naming_convention', 'account_mapping', 'extraction_failure_pattern', 'account_veto'];

const PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;

/** '{vendor} - {invoice_number}' with the invoice's values; null when a placeholder has no value. */
function renderTemplate(template: string, invoice: Invoice, fields: JsonObject): string | null {
  let complete = true;
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = name === 'vendor' ? invoice.vendor : fields[name];
    if (value === undefined || value === null || typeof value === 'object') {
      complete = false;
      return '';
    }
    return String(value);
  });
  return complete ? rendered : null;
}

interface Draft {
  readonly invoice: Invoice;
  readonly suggestion: Suggestion;
  readonly applied: AppliedRef[];
}

function apply(draft: Draft, item: KnowledgeItem, note: string): void {
  draft.applied.push({ id: item.id, version: item.version });
  draft.suggestion.notes.push(`${item.type}#${item.id.slice(0, 8)} v${item.version}: ${note}`);
}

interface FieldUpdate {
  readonly field: string;
  readonly value: JsonValue;
  readonly note: string;
}

/** An item that leaves the field as it already is did not influence the output, so it is not "applied". */
function setField(draft: Draft, item: KnowledgeItem, update: FieldUpdate): void {
  const current = draft.suggestion.fields[update.field];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(update.value)) return;
  draft.suggestion.fields[update.field] = update.value;
  apply(draft, item, update.note);
}

function applyFieldMapping(draft: Draft, item: KnowledgeItem): void {
  const { from, to } = item.rule as { from: string; to: string };
  const value = draft.suggestion.fields[from];
  if (value !== undefined) setField(draft, item, { field: to, value, note: `field '${to}' taken from '${from}'` });
}

function applyBookingRule(draft: Draft, item: KnowledgeItem): void {
  const { field, value } = item.rule as { field: string; value: JsonValue };
  setField(draft, item, { field, value, note: `field '${field}' booked as ${JSON.stringify(value)}` });
}

function applyNaming(draft: Draft, item: KnowledgeItem): void {
  const { field, template } = item.rule as { field: string; template: string };
  const rendered = renderTemplate(template, draft.invoice, draft.suggestion.fields);
  if (rendered !== null) setField(draft, item, { field, value: rendered, note: `field '${field}' named by template '${template}'` });
}

function applyAccountMapping(draft: Draft, item: KnowledgeItem): void {
  const { account } = item.rule as { account: string };
  if (item.subject_key !== accountSubject(draft.invoice.vendor).subject_key || draft.suggestion.account === account) return;
  const previous = draft.suggestion.account;
  draft.suggestion.account = account;
  apply(draft, item, `account ${previous} -> ${account}`);
}

function applyFailurePattern(draft: Draft, item: KnowledgeItem): void {
  const { recovery_strategy } = item.rule as { recovery_strategy?: string };
  const pattern = draft.invoice.doc_structure === undefined ? null : docPatternSubject(draft.invoice.doc_structure).subject_key;
  if (item.subject_key !== pattern || recovery_strategy === undefined || draft.suggestion.recovery_strategy !== undefined) return;
  draft.suggestion.recovery_strategy = recovery_strategy;
  apply(draft, item, `known failure pattern, recovery '${recovery_strategy}' applied`);
}

function applyVeto(draft: Draft, item: KnowledgeItem): void {
  const { forbidden_accounts } = item.rule as { forbidden_accounts: string[] };
  if (item.subject_key !== accountSubject(draft.invoice.vendor).subject_key || !forbidden_accounts.includes(draft.suggestion.account)) return;
  const forbidden = draft.suggestion.account;
  draft.suggestion.account = UNMAPPED_ACCOUNT;
  apply(draft, item, `account ${forbidden} is forbidden for this vendor -> ${UNMAPPED_ACCOUNT}`);
}

const APPLIERS: Readonly<Record<KnowledgeType, (draft: Draft, item: KnowledgeItem) => void>> = {
  field_mapping: applyFieldMapping,
  booking_rule: applyBookingRule,
  naming_convention: applyNaming,
  account_mapping: applyAccountMapping,
  extraction_failure_pattern: applyFailurePattern,
  account_veto: applyVeto,
};

/**
 * Deterministic stand-in for the LLM agent: the same invoice and knowledge always yield the same
 * suggestion. `applied` lists only the items that changed the output; that is what the trace and the
 * reinforcement read.
 */
export function mockInvoiceAgent(invoice: Invoice, knowledge: readonly KnowledgeItem[]): AgentOutput {
  const draft: Draft = { invoice, suggestion: { account: DEFAULT_ACCOUNT, fields: { ...invoice.fields }, notes: [] }, applied: [] };
  for (const phase of PHASES) {
    for (const item of knowledge) if (item.type === phase) APPLIERS[phase](draft, item);
  }
  return { suggestion: draft.suggestion, applied: draft.applied };
}
