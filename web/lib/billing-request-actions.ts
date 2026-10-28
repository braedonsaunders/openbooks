import "server-only";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { db } from "@openbooks/engine/platform/db";
import { readBillingRequestInvoice } from "@openbooks/engine/projects/billing-requests-read";
import { canonicalDecimal } from "./exact-decimal";
import { moneyRefusal } from "./payroll-decimal-refusal";
import { createBillingRequest, type BillingRequestInput } from "./billing-requests";
import { assembleInvoiceBackup, type BackupType } from "./invoice-backup";

export class BillingRequestAmountError extends Error {
  readonly status = 422;
}

export class BillingRequestBackupNotReadyError extends Error {
  readonly status = 422;
}

export function normalizeBillingRequestAmount(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new BillingRequestAmountError(moneyRefusal("Draw amount", value));
  try {
    return normalizeMoney(exact);
  } catch {
    throw new BillingRequestAmountError(moneyRefusal("Draw amount", value));
  }
}

export async function createProjectBillingRequest(
  orgId: string,
  actorId: string,
  input: BillingRequestInput,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
) {
  const drawAmount = normalizeBillingRequestAmount(input.drawAmount);
  return createBillingRequest(orgId, actorId, { ...input, drawAmount }, allowedSubsidiaryIds);
}

export async function generateBillingRequestBackup(
  orgId: string,
  actorId: string,
  requestId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
) {
  const request = await readBillingRequestInvoice(db, orgId, requestId, allowedSubsidiaryIds);
  if (!request) return null;
  if (!request.invoice_document_id) {
    throw new BillingRequestBackupNotReadyError("This request has no invoice to back up yet");
  }
  const result = await assembleInvoiceBackup(
    orgId,
    actorId,
    request.invoice_document_id,
    request.backup_type as BackupType,
    allowedSubsidiaryIds,
  );
  return {
    fileId: result.fileId,
    pageCount: result.pageCount,
    invoiceId: request.invoice_document_id,
  };
}
