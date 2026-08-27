import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { PayrollFilingData } from '@openbooks/engine/src/payroll-filing-registry.ts'
import type { Authz } from '../../../lib/authz'
import { guardSubsidiaryScope, subsidiaryScopeAllows } from '../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'

/**
 * Payroll rows do not carry a second subsidiary column: the employee's party
 * is the legal-entity owner of a stub, while filing accounts may carry an
 * explicit entity of their own. Keep those two checks in one place so a route
 * cannot accidentally guard only the account (or only the employee).
 */
export async function guardPayrollEmployees(
  gate: Authz,
  employeeIds: readonly string[],
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const ids = [...new Set(employeeIds)]
  if (ids.length === 0) return null
  const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
    select p.id, p.subsidiary_id as "subsidiaryId"
      from parties p
     where p.org_id = ${gate.user.orgId}
       and p.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)).rows
  // An unresolved employee id is indistinguishable from an out-of-scope one.
  if (rows.length !== ids.length) return notFound()
  for (const row of rows) {
    const denied = guardSubsidiaryScope(gate, row.subsidiaryId)
    if (denied) return denied
  }
  return null
}

/** Filing-account subsidiary, with the documented null → active-root rule. */
export async function guardPayrollFilingAccounts(
  gate: Authz,
  accountIds: readonly (string | null | undefined)[],
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return guardPayrollRoot(gate)
  const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
    select id, subsidiary_id as "subsidiaryId"
      from payroll_filing_accounts
     where org_id = ${gate.user.orgId}
       and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       and is_active
  `)).rows
  if (rows.length !== ids.length) return notFound()
  for (const row of rows) {
    const denied = await guardPayrollSubsidiaryOrRoot(gate, row.subsidiaryId)
    if (denied) return denied
  }
  return null
}

/** Vendor remittance destinations are party records and are entity-owned too. */
export async function guardPayrollVendor(gate: Authz, partyId: string): Promise<Response | null> {
  const rows = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId"
      from parties
     where org_id = ${gate.user.orgId} and id = ${partyId}
  `)).rows
  if (rows.length !== 1) return notFound()
  const denied = guardSubsidiaryScope(gate, rows[0]!.subsidiaryId)
  return denied
}

/** A remittance summary is aggregate data; hide an entire group if its
 * account is not visible. Unassigned groups are safe only after all employees
 * in that period have been checked by the caller. */
export async function visibleRemittanceAccountIds(
  gate: Authz,
  accountIds: readonly (string | null)[],
): Promise<Set<string | null>> {
  if (gate.allowedSubsidiaryIds === null) return new Set(accountIds)
  const visible = new Set<string | null>()
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))]
  if (ids.length) {
    const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select id, subsidiary_id as "subsidiaryId"
        from payroll_filing_accounts
       where org_id = ${gate.user.orgId} and is_active
         and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `)).rows
    for (const row of rows) {
      const sub = row.subsidiaryId ?? await activeRoot(gate)
      if (sub && subsidiaryScopeAllows(gate.allowedSubsidiaryIds, sub)) visible.add(row.id)
    }
  }
  return visible
}

/** Guard every row in a filing population before returning a year-end output. */
export async function guardPayrollFilingData(
  gate: Authz,
  country: string,
  filing: string,
  data: PayrollFilingData,
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const parsed = data.rows.map((row) => parsePayrollRow(country, filing, String(row[data.rowKey] ?? '')))
  if (parsed.some((row) => row === null)) return notFound()
  const employees = parsed.flatMap((row) => row!.employees)
  const accounts = parsed.flatMap((row) => row!.accounts)
  const employeeDenied = await guardPayrollEmployees(gate, employees)
  if (employeeDenied) return employeeDenied
  return guardPayrollFilingAccounts(gate, accounts)
}

/** Same guard for stored amendment rows, where only opaque row ids are kept. */
export async function guardPayrollFilingRowIds(
  gate: Authz,
  country: string,
  filing: string,
  rowIds: readonly string[],
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const parsed = rowIds.map((rowId) => parsePayrollRow(country, filing, rowId))
  if (parsed.some((row) => row === null)) return notFound()
  const employeeDenied = await guardPayrollEmployees(gate, parsed.flatMap((row) => row!.employees))
  if (employeeDenied) return employeeDenied
  return guardPayrollFilingAccounts(gate, parsed.flatMap((row) => row!.accounts))
}

/** Parse the built-in filing row keys. Unknown pack row shapes fail closed. */
export function payrollRowScope(
  country: string,
  filing: string,
  rowId: string,
): { employees: string[]; accounts: string[] } | null {
  return parsePayrollRow(country, filing, rowId)
}

function parsePayrollRow(
  country: string,
  filing: string,
  rowId: string,
): { employees: string[]; accounts: string[] } | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const parts = rowId.split(':')
  if (country === 'CA' && filing === 't4' && parts.length === 3 && uuid.test(parts[0]!)) {
    return { employees: [parts[0]!], accounts: parts[2] && uuid.test(parts[2]!) ? [parts[2]!] : [] }
  }
  if (country === 'CA' && filing === 'roe' && uuid.test(rowId)) {
    return { employees: [rowId], accounts: [] }
  }
  // Québec's RL-1 population is one row per employee, just like the ROE;
  // unlike T4 its row key is the employee UUID without province/account
  // suffixes.
  if (country === 'CA' && filing === 'rl1' && uuid.test(rowId)) {
    return { employees: [rowId], accounts: [] }
  }
  if (country === 'US' && filing === 'w2' && parts.length === 2 && uuid.test(parts[0]!)) {
    return { employees: [parts[0]!], accounts: parts[1] && uuid.test(parts[1]!) ? [parts[1]!] : [] }
  }
  if (country === 'US' && filing === '941' && parts.length === 2 && uuid.test(parts[0]!)) {
    return { employees: [], accounts: [parts[0]!] }
  }
  return null
}

async function guardPayrollSubsidiaryOrRoot(
  gate: Authz,
  subsidiaryId: string | null,
): Promise<Response | null> {
  return guardSubsidiaryScope(gate, subsidiaryId ?? await activeRoot(gate))
}

async function guardPayrollRoot(gate: Authz): Promise<Response | null> {
  return guardSubsidiaryScope(gate, await activeRoot(gate))
}

async function activeRoot(gate: Authz): Promise<string | null> {
  return (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${gate.user.orgId} and parent_id is null and is_active
     order by created_at limit 1
  `)).rows[0]?.id ?? null
}

function notFound(): Response {
  return Response.json({ error: 'not found' }, { status: 404 })
}

// Keep the shared list predicate in this module as well as the direct guards:
// callers that need a filtered employee list cannot accidentally interpolate a
// raw subsidiary id and turn an empty scope into an unrestricted query.
export function payrollVisiblePartyFilter(gate: Authz) {
  return subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)
}
