import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, guardPermission, guardSubsidiaryScope } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { loadFieldDefs } from '../../../../../lib/custom-fields'
import { resolveFormLayout } from '../../../../../lib/customization/resolve'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryUiOptions } from '../../../../../lib/subsidiaries'
import { loadParty } from '../../_lib'

export const runtime = 'nodejs'

/** Complete, org-scoped payload needed by the shell-level related-party drawer. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Party record boundary (null-subsidiary parties are org-wide).
  const scope = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${id} and org_id = ${gate.user.orgId}`,
  ))
  if (!scope.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(gate, scope.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  const [payload, paymentTerms, departments, trades, workerCompGroups, fieldDefs, subsidiaries, accounts, taxCodes, salesReps, payrollEnabled, multiCurrency] = await Promise.all([
    loadParty(id, gate.user.orgId),
    (db.execute(sql`select id, name from payment_terms where org_id = ${gate.user.orgId} and is_active order by name`)),
    (db.execute(sql`select id, name from departments where org_id = ${gate.user.orgId} and is_active order by name`)),
    (db.execute(sql`select id, name from trades where org_id = ${gate.user.orgId} and is_active order by name`)),
    isFeatureEnabled(gate.user.orgId, 'payroll').then((enabled) => enabled
      ? db.execute(sql`select id, name from worker_comp_groups where org_id = ${gate.user.orgId} and is_active order by name`) as any
      : Promise.resolve({ rows: [] })),
    loadFieldDefs('parties'),
    subsidiaryUiOptions(gate.user.orgId).then((options) => gate.allowedSubsidiaryIds
      ? options.filter((option) => gate.allowedSubsidiaryIds!.has(option.id))
      : options),
    (db.execute(sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${gate.user.orgId} and is_active and not is_summary order by number nulls last, name`)),
    (db.execute(sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${gate.user.orgId} and is_active order by code`)),
    (db.execute(sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active where p.org_id = ${gate.user.orgId} and p.is_active order by p.display_name`)),
    isFeatureEnabled(gate.user.orgId, 'payroll'),
    isFeatureEnabled(gate.user.orgId, 'multiCurrency'),
  ])
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const requestedRole = new URL(request.url).searchParams.get('role')
  const role = requestedRole === 'customer' || requestedRole === 'vendor' || requestedRole === 'employee'
    ? requestedRole
    : payload.customer ? 'customer' : payload.vendor ? 'vendor' : 'employee'
  const formId = new URL(request.url).searchParams.get('form')
  const resolvedForm = await resolveFormLayout({
    orgId: gate.user.orgId,
    userId: gate.user.id,
    recordType: role,
    userRoles: gate.user.roles.map(({ key }) => key),
    headerDefs: (fieldDefs),
    lineDefs: [],
    explicitLayoutId: formId,
  })

  return NextResponse.json({
    payload,
    paymentTerms: paymentTerms.rows,
    departments: departments.rows,
    trades: trades.rows,
    workerCompGroups: workerCompGroups.rows,
    payrollEnabled,
    multiCurrency,
    fieldDefs,
    subsidiaries,
    accounts: accounts.rows,
    taxCodes: taxCodes.rows,
    salesReps: salesReps.rows,
    layout: resolvedForm.layout,
    forms: resolvedForm.available,
    currentFormId: resolvedForm.row?.id ?? null,
    recordType: role,
    canCustomize: can(gate, 'admin.customization.manage'),
  })
}
