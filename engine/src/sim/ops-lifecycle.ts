import { randomUUID } from "node:crypto";
import { deleteDocument } from "../document-delete.ts";
import { reverseProjectGlEntry } from "../project-recognition.ts";
import { createAndPostDocument } from "./activities/documents.ts";
import type { SimOrg } from "./world.ts";

/**
 * Phase 7 — adversarial lifecycle. The messy reality that stresses the
 * invariants: voiding a posted document, reversing a posted GL entry, and
 * writing off a bad receivable. All route through the real engine
 * (document-delete / GL-reversal / credit-memo posting).
 */

/**
 * Void a posted document in an OPEN period: removes the document, its lines,
 * and its journal entry under the guarded amend path, with an audit tombstone.
 * Throws (DeleteError) if the period is closed or payments are applied — which
 * is correct behavior the harness expects.
 */
export async function voidDocument(
  _world: SimOrg,
  documentId: string,
  actorId: string,
  reason: string,
): Promise<{ documentId: string }> {
  return deleteDocument(documentId, actorId, { source: "sim", reason });
}

/** Post a negated reversing entry for a posted journal entry (flips the original to reversed). */
export async function reverseEntry(world: SimOrg, entryId: string, actorId: string): Promise<{ reversalId: string | null }> {
  const reversalId = await reverseProjectGlEntry(
    world.orgId,
    actorId,
    entryId,
    "Adversarial lifecycle simulation reversal",
  );
  return { reversalId };
}

/**
 * Write off an uncollectible receivable: a credit memo whose line hits Bad Debt
 * Expense posts DR Bad Debt / CR Accounts Receivable, reducing the customer's
 * open balance the same way a real write-off does.
 */
export async function writeOffReceivable(
  world: SimOrg,
  args: { customerId: string; amount: string; reason: string; actorId: string; documentDate: string },
): Promise<{ documentId: string; entryId: string }> {
  const res = await createAndPostDocument(world, {
    kind: "customer_credit",
    documentNumber: `WOFF-${randomUUID().slice(0, 8)}`,
    partyId: args.customerId,
    documentDate: args.documentDate,
    createdBy: args.actorId,
    currency: world.currency,
    memo: `Bad debt write-off — ${args.reason}`,
    custom: { sim: { writeOff: true } },
    lines: [{ accountId: world.accounts.badDebt!, description: `Write-off: ${args.reason}`, amount: args.amount }],
  });
  return { documentId: res.documentId, entryId: res.entryId };
}
