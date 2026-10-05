import { isJsonObject, type JsonObject, type JsonPrimitive } from '../../shared/json.js';
import { asStructuralIdentifier, structuralFeatures } from '../knowledge/keys.js';

/**
 * Global knowledge may carry STRUCTURAL facts only. Allowlist, not denylist: a field nobody thought of
 * is stripped, never leaked. The description is regenerated from the surviving structure, so a
 * tenant's free text is never copied, and a residue check runs over the final output anyway.
 */
const GLOBAL_ALLOWED_FIELDS: ReadonlySet<string> = new Set(['doc_type', 'error_signature', 'missing_field', 'recovery_strategy']);

const RESIDUE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['iban', /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{4}){2,7}[A-Z0-9]{1,4}\b/i],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['amount', /(?:\u20ac|\$|\u00a3|\b(?:EUR|USD|GBP|CHF)\b)\s?\d|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?\b|\b\d+[.,]\d{2}\b/],
  ['long_number', /\b\d{6,}\b/],
];

export interface SanitizeInput {
  readonly rule: JsonObject;
  readonly supporting_context: JsonObject;
}

export type SanitizeResult =
  | { readonly ok: true; readonly rule: JsonObject; readonly rule_text: string; readonly supporting_context: JsonObject; readonly stripped: string[] }
  | { readonly ok: false; readonly reason: string; readonly stripped: string[] };

function pickStructure(value: JsonObject, path: string, stripped: string[]): JsonObject | undefined {
  const structural = structuralFeatures(value);
  for (const inner of Object.keys(value)) if (!(inner in structural)) stripped.push(`${path}.doc_structure.${inner}`);
  return Object.keys(structural).length > 0 ? structural : undefined;
}

const isPrimitive = (value: unknown): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function pickAllowed(source: JsonObject, path: string, stripped: string[]): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'doc_structure' && isJsonObject(value)) {
      const structure = pickStructure(value, path, stripped);
      if (structure !== undefined) out['doc_structure'] = structure;
    } else if (GLOBAL_ALLOWED_FIELDS.has(key) && isPrimitive(value)) {
      out[key] = value;
    } else {
      stripped.push(`${path}.${key}`);
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tokens of tenant and vendor names; any whole-word occurrence in global output is a leak. */
function nameTokens(names: readonly string[]): string[] {
  const tokens = new Set<string>();
  for (const name of names) {
    const lower = name.trim().toLowerCase();
    if (lower.length >= 3) tokens.add(lower);
    for (const part of lower.split(/[^a-z0-9]+/)) if (part.length >= 4) tokens.add(part);
  }
  return [...tokens];
}

function findResidue(text: string, knownNameTokens: readonly string[]): string | null {
  for (const [label, pattern] of RESIDUE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return `${label} pattern '${match[0]}'`;
  }
  for (const token of knownNameTokens) {
    // Not \b: an underscore is a word character, and 'total_for_rossi' must still be caught.
    if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, 'i').test(text)) return `known tenant/vendor name '${token}'`;
  }
  return null;
}

function nonIdentifier(values: readonly JsonPrimitive[]): string | null {
  for (const value of values) if (typeof value === 'string' && asStructuralIdentifier(value) !== value) return value;
  return null;
}

function describe(rule: JsonObject): string {
  const parts: string[] = [];
  const structure = rule['doc_structure'];
  if (isJsonObject(structure)) {
    parts.push(`documents with structure {${Object.entries(structure).map(([k, v]) => `${k}=${String(v)}`).join(', ')}}`);
  }
  if (typeof rule['error_signature'] === 'string') parts.push(`fail with ${rule['error_signature']}`);
  if (typeof rule['recovery_strategy'] === 'string') parts.push(`recover with '${rule['recovery_strategy']}'`);
  return parts.join('; ').replace(/^./, (c) => c.toUpperCase());
}

export function sanitizeForGlobal(input: SanitizeInput, knownNames: readonly string[]): SanitizeResult {
  const stripped: string[] = [];
  const rule = pickAllowed(input.rule, 'rule', stripped);
  const supportingContext = pickAllowed(input.supporting_context, 'supporting_context', stripped);
  if (Object.keys(rule).length === 0) return { ok: false, reason: 'rule is empty after stripping non-structural fields', stripped };
  const ruleText = describe(rule);
  if (ruleText === '') return { ok: false, reason: 'no structural statement can be made from the rule', stripped };

  const values = [...Object.values(rule), ...Object.values(supportingContext)].flatMap((v) => (isJsonObject(v) ? Object.values(v) : [v])) as JsonPrimitive[];
  const prose = nonIdentifier(values);
  if (prose !== null) return { ok: false, reason: `residue check failed: value '${prose}' is not a structural identifier`, stripped };
  const residue = findResidue(`${JSON.stringify(rule)} ${JSON.stringify(supportingContext)} ${ruleText}`, nameTokens(knownNames));
  if (residue !== null) return { ok: false, reason: `residue check failed: ${residue}`, stripped };
  return { ok: true, rule, rule_text: ruleText, supporting_context: supportingContext, stripped };
}
