import "server-only";
import { generateInvoiceFromBillingRequest } from "./billing";
import {
  assembleInvoiceBackup,
  InvoiceBackupSourceAccessError,
  type BackupType,
} from "./invoice-backup";
import { isRendererUnavailable } from "./api/pdf-renderer";

/** Generate the draft invoice and assemble required evidence through the same path used by billing requests. */
export async function createInvoiceFromBillingRequest(input: {
  orgId: string;
  actorId: string;
  requestId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}) {
  const result = await generateInvoiceFromBillingRequest(
    input.orgId,
    input.actorId,
    input.requestId,
    input.allowedSubsidiaryIds,
  );
  let backup: { status: "generated" | "not_required" | "failed"; error?: string } =
    result.backupRequired ? { status: "generated" } : { status: "not_required" };
  if (result.backupRequired) {
    try {
      await assembleInvoiceBackup(
        input.orgId,
        input.actorId,
        result.id,
        result.backupType as BackupType,
        input.allowedSubsidiaryIds,
      );
    } catch (error) {
      console.error("billing backup auto-assemble failed", {
        requestId: input.requestId,
        invoiceId: result.id,
        error,
      });
      backup = {
        status: "failed",
        error:
          error instanceof InvoiceBackupSourceAccessError
            ? error.message
            : isRendererUnavailable(error) && error instanceof Error
              ? error.message
              : "The backup packet could not be generated — generate it from the billing request, then submit the invoice",
      };
    }
  }
  return { ...result, backup };
}
