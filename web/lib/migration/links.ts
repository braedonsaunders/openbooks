/** The guided migration cutover: the checklist every path works through, with or without the assistant. Client-safe. */
export const MIGRATION_WORKSPACE_HREF = '/migrate'

/** The migration assistant conversation, offered as an optional helper from the guided cutover. Client-safe. */
export const MIGRATION_ASSISTANT_HREF = '/migrate/assistant'

export function migrationConversationHref(conversationId: string): string {
  return `${MIGRATION_WORKSPACE_HREF}/${conversationId}`
}

/** Opens the native connection drawer with the source preselected; credentials are entered only there. */
export function connectSourceHref(source: string): string {
  return `/sync?connect=${encodeURIComponent(source)}`
}
