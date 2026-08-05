import { PayrollError } from "./payroll-run.ts";

/**
 * Payroll direct-deposit export is deliberately unavailable in this alpha.
 *
 * AP payment files are persisted as immutable artifacts, optionally approved,
 * and every download/delivery is audited. Payroll cannot safely expose bank
 * bytes until it uses that same lifecycle; rendering a fresh file per request
 * would make NACHA/CPA creation timestamps and evidence non-reproducible.
 */
export const PAYROLL_BANK_FILE_EXPORT_ENABLED = false;
export const PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE =
  "payroll bank-file export is unavailable until immutable artifact, approval, and download-audit controls are enabled";

export type PayRunBankFileFormat = "cpa005" | "nacha";

export async function buildPayRunBankFile(_opts: {
  orgId: string;
  documentId: string;
  format?: PayRunBankFileFormat;
}): Promise<never> {
  throw new PayrollError(PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE);
}
