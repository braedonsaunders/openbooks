import 'server-only'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { contractorWithholdingScheme } from '@openbooks/engine/country-tax-packs'
import { ContractorWithholdingError } from '@openbooks/engine/contractor-withholding'
import { guardSubsidiaryScope, type Authz } from './authz'
import { notFound } from './api/responses'
import { subsidiaryVisibleFilter } from './subsidiaries'

export interface WithholdingEnrollmentOption extends Record<string, unknown> { id: string; subsidiaryId: string; entityName: string; schemeCode: string; contractorReference: string; currency: string; schemeName: string; returnKind: 'statutory_periodic' | 'annual_945' | 'financial_workpaper'; filingNotice: string; canDeposit: boolean }
export async function withholdingEnrollments(authz: Authz): Promise<WithholdingEnrollmentOption[]> {
  const rows = (await db.execute<WithholdingEnrollmentOption>(sql`
    select e.id, e.subsidiary_id as "subsidiaryId", s.name as "entityName", e.scheme_code as "schemeCode", e.contractor_reference as "contractorReference"
      from withholding_enrollments e join subsidiaries s on s.org_id=e.org_id and s.id=e.subsidiary_id
     where e.org_id=${authz.user.orgId} ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, authz.allowedSubsidiaryIds)}
     order by s.name, e.scheme_code, e.effective_from desc`)).rows
  return rows.map(row => {
    const scheme = contractorWithholdingScheme(row.schemeCode)
    if (!scheme) throw new ContractorWithholdingError('The enrollment names an unknown withholding scheme.', 'End this enrollment in Setup and select a supported scheme.')
    return { ...row, currency: scheme.currency, schemeName: scheme.name, returnKind: scheme.returnKind ?? 'statutory_periodic', filingNotice: scheme.filingNotice ?? '', canDeposit: !!scheme.remittanceSchedules?.length }
  })
}
export async function withholdingRecordScope(authz: Authz, id: string, kind: 'enrollment' | 'return'): Promise<NextResponse | null> {
  const table = kind === 'enrollment' ? sql`withholding_enrollments` : sql`withholding_returns`
  const row = (await db.execute<{ subsidiary_id: string }>(sql`select subsidiary_id from ${table} where org_id=${authz.user.orgId} and id=${id}`)).rows[0]
  if (!row) return notFound('record')
  return guardSubsidiaryScope(authz, row.subsidiary_id)
}
export function withholdingRefusal(error: unknown): NextResponse {
  if (error instanceof ContractorWithholdingError) return NextResponse.json({ error: error.message, remedy: error.remedy }, { status: 422 })
  throw error
}
