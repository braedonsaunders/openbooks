import { sql } from "drizzle-orm";
import { PayrollError } from "./payroll-error.ts";
import { db, type SqlExecutor } from "./db.ts";

/**
 * Payroll filing accounts — the employer's remittance/filing identities.
 *
 * One employer routinely holds several: a Canadian business number carries
 * …RP0001, …RP0002 … (divisions that remit and file T4s separately), and a US
 * employer holds one or more EINs plus a per-state SUI account. Every filing
 * artifact — the PD7A remittance worksheet, the remittance bill, the T4
 * return — is scoped to ONE account, so all of them group by it.
 *
 * Assignment lives on the employee (employee_payroll_profiles.filing_account_id).
 * An org that files under a single account leaves it null and every employee
 * resolves to the country pack's default account (is_default), or to the
 * "unassigned" bucket when no account is configured at all — which is exactly
 * the pre-existing single-account behaviour.
 */

export interface PayrollFilingAccount {
  id: string;
  /**
   * Open text, like the pack registry's keys — validated at the API boundary
   * against the pack's declared filing program types
   * (payroll-filing-registry.ts), never a closed union that a registered
   * pack cannot satisfy.
   */
  country: string;
  programType: string;
  accountNumber: string;
  name: string;
  remitterType: "regular" | "quarterly" | "accelerated_1" | "accelerated_2";
  subsidiaryId: string | null;
  stateCode: string | null;
  isDefault: boolean;
  isActive: boolean;
}

/** The org's active filing accounts, default first, then by number. */
export async function listFilingAccounts(
  orgId: string,
  country?: string,
  includeInactive = false,
): Promise<PayrollFilingAccount[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select id, country, program_type, account_number, name, remitter_type,
           subsidiary_id, state_code, is_default, is_active
      from payroll_filing_accounts
     where org_id = ${orgId} and (${includeInactive} or is_active)
       and (${country ?? null}::text is null or country = ${country ?? null})
     order by is_default desc, account_number
  `));
  return rows.rows.map(toAccount);
}

function toAccount(row: Record<string, unknown>): PayrollFilingAccount {
  return {
    id: String(row.id),
    country: row.country as PayrollFilingAccount["country"],
    programType: row.program_type as PayrollFilingAccount["programType"],
    accountNumber: String(row.account_number),
    name: String(row.name),
    remitterType: row.remitter_type as PayrollFilingAccount["remitterType"],
    subsidiaryId: (row.subsidiary_id as string | null) ?? null,
    stateCode: (row.state_code as string | null) ?? null,
    isDefault: row.is_default === true,
    isActive: row.is_active === true,
  };
}

/**
 * Identity of a filing group. `id` is null for the unassigned bucket (no
 * account configured, or an employee whose country pack has no default), which
 * keeps single-account orgs working unchanged.
 */
export interface FilingAccountRef {
  id: string | null;
  accountNumber: string | null;
  name: string | null;
  remitterType: PayrollFilingAccount["remitterType"] | null;
}

export const UNASSIGNED_FILING_ACCOUNT: FilingAccountRef = {
  id: null, accountNumber: null, name: null, remitterType: null,
};

/**
 * SQL fragment resolving an employee's effective filing account id:
 * the profile's account, else the default account for the profile's country.
 * `profileAlias` is the alias the caller gave employee_payroll_profiles.
 *
 * Used for prospective calculation and current-profile pickers. Committed
 * reporting reads pay_stubs.filing_account_id, including an explicit null.
 */
export function effectiveFilingAccountSql(profileAlias: string) {
  const profile = sql.raw(profileAlias);
  return sql`coalesce(
    ${profile}.filing_account_id,
    (select fa.id from payroll_filing_accounts fa
      where fa.org_id = ${profile}.org_id and fa.is_active and fa.is_default
        and fa.country = coalesce(${profile}.country, 'CA')
      limit 1)
  )`;
}

/** Filing accounts by id, for labelling grouped output. */
export async function filingAccountsById(
  orgId: string,
): Promise<Map<string, PayrollFilingAccount>> {
  const accounts = await listFilingAccounts(orgId, undefined, true);
  return new Map(accounts.map((account) => [account.id, account]));
}

/** A grouped artifact's account reference; unassigned when id is null. */
export function filingAccountRef(
  id: string | null,
  accounts: Map<string, PayrollFilingAccount>,
): FilingAccountRef {
  if (!id) return UNASSIGNED_FILING_ACCOUNT;
  const account = accounts.get(id);
  if (!account) return { ...UNASSIGNED_FILING_ACCOUNT, id };
  return {
    id: account.id,
    accountNumber: account.accountNumber,
    name: account.name,
    remitterType: account.remitterType,
  };
}

/** Legacy rows were never attributed at calculation; current settings are not evidence. */
export async function assertPayrollFilingAccountKnown(
  executor: SqlExecutor,
  orgId: string,
  scope: { taxYear: number } | { from: string; to: string },
): Promise<void> {
  const filter = "taxYear" in scope
    ? sql`s.tax_year = ${scope.taxYear}`
    : sql`s.pay_date between ${scope.from} and ${scope.to}`;
  const result = await executor.execute(sql`
    select s.id from pay_stubs s
    join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
     where s.org_id = ${orgId} and ${filter}
       and r.run_status = 'committed' and s.filing_account_source = 'unknown'
     limit 1
  `);
  if (result.rows.length) {
    throw new PayrollError("Committed payroll has an unknown historical filing account. Reconcile its original payroll evidence before generating filing or remittance reports.");
  }
}
