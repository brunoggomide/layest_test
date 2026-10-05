import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

/** An error whose code and message are safe to show to the caller. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, 'not_found', `${what} not found`);
export const invalidTransition = (message: string): HttpError => new HttpError(409, 'invalid_transition', message);
export const forbidden = (message: string): HttpError => new HttpError(403, 'forbidden', message);
export const validation = (message: string, details?: unknown): HttpError => new HttpError(400, 'validation_error', message, details);

const PG_ERRORS: Readonly<Record<string, HttpError>> = {
  // The partial unique index lost a race between two activations: the caller retries after reading the key.
  '23505': new HttpError(409, 'active_conflict', 'Another item became active for this key concurrently'),
  '23503': new HttpError(404, 'not_found', 'Referenced tenant or run does not exist'),
  '42501': new HttpError(403, 'forbidden', 'Row-level security rejected this write'),
};

function toHttpError(error: FastifyError | HttpError | ZodError): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) return validation('Request does not match the schema', error.issues);
  const known = PG_ERRORS[(error as { code?: string }).code ?? ''];
  if (known !== undefined) return known;
  if (typeof error.code === 'string' && error.code.startsWith('FST_ERR_') && (error.statusCode ?? 500) < 500) {
    return new HttpError(error.statusCode ?? 400, 'bad_request', error.message);
  }
  // Anything else may carry SQL or a payload in its message: it goes to the log only.
  return new HttpError(500, 'internal_error', 'Internal server error');
}

function send(reply: FastifyReply, request: FastifyRequest, error: HttpError): FastifyReply {
  const body: ErrorBody = {
    error: { code: error.code, message: error.message, requestId: request.id, ...(error.details === undefined ? {} : { details: error.details }) },
  };
  return reply.status(error.statusCode).send(body);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => send(reply, request, new HttpError(404, 'not_found', 'Route not found')));
  app.setErrorHandler<FastifyError | HttpError | ZodError>((error, request, reply) => {
    const shown = toHttpError(error);
    if (shown.statusCode >= 500) request.log.error({ err: error }, 'request failed');
    return send(reply, request, shown);
  });
}
