import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import {
  voidRemedyHooks,
  type VoidRemedyContributors,
} from "../journal/void-remedy-contributors.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import { releaseAllowancePayrollInputs } from "./allowance-payroll-inputs.ts";
import { releaseLeavePayrollInputs } from "./leave-payroll-inputs.ts";
import {
  assertPayrollRemittanceBillCurrent,
  assertRemittanceBillEdit,
  RemittanceSourceIntegrityError,
} from "./remittance-bill-integrity.ts";

const preconditions: PostingPreconditions["payroll"] = {
  assertRemittanceBillCurrent: assertPayrollRemittanceBillCurrent,
  async assertRemittanceBillEdit(executor, orgId, documentId, preparedLines, patch) {
    try {
      return await assertRemittanceBillEdit(executor, orgId, documentId, preparedLines, patch);
    } catch (error) {
      if (error instanceof RemittanceSourceIntegrityError)
        throw new DocumentEditError(422, error.message);
      throw error;
    }
  },
};

const remedies: VoidRemedyContributors["payroll"] = {
  async releaseRunInputs(executor, input) {
    await releaseLeavePayrollInputs(executor, input);
    await releaseAllowancePayrollInputs(executor, input);
  },
};

/** Payroll: remittance bills reconcile to committed payroll; a voided run releases its inputs. */
export function registerPayrollPostingContributors(): void {
  postingPreconditionHooks.register("payroll", preconditions);
  voidRemedyHooks.register("payroll", remedies);
}
