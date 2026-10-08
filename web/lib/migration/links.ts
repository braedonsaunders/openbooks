/** The migration workspace: the assistant conversation beside the measured migration plan. Client-safe. */
export const MIGRATION_WORKSPACE_HREF = '/migrate'

export function migrationConversationHref(conversationId: string): string {
  return `${MIGRATION_WORKSPACE_HREF}/${conversationId}`
}

/** Opens the native connection drawer with the source preselected; credentials are entered only there. */
export function connectSourceHref(source: string): string {
  return `/sync?connect=${encodeURIComponent(source)}`
}
