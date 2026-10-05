import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../shared/actor.js';
import { HttpError } from './errors.js';

/**
 * The MVP stand-in for authentication. The isolation guarantee lives in row-level security, so a
 * real identity provider would replace this file only.
 *   X-Service-Token == SERVICE_TOKEN  -> platform reviewer, runs as billay_service
 *   X-Tenant-Id: <uuid>               -> tenant reviewer, runs as billay_app scoped to that tenant
 */
declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function resolveActor(request: FastifyRequest, serviceToken: string): Actor {
  const token = header(request, 'x-service-token');
  if (token !== undefined) {
    if (!sameSecret(token, serviceToken)) throw new HttpError(401, 'unauthorized', 'Invalid service token');
    return { kind: 'service' };
  }
  const tenantId = header(request, 'x-tenant-id');
  if (tenantId === undefined || tenantId === '') throw new HttpError(401, 'unauthorized', 'Missing X-Tenant-Id or X-Service-Token header');
  if (!UUID.test(tenantId)) throw new HttpError(400, 'validation_error', 'X-Tenant-Id must be a uuid');
  return { kind: 'tenant', tenantId: tenantId.toLowerCase() };
}

/** Every route registered on `scope` after this call carries a resolved actor. */
export function requireActor(scope: FastifyInstance, serviceToken: string): void {
  scope.addHook('onRequest', async (request) => {
    request.actor = resolveActor(request, serviceToken);
  });
}

export function actorOf(request: FastifyRequest): Actor {
  if (request.actor === null) throw new Error('route registered outside the actor scope');
  return request.actor;
}

export function tenantOf(request: FastifyRequest): string {
  const actor = actorOf(request);
  if (actor.kind !== 'tenant') throw new HttpError(403, 'forbidden', 'This endpoint requires a tenant context (X-Tenant-Id)');
  return actor.tenantId;
}

export function requireService(request: FastifyRequest): void {
  if (actorOf(request).kind !== 'service') throw new HttpError(403, 'forbidden', 'This endpoint requires the service token');
}
