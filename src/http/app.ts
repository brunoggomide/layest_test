import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import type { Database } from '../infrastructure/db/database.js';
import { deterministicExtractor, type KnowledgeExtractor } from '../internal/feedback/extract.js';
import { registerFeedbackRoutes } from '../internal/feedback/router.js';
import { registerKnowledgeRoutes } from '../internal/knowledge/router.js';
import { registerPromotionRoutes } from '../internal/promotion/router.js';
import { registerRunRoutes } from '../internal/runs/router.js';
import { actorOf, requireActor } from './actor.js';
import { registerErrorHandling } from './errors.js';

export interface AppDeps {
  readonly env: Env;
  readonly database: Database;
  readonly extractor?: KnowledgeExtractor;
}

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Keeps the caller's id so one request can be followed across services. */
function requestId(request: IncomingMessage): string {
  const inbound = request.headers['x-request-id'];
  return typeof inbound === 'string' && SAFE_ID.test(inbound) ? inbound : randomUUID();
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const extractor = deps.extractor ?? deterministicExtractor;
  const app = Fastify({
    logger: { level: deps.env.LOG_LEVEL, redact: { paths: ['req.headers["x-service-token"]'], censor: '[redacted]' } },
    genReqId: requestId,
  });
  app.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('x-request-id', request.id);
    done();
  });
  registerErrorHandling(app);
  app.decorateRequest('actor', null);

  app.get('/health', async () => {
    await deps.database.withService((db) => db.query('SELECT 1'));
    return { data: { ok: true } };
  });

  void app.register(
    (v1, _options, done) => {
      requireActor(v1, deps.env.SERVICE_TOKEN);
      // The platform sees every tenant; a tenant connection sees its own row only (RLS on tenants).
      v1.get('/tenants', async (request) => {
        const actor = actorOf(request);
        const query = 'SELECT id, name FROM tenants ORDER BY name';
        const rows = actor.kind === 'service' ? await deps.database.withService((db) => db.query(query)) : await deps.database.withTenant(actor.tenantId, (db) => db.query(query));
        return { data: rows.rows };
      });
      registerRunRoutes(v1, deps.database);
      registerFeedbackRoutes(v1, deps.database, extractor);
      registerKnowledgeRoutes(v1, deps.database);
      registerPromotionRoutes(v1, deps.database, deps.env.PROMOTION_MIN_TENANTS);
      done();
    },
    { prefix: '/api/v1' },
  );

  return app;
}
