/**
 * Gate quorum resolution — the pure decision logic gates.ts applies after a
 * sibling row flips. Factored out DB-free so it is unit-testable
 * (quorum.test.ts) and so the semantics live in one place:
 *
 *   any — the FIRST decision wins the whole gate: approve resumes the approve
 *         branch, reject resumes the reject branch; undecided siblings cancel.
 *   all — one rejection rejects the gate (siblings cancel); the approve
 *         branch resumes only when EVERY sibling has approved.
 *
 * Single-assignee gates resolve directly; multi-assignee gates use the quorum
 * behavior described in the flow execution contract.
 */

export type GateQuorum = "any" | "all";
export type GateDecision = "approved" | "rejected";

/** Sibling snapshot AFTER the deciding row was flipped. */
export interface SiblingGate {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "escalated";
}

export interface QuorumOutcome {
  /** Which branch to resume now; null = keep waiting on remaining siblings. */
  resume: "approve" | "reject" | null;
  /** Sibling ids still pending/escalated that should flip to 'cancelled'. */
  cancelIds: string[];
}

/**
 * Evaluate a gate group after `decision` landed. `siblings` is every row of
 * the group (including the just-decided one, already carrying its new
 * status). 'escalated' rows count as replaced — they never block an 'all'
 * quorum (their replacement row does), but they are cancelled with the rest
 * once the gate resolves.
 */
export function resolveQuorumOutcome(
  quorum: GateQuorum,
  decision: GateDecision,
  siblings: SiblingGate[],
): QuorumOutcome {
  // Rows that flip to 'cancelled' once the gate resolves: undecided pendings
  // plus escalated leftovers (their replacement rows are the live pendings).
  const cancellable = siblings
    .filter((s) => s.status === "pending" || s.status === "escalated")
    .map((s) => s.id);

  if (quorum === "any") {
    return { resume: decision === "approved" ? "approve" : "reject", cancelIds: cancellable };
  }

  // quorum === 'all'
  if (decision === "rejected") return { resume: "reject", cancelIds: cancellable };
  const stillPending = siblings.some((s) => s.status === "pending");
  if (stillPending) return { resume: null, cancelIds: [] };
  const anyRejected = siblings.some((s) => s.status === "rejected");
  return { resume: anyRejected ? "reject" : "approve", cancelIds: cancellable };
}
