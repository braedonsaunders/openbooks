import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { Authz } from "../authz";
import {
  mergeResolvedEntities,
  type ConversationSummary,
  type ResolvedEntity,
} from "./context-summary";

/**
 * Conversation memory persistence: the rolling summary lives at
 * `ai_conversations.metadata -> 'summary'` (migration 0152), namespaced so
 * future memory keys share the column without colliding. Every accessor
 * takes the resolved Authz and enforces ownership (org_id + user_id) in SQL
 * — the same rule as ai-conversations.ts — so one user's memory never leaks
 * to another user, even in the same org.
 */

export type ConversationMemoryInput = {
  text: string;
  entities: ResolvedEntity[];
  turnsCovered: number;
};

function cleanSummaryRow(value: unknown): ConversationSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const { text, entities, turnsCovered, updatedAt } = value as Record<string, unknown>;
  if (typeof text !== "string" || !text.trim()) return null;
  if (!Array.isArray(entities)) return null;
  if (typeof turnsCovered !== "number" || !Number.isFinite(turnsCovered)) return null;
  return {
    text: text.trim().slice(0, 1_000),
    entities: mergeResolvedEntities([], entities),
    turnsCovered: Math.max(0, Math.floor(turnsCovered)),
    updatedAt: typeof updatedAt === "string" && updatedAt ? updatedAt : new Date(0).toISOString(),
  };
}

/** Owner-only count of assistant turns (drives the refresh cadence). */
export async function countConversationAssistantTurns(
  authz: Authz,
  conversationId: string,
): Promise<number> {
  const r = await db.execute<{ count: string }>(sql`
    select count(*) as count
      from ai_messages m
      join ai_conversations c on c.id = m.conversation_id
     where m.conversation_id = ${conversationId} and m.role = 'assistant'
       and c.org_id = ${authz.user.orgId} and c.user_id = ${authz.user.id}
  `);
  return Number(r.rows[0]?.count ?? 0);
}

/** Owner-only read; null when no summary exists yet or it fails validation. */

/**
 * `metadata` arrives with migration 0152. A web process can serve requests
 * before a deployment's migrations have run (or against a database that has
 * not taken the release yet); conversation memory is an optimisation, so a
 * missing column degrades to "no memory" instead of failing the whole turn.
 */
let warnedMissingMetadata = false;
function isMissingMetadataColumn(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  const message = String(cause?.message ?? (error as Error)?.message ?? "");
  const missing = code === "42703" && /\bmetadata\b/.test(message);
  if (missing && !warnedMissingMetadata) {
    warnedMissingMetadata = true;
    console.warn("[assistant/memory] ai_conversations.metadata is missing (migration 0152 not applied); conversation memory disabled until it is");
  }
  return missing;
}

export async function readConversationSummary(
  authz: Authz,
  conversationId: string,
): Promise<ConversationSummary | null> {
  let r: { rows: { summary: unknown }[] };
  try {
    r = await db.execute<{ summary: unknown }>(sql`
      select c.metadata -> 'summary' as summary
        from ai_conversations c
       where c.id = ${conversationId}
         and c.org_id = ${authz.user.orgId} and c.user_id = ${authz.user.id}
    `);
  } catch (error) {
    if (isMissingMetadataColumn(error)) return null;
    throw error;
  }
  if (r.rows.length === 0) return null;
  return cleanSummaryRow(r.rows[0]!.summary);
}

/**
 * Owner-only write (merge at the `summary` key; other metadata keys
 * survive). Returns false when the conversation is not owned — the caller
 * logs and continues; a memory update must never fail a completed turn.
 */
export async function writeConversationSummary(
  authz: Authz,
  conversationId: string,
  input: ConversationMemoryInput,
): Promise<boolean> {
  const payload = JSON.stringify({
    text: input.text.trim().slice(0, 1_000),
    entities: mergeResolvedEntities([], input.entities),
    turnsCovered: Math.max(0, Math.floor(input.turnsCovered)),
    updatedAt: new Date().toISOString(),
  });
  let result: unknown;
  try {
    result = await db.execute(sql`
      update ai_conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('summary', ${payload}::jsonb)
       where id = ${conversationId}
         and org_id = ${authz.user.orgId} and user_id = ${authz.user.id}
    `);
  } catch (error) {
    if (isMissingMetadataColumn(error)) return false;
    throw error;
  }
  return Number((result as { rowCount?: number }).rowCount ?? 0) > 0;
}
