import type { Db } from '../../infrastructure/db/database.js';
import { docPatternSubject, TENANT_ANCHOR, vendorAnchor } from '../knowledge/keys.js';
import { ITEM_COLUMNS } from '../knowledge/repository.js';
import type { KnowledgeItem } from '../knowledge/types.js';
import type { Invoice } from './types.js';

/**
 * Everything known about the vendor, the document pattern and the tenant as a whole. Anchors, not
 * field names: a rule that ADDS a field the invoice does not carry yet must still be found.
 */
export function deriveAnchors(invoice: Invoice): string[] {
  const anchors = [vendorAnchor(invoice.vendor), TENANT_ANCHOR];
  if (invoice.doc_structure !== undefined) anchors.push(docPatternSubject(invoice.doc_structure).anchor);
  return anchors;
}

export interface Retrieval {
  readonly retrieved: KnowledgeItem[];
  /** Global items a tenant item shadows on the same slot: reported so the decision stays explainable. */
  readonly shadowed_global: KnowledgeItem[];
}

/**
 * Active, unexpired items of the tenant and of the global scope. On the same slot the tenant item
 * wins regardless of confidence: the tenant's own reviewer outranks a platform default. Ranked by
 * confidence, then by most recent activation. RLS already limits a tenant connection to these rows;
 * the predicate is explicit so the query is correct under any role.
 */
export async function retrieveKnowledge(db: Db, tenantId: string, anchors: readonly string[]): Promise<Retrieval> {
  const rows = (
    await db.query<KnowledgeItem>(
      `SELECT ${ITEM_COLUMNS} FROM knowledge_items
       WHERE status = 'active'
         AND anchor = ANY($1::text[])
         AND (valid_until IS NULL OR valid_until > now())
         AND ((scope = 'tenant' AND tenant_id = $2::uuid) OR scope = 'global')`,
      [anchors, tenantId],
    )
  ).rows;
  const tenantSlots = new Set(rows.filter((row) => row.scope === 'tenant').map((row) => row.subject_key));
  const shadowed = rows.filter((row) => row.scope === 'global' && tenantSlots.has(row.subject_key));
  const retrieved = rows
    .filter((row) => row.scope === 'tenant' || !tenantSlots.has(row.subject_key))
    .sort((a, b) => b.confidence - a.confidence || (b.activated_at?.getTime() ?? 0) - (a.activated_at?.getTime() ?? 0));
  return { retrieved, shadowed_global: shadowed };
}
