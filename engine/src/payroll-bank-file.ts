import { sum } from "./money.ts";
import { stubPaymentMethods } from "./payroll-payment-method.ts";
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

/** One credit on the direct-deposit file. */
export interface PayRunBankFileEntry {
  stubId: string;
  employeePartyId: string;
  employeeName: string;
  amount: string;
}

export interface PayRunBankFilePopulation {
  entries: PayRunBankFileEntry[];
  /** Control total of the file — the money the EFT debit will draw. */
  total: string;
  /** Employees settled on paper instead; they are NOT on the file. */
  excludedCheque: { employeePartyId: string; employeeName: string; amount: string }[];
}

/**
 * Who is on the direct-deposit file, and for how much.
 *
 * A bank file is EFT ONLY. Cheque employees are deliberately excluded rather
 * than filtered out incidentally by "has bank details": an employee can hold
 * approved bank details and still be paid by cheque, and crediting their
 * account as well as handing them paper pays them twice. The rail comes from
 * the one resolver (engine/src/payroll-payment-method.ts) so the file, the
 * cheque batch and the funding panel always partition the same population.
 *
 * This emits no bank bytes, so it is safe to call while the export below
 * remains gated — the split is the part that has to be right regardless.
 */
export async function payRunBankFilePopulation(
  orgId: string,
  documentId: string,
): Promise<PayRunBankFilePopulation> {
  const stubs = await stubPaymentMethods(orgId, documentId);
  const entries = stubs
    .filter((stub) => stub.method === "eft")
    .map((stub) => ({
      stubId: stub.stubId,
      employeePartyId: stub.employeePartyId,
      employeeName: stub.name,
      amount: stub.netPay,
    }));
  return {
    entries,
    total: sum(entries.map((entry) => entry.amount)),
    excludedCheque: stubs
      .filter((stub) => stub.method === "cheque")
      .map((stub) => ({
        employeePartyId: stub.employeePartyId,
        employeeName: stub.name,
        amount: stub.netPay,
      })),
  };
}

/**
 * The approval half of the control above now exists
 * (engine/src/payroll-approval.ts): whoever re-enables this export must call
 * `assertPayRunApprovalReleased(orgId, documentId)` before a single byte is
 * produced, so money-movement instructions can never leave an unapproved run.
 *
 * It must also build its records from `payRunBankFilePopulation` — never from
 * the stub table directly — or cheque employees will be credited twice.
 */
export async function buildPayRunBankFile(_opts: {
  orgId: string;
  documentId: string;
  format?: PayRunBankFileFormat;
}): Promise<never> {
  throw new PayrollError(PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE);
}
