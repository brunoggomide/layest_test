import type { Json, JsonObject } from './types';

export const shortId = (id: string): string => id.slice(0, 8);

/** 'doc_pattern=89ae367c...|failure': a full hash says nothing a reviewer can read; the title keeps it. */
export const shortSlot = (slot: string): string => slot.replace(/([0-9a-f]{8})[0-9a-f]{32}/, '$1\u2026');

export function formatDate(iso: string | null): string {
  return iso === null ? '-' : new Date(iso).toLocaleString();
}

/** How a scalar is shown in an input: null as empty, objects as JSON. */
export function displayValue(value: Json | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Empty means null; a number stays a number; everything else is text. */
export function parseScalar(text: string): Json {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return NUMBER.test(trimmed) ? Number(trimmed) : text;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string, what: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
  if (!isObject(parsed)) throw new Error(`${what} must be a JSON object`);
  return parsed;
}

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
