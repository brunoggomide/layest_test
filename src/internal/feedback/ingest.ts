import type { Database, Db } from '../../infrastructure/db/database.js';
import { HttpError, notFound, validation } from '../../http/errors.js';
import { contestItems, reinforceItems } from '../knowledge/repository.js';
import type { KnowledgeItem } from '../knowledge/types.js';
import { appliedGlobalItemIds, appliedTenantItemIds, lockRun } from '../runs/repository.js';
import type { RunRow } from '../runs/types.js';
import type { KnowledgeExtractor } from './extract.js';
import { classifyFailure, type FailureClass } from './extract-failed.js';
import { persistCandidate, type PersistOutcome } from './persist-candidate.js';
import type { FeedbackDiff, FeedbackEventRow, FeedbackKind, RunError } from './types.js';

export interface FeedbackInput {
  readonly run_id: string;
  readonly kind: FeedbackKind;
  readonly reviewer_id: string;
  readonly diff?: FeedbackDiff;
  readonly error?: RunError;
}

export interface FeedbackResult {
  readonly event_id: string;
  readonly run_id: string;
  readonly kind: FeedbackKind;
  readonly idempotent_replay: boolean;
  readonly classification?: FailureClass;
  readonly created_items: KnowledgeItem[];
  readonly reinforced_item_ids: string[];
  readonly contested_item_ids: string[];
  readonly notes: string[];
}

function validateInput(input: FeedbackInput): void {
  if (input.kind === 'adjusted' && (input.diff === undefined || Object.keys(input.diff).length === 0)) throw validation("kind 'adjusted' requires a non-empty diff");
  if (input.kind === 'failed' && input.error === undefined) throw validation("kind 'failed' requires an error payload");
}

type Recorded = { readonly replayOf: FeedbackEventRow } | { readonly event: FeedbackEventRow };

/** One decision per run. The same decision again is a no-op; a different one is a conflict the caller must see. */
async function recordEvent(db: Db, run: RunRow, tenantId: string, input: FeedbackInput): Promise<Recorded> {
  const inserted = await db.query<FeedbackEventRow>(
    `INSERT INTO feedback_events (run_id, tenant_id, kind, diff, error, reviewer_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id) DO NOTHING
     RETURNING *`,
    [run.id, tenantId, input.kind, input.diff === undefined ? null : JSON.stringify(input.diff), input.error === undefined ? null : JSON.stringify(input.error), input.reviewer_id],
  );
  const event = inserted.rows[0];
  if (event !== undefined) return { event };
  const existing = (await db.query<FeedbackEventRow>('SELECT * FROM feedback_events WHERE run_id = $1', [run.id])).rows[0];
  if (existing === undefined) throw new Error('feedback insert conflicted without an existing event');
  if (existing.kind !== input.kind) {
    throw new HttpError(409, 'run_already_reviewed', `run ${run.id} already received '${existing.kind}' feedback; a run has one reviewer decision`);
  }
  return { replayOf: existing };
}

interface Learned {
  readonly created: KnowledgeItem[];
  readonly reinforced: string[];
  readonly contested: string[];
  readonly notes: string[];
  readonly classification?: FailureClass;
  /** Applied global items: reinforced afterwards by the service role, which a tenant transaction cannot do. */
  readonly globalApplied: string[];
}

async function learnFromCandidates(db: Db, run: RunRow, event: FeedbackEventRow, extractor: KnowledgeExtractor): Promise<Omit<Learned, 'contested' | 'globalApplied'>> {
  const kind = event.kind as 'adjusted' | 'rejected' | 'failed';
  const extraction = await extractor.extract({ kind, run, diff: event.diff, error: event.error });
  const created: KnowledgeItem[] = [];
  const reinforced: string[] = [];
  const notes = [...extraction.notes];
  for (const candidate of extraction.candidates) {
    const outcome: PersistOutcome = await persistCandidate(db, { tenantId: event.tenant_id, eventId: event.id, runId: run.id }, candidate);
    if (outcome.kind === 'created') created.push(outcome.item);
    else {
      reinforced.push(outcome.itemId);
      notes.push(outcome.note);
    }
  }
  const learned = { created, reinforced, notes };
  return kind === 'failed' && event.error !== null ? { ...learned, classification: classifyFailure(event.error) } : learned;
}

async function learn(db: Db, run: RunRow, event: FeedbackEventRow, extractor: KnowledgeExtractor): Promise<Learned> {
  if (event.kind === 'accepted') {
    const reinforced = await reinforceItems(db, await appliedTenantItemIds(db, run.id));
    const globalApplied = await appliedGlobalItemIds(db, run.id);
    const notes = [reinforced.length + globalApplied.length > 0 ? `reinforced ${reinforced.length + globalApplied.length} applied item(s)` : 'no applied knowledge to reinforce'];
    return { created: [], reinforced, contested: [], notes, globalApplied };
  }
  const contested = event.kind === 'rejected' ? await contestItems(db, await appliedTenantItemIds(db, run.id)) : [];
  const learned = await learnFromCandidates(db, run, event, extractor);
  const notes = contested.length > 0 ? [`marked ${contested.length} applied item(s) as contested`, ...learned.notes] : learned.notes;
  return { ...learned, contested, notes, globalApplied: [] };
}

const replay = (event: FeedbackEventRow): FeedbackResult => ({
  event_id: event.id,
  run_id: event.run_id,
  kind: event.kind,
  idempotent_replay: true,
  created_items: [],
  reinforced_item_ids: [],
  contested_item_ids: [],
  notes: [`feedback for run ${event.run_id} was already processed at ${event.created_at.toISOString()}; nothing changed`],
});

/**
 * Ingests one reviewer decision. The tenant transaction holds everything RLS must guard: the run
 * lookup (404 for another tenant's run), the event and every knowledge write. Global items the run
 * applied are reinforced in a second, service-role transaction, because a tenant connection must
 * never be able to write a global row.
 */
export async function ingestFeedback(database: Database, tenantId: string, input: FeedbackInput, extractor: KnowledgeExtractor): Promise<FeedbackResult> {
  validateInput(input);
  const outcome = await database.withTenant(tenantId, async (db) => {
    const run = await lockRun(db, input.run_id);
    if (run === null) throw notFound(`run ${input.run_id}`);
    const recorded = await recordEvent(db, run, tenantId, input);
    if ('replayOf' in recorded) return { replay: replay(recorded.replayOf) };
    await db.query('UPDATE runs SET status = $2 WHERE id = $1', [run.id, input.kind]);
    return { event: recorded.event, learned: await learn(db, run, recorded.event, extractor) };
  });
  if ('replay' in outcome) return outcome.replay;

  const { event, learned } = outcome;
  const reinforcedGlobal = learned.globalApplied.length === 0 ? [] : await database.withService((db) => reinforceItems(db, learned.globalApplied));
  const result: FeedbackResult = {
    event_id: event.id,
    run_id: event.run_id,
    kind: event.kind,
    idempotent_replay: false,
    created_items: learned.created,
    reinforced_item_ids: [...learned.reinforced, ...reinforcedGlobal],
    contested_item_ids: learned.contested,
    notes: learned.notes,
  };
  return learned.classification === undefined ? result : { ...result, classification: learned.classification };
}
