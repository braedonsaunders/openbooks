import { isUuid } from "../platform/uuid.ts";

/**
 * Shared inbox delegation parser (B-INB-1/B3-INB-01).
 *
 * Every inbox adapter that hands a pending gate to a colleague demands the
 * same reason shape — `user:<uuid>: handover note` — and every one of them
 * used to parse the note and then drop it, passing only the uuid to
 * delegateGate. Parse once here and hand BOTH halves to delegateGate, so no
 * adapter can demand a note it never records.
 */

export type DelegationTarget = {
  /** The colleague taking over. */
  toUserId: string;
  /** The handover note, trimmed; empty when the delegator wrote none. */
  note: string;
};

/**
 * Split a delegation reason into its recipient and its handover note.
 * Throws the named refusal when no recipient is given — the adapters rely
 * on the throw, never on a silent default.
 *
 * The recipient ends at the first colon or whitespace, so both documented
 * shapes work: `user:<uuid>: covering note` and `user:<uuid> covering
 * note`. (The copy-pasted regex this replaces captured the colon into the
 * id, so the documented colon shape never parsed — every adapter refused a
 * well-formed delegation reason.)
 */
export function parseDelegationReason(reason: string | null | undefined): DelegationTarget {
  // The adapters rely on the throw, never on a silent default.
  const REFUSAL = "delegation needs a recipient — give the reason as the colleague taking over, then the handover note";
  const text = (reason ?? "").trim();
  const prefix = /^user:/i.exec(text);
  if (!prefix) throw new Error(REFUSAL);
  const rest = text.slice(prefix[0].length).trim();
  const end = rest.search(/[\s:]/);
  const toUserId = end < 0 ? rest : rest.slice(0, end);
  if (!isUuid(toUserId)) throw new Error(REFUSAL);
  const note = (end < 0 ? "" : rest.slice(end)).replace(/^:\s*/, "").trim();
  return { toUserId, note };
}
