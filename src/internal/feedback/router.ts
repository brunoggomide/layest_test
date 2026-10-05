import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../infrastructure/db/database.js';
import { tenantOf } from '../../http/actor.js';
import type { KnowledgeExtractor } from './extract.js';
import { ingestFeedback, type FeedbackInput } from './ingest.js';
import { FEEDBACK_KINDS, type FeedbackDiff, type RunError } from './types.js';

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([jsonPrimitive, z.array(jsonValue), z.record(jsonValue)]));

const feedbackBody = z.object({
  run_id: z.string().uuid(),
  kind: z.enum(FEEDBACK_KINDS),
  reviewer_id: z.string().min(1).max(200),
  diff: z.record(z.object({ before: jsonValue, after: jsonValue })).optional(),
  error: z
    .object({
      code: z.string().min(1).max(100),
      message: z.string().max(2000).optional(),
      missing_field: z.string().max(200).optional(),
      doc_type: z.string().max(100).optional(),
      doc_structure: z.record(jsonPrimitive).optional(),
      suggested_recovery: z.string().max(200).optional(),
    })
    .passthrough()
    .optional(),
});

export function registerFeedbackRoutes(scope: FastifyInstance, database: Database, extractor: KnowledgeExtractor): void {
  scope.post('/feedback', async (request, reply) => {
    const tenantId = tenantOf(request);
    const body = feedbackBody.parse(request.body);
    const input: FeedbackInput = {
      run_id: body.run_id,
      kind: body.kind,
      reviewer_id: body.reviewer_id,
      ...(body.diff === undefined ? {} : { diff: body.diff as FeedbackDiff }),
      ...(body.error === undefined ? {} : { error: body.error as RunError }),
    };
    const result = await ingestFeedback(database, tenantId, input, extractor);
    return reply.status(result.idempotent_replay ? 200 : 201).send({ data: result });
  });
}
