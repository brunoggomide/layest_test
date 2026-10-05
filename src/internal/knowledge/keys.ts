import { createHash } from 'node:crypto';
import { stableStringify, type JsonObject } from '../../shared/json.js';

/**
 * A subject is what an item is about (the anchor, used for retrieval) and the slot of truth it
 * fills (the subject_key, of which at most one item is active per scope and tenant).
 */
export interface Subject {
  readonly anchor: string;
  readonly subject_key: string;
}

const subject = (anchor: string, slot: string): Subject => ({ anchor, subject_key: `${anchor}|${slot}` });

const LEGAL_SUFFIXES = new Set(['spa', 'srl', 'srls', 'sas', 'snc', 'gmbh', 'ag', 'kg', 'ltd', 'llc', 'inc', 'corp', 'co', 'sa', 'sarl', 'bv', 'nv', 'plc', 'oy', 'ab', 'as']);

/** 'Rossi S.p.A. ' -> 'rossi': case, accents, punctuation and a trailing legal form do not make another vendor. */
function normalizeVendor(vendor: string): string {
  const tokens = vendor
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const core = [...tokens];
  while (core.length > 1 && LEGAL_SUFFIXES.has(core[core.length - 1] as string)) core.pop();
  return (core.length > 0 ? core : tokens).join('-');
}

/** 'Cost Center' -> 'cost_center'. */
function normalizeField(field: string): string {
  const normalized = field.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized === '' ? 'field' : normalized;
}

export const vendorAnchor = (vendor: string): string => `vendor=${normalizeVendor(vendor)}`;

/** Conventions hold for every invoice of the tenant, whatever the vendor. */
export const TENANT_ANCHOR = 'tenant';

export const accountSubject = (vendor: string): Subject => subject(vendorAnchor(vendor), 'account');
export const bookingSubject = (vendor: string, field: string): Subject => subject(vendorAnchor(vendor), `booking:${normalizeField(field)}`);
export const fieldMappingSubject = (vendor: string, to: string): Subject => subject(vendorAnchor(vendor), `field_mapping:${normalizeField(to)}`);
export const namingSubject = (field: string): Subject => subject(TENANT_ANCHOR, `naming:${normalizeField(field)}`);

const STRUCTURAL_IDENTIFIER = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;

/** Structural facts are lowercase identifiers, never prose: 'missing_field', 'sum_line_items'. Anything else is not structure. */
export function asStructuralIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && STRUCTURAL_IDENTIFIER.test(normalized) ? normalized : undefined;
}

/** A closed list of document features: nothing identifying can enter a pattern key or global knowledge. */
const STRUCTURAL_FEATURES = ['layout', 'header', 'columns', 'doc_type', 'pages', 'language', 'currency_column', 'has_line_items'] as const;

export function structuralFeatures(doc: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of STRUCTURAL_FEATURES) {
    const value = doc[key];
    if (typeof value === 'string') out[key] = value.trim().toLowerCase();
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function docPatternSubject(doc: JsonObject): Subject {
  const hash = createHash('sha1').update(stableStringify(structuralFeatures(doc))).digest('hex');
  return subject(`doc_pattern=${hash}`, 'failure');
}
