import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { Authz } from "./authz";

/**
 * Assistant conversation persistence: a conversation is
 * private to its owner (no sharing), org-scoped, namespaced by `scope`
 * ('assistant' for the overview chat). Every accessor takes the resolved
 * Authz and enforces ownership in SQL — no caller can read or append to
 * someone else's thread.
 */

export const AI_CONVERSATION_TITLE_MAX_CHARS = 120;
/** Recent-window size sent to the model (and shown on load). */
export const AI_MESSAGE_WINDOW = 30;

export interface AiConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AiStoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export async function listConversations(
  authz: Authz,
  scope: string,
  limit = 20,
): Promise<AiConversationSummary[]> {
  const r = (await db.execute(sql`
    select id, title, updated_at as "updatedAt"
      from ai_conversations
     where org_id = ${authz.user.orgId} and user_id = ${authz.user.id} and scope = ${scope}
     order by updated_at desc
     limit ${limit}
  `)) as unknown as { rows: AiConversationSummary[] };
  return r.rows;
}

/** True when the conversation exists, is in scope, and belongs to this user. */
export async function ownsConversation(
  authz: Authz,
  conversationId: string,
  scope: string,
): Promise<boolean> {
  const r = (await db.execute(sql`
    select 1 from ai_conversations
     where id = ${conversationId} and org_id = ${authz.user.orgId}
       and user_id = ${authz.user.id} and scope = ${scope}
  `)) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

export async function createConversation(
  authz: Authz,
  scope: string,
  title: string,
): Promise<string> {
  const clean = title.trim().slice(0, AI_CONVERSATION_TITLE_MAX_CHARS) || "New chat";
  const r = (await db.execute(sql`
    insert into ai_conversations (org_id, user_id, scope, title, created_by, updated_by)
    values (${authz.user.orgId}, ${authz.user.id}, ${scope}, ${clean},
            ${authz.user.id}, ${authz.user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  return r.rows[0]!.id;
}

/** Owner-only append; also bumps the conversation's updated_at for ordering. */
export async function appendMessage(
  authz: Authz,
  args: {
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const owned = (await tx.execute(sql`
      select 1 from ai_conversations
       where id = ${args.conversationId} and org_id = ${authz.user.orgId}
         and user_id = ${authz.user.id}
    `)) as unknown as { rows: unknown[] };
    if (owned.rows.length === 0) throw new Error("conversation not owned");
    await tx.execute(sql`
      insert into ai_messages (org_id, conversation_id, role, content, data, created_by, updated_by)
      values (${authz.user.orgId}, ${args.conversationId}, ${args.role}, ${args.content},
              ${args.data ? JSON.stringify(args.data) : null}, ${authz.user.id}, ${authz.user.id})
    `);
    await tx.execute(sql`
      update ai_conversations set updated_at = now(), updated_by = ${authz.user.id}
       where id = ${args.conversationId}
    `);
  });
}

/** The most recent window of messages, oldest first (owner-only). */
export async function recentMessages(
  authz: Authz,
  conversationId: string,
  limit = AI_MESSAGE_WINDOW,
): Promise<AiStoredMessage[]> {
  const r = (await db.execute(sql`
    select m.id, m.role, m.content, m.data, m.created_at as "createdAt"
      from ai_messages m
      join ai_conversations c on c.id = m.conversation_id
     where m.conversation_id = ${conversationId}
       and c.org_id = ${authz.user.orgId} and c.user_id = ${authz.user.id}
     order by m.created_at desc, m.id desc
     limit ${limit}
  `)) as unknown as { rows: AiStoredMessage[] };
  return r.rows.reverse();
}

export async function renameConversation(
  authz: Authz,
  conversationId: string,
  scope: string,
  title: string,
): Promise<boolean> {
  const clean = title.trim().slice(0, AI_CONVERSATION_TITLE_MAX_CHARS);
  if (!clean) return false;
  const r = (await db.execute(sql`
    update ai_conversations set title = ${clean}, updated_by = ${authz.user.id}
     where id = ${conversationId} and org_id = ${authz.user.orgId}
       and user_id = ${authz.user.id} and scope = ${scope}
    returning id
  `)) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

export async function deleteConversation(
  authz: Authz,
  conversationId: string,
  scope: string,
): Promise<boolean> {
  // ai_messages cascade via FK.
  const r = (await db.execute(sql`
    delete from ai_conversations
     where id = ${conversationId} and org_id = ${authz.user.orgId}
       and user_id = ${authz.user.id} and scope = ${scope}
    returning id
  `)) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}
