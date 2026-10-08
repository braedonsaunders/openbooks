/**
 * Conversation scopes: the general assistant, and the migration workspace,
 * whose conversations carry the migration playbook and stay separate from
 * general chat history. Client-safe.
 */
export const CONVERSATION_SCOPES = ["assistant", "migration"] as const;
export type ConversationScope = (typeof CONVERSATION_SCOPES)[number];

/** Unknown or absent values are the general assistant — never a broader scope. */
export function conversationScope(value: unknown): ConversationScope {
  return CONVERSATION_SCOPES.find((scope) => scope === value) ?? "assistant";
}
