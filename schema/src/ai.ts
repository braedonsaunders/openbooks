import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * AI assistant conversation history. Ported from the beaconhs platform's
 * ai_conversations/ai_messages pair (packages/db/src/schema/ai.ts), minus the
 * cross-user sharing layer: an openbooks conversation is private to the user
 * who started it. `scope` namespaces threads per feature ('assistant' for the
 * overview chat) so future features (report explanations, drawer copilots)
 * can reuse the same tables.
 */

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: id(),
    orgId: orgRef(),
    /** Owner — the only user who can read, continue, or delete the thread. */
    userId: uuid("user_id").notNull(),
    scope: text("scope").notNull().default("assistant"),
    title: text("title").notNull().default("New chat"),
    ...auditColumns,
  },
  (t) => [
    index("ai_conversations_owner_scope").on(t.orgId, t.userId, t.scope, t.updatedAt),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: id(),
    orgId: orgRef(),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    /** Plain-text rendering of the turn (used as the model-window fallback). */
    content: text("content").notNull(),
    /**
     * Structured agent-turn payload: `{ v, kind, status, finishReason, usage,
     * parts }` where `parts` is the UI-message parts array (text + tool calls)
     * the chat re-renders on reload exactly as it streamed live.
     */
    data: jsonb("data").$type<Record<string, unknown> | null>(),
    ...auditColumns,
  },
  (t) => [index("ai_messages_conversation").on(t.conversationId, t.createdAt)],
);
