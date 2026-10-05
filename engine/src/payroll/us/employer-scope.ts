import { sql } from "drizzle-orm";
import type { db } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";

/**
 * Which committed US payroll counts toward which annual wage base.
 *
 * An employee's payroll profile names ONE filing account — either the
 * employer's federal EIN or the state unemployment (SUI) account the
 * employee reports under — but the annual bases do not follow that choice:
 *
 * - Social Security, Medicare (including the Additional Medicare threshold),
 *   FUTA and the $1 million supplemental-wage threshold accumulate per
 *   EMPLOYER — the federal EIN — across every state account it holds. An
 *   employee moved from the New York SUI account to the New Jersey one under
 *   the same EIN continues the same Social Security wage base; restarting it
 *   would withhold Social Security on wages already taxed to the base.
 * - SUI accumulates per state account, and the state account for a run is
 *   the employer's account for the run's work state, whichever account the
 *   profile happens to name — so a recorded financing method (reimbursable,
 *   school employees fund) is honoured for an employee whose profile names
 *   the EIN.
 *
 * The legal employer of an account is its subsidiary; an org-wide account
 * (no subsidiary) belongs to the employee's own legal employer. A state
 * account belongs to the EIN of the same legal employer. Both resolutions
 * are pure over the org's filing accounts, so the run, the readiness gate
 * and the tests decide from one function.
 */
export interface UsFilingAccountRef {
  id: string;
  name: string;
  programType: string;
  subsidiaryId: string | null;
  stateCode: string | null;
  isActive: boolean;
}

export interface UsEmployerScope {
  /**
   * The EIN filing account the federal per-EIN carry-ins are keyed by; null
   * when the profile names no filing account or the legal employer has no
   * EIN account on file (no per-EIN carry-in can then exist either — saving
   * one requires an EIN account).
   */
  federalAccountId: string | null;
  /**
   * Filing accounts whose committed stubs share the federal wage bases with
   * this run; null means the run names no filing account and shares only
   * with stubs that named none either.
   */
  stubAccountIds: readonly string[] | null;
}

const EIN = "us_ein";
const SUI = "us_state_sui";

function employerOf(account: UsFilingAccountRef, employeeSubsidiaryId: string | null): string | null {
  return account.subsidiaryId ?? employeeSubsidiaryId;
}

/** The EIN accounts a legal employer holds: active ones when any are active. */
function einsOf(
  accounts: readonly UsFilingAccountRef[],
  employer: string | null,
  employeeSubsidiaryId: string | null,
): UsFilingAccountRef[] {
  const eins = accounts.filter((account) =>
    account.programType === EIN && employerOf(account, employeeSubsidiaryId) === employer);
  const active = eins.filter((account) => account.isActive);
  return active.length > 0 ? active : eins;
}

export function resolveUsEmployerScope(
  accounts: readonly UsFilingAccountRef[],
  runAccountId: string | null,
  employeeSubsidiaryId: string | null,
): UsEmployerScope {
  if (!runAccountId) return { federalAccountId: null, stubAccountIds: null };
  const run = accounts.find((account) => account.id === runAccountId);
  if (!run) {
    throw new PayrollError(
      `the payroll profile names filing account ${runAccountId}, which is not a US filing account of this organization. `
      + "Assign the employee a US filing account in Payroll → Employees before calculating.",
    );
  }
  const employer = employerOf(run, employeeSubsidiaryId);
  const sameEmployer = accounts.filter((account) => employerOf(account, employeeSubsidiaryId) === employer);
  const eins = einsOf(accounts, employer, employeeSubsidiaryId);
  // A state account maps to its employer's EIN only when that EIN is
  // unambiguous; two live EINs under one legal employer leave every state
  // account's wages unattributable, and guessing would merge or split two
  // employers' Social Security bases.
  if (eins.length > 1 && sameEmployer.some((account) => account.programType !== EIN)) {
    throw new PayrollError(
      `US federal wage bases cannot be accumulated for the ${run.name} filing account: its legal employer holds `
      + `${eins.length} EIN accounts (${eins.map((account) => account.name).sort().join(", ")}), so wages under its `
      + "state accounts cannot be attributed to one EIN. Deactivate the superseded EIN, or assign each EIN to its "
      + "own subsidiary, in Payroll Setup → Filing accounts.",
    );
  }
  const federal = run.programType === EIN ? run : eins[0] ?? null;
  const stubAccountIds = sameEmployer
    .filter((account) => account.programType !== EIN || account.id === federal?.id)
    .map((account) => account.id);
  return { federalAccountId: federal?.id ?? null, stubAccountIds };
}

/**
 * The employer's state SUI account for the run's work state. Prefers an
 * account scoped to the legal employer over an org-wide one; two accounts at
 * the same precedence refuse by name rather than picking one.
 */
export function resolveUsStateSuiAccount(
  accounts: readonly UsFilingAccountRef[],
  runAccountId: string | null,
  employeeSubsidiaryId: string | null,
  region: string,
): string | null {
  const run = runAccountId ? accounts.find((account) => account.id === runAccountId) : undefined;
  const employer = run ? employerOf(run, employeeSubsidiaryId) : employeeSubsidiaryId;
  const candidates = accounts.filter((account) =>
    account.programType === SUI && account.stateCode === region && account.isActive
    && ((employer !== null && account.subsidiaryId === employer) || account.subsidiaryId === null));
  const scoped = candidates.filter((account) => account.subsidiaryId !== null);
  const best = scoped.length > 0 ? scoped : candidates;
  if (best.length > 1) {
    throw new PayrollError(
      `US SUI account is ambiguous for ${region}; resolve the employee's legal-employer state account before calculating.`,
    );
  }
  return best[0]?.id ?? null;
}

/**
 * The federal EIN account a committed stub's wages are reported under on the
 * W-2 and Form 941. Both are filed BY EIN, while a stub records the account
 * its profile named — often a state SUI account — so year-end groups by the
 * legal employer's EIN, the same EIN the run accumulated the federal bases
 * and resolved the per-EIN carry-ins under. Null when the stub names no
 * account or its legal employer has no EIN account on file: the return is
 * then the unassigned one and prints no EIN, never a state account number.
 */
export function resolveUsFederalFilingAccount(
  accounts: readonly UsFilingAccountRef[],
  stubAccountId: string | null,
  employeeSubsidiaryId: string | null,
): string | null {
  if (!stubAccountId) return null;
  const stub = accounts.find((account) => account.id === stubAccountId);
  if (!stub) {
    throw new PayrollError(
      `committed US payroll is filed under account ${stubAccountId}, which is not a US filing account of this `
      + "organization, so its W-2 and Form 941 employer cannot be determined. Reconcile the stub's filing account "
      + "against the original payroll evidence before generating year-end reports.",
    );
  }
  if (stub.programType === EIN) return stub.id;
  const eins = einsOf(accounts, employerOf(stub, employeeSubsidiaryId), employeeSubsidiaryId);
  if (eins.length > 1) {
    throw new PayrollError(
      `W-2 and Form 941 wages filed under the ${stub.name} filing account cannot be attributed to one EIN: its legal `
      + `employer holds ${eins.length} EIN accounts (${eins.map((account) => account.name).sort().join(", ")}). `
      + "Deactivate the superseded EIN, or assign each EIN to its own subsidiary, in Payroll Setup → Filing accounts.",
    );
  }
  return eins[0]?.id ?? null;
}

/**
 * The state account whose number prints in W-2 box 15 for a stub's work
 * state: the stub's own account when it is that state's SUI account, else
 * the employer's account for the state (as the run resolved it). Null when
 * the employer has no account for the state — the slip then names the state
 * with no ID rather than borrowing another employer's number.
 */
export function resolveUsW2StateAccount(
  accounts: readonly UsFilingAccountRef[],
  stubAccountId: string | null,
  employeeSubsidiaryId: string | null,
  state: string,
): string | null {
  if (!state) return null;
  const stub = stubAccountId ? accounts.find((account) => account.id === stubAccountId) : undefined;
  if (stub?.programType === SUI && stub.stateCode === state) return stub.id;
  return resolveUsStateSuiAccount(accounts, stubAccountId, employeeSubsidiaryId, state);
}

/** The org's US filing accounts, active or not (history keeps its employer). */
export async function loadUsFilingAccounts(
  tx: Pick<typeof db, "execute">,
  orgId: string,
): Promise<(UsFilingAccountRef & { accountNumber: string })[]> {
  const rows = await tx.execute<{
    id: string; name: string; program_type: string; subsidiary_id: string | null;
    state_code: string | null; is_active: boolean; account_number: string;
  }>(sql`
    select id, name, program_type, subsidiary_id, state_code, is_active, account_number
      from payroll_filing_accounts
     where org_id = ${orgId} and country = 'US'
     order by id`);
  return rows.rows.map((row) => ({
    id: row.id, name: row.name, programType: row.program_type,
    subsidiaryId: row.subsidiary_id, stateCode: row.state_code, isActive: row.is_active,
    accountNumber: row.account_number,
  }));
}
