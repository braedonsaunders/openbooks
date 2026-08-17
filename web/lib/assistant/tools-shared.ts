import "server-only";
import { z } from "zod";

/**
 * Shared input atoms and result-shaping helpers for the domain tool files
 * (tools-analytics, tools-reports, tools-banking, tools-payroll, tools-files,
 * tools-setup). Same contracts as the originals in tools.ts: capped lists,
 * 2-dp money, ISO dates.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const dateInput = z.string().regex(ISO_DATE, "YYYY-MM-DD");
export const uuidInput = z.string().regex(UUID_RE, "uuid");

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export const MAX_LIST_ROWS = 200;

/** Cap a list so a single tool result can't blow the model context. */
export function capList<T>(items: T[], max = MAX_LIST_ROWS): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, max), truncated: items.length > max };
}
