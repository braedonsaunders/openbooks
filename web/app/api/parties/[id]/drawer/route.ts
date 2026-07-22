import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, guardPermission } from '../../../../../lib/authz'
import { loadFieldDefs } from '../../../../../lib/custom-fields'
import { resolveFormLayout } from '../../../../../lib/customization/resolve'
import { isUuid } from '../../../../../lib/list-params'
import { loadParty } from '../../_lib'

export const runtime = 'nodejs'

interface SubsidiaryRow {
  id: string
  parentId: string | null
  name: string
  isElimination: boolean
}

async function loadSubsidiaries(orgId: string) {
  const result = (await db.execute(sql`
    select id, parent_id as "parentId", name, is_elimination as "isElimination"
      from subsidiaries
     where org_id = ${orgId} and is_active
     order by name
  `)) as unknown as { rows: SubsidiaryRow[] }
  const byParent = new Map<string | null, SubsidiaryRow[]>()
  for (const row of result.rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row])
  const options: Array<SubsidiaryRow & { depth: number }> = []
  const visit = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      options.push({ ...row, depth })
      visit(row.id, depth + 1)
    }
  }
  visit(null, 0)
  return options
}

/** Complete, org-scoped payload needed by the shell-level related-party drawer. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('parties.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [payload, paymentTerms, departments, trades, workerCompGroups, fieldDefs, subsidiaries, accounts, taxCodes, salesReps] = await Promise.all([
    loadParty(id, gate.user.orgId),
    db.execute(sql`select id, name from payment_terms where org_id = ${gate.user.orgId} and is_active order by name`) as any,
    db.execute(sql`select id, name from departments where org_id = ${gate.user.orgId} and is_active order by name`) as any,
    db.execute(sql`select id, name from trades where org_id = ${gate.user.orgId} and is_active order by name`) as any,
    db.execute(sql`select id, name from worker_comp_groups where org_id = ${gate.user.orgId} and is_active order by name`) as any,
    loadFieldDefs('parties'),
    loadSubsidiaries(gate.user.orgId),
    db.execute(sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${gate.user.orgId} and is_active and not is_summary order by number nulls last, name`) as any,
    db.execute(sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${gate.user.orgId} and is_active order by code`) as any,
    db.execute(sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.is_active where p.org_id = ${gate.user.orgId} and p.is_active order by p.display_name`) as any,
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
    userRoles: [gate.user.role],
    headerDefs: fieldDefs as any,
    lineDefs: [],
    explicitLayoutId: formId,
  })

  return NextResponse.json({
    payload,
    paymentTerms: paymentTerms.rows,
    departments: departments.rows,
    trades: trades.rows,
    workerCompGroups: workerCompGroups.rows,
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
