class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ActorHeaders = Readonly<Record<string, string>>;

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown, extraHeaders?: ActorHeaders): Promise<T>;
}

interface Envelope<T> {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly requestId?: string };
}

async function request<T>(method: 'GET' | 'POST', path: string, headers: ActorHeaders, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (envelope.error !== undefined) {
    throw new ApiError(response.status, envelope.error.code, envelope.error.message, envelope.error.requestId ?? null);
  }
  if (!response.ok || envelope.data === undefined) {
    throw new ApiError(response.status, 'http_error', `Unexpected response (HTTP ${response.status})`, null);
  }
  return envelope.data;
}

export function createApi(headers: ActorHeaders): Api {
  return {
    get: (path) => request('GET', path, headers),
    post: (path, body, extraHeaders) => request('POST', path, { ...headers, ...extraHeaders }, body ?? {}),
  };
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}${error.requestId === null ? '' : ` (request ${error.requestId})`}`;
  }
  return error instanceof Error ? error.message : String(error);
}
