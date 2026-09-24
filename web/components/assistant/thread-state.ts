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

/**
 * History page size (mirrors AI_MESSAGE_WINDOW in ai-conversations.ts, which
 * the client bundle cannot import — it pulls in server-only).
 */
export const MESSAGE_PAGE_SIZE = 30;

/**
 * Delay before the post-turn sidebar re-refresh (mirrors TITLE_TIMEOUT_MS in
 * conversation-title.ts plus margin: the server generates the thread title
 * after the stream closes, so the end-of-turn refresh usually still shows the
 * placeholder and this second pass picks the generated title up).
 */
export const TITLE_REFRESH_DELAY_MS = 12_000;

/**
 * Restore the reader's position after prepending history: the viewport keeps
 * its exact distance from the old head by the height the new rows added.
 */
export function anchorScrollTop(
  prevScrollTop: number,
  prevScrollHeight: number,
  nextScrollHeight: number,
): number {
  return prevScrollTop + (nextScrollHeight - prevScrollHeight);
}

/**
 * Stick-to-bottom gate for the streaming viewport: auto-scroll follows new
 * chunks only while the reader is already at the bottom. Any upward scroll
 * detaches (the reader is looking at history); jumping back re-attaches.
 * Short content that fits without scrolling counts as at the bottom.
 */
export function isViewportAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 48,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
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
  now: Date,
  locale: string,
  timeZone: string,
): { compact: string; full: string } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const civilDate = (value: Date) => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone,
  }).format(value)
  const sameDay =
    civilDate(date) === civilDate(now);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
  const compact = sameDay
    ? time
    : `${new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        ...(new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone }).format(date) === new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone }).format(now) ? {} : { year: "numeric" as const }),
        timeZone,
      }).format(date)} · ${time}`;
  const full = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(date);
  return { compact, full };
}
