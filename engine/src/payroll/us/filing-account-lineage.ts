import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { isUuid } from "../../platform/uuid.ts";
import { isIsoCalendarDate } from "../../platform/iso-date.ts";
import { PayrollError } from "../error.ts";

export type UsFilingAccountLineage = {
  id: string;
  filingAccountId: string;
  federalAccountId: string;
  subsidiaryId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceReference: string;
};
export type UsFilingAccountLineageInput = Omit<UsFilingAccountLineage, "id"> & {
  changeReason: string;
};

export function usFilingAccountLineageProblem(input: UsFilingAccountLineageInput): string | null {
  if (![input.filingAccountId, input.federalAccountId, input.subsidiaryId].every(isUuid)) {
    return "Choose the original US state filing account, federal EIN and legal employer.";
  }
  if (
    !isIsoCalendarDate(input.effectiveFrom) ||
    (input.effectiveTo !== null &&
      (!isIsoCalendarDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom))
  ) {
    return "Enter the inclusive dates supported by the original employer registration evidence.";
  }
  if (
    typeof input.sourceReference !== "string" ||
    !input.sourceReference.trim() ||
    input.sourceReference.trim().length > 2000 ||
    typeof input.changeReason !== "string" ||
    !input.changeReason.trim() ||
    input.changeReason.trim().length > 2000
  ) {
    return "Record the original employer registration evidence reference and a change reason within 2000 characters.";
  }
  return null;
}

/** Native Setup and other writers share the same organization and original-employer boundary. */
export async function validateUsFilingAccountLineage(
  tx: SqlExecutor,
  orgId: string,
  input: UsFilingAccountLineageInput,
): Promise<void> {
  const problem = usFilingAccountLineageProblem(input);
  if (problem) throw new PayrollError(problem);
  // The storage policy guard takes these parent locks in the same order.
  const ids = [input.filingAccountId, input.federalAccountId].sort();
  const accounts = await tx.execute<{
    id: string;
    country: string;
    program_type: string;
    subsidiary_id: string | null;
  }>(
    sql`
    select id, country, program_type, subsidiary_id from payroll_filing_accounts
     where org_id = ${orgId} and id in (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     order by id for update
  `,
    "objects",
  );
  const state = accounts.find((account) => account.id === input.filingAccountId);
  const federal = accounts.find((account) => account.id === input.federalAccountId);
  const employer = await tx.execute(
    sql`select id from subsidiaries
    where org_id = ${orgId} and id = ${input.subsidiaryId} and country = 'US' and not is_elimination for share`,
    "objects",
  );
  if (
    employer.length !== 1 ||
    !state ||
    !federal ||
    state.country !== "US" ||
    federal.country !== "US" ||
    state.program_type !== "us_state_sui" ||
    federal.program_type !== "us_ein" ||
    (state.subsidiary_id !== null && state.subsidiary_id !== input.subsidiaryId) ||
    (federal.subsidiary_id !== null && federal.subsidiary_id !== input.subsidiaryId)
  ) {
    throw new PayrollError(
      "Choose this organization’s US state account and original federal EIN for the same native legal employer. Retired accounts remain available for historical qualification.",
    );
  }
}
