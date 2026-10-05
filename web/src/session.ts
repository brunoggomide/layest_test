import type { ActorHeaders } from './api';
import type { Tenant } from './types';

export interface Session {
  readonly token: string;
  readonly reviewer: string;
  /** 'platform' or a tenant id. */
  readonly actorKey: string;
}

export const PLATFORM = 'platform';
const STORAGE_KEY = 'billay-kb-session';
const EMPTY: Session = { token: '', reviewer: '', actorKey: PLATFORM };

export function loadSession(): Session {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Session>;
    return { token: parsed.token ?? '', reviewer: parsed.reviewer ?? '', actorKey: parsed.actorKey ?? PLATFORM };
  } catch {
    return EMPTY;
  }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable: the session lives for this page only */
  }
}

export type Actor = { readonly kind: 'platform' } | { readonly kind: 'tenant'; readonly id: string; readonly name: string };

/** An actorKey that matches no loaded tenant falls back to the platform instead of sending a stale id. */
export function resolveActor(actorKey: string, tenants: readonly Tenant[]): Actor {
  const tenant = tenants.find((t) => t.id === actorKey);
  return tenant === undefined ? { kind: 'platform' } : { kind: 'tenant', id: tenant.id, name: tenant.name };
}

export function actorHeaders(actor: Actor, token: string): ActorHeaders {
  return actor.kind === 'platform' ? { 'x-service-token': token } : { 'x-tenant-id': actor.id };
}

export function describeActor(actor: Actor): string {
  return actor.kind === 'platform' ? 'Platform reviewer' : `Tenant: ${actor.name}`;
}
