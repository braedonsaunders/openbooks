/**
 * Client-safe lineage helpers (A8). Db-free: safe for 'use client' modules.
 * The server re-validates the anchor; this only builds the request.
 */

export interface LineageAnchorInput {
  runId?: string;
  journalEntryId?: string;
  documentId?: string;
}

/** Exactly one anchor → its query string; otherwise throws for the caller. */
export function buildLineageQuery(anchor: LineageAnchorInput): string {
  const entries = (
    Object.entries(anchor) as [keyof LineageAnchorInput, string | undefined][]
  ).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length !== 1) {
    throw new Error("lineage needs exactly one of runId, journalEntryId, documentId");
  }
  const [[key, value]] = entries as [[keyof LineageAnchorInput, string]];
  return `/api/allocations/lineage?${key}=${encodeURIComponent(value)}`;
}

/** First 8 chars of a uuid for compact drill tables. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length > 8 ? id.slice(0, 8) : id;
}
