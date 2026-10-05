import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Db } from '../../infrastructure/db/database.js';
import { actorOf } from '../../http/actor.js';
import { notFound } from '../../http/errors.js';
import type { Actor } from '../../shared/actor.js';
import type { JsonObject } from '../../shared/json.js';
import { acceptItem, disableItem, editItem, itemHistory, rejectItem, resolveConflict } from './lifecycle.js';
import { getItem, listItems } from './repository.js';
import { KNOWLEDGE_STATUSES, KNOWLEDGE_TYPES } from './types.js';

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([jsonPrimitive, z.array(jsonValue), z.record(jsonValue)]));

const listQuery = z.object({
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  scope: z.enum(['tenant', 'global']).optional(),
  tenant_id: z.string().uuid().optional(),
  type: z.enum(KNOWLEDGE_TYPES).optional(),
  subject_key: z.string().max(300).optional(),
});
const idParams = z.object({ id: z.string().uuid() });
const reviewer = z.object({ reviewer_id: z.string().min(1).max(200) });
const acceptBody = reviewer.extend({ valid_until: z.coerce.date().nullable().optional() });
const resolveBody = reviewer.extend({ winner: z.enum(['new', 'existing']) });
const editBody = reviewer.extend({ rule: z.record(jsonValue), rule_text: z.string().min(1).max(2000) });

const idOf = (request: FastifyRequest): string => idParams.parse(request.params).id;

/** Runs `fn` in the transaction of the caller's role: tenant (RLS-scoped) or service. */
function withActor<T>(database: Database, actor: Actor, fn: (db: Db, actor: Actor) => Promise<T>): Promise<T> {
  return actor.kind === 'service' ? database.withService((db) => fn(db, actor)) : database.withTenant(actor.tenantId, (db) => fn(db, actor));
}

export function registerKnowledgeRoutes(scope: FastifyInstance, database: Database): void {
  const asActor = <T>(request: FastifyRequest, fn: (db: Db, actor: Actor) => Promise<T>): Promise<T> => withActor(database, actorOf(request), fn);

  scope.get('/knowledge', async (request) => {
    const filters = listQuery.parse(request.query);
    return { data: await asActor(request, (db) => listItems(db, filters)) };
  });

  scope.get('/knowledge/:id', async (request) => {
    const id = idOf(request);
    const item = await asActor(request, (db) => getItem(db, id));
    if (item === null) throw notFound(`knowledge item ${id}`);
    return { data: item };
  });

  scope.get('/knowledge/:id/history', async (request) => {
    const id = idOf(request);
    return { data: await asActor(request, (db) => itemHistory(db, id)) };
  });

  scope.post('/knowledge/:id/accept', async (request) => {
    const id = idOf(request);
    const body = acceptBody.parse(request.body);
    const review = body.valid_until === undefined ? { reviewer: body.reviewer_id } : { reviewer: body.reviewer_id, validUntil: body.valid_until };
    return { data: await asActor(request, (db, actor) => acceptItem(db, id, review, actor)) };
  });

  scope.post('/knowledge/:id/resolve-conflict', async (request) => {
    const id = idOf(request);
    const body = resolveBody.parse(request.body);
    return { data: await asActor(request, (db, actor) => resolveConflict(db, id, { winner: body.winner, reviewer: body.reviewer_id }, actor)) };
  });

  scope.post('/knowledge/:id/edit', async (request, reply) => {
    const id = idOf(request);
    const body = editBody.parse(request.body);
    const edit = { rule: body.rule as JsonObject, ruleText: body.rule_text, reviewer: body.reviewer_id };
    const item = await asActor(request, (db, actor) => editItem(db, id, edit, actor));
    return reply.status(201).send({ data: item });
  });

  scope.post('/knowledge/:id/reject', async (request) => {
    const id = idOf(request);
    const body = reviewer.parse(request.body);
    return { data: await asActor(request, (db, actor) => rejectItem(db, id, body.reviewer_id, actor)) };
  });

  scope.post('/knowledge/:id/disable', async (request) => {
    const id = idOf(request);
    const body = reviewer.parse(request.body);
    return { data: await asActor(request, (db, actor) => disableItem(db, id, body.reviewer_id, actor)) };
  });
}
