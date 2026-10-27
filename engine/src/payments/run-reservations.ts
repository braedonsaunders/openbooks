import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";

/**
 * A live payment-run reservation of an open item. Run items in status
 * 'selected' reserve their source line until the run pays, returns or
 * releases it; the run's file may already be at the bank.
 */
// A type alias (not an interface): db.execute<T> needs the implicit index
// signature only object-literal types carry.
export type RunReservation = {
  lineId: string;
  documentNumber: string | null;
  runId: string;
  runNumber: string;
  runStatus: string;
};

/**
 * Live reservations of the given lines held by any run other than the one
 * paying through `paymentDocumentId` (the run's own payment document may
 * settle what its run reserved).
 */
export async function foreignRunReservations(
  orgId: string,
  lineIds: readonly string[],
  paymentDocumentId: string | null,
  opts: { skipUnassembled?: boolean } = {},
): Promise<RunReservation[]> {
  const ids = [...new Set(lineIds)].sort();
  if (ids.length === 0) return [];
  return await db.execute<RunReservation>(
    sql`
    select item.source_open_line_id as "lineId", document.document_number as "documentNumber",
           run.id as "runId", run.run_number as "runNumber", run.status as "runStatus"
      from payment_run_items item
      join payment_runs run on run.id = item.payment_run_id and run.org_id = item.org_id
      left join payment_instructions instruction
        on instruction.id = item.payment_instruction_id and instruction.org_id = item.org_id
      left join documents document on document.id = item.source_document_id and document.org_id = item.org_id
     where item.org_id = ${orgId} and item.status = 'selected'
       and item.source_open_line_id = any(${`{${ids.join(",")}}`}::uuid[])
       and (${paymentDocumentId}::uuid is null
            or instruction.payment_document_id is distinct from ${paymentDocumentId}::uuid)
       and (not ${opts.skipUnassembled === true} or item.payment_instruction_id is not null)
     order by document.document_number, item.source_open_line_id
  `,
    "objects",
  );
}

/** The operator's way out of a reservation, for the run's current status. */
function releaseRemedy(runNumber: string, runStatus: string): string {
  switch (runStatus) {
    case "draft":
    case "rejected":
      return `cancel payment run ${runNumber}`;
    case "pending_approval":
      return `have payment run ${runNumber} rejected in its approval flow and cancel it`;
    case "approved":
    case "generated":
      return `roll back payment run ${runNumber}`;
    case "delivered":
    case "partially_failed":
      return `confirm with the bank that payment run ${runNumber}'s file was not processed and roll the run back`;
    case "processing":
      return `wait for payment run ${runNumber} to finish posting`;
    default:
      return `resolve payment run ${runNumber}`;
  }
}

/**
 * Refuse by name when a settlement would touch an item another payment run
 * has reserved: the run will pay it, possibly from a file already at the
 * bank, so paying it here pays it twice.
 */
export function runReservationRefusal(
  reservations: readonly RunReservation[],
): PaymentError | null {
  const first = reservations[0];
  if (!first) return null;
  const item = first.documentNumber ?? "an applied open item";
  const others =
    reservations.length > 1
      ? ` (and ${reservations.length - 1} more reserved item${reservations.length > 2 ? "s" : ""})`
      : "";
  return new PaymentError(
    `${item}${others} is reserved by payment run ${first.runNumber} (${first.runStatus.replaceAll("_", " ")}), which will pay it; ` +
      `pay it through that run, or ${releaseRemedy(first.runNumber, first.runStatus)} before settling it here`,
  );
}

/** Throw the reservation refusal for the given lines, if any applies. */
export async function assertNoForeignRunReservation(
  orgId: string,
  lineIds: readonly string[],
  paymentDocumentId: string | null,
  opts: { skipUnassembled?: boolean } = {},
): Promise<void> {
  const refusal = runReservationRefusal(
    await foreignRunReservations(orgId, lineIds, paymentDocumentId, opts),
  );
  if (refusal) throw refusal;
}
