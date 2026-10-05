import type { FastifyInstance } from 'fastify';
import type { Database } from '../../infrastructure/db/database.js';
import { requireService } from '../../http/actor.js';
import { runPromotion } from './promote.js';

export function registerPromotionRoutes(scope: FastifyInstance, database: Database, minTenants: number): void {
  scope.post('/promotion/run', async (request) => {
    requireService(request);
    return { data: await database.withService((db) => runPromotion(db, minTenants)) };
  });
}
