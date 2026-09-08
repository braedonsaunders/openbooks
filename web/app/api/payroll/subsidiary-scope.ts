import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { roeSourceScope } from '@openbooks/engine/src/payroll-yearend.ts'
import type { PayrollFilingData } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { isUuid } from '../../../lib/list-params'
import type { Authz } from '../../../lib/authz'
import { guardSubsidiaryScope, subsidiaryScopeAllows } from '../../../lib/authz'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'

/**
 * Current employee operations use party ownership. Historical payroll
 * aggregates use their original pay-run ownership; employee transfers cannot
 * move that history. Filing accounts have their own additional entity check.
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
  includeInactive = false,
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return guardPayrollRoot(gate)
  const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
    select id, subsidiary_id as "subsidiaryId"
      from payroll_filing_accounts
     where org_id = ${gate.user.orgId}
       and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       and (${includeInactive} or is_active)
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
  // Remittance bills are posted to the active root entity. A null-subsidiary
  // vendor is an org-wide party, so resolve it to that same root rather than
  // accidentally allowing a bill for a root the caller cannot see.
  const denied = await guardPayrollSubsidiaryOrRoot(gate, rows[0]!.subsidiaryId)
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
       where org_id = ${gate.user.orgId}
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
  taxYear: number,
): Promise<Response | null> {
  return guardPayrollFilingRowIds(
    gate, country, filing,
    data.rows.map(row => String(row[data.rowKey] ?? '')),
    taxYear,
  )
}

/** Same guard for stored amendment rows, where only opaque row ids are kept. */
export async function guardPayrollFilingRowIds(
  gate: Authz,
  country: string,
  filing: string,
  rowIds: readonly string[],
  taxYear: number,
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) return notFound()
  const parsed = rowIds.map((rowId) => parsePayrollRow(country, filing, rowId))
  if (parsed.some((row) => row === null)) return notFound()
  if (country === 'US' && filing === '941') return guardPayroll941Rows(gate, rowIds, taxYear)
  const employeeDenied = await guardPayrollFilingEmployees(gate, country, filing, parsed.flatMap((row) => row!.employees), taxYear)
  if (employeeDenied) return employeeDenied
  const employees = parsed.flatMap((row) => row!.employees)
  const accounts = parsed.flatMap((row) => row!.accounts)
  if (employees.length > 0 && accounts.length === 0) return null
  return guardPayrollFilingAccounts(gate, accounts, true)
}

/** Account-only quarter rows still contain source payroll owned by legal entities. */
async function guardPayroll941Rows(
  gate: Authz,
  rowIds: readonly string[],
  taxYear: number,
): Promise<Response | null> {
  if (rowIds.length === 0) return guardPayrollRoot(gate)
  // The parser has validated every key, including the quarter range.
  const requested = [...new Set(rowIds.map(id => id.toLowerCase()))].map(id => {
    const [account, quarter] = id.split(':')
    return { id, account: account || null, quarter: Number(quarter) }
  })
  const sources = (await db.execute<{
    account: string | null; quarter: number; subsidiaryId: string | null;
  }>(sql`
    select distinct s.filing_account_id as account,
           extract(quarter from s.pay_date)::int as quarter,
           d.subsidiary_id as "subsidiaryId"
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
      left join documents d on d.org_id = r.org_id and d.id = r.document_id
     where s.org_id = ${gate.user.orgId} and s.tax_year = ${taxYear}
       and s.country = 'US' and r.run_status in ('committed', 'voided')
       and (${sql.join(requested.map(row => sql`(
         s.filing_account_id is not distinct from ${row.account}::uuid
         and extract(quarter from s.pay_date)::int = ${row.quarter}
       )`), sql` or `)})
  `)).rows
  const resolved = new Set(sources.map(row => `${row.account ?? ''}:${row.quarter}`))
  if (requested.some(row => !resolved.has(row.id))) return notFound()
  for (const row of sources) {
    const denied = guardSubsidiaryScope(gate, row.subsidiaryId)
    if (denied) return denied
  }
  // An assigned account elsewhere in the population cannot erase the root
  // boundary of an unassigned aggregate.
  if (requested.some(row => row.account === null)) {
    const denied = await guardPayrollRoot(gate)
    if (denied) return denied
  }
  const accounts = requested.map(row => row.account).filter((id): id is string => id !== null)
  return accounts.length ? guardPayrollFilingAccounts(gate, accounts, true) : null
}

/**
 * Annual slips derive ownership from original pay-run documents in the requested
 * year. Check the whole employee/year: annual caps and opening carry-in can
 * affect several account/province rows. A transfer must not move that evidence.
 * ROE uses current employment details and a period window that can cross years;
 * it requires both current-profile and original-source visibility.
 */
async function guardPayrollFilingEmployees(
  gate: Authz,
  country: string,
  filing: string,
  employeeIds: readonly string[],
  taxYear: number,
): Promise<Response | null> {
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) return notFound()
  const annual = (country === 'CA' && (filing === 't4' || filing === 'rl1'))
    || (country === 'US' && filing === 'w2')
  if (country === 'CA' && filing === 'roe') return guardPayrollRoeEmployees(gate, employeeIds)
  if (!annual) return guardPayrollEmployees(gate, employeeIds)
  const ids = [...new Set(employeeIds)]
  if (ids.length === 0) return null
  const rows = (await db.execute<{ employeeId: string; subsidiaryId: string | null }>(sql`
    select distinct s.employee_party_id as "employeeId", d.subsidiary_id as "subsidiaryId"
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
      left join documents d on d.org_id = r.org_id and d.id = r.document_id
     where s.org_id = ${gate.user.orgId} and s.tax_year = ${taxYear}
       and s.country = ${country} and r.run_status in ('committed', 'voided')
       and s.employee_party_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
  `)).rows
  for (const row of rows) {
    const denied = guardSubsidiaryScope(gate, row.subsidiaryId)
    if (denied) return denied
  }
  // Opening balances have no historical legal-entity stamp. Preserve their
  // current employee boundary as an ADDITIONAL check, never infer an employer
  // for them from an unrelated pay run. Rows without any historical sources
  // retain that same boundary (including opening-only slips).
  const openings = (await db.execute<{ employeeId: string }>(sql`
    select employee_party_id as "employeeId" from payroll_opening_balances
     where org_id = ${gate.user.orgId} and tax_year = ${taxYear}
       and employee_party_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
       and (coalesce(pensionable_ytd, 0) <> 0 or coalesce(insurable_ytd, 0) <> 0
         or coalesce(cpp_ytd, 0) <> 0 or coalesce(cpp2_ytd, 0) <> 0
         or coalesce(ei_ytd, 0) <> 0 or coalesce(qpip_ytd, 0) <> 0
         or coalesce(taxable_ytd, 0) <> 0 or coalesce(tax_ytd, 0) <> 0)
  `)).rows
  const historical = new Set(rows.map(row => row.employeeId))
  return guardPayrollEmployees(gate, [
    ...ids.filter(id => !historical.has(id)),
    ...openings.map(row => row.employeeId),
  ])
}

/** ROE header and source evidence must both be visible before any bytes leave. */
export async function guardPayrollRoeEmployees(
  gate: Authz,
  employeeIds: readonly string[],
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const ids = [...new Set(employeeIds)]
  if (ids.some(id => !isUuid(id))) return notFound()
  const employeeDenied = await guardPayrollEmployees(gate, ids)
  if (employeeDenied) return employeeDenied
  const sources = await roeSourceScope(gate.user.orgId, ids)
  if (new Set(sources.map(row => row.employeeId)).size !== ids.length) return notFound()
  for (const row of sources) {
    if (row.sourceDocumentId) {
      const denied = guardSubsidiaryScope(gate, row.sourceSubsidiaryId)
      if (denied) return denied
    }
  }
  const accounts = sources.map(row => row.filingAccountId).filter((id): id is string => id !== null)
  return accounts.length ? guardPayrollFilingAccounts(gate, accounts, true) : null
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
  const parts = rowId.split(':')
  if (country === 'CA' && filing === 't4' && parts.length === 3 && isUuid(parts[0]!)) {
    if (parts[2] && !isUuid(parts[2])) return null
    return { employees: [parts[0]!], accounts: parts[2] ? [parts[2]] : [] }
  }
  if (country === 'CA' && filing === 'roe' && isUuid(rowId)) {
    return { employees: [rowId], accounts: [] }
  }
  // Québec's RL-1 population is one row per employee, just like the ROE;
  // unlike T4 its row key is the employee UUID without province/account
  // suffixes.
  if (country === 'CA' && filing === 'rl1' && isUuid(rowId)) {
    return { employees: [rowId], accounts: [] }
  }
  if (country === 'US' && filing === 'w2' && parts.length === 2 && isUuid(parts[0]!)) {
    if (parts[1] && !isUuid(parts[1])) return null
    return { employees: [parts[0]!], accounts: parts[1] ? [parts[1]] : [] }
  }
  if (country === 'US' && filing === '941' && parts.length === 2
    && (!parts[0] || isUuid(parts[0])) && /^[1-4]$/.test(parts[1]!)) {
    return { employees: [], accounts: parts[0] ? [parts[0]] : [] }
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

/**
 * Pay schedules use the engine's explicit org-wide convention: a NULL
 * subsidiary resolves to the active root legal entity. Preserve that fallback
 * for a restricted caller only when the root itself is visible; an empty set
 * remains deny-all.
 */
export function payrollVisibleScheduleFilter(gate: Authz) {
  const allowed = gate.allowedSubsidiaryIds
  if (allowed === null) return sql``
  const ids = [...allowed]
  if (ids.length === 0) return sql` and false`
  return sql` and coalesce(
    subsidiary_id,
    (select root.id
       from subsidiaries root
      where root.org_id = ${gate.user.orgId}
        and root.parent_id is null and root.is_active
      order by root.created_at limit 1)
  ) = any(${`{${ids.join(',')}}`}::uuid[])`
}

/**
 * Employees a restricted caller may see, or null for an unrestricted one.
 * Payroll pages, API routes and assistant tools that filter a population
 * share this one query so the three transports cannot disagree.
 */
export async function visiblePayrollEmployeeIds(gate: Authz): Promise<Set<string> | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const rows = await db.execute<{ id: string }>(sql`
    select id from parties p
     where p.org_id = ${gate.user.orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}`)
  return new Set(rows.rows.map((row) => row.id))
}

/**
 * A remittance period is an employer-level aggregate: refusing the whole
 * period when any committed stub in it sits outside the caller's scope is the
 * only fail-closed answer, because filtering afterwards would still leak
 * gross/employee totals from a hidden subsidiary. Historical stubs are guarded
 * on the filing account they were captured under, inactive accounts included.
 */
export async function guardRemittancePeriod(
  gate: Authz,
  from: string,
  to: string,
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  const rows = (await db.execute<{ subsidiaryId: string | null; filingAccountId: string | null }>(sql`
    select distinct d.subsidiary_id as "subsidiaryId",
           s.filing_account_id as "filingAccountId"
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       and r.run_status = 'committed'
      left join documents d on d.id=r.document_id and d.org_id=r.org_id
     where s.org_id = ${gate.user.orgId} and s.pay_date between ${from} and ${to}
  `)).rows
  // Employee transfers do not transfer the earlier employer's payroll history.
  for (const row of rows) {
    const denied = guardSubsidiaryScope(gate, row.subsidiaryId)
    if (denied) return denied
  }
  const accountIds = rows.map((row) => row.filingAccountId).filter(Boolean)
  return accountIds.length ? guardPayrollFilingAccounts(gate, accountIds, true) : null
}

/** The year-end population guard, applied to every filing section at once. */
export async function guardPayrollYearEndFilings(
  gate: Authz,
  filings: readonly { country: string; key: string; data: PayrollFilingData }[],
  taxYear: number,
): Promise<Response | null> {
  if (gate.allowedSubsidiaryIds === null) return null
  for (const filing of filings) {
    const denied = await guardPayrollFilingData(gate, filing.country, filing.key, filing.data, taxYear)
    if (denied) return denied
  }
  return null
}
