/**
 * Payment-document edit lock: lock in run -> instruction -> payment document
 * order before any flow or service writer mutates a payment document, plus
 * the PaymentKind guard. Moved verbatim from payments/payment-documents.ts;
 * depends only on db, payment-errors and the
 * organization subsidiary-scope row lock, so flows and the posting
 * orchestrator can use it without importing the payments orchestrator.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { PaymentError } from "./payment-errors.ts";
import { lockScopeRow } from "../organization/subsidiary-scope.ts";

export type PaymentKind = "vendor_payment" | "customer_payment";
export function isPaymentKind(kind: string): kind is PaymentKind {
  return kind === "vendor_payment" || kind === "customer_payment";
}

/** Lock in run → instruction → payment document order before any flow or
 * service writer mutates a payment document; retain the document lock through
 * the caller's transaction so a new run instruction cannot race the check. */
export async function lockEditablePaymentDocument(
  id: string,
  orgId: string,
  options: { requireDraft?: boolean; allowedSubsidiaryIds?: ReadonlySet<string> | null } = {},
) {
  const candidates = (await db.execute<{ run_id: string; instruction_id: string }>(sql`
    select run.id as run_id, instruction.id as instruction_id
      from payment_instructions instruction
      join payment_runs run on run.id = instruction.payment_run_id and run.org_id = instruction.org_id
     where instruction.payment_document_id = ${id} and instruction.org_id = ${orgId}
       and instruction.status in ('pending', 'approved', 'generated')
       and run.status in ('draft', 'pending_approval', 'approved', 'processing',
                          'generated', 'delivered', 'partially_failed')
     order by run.id, instruction.id
  `)).rows;
  const runIds = [...new Set(candidates.map((row) => row.run_id))].sort();
  if (runIds.length) {
    await db.execute(sql`select id from payment_runs where org_id = ${orgId} and id in ${runIds} order by id for update`);
    await db.execute(sql`select id from payment_instructions where org_id = ${orgId} and id in ${candidates.map((row) => row.instruction_id)} order by id for update`);
  }
  const [doc] = await db.select().from(schema.documents)
    .where(and(eq(schema.documents.id, id), eq(schema.documents.orgId, orgId))).for("update");
  if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
  // Preserve run → instruction → document lock order, then authorize the
  // persisted scope before exposing any run-state refusal.
  await lockScopeRow(db, orgId, "document", id, options.allowedSubsidiaryIds ?? null);
  const claimed = (await db.execute<{ runNumber: string; status: string }>(sql`
    select run.run_number as "runNumber", run.status
      from payment_instructions instruction
      join payment_runs run on run.id = instruction.payment_run_id and run.org_id = instruction.org_id
     where instruction.payment_document_id = ${id} and instruction.org_id = ${orgId}
       and instruction.status in ('pending', 'approved', 'generated')
       and run.status in ('draft', 'pending_approval', 'approved', 'processing',
                          'generated', 'delivered', 'partially_failed')
     order by run.id, instruction.id limit 1
  `)).rows[0];
  if (claimed) {
    throw new PaymentError(
      `payment is claimed by open payment run ${claimed.runNumber} (${claimed.status}) — ` +
        "reject, roll back, or cancel the run and re-plan the payment before editing it",
    );
  }
  if (options.requireDraft !== false && doc.status !== "draft") throw new PaymentError("only draft payments can be edited");
  return doc;
}
