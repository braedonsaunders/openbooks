import { sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";

export async function event(opts: {
  orgId: string;
  runId: string;
  eventType: string;
  actorId?: string | null;
  instructionId?: string | null;
  fileId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.paymentEvents).values({
    orgId: opts.orgId,
    paymentRunId: opts.runId,
    paymentInstructionId: opts.instructionId ?? null,
    paymentFileId: opts.fileId ?? null,
    eventType: opts.eventType,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus ?? null,
    details: opts.details ?? {},
    actorId: opts.actorId ?? null,
  });
}

/** Lock the unsent composition shared by file generation and SFTP delivery. */
export async function lockPendingPaymentInstructions(
  runId: string,
  orgId: string,
): Promise<string[]> {
  const instructions = await db.execute<{ id: string; status: string }>(
    sql`
    select id, status from payment_instructions
     where payment_run_id = ${runId} and org_id = ${orgId}
     order by id for update
  `,
    "objects",
  );
  const ineligible = instructions.find(
    (instruction) => instruction.status !== "pending" && instruction.status !== "cancelled",
  );
  if (ineligible) {
    throw new PaymentError(
      "payment instructions already left pending; do not deliver or regenerate a file containing previously sent instructions",
    );
  }
  return instructions
    .filter((instruction) => instruction.status === "pending")
    .map((instruction) => instruction.id);
}
