import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../infrastructure/db/database.js';
import { actorOf, tenantOf } from '../../http/actor.js';
import { notFound, validation } from '../../http/errors.js';
import type { JsonObject } from '../../shared/json.js';
import { getRunDetail, listRuns } from './repository.js';
import { startRun } from './start.js';
import type { Invoice } from './types.js';

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([jsonPrimitive, z.array(jsonValue), z.record(jsonValue)]));

const runBody = z.object({
  invoice: z.object({
    vendor: z.string().trim().min(1).max(200),
    fields: z.record(jsonValue).default({}),
    doc_structure: z.record(jsonPrimitive).optional(),
  }),
  invoice_ref: z.string().max(200).optional(),
});
const idParams = z.object({ id: z.string().uuid() });

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function idempotencyKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  if (!IDEMPOTENCY_KEY.test(value)) throw validation('Idempotency-Key must be 1 to 128 characters of letters, digits, ".", "_", ":" or "-"');
  return value;
}

export function registerRunRoutes(scope: FastifyInstance, database: Database): void {
  scope.post('/runs', async (request, reply) => {
    const tenantId = tenantOf(request);
    const body = runBody.parse(request.body);
    const invoice: Invoice = {
      vendor: body.invoice.vendor,
      fields: body.invoice.fields as JsonObject,
      ...(body.invoice.doc_structure === undefined ? {} : { doc_structure: body.invoice.doc_structure }),
    };
    const result = await startRun(database, { tenantId, invoice, invoiceRef: body.invoice_ref ?? null, idempotencyKey: idempotencyKeyOf(request) });
    return reply.status(result.replayed ? 200 : 201).send({ data: result });
  });

  scope.get('/runs', async (request) => {
    const actor = actorOf(request);
    const runs = actor.kind === 'service' ? await database.withService(listRuns) : await database.withTenant(actor.tenantId, listRuns);
    return { data: runs };
  });

  scope.get('/runs/:id', async (request) => {
    const actor = actorOf(request);
    const { id } = idParams.parse(request.params);
    const detail = actor.kind === 'service' ? await database.withService((db) => getRunDetail(db, id)) : await database.withTenant(actor.tenantId, (db) => getRunDetail(db, id));
    if (detail === null) throw notFound(`run ${id}`);
    return { data: detail };
  });
}
