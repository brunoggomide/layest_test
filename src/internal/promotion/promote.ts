import type { Db } from '../../infrastructure/db/database.js';
import { addEvidence, insertItem, ITEM_COLUMNS } from '../knowledge/repository.js';
import type { KnowledgeItem, KnowledgeType } from '../knowledge/types.js';
import { sanitizeForGlobal, type SanitizeResult } from './sanitize.js';

/**
 * Why only document-structure patterns generalize: every other type encodes one tenant's chart of
 * accounts, vocabulary or vendor relationships, which are identifiers by nature, not structure.
 */
const PROMOTABLE_TYPES: ReadonlySet<KnowledgeType> = new Set(['extraction_failure_pattern']);

const REFUSAL_REASONS: Readonly<Record<KnowledgeType, string>> = {
  account_mapping: "account numbers belong to one tenant's chart of accounts; a vendor-to-account pair is an identifier, never structure",
  account_veto: 'a veto is bound to a vendor and an account of one tenant',
  booking_rule: "a booking value is one tenant's vocabulary for one vendor",
  naming_convention: "a naming template is one tenant's private convention",
  field_mapping: 'a field mapping is bound to one vendor of one tenant',
  extraction_failure_pattern: '',
};

export interface PromotionDecision {
  readonly type: KnowledgeType;
  readonly subject_key: string;
  readonly tenant_ids: string[];
  readonly source_item_ids: string[];
  readonly outcome: 'promoted' | 'refused' | 'skipped';
  readonly reason: string;
  readonly sanitizer?: SanitizeResult;
  readonly global_item_id?: string;
}

export interface PromotionReport {
  readonly min_tenants: number;
  readonly decisions: PromotionDecision[];
}

interface Group {
  readonly type: KnowledgeType;
  readonly subject_key: string;
  readonly items: KnowledgeItem[];
}

async function loadKnownNames(db: Db): Promise<string[]> {
  const tenants = (await db.query<{ name: string }>('SELECT name FROM tenants')).rows.map((row) => row.name);
  const vendors = (await db.query<{ vendor: string | null }>("SELECT DISTINCT input->'invoice'->>'vendor' AS vendor FROM runs")).rows
    .map((row) => row.vendor)
    .filter((vendor): vendor is string => vendor !== null);
  return [...tenants, ...vendors];
}

async function groupActiveTenantItems(db: Db): Promise<Group[]> {
  const active = (await db.query<KnowledgeItem>(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE scope = 'tenant' AND status = 'active' ORDER BY created_at`)).rows;
  const groups = new Map<string, Group>();
  for (const item of active) {
    const key = `${item.type}|${item.subject_key}`;
    const group = groups.get(key) ?? { type: item.type, subject_key: item.subject_key, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function existingGlobal(db: Db, subjectKey: string): Promise<{ id: string; status: string } | undefined> {
  const res = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM knowledge_items WHERE scope = 'global' AND subject_key = $1 AND status IN ('candidate', 'accepted', 'active') LIMIT 1",
    [subjectKey],
  );
  return res.rows[0];
}

async function promoteGroup(db: Db, group: Group, tenantIds: string[], knownNames: readonly string[]): Promise<Pick<PromotionDecision, 'outcome' | 'reason' | 'sanitizer' | 'global_item_id'>> {
  // The best-supported example is sanitized; the global item starts at the group's LOWEST confidence.
  const representative = [...group.items].sort((a, b) => b.confidence - a.confidence)[0] as KnowledgeItem;
  const sanitized = sanitizeForGlobal({ rule: representative.rule, supporting_context: representative.supporting_context }, knownNames);
  if (!sanitized.ok) return { outcome: 'refused', reason: `sanitizer discarded the content: ${sanitized.reason}`, sanitizer: sanitized };

  const globalItem = await insertItem(db, {
    scope: 'global',
    tenant_id: null,
    type: group.type,
    anchor: representative.anchor,
    subject_key: group.subject_key,
    rule: sanitized.rule,
    rule_text: sanitized.rule_text,
    supporting_context: sanitized.supporting_context,
    confidence: Math.min(...group.items.map((item) => item.confidence)),
    status: 'candidate',
    evidence_count: group.items.reduce((sum, item) => sum + item.evidence_count, 0),
    distinct_tenant_count: tenantIds.length,
  });
  for (const source of group.items) {
    if (source.source_event_id !== null && source.tenant_id !== null) await addEvidence(db, globalItem.id, source.source_event_id, source.tenant_id);
  }
  return { outcome: 'promoted', reason: `${tenantIds.length} distinct tenants and the sanitizer passed; the global candidate awaits the platform reviewer`, sanitizer: sanitized, global_item_id: globalItem.id };
}

/**
 * Runs as billay_service. Gates, in order: the type must be structural by nature; at least
 * `minTenants` distinct tenants must hold the same active pattern; no global item may exist for the
 * slot; the sanitizer must accept the content. What passes is a global CANDIDATE: a human still accepts it.
 */
export async function runPromotion(db: Db, minTenants: number): Promise<PromotionReport> {
  const knownNames = await loadKnownNames(db);
  const decisions: PromotionDecision[] = [];
  for (const group of await groupActiveTenantItems(db)) {
    const tenantIds = [...new Set(group.items.map((item) => item.tenant_id).filter((id): id is string => id !== null))];
    const base = { type: group.type, subject_key: group.subject_key, tenant_ids: tenantIds, source_item_ids: group.items.map((item) => item.id) };
    if (!PROMOTABLE_TYPES.has(group.type)) {
      decisions.push({ ...base, outcome: 'refused', reason: `${group.type} never generalizes: ${REFUSAL_REASONS[group.type]}` });
      continue;
    }
    if (tenantIds.length < minTenants) {
      decisions.push({ ...base, outcome: 'skipped', reason: `insufficient cross-tenant evidence (${tenantIds.length}/${minTenants} distinct tenants)` });
      continue;
    }
    const existing = await existingGlobal(db, group.subject_key);
    if (existing !== undefined) {
      decisions.push({ ...base, outcome: 'skipped', reason: `global item ${existing.id} already exists for this slot (status ${existing.status})` });
      continue;
    }
    decisions.push({ ...base, ...(await promoteGroup(db, group, tenantIds, knownNames)) });
  }
  return { min_tenants: minTenants, decisions };
}
