// Transcript state for the assistant thread: helpers that keep a streamed
// turn visible exactly once while it streams and protect it across the
// stop → persistence gap (ported from the appkit AgentPanel reconciliation).

export type ThreadMessage = { id: string; role: string; parts: unknown[] };

/** Replace the last assistant message's parts with freshly streamed ones. */
export function withLastAssistantParts<T extends ThreadMessage>(
  list: T[],
  parts: unknown[],
): T[] {
  const copy = list.slice();
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    const message = copy[index];
    if (message && message.role === "assistant") {
      copy[index] = { ...message, parts };
      break;
    }
  }
  return copy;
}

/** Number of assistant turns witnessed (the persistence-gap floor). */
export function countAssistantTurns(list: ThreadMessage[]): number {
  return list.reduce((count, message) => count + (message.role === "assistant" ? 1 : 0), 0);
}

/**
 * Reconcile after a stopped turn: adopt the persisted transcript, UNLESS the
 * server knows fewer assistant turns than the panel already showed — then
 * persistence has not caught up yet and adopting would briefly erase the
 * completed answer. The host stays authoritative as soon as it catches up.
 */
export function reconcileThreadAfterStop<T extends ThreadMessage>(
  local: T[],
  server: T[],
  completedFloor: number,
): T[] {
  if (countAssistantTurns(server) < completedFloor) return local;
  return server;
}

/**
 * Compact + full labels for a message timestamp. Same-day turns show the
 * time; older turns show the date too. Null for unparseable input.
 */
export function formatMessageTimestamp(
  value: string,
  now = new Date(),
): { compact: string; full: string } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const compact = sameDay
    ? time
    : `${date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
      })} · ${time}`;
  const full = date.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return { compact, full };
}
