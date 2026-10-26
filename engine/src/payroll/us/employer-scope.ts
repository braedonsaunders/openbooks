import { sql } from "drizzle-orm";
import type { db } from "../../platform/db.ts";
import { isIsoCalendarDate } from "../../platform/iso-date.ts";
import { PayrollError } from "../error.ts";
import type { UsFilingAccountLineage } from "./filing-account-lineage.ts";

/** All accounts are organization-owned; dated affiliations identify original legal employers. */
export interface UsFilingAccountRef {
  id: string;
  name: string;
  programType: string;
  subsidiaryId: string | null;
  stateCode: string | null;
  isActive: boolean;
  affiliations?: readonly UsFilingAccountLineage[];
}
export interface UsEmployerScope {
  federalAccountId: string | null;
}
const EIN = "us_ein";
const SUI = "us_state_sui";
const REMEDY =
  "Record the original legal employer, federal EIN, evidence reference and inclusive dates in Payroll Setup → Filing Accounts → Employer EIN history.";

function requireSourceDate(sourceDate: string): void {
  if (!isIsoCalendarDate(sourceDate))
    throw new PayrollError("US filing-account ownership requires the actual payroll source date.");
}
function requireAccount(
  accounts: readonly UsFilingAccountRef[],
  id: string,
  employer: string | null,
): UsFilingAccountRef {
  const account = accounts.find((row) => row.id === id);
  if (!account || (account.subsidiaryId !== null && account.subsidiaryId !== employer)) {
    throw new PayrollError(
      `US filing account ${id} is unavailable for the original pay-run legal employer. Reconcile the account against the retained payroll source before calculating or filing.`,
    );
  }
  return account;
}

/** Activation never reassigns historical wages. An explicit EIN retains its own identity. */
export function resolveUsFederalFilingAccount(
  accounts: readonly UsFilingAccountRef[],
  accountId: string | null,
  sourceSubsidiaryId: string | null,
  sourceDate: string,
): string | null {
  requireSourceDate(sourceDate);
  if (!accountId) return null;
  const account = requireAccount(accounts, accountId, sourceSubsidiaryId);
  if (account.programType === EIN) return account.id;
  if (!sourceSubsidiaryId || account.programType !== SUI) {
    throw new PayrollError(
      `The original US employer EIN for ${account.name} on ${sourceDate} is unknown. ${REMEDY}`,
    );
  }
  const rows = (account.affiliations ?? []).filter(
    (row) =>
      row.filingAccountId === account.id &&
      row.effectiveFrom <= sourceDate &&
      (row.effectiveTo === null || row.effectiveTo >= sourceDate),
  );
  if (rows.length !== 1) {
    throw new PayrollError(
      `The original US employer EIN for ${account.name} on ${sourceDate} is ${rows.length ? "ambiguous" : "unknown"}. ${REMEDY}`,
    );
  }
  if (rows[0]!.subsidiaryId !== sourceSubsidiaryId) {
    throw new PayrollError(
      `US filing account ${account.name} on ${sourceDate} belongs to another original legal employer. Select the original account for this native pay-run legal employer; preserve the retained Employer EIN history.`,
    );
  }
  const federal = requireAccount(accounts, rows[0]!.federalAccountId, sourceSubsidiaryId);
  if (federal.programType !== EIN)
    throw new PayrollError(
      `The retained employer affiliation for ${account.name} does not identify a US EIN. ${REMEDY}`,
    );
  return federal.id;
}

/** Prior stubs are resolved separately at each retained source date, then compared by EIN. */
export function resolveUsEmployerScope(
  accounts: readonly UsFilingAccountRef[],
  runAccountId: string | null,
  sourceSubsidiaryId: string | null,
  sourceDate: string,
): UsEmployerScope {
  return {
    federalAccountId: resolveUsFederalFilingAccount(
      accounts,
      runAccountId,
      sourceSubsidiaryId,
      sourceDate,
    ),
  };
}

/** One state account for this original employer and EIN on the payroll source date. */
export function resolveUsStateSuiAccount(
  accounts: readonly UsFilingAccountRef[],
  runAccountId: string | null,
  sourceSubsidiaryId: string | null,
  region: string,
  sourceDate: string,
): string | null {
  requireSourceDate(sourceDate);
  const federal = resolveUsFederalFilingAccount(
    accounts,
    runAccountId,
    sourceSubsidiaryId,
    sourceDate,
  );
  if (!federal) return null;
  const candidates = accounts.filter(
    (account) =>
      account.programType === SUI &&
      account.stateCode === region &&
      (account.subsidiaryId === null || account.subsidiaryId === sourceSubsidiaryId),
  );
  const best = candidates.filter((account) =>
    (account.affiliations ?? []).some(
      (row) =>
        row.subsidiaryId === sourceSubsidiaryId &&
        row.effectiveFrom <= sourceDate &&
        (row.effectiveTo === null || row.effectiveTo >= sourceDate) &&
        row.federalAccountId === federal,
    ),
  );
  // Validate each chosen relationship, including overlapping rows with different EINs.
  for (const account of best)
    resolveUsFederalFilingAccount(accounts, account.id, sourceSubsidiaryId, sourceDate);
  if (best.length > 1)
    throw new PayrollError(
      `US SUI account is ambiguous for ${region} and the original EIN on ${sourceDate}. Resolve the overlapping Employer EIN history in Payroll Setup → Filing Accounts.`,
    );
  if (
    !best.length &&
    candidates.some(
      (account) =>
        !(account.affiliations ?? []).some(
          (row) =>
            row.effectiveFrom <= sourceDate &&
            (row.effectiveTo === null || row.effectiveTo >= sourceDate),
        ),
    )
  ) {
    throw new PayrollError(
      `US SUI account ownership for ${region} on ${sourceDate} is unknown. ${REMEDY}`,
    );
  }
  return best[0]?.id ?? null;
}

export function resolveUsW2StateAccount(
  accounts: readonly UsFilingAccountRef[],
  stubAccountId: string | null,
  sourceSubsidiaryId: string | null,
  state: string,
  sourceDate: string,
): string | null {
  requireSourceDate(sourceDate);
  if (!state) return null;
  const stub = stubAccountId
    ? requireAccount(accounts, stubAccountId, sourceSubsidiaryId)
    : undefined;
  if (stub?.programType === SUI && stub.stateCode === state) {
    resolveUsFederalFilingAccount(accounts, stub.id, sourceSubsidiaryId, sourceDate);
    return stub.id;
  }
  return resolveUsStateSuiAccount(accounts, stubAccountId, sourceSubsidiaryId, state, sourceDate);
}

/** Share parent locks with policy writers until the payroll transaction completes. */
export async function loadUsFilingAccounts(
  tx: Pick<typeof db, "execute">,
  orgId: string,
): Promise<(UsFilingAccountRef & { accountNumber: string })[]> {
  const accounts = await tx.execute<{
    id: string;
    name: string;
    program_type: string;
    subsidiary_id: string | null;
    state_code: string | null;
    is_active: boolean;
    account_number: string;
  }>(
    sql`select id, name, program_type, subsidiary_id, state_code, is_active, account_number
    from payroll_filing_accounts where org_id = ${orgId} and country = 'US' order by id for share`,
    "objects",
  );
  const affiliations = await tx.execute<UsFilingAccountLineage>(
    sql`
    select id, filing_account_id as "filingAccountId", federal_account_id as "federalAccountId",
      subsidiary_id as "subsidiaryId", effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
      source_reference as "sourceReference" from payroll_us_filing_account_employer_lineage
    where org_id = ${orgId} order by filing_account_id, effective_from, id`,
    "objects",
  );
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    programType: account.program_type,
    subsidiaryId: account.subsidiary_id,
    stateCode: account.state_code,
    isActive: account.is_active,
    accountNumber: account.account_number,
    affiliations: affiliations.filter((row) => row.filingAccountId === account.id),
  }));
}
