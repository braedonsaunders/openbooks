import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";
import { readAdjudicatedHolidayPayment, type AdjudicatedHolidayPayment } from "./holiday-payment-contract.ts";

export interface HolidayPaymentSourceReference {
  readonly fileId: string;
  readonly versionId: string;
}

export interface RetainedHolidayPaymentSource {
  readonly orgId: string;
  readonly fileId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly contentHash: string | null;
  readonly fileInactive: boolean;
  readonly folderInactive: boolean;
}

export interface SourceBoundHolidayPayment {
  readonly instruction: AdjudicatedHolidayPayment;
  readonly source: HolidayPaymentSourceReference & { readonly versionNumber: number; readonly contentHash: string };
}

export function readHolidayPaymentSourceReference(value: unknown): HolidayPaymentSourceReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PayrollError("Select the retained File Cabinet version containing the unpaid holiday instruction.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "fileId" && key !== "versionId") ||
      typeof input.fileId !== "string" || !isUuid(input.fileId) ||
      typeof input.versionId !== "string" || !isUuid(input.versionId)) {
    throw new PayrollError("Holiday evidence requires a File Cabinet file and its exact retained version.");
  }
  return { fileId: input.fileId.toLowerCase(), versionId: input.versionId.toLowerCase() };
}

/** Bind the input to a tenant-owned append-only version, never the mutable
 * current-file pointer. The caller must load this row under File Cabinet
 * authorization; metadata alone does not adjudicate the employee's right. */
export function bindHolidayPaymentSource(
  orgId: string,
  instructionValue: unknown,
  referenceValue: unknown,
  retained: RetainedHolidayPaymentSource | null,
): SourceBoundHolidayPayment {
  const instruction = readAdjudicatedHolidayPayment(instructionValue);
  const reference = readHolidayPaymentSourceReference(referenceValue);
  if (!isUuid(orgId) || !retained || retained.orgId.toLowerCase() !== orgId.toLowerCase() ||
      retained.fileId.toLowerCase() !== reference.fileId || retained.versionId.toLowerCase() !== reference.versionId ||
      retained.fileInactive !== false || retained.folderInactive !== false) {
    throw new PayrollError("The selected holiday evidence is not an available retained version in this organization.");
  }
  if (!Number.isSafeInteger(retained.versionNumber) || retained.versionNumber < 1 ||
      typeof retained.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(retained.contentHash)) {
    throw new PayrollError("The retained holiday evidence has no valid version digest; upload the original source through File Cabinet before proposing payment.");
  }
  const contentHash = retained.contentHash.toLowerCase();
  if (contentHash !== instruction.sourceDigest) {
    throw new PayrollError("The holiday instruction digest differs from the retained source version; review the original and select its matching version.");
  }
  return { instruction, source: { ...reference, versionNumber: retained.versionNumber, contentHash } };
}
