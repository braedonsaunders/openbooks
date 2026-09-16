// Sidebar list state for the assistant: a new thread appears the moment its
// id is known (the chat POST's `x-conversation-id`), long before the first
// turn finishes streaming. The functions are pure so the merge rules are
// unit-testable; the component owns the provisional-id set in a ref.

export type SidebarConversation = { id: string; title: string; updatedAt: string };

/** Server-side placeholder for a fresh thread (ai-conversations.ts slices the prompt). */
export const PROVISIONAL_TITLE_CHARS = 60;

export function provisionalTitle(prompt: string): string {
  return prompt.trim().slice(0, PROVISIONAL_TITLE_CHARS);
}

/**
 * Insert a just-created thread at the top of the sidebar. An existing row
 * wins: a rename that landed first must not be clobbered by the provisional
 * title.
 */
export function upsertProvisionalConversation(
  list: SidebarConversation[],
  entry: SidebarConversation,
): SidebarConversation[] {
  if (list.some((c) => c.id === entry.id)) return list;
  return [entry, ...list];
}

/** Optimistic local rename; position is preserved. */
export function renameConversationRow(
  list: SidebarConversation[],
  id: string,
  title: string,
): SidebarConversation[] {
  return list.map((c) => (c.id === id ? { ...c, title } : c));
}

/** Optimistic local delete. */
export function removeConversationRow(
  list: SidebarConversation[],
  id: string,
): SidebarConversation[] {
  return list.filter((c) => c.id !== id);
}

/**
 * Merge the server list back after a stream ends. The server is authoritative
 * for every thread it knows; rows the client created (provisional ids) that
 * the server does not list yet stay pinned at the top in first-seen order, so
 * a rename or delete issued mid-stream — or a still-replicating create — can
 * never drop the row. Ids the server now knows leave the provisional set.
 */
export function reconcileConversations(
  local: SidebarConversation[],
  server: SidebarConversation[],
  provisionalIds: ReadonlySet<string>,
): { items: SidebarConversation[]; provisionalIds: Set<string> } {
  const serverIds = new Set(server.map((c) => c.id));
  const pending = local.filter((c) => provisionalIds.has(c.id) && !serverIds.has(c.id));
  const remaining = new Set<string>();
  for (const c of pending) remaining.add(c.id);
  return { items: [...pending, ...server], provisionalIds: remaining };
}
