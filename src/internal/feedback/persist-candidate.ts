import type { Db } from '../../infrastructure/db/database.js';
import { jsonEqual, type JsonObject } from '../../shared/json.js';
import { addEvidence, findActive, findPending, insertItem, reinforceItems } from '../knowledge/repository.js';
import type { KnowledgeCandidate, KnowledgeItem } from '../knowledge/types.js';

export interface PersistContext {
  readonly tenantId: string;
  readonly eventId: string;
  readonly runId: string;
}

export type PersistOutcome =
  | { readonly kind: 'created'; readonly item: KnowledgeItem }
  | { readonly kind: 'reinforced'; readonly itemId: string; readonly note: string };

const isVetoSuccessor = (active: KnowledgeItem | null, candidate: KnowledgeCandidate): boolean =>
  active !== null && active.type === 'account_veto' && candidate.type === 'account_veto';

/** Two rejections of different accounts for one vendor are one veto with both accounts, as a new version. */
function mergeVeto(active: KnowledgeItem, candidate: KnowledgeCandidate): KnowledgeCandidate {
  const known = (active.rule['forbidden_accounts'] as string[] | undefined) ?? [];
  const incoming = candidate.rule['forbidden_accounts'] as string[];
  const forbidden = [...new Set([...known, ...incoming])];
  return {
    ...candidate,
    rule: { forbidden_accounts: forbidden },
    rule_text: `Vendor accounts ${forbidden.join(', ')} are forbidden (rejected by reviewers, no correction given)`,
  };
}

interface Lineage {
  readonly version: number;
  readonly supersedes_id: string | null;
  readonly supporting_context: JsonObject;
}

/** A veto extending the active veto is its next version; any other active item on the slot is a conflict a reviewer resolves. */
function lineageOf(active: KnowledgeItem | null, candidate: KnowledgeCandidate): Lineage {
  if (active === null) return { version: 1, supersedes_id: null, supporting_context: candidate.supporting_context };
  if (isVetoSuccessor(active, candidate)) return { version: active.version + 1, supersedes_id: active.id, supporting_context: candidate.supporting_context };
  return { version: 1, supersedes_id: null, supporting_context: { ...candidate.supporting_context, conflicts_with: active.id } };
}

async function reinforce(db: Db, item: KnowledgeItem, context: PersistContext, why: string): Promise<PersistOutcome> {
  await reinforceItems(db, [item.id]);
  await addEvidence(db, item.id, context.eventId, context.tenantId);
  return { kind: 'reinforced', itemId: item.id, note: `${why}; evidence_count of ${item.id} incremented` };
}

/**
 * A candidate is stored once per distinct rule: an identical pending candidate is strengthened, an
 * identical active item is reinforced, and a different active item is marked as a conflict. Nothing
 * is ever auto-activated or auto-superseded here.
 */
export async function persistCandidate(db: Db, context: PersistContext, proposed: KnowledgeCandidate): Promise<PersistOutcome> {
  const active = await findActive(db, 'tenant', context.tenantId, proposed.subject_key);
  const candidate = active !== null && isVetoSuccessor(active, proposed) ? mergeVeto(active, proposed) : proposed;

  const pending = (await findPending(db, context.tenantId, candidate.type, candidate.subject_key)).find((item) => jsonEqual(item.rule, candidate.rule));
  if (pending !== undefined) return reinforce(db, pending, context, `candidate ${pending.id} (${candidate.subject_key}) already pending with the same rule`);
  if (active !== null && active.type === candidate.type && jsonEqual(active.rule, candidate.rule)) {
    return reinforce(db, active, context, `item ${active.id} (${candidate.subject_key}) is already active with the same rule`);
  }

  const item = await insertItem(db, {
    ...candidate,
    ...lineageOf(active, candidate),
    scope: 'tenant',
    tenant_id: context.tenantId,
    status: 'candidate',
    source_event_id: context.eventId,
    source_run_id: context.runId,
  });
  await addEvidence(db, item.id, context.eventId, context.tenantId);
  return { kind: 'created', item };
}
