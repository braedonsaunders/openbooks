import { sql } from "drizzle-orm";
import { db } from "./db.ts";

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
): Promise<PayrollFilingAccount[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select id, country, program_type, account_number, name, remitter_type,
           subsidiary_id, state_code, is_default, is_active
      from payroll_filing_accounts
     where org_id = ${orgId} and is_active
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
 * Kept as one fragment so the remittance summary, the year-end returns, and
 * the filing-account pickers never drift on the fallback rule.
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
  const accounts = await listFilingAccounts(orgId);
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
