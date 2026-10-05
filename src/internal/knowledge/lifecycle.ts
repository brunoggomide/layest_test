import type { Db } from '../../infrastructure/db/database.js';
import { forbidden, invalidTransition, notFound } from '../../http/errors.js';
import type { Actor } from '../../shared/actor.js';
import type { JsonObject } from '../../shared/json.js';
import { findActive, getHistory, getItem, insertItem, lockItem, updateStatus } from './repository.js';
import { parseRule } from './rules.js';
import type { KnowledgeItem } from './types.js';

/**
 * candidate -> accepted -> active, with a human on every step. Nothing here is automatic: a candidate
 * never influences a run, and the only way to active is a reviewer's accept (or conflict resolution).
 */
export interface AcceptOutcome {
  readonly item: KnowledgeItem;
  readonly status: 'active' | 'accepted' | 'rejected';
  /** Set when another item holds the slot: the reviewer resolves it explicitly. */
  readonly pending_conflict_with?: string;
  readonly superseded_id?: string;
}

export interface Review {
  readonly reviewer: string;
  /** Knowledge that is known to expire (a temporary rule) leaves retrieval on its own after this date. */
  readonly validUntil?: Date | null;
}

async function loadForReview(db: Db, id: string, actor: Actor): Promise<KnowledgeItem> {
  const peek = await getItem(db, id);
  if (peek === null) throw notFound(`knowledge item ${id}`);
  // Global rows are readable by tenants but reviewable only by the platform: say so instead of letting RLS update zero rows.
  if (peek.scope === 'global' && actor.kind !== 'service') throw forbidden('Global knowledge can only be reviewed with the service token');
  const item = await lockItem(db, id);
  if (item === null) throw notFound(`knowledge item ${id}`);
  return item;
}

async function tryActivate(db: Db, item: KnowledgeItem, review: Review): Promise<AcceptOutcome> {
  const existing = await findActive(db, item.scope, item.tenant_id, item.subject_key);
  // The item's own predecessor is not a conflict: activating a new version supersedes it.
  if (existing !== null && existing.id !== item.id && existing.id !== item.supersedes_id) {
    const context: JsonObject = { ...item.supporting_context, conflicts_with: existing.id };
    const held = await updateStatus(db, item.id, 'accepted', { supportingContext: context });
    return { item: held, status: 'accepted', pending_conflict_with: existing.id };
  }
  let supersededId: string | undefined;
  if (existing !== null && existing.id !== item.id) {
    await updateStatus(db, existing.id, 'superseded');
    supersededId = existing.id;
  }
  const active = await updateStatus(db, item.id, 'active', { activated: true, validUntil: review.validUntil ?? null });
  return supersededId === undefined ? { item: active, status: 'active' } : { item: active, status: 'active', superseded_id: supersededId };
}

export async function acceptItem(db: Db, id: string, review: Review, actor: Actor): Promise<AcceptOutcome> {
  const item = await loadForReview(db, id, actor);
  if (item.status !== 'candidate' && item.status !== 'accepted') throw invalidTransition(`cannot accept an item in status '${item.status}'`);
  const accepted = await updateStatus(db, id, 'accepted', { reviewer: review.reviewer });
  return tryActivate(db, accepted, review);
}

export interface ConflictDecision {
  readonly winner: 'new' | 'existing';
  readonly reviewer: string;
}

export async function resolveConflict(db: Db, id: string, decision: ConflictDecision, actor: Actor): Promise<AcceptOutcome> {
  const item = await loadForReview(db, id, actor);
  if (item.status !== 'accepted') throw invalidTransition(`only an item in status 'accepted' can have a conflict resolved (item is '${item.status}')`);
  const existing = await findActive(db, item.scope, item.tenant_id, item.subject_key);
  if (existing === null || existing.id === item.id) return tryActivate(db, item, { reviewer: decision.reviewer });

  if (decision.winner === 'existing') {
    const context: JsonObject = { ...item.supporting_context, conflict_resolution: 'lost', resolved_against: existing.id };
    const rejected = await updateStatus(db, id, 'rejected', { reviewer: decision.reviewer, supportingContext: context });
    return { item: rejected, status: 'rejected' };
  }
  await updateStatus(db, existing.id, 'superseded');
  const context: JsonObject = { ...item.supporting_context, conflict_resolution: 'won', resolved_against: existing.id };
  const active = await updateStatus(db, id, 'active', {
    reviewer: decision.reviewer,
    activated: true,
    supportingContext: context,
    // Keeps the history chain linkable when the winner was not an edit of the loser.
    supersedesId: item.supersedes_id ?? existing.id,
  });
  return { item: active, status: 'active', superseded_id: existing.id };
}

export interface Edit {
  readonly rule: JsonObject;
  readonly ruleText: string;
  readonly reviewer: string;
}

/** Immutable history: an edit is a NEW row (version + 1) pointing at the old one, which stays untouched until the edit is accepted. */
export async function editItem(db: Db, id: string, edit: Edit, actor: Actor): Promise<KnowledgeItem> {
  const old = await loadForReview(db, id, actor);
  if (old.status !== 'candidate' && old.status !== 'accepted' && old.status !== 'active') {
    throw invalidTransition(`cannot edit an item in status '${old.status}'; edit the latest version instead`);
  }
  return insertItem(db, {
    scope: old.scope,
    tenant_id: old.tenant_id,
    type: old.type,
    anchor: old.anchor,
    subject_key: old.subject_key,
    rule: parseRule(old.type, edit.rule),
    rule_text: edit.ruleText,
    supporting_context: { ...old.supporting_context, edited_from: old.id, edited_by: edit.reviewer },
    confidence: old.confidence,
    status: 'candidate',
    source_event_id: old.source_event_id,
    source_run_id: old.source_run_id,
    version: old.version + 1,
    supersedes_id: old.id,
    evidence_count: old.evidence_count,
    distinct_tenant_count: old.distinct_tenant_count,
    reviewed_by: edit.reviewer,
  });
}

export async function rejectItem(db: Db, id: string, reviewer: string, actor: Actor): Promise<KnowledgeItem> {
  const item = await loadForReview(db, id, actor);
  if (item.status !== 'candidate' && item.status !== 'accepted') throw invalidTransition(`cannot reject an item in status '${item.status}'`);
  return updateStatus(db, id, 'rejected', { reviewer });
}

/** Soft delete: the row stays for history and the slot is free for a future activation. */
export async function disableItem(db: Db, id: string, reviewer: string, actor: Actor): Promise<KnowledgeItem> {
  const item = await loadForReview(db, id, actor);
  if (item.status === 'disabled') return item;
  if (item.status === 'superseded' || item.status === 'rejected') throw invalidTransition(`an item in status '${item.status}' is already inactive`);
  return updateStatus(db, id, 'disabled', { reviewer });
}

export async function itemHistory(db: Db, id: string): Promise<KnowledgeItem[]> {
  const chain = await getHistory(db, id);
  if (chain.length === 0) throw notFound(`knowledge item ${id}`);
  return chain;
}
