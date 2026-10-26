/**
 * What Save & new carries into the next form of the same kind: the document
 * date and, by personal preference, the party. Held in this tab's session
 * storage for a few seconds between the save and the fresh form, consumed
 * once, and never sent to the server — the next form saves only what the
 * clerk confirms on it.
 */

export interface EntryCarry {
  documentDate: string | null;
  partyId: string | null;
}

const PREFIX = "openbooks:entry-carry:";
const LIFETIME_MS = 30_000;

export function stashEntryCarry(kind: string, carry: EntryCarry): void {
  if (typeof window === "undefined") return;
  if (!carry.documentDate && !carry.partyId) {
    window.sessionStorage.removeItem(PREFIX + kind);
    return;
  }
  try {
    window.sessionStorage.setItem(PREFIX + kind, JSON.stringify({ ...carry, at: Date.now() }));
  } catch {
    // Storage refusal only means the next form starts from its defaults.
  }
}

export function takeEntryCarry(kind: string): EntryCarry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + kind);
    window.sessionStorage.removeItem(PREFIX + kind);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { documentDate?: unknown; partyId?: unknown; at?: unknown };
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > LIFETIME_MS) return null;
    return {
      documentDate:
        typeof parsed.documentDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.documentDate)
          ? parsed.documentDate
          : null,
      partyId: typeof parsed.partyId === "string" && parsed.partyId ? parsed.partyId : null,
    };
  } catch {
    return null;
  }
}
