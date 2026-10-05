import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { can, guardSubsidiaryScope } from '../../../../../lib/authz'
import { defineRoute } from '../../../../../lib/api/route'
import { isFeatureEnabled } from '../../../../../lib/features'
import { loadFieldDefs } from '../../../../../lib/custom-fields'
import { resolveFormLayout } from '../../../../../lib/customization/resolve'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryUiOptions, subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { loadParty } from '../../_lib'
import { loadComplianceClasses, loadVendorComplianceClass } from '../../../../../lib/compliance'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Complete, org-scoped payload needed by the shell-level related-party drawer. */
export const GET = defineRoute({
  permission: 'parties.read',
  feature: { none: 'Party records are shared master data; optional role capabilities are resolved in the drawer payload.' },
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz: gate, params }) => {
  const { id } = params
  if (!isUuid(id)) return notFound("record")
  // Party record boundary (null-subsidiary parties are org-wide).
  const scope = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${id} and org_id = ${gate.user.orgId}`,
  ))
  if (!scope.rows[0]) return notFound("record")
  const scopeDenied = guardSubsidiaryScope(gate, scope.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  const [payload, paymentTerms, departments, trades, workerCompGroups, fieldDefs, subsidiaries, accounts, taxCodes, salesReps, payrollEnabled, multiCurrency, complianceEnabled] = await Promise.all([
    loadParty(id, gate.user.orgId, gate.allowedSubsidiaryIds),
    (db.execute(sql`select id, name from payment_terms where org_id = ${gate.user.orgId} and is_active order by name`)),
    (db.execute(sql`select id, name from departments where org_id = ${gate.user.orgId} and is_active order by name`)),
    (db.execute(sql`select id, name from trades where org_id = ${gate.user.orgId} and is_active order by name`)),
    isFeatureEnabled(gate.user.orgId, 'payroll').then((enabled) => enabled
      ? db.execute<{ id: string; name: string }>(sql`select id, name from worker_comp_groups where org_id = ${gate.user.orgId} and is_active order by name`)
      : Promise.resolve({ rows: [] as { id: string; name: string }[] })),
    loadFieldDefs('parties'),
    subsidiaryUiOptions(gate.user.orgId).then((options) => gate.allowedSubsidiaryIds
      ? options.filter((option) => gate.allowedSubsidiaryIds!.has(option.id))
      : options),
    (db.execute(sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${gate.user.orgId} and is_active and not is_summary order by number nulls last, name`)),
    (db.execute(sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${gate.user.orgId} and is_active order by code`)),
    (db.execute(sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active where p.org_id = ${gate.user.orgId} and p.is_active ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })} order by p.display_name`)),
    isFeatureEnabled(gate.user.orgId, 'payroll'),
    isFeatureEnabled(gate.user.orgId, 'multiCurrency'),
    isFeatureEnabled(gate.user.orgId, 'subcontractorCompliance'),
  ])
  if (!payload) return notFound("record")
  const requestedRole = new URL(request.url).searchParams.get('role')
  const role = requestedRole === 'customer' || requestedRole === 'vendor' || requestedRole === 'employee'
    ? requestedRole
    : payload.customer ? 'customer' : payload.vendor ? 'vendor' : 'employee'
  // The shell overlay vendor drawer needs the same Compliance tab
  // inputs the /parties and /entities loaders supply — drawer-open vendors
  // only, so the class list never loads for customers, employees, or a
  // feature-off org.
  const compliance = complianceEnabled && role === 'vendor'
    ? {
        classId: await loadVendorComplianceClass(gate.user.orgId, id),
        classes: await loadComplianceClasses(gate.user.orgId),
      }
    : null
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

  // Payer-hierarchy billing resolves in the payload like Compliance:
  // drawer-open customers only, so the tab never loads for other roles or
  // a feature-off org.
  const consolidatedBilling = role === 'customer' && await isFeatureEnabled(gate.user.orgId, 'consolidatedBilling')
    ? { canManage: can(gate, 'documents.manage') }
    : null
  return NextResponse.json({
    payload,
    consolidatedBilling,
    paymentTerms: paymentTerms.rows,
    departments: departments.rows,
    trades: trades.rows,
    workerCompGroups: workerCompGroups.rows,
    canReadBenefits: role === 'employee' && can(gate, 'hrm.benefits.read') && await isFeatureEnabled(gate.user.orgId, 'hrm'),
    payrollEnabled,
    multiCurrency,
    complianceEnabled,
    canManageCompliance: can(gate, 'compliance.manage'),
    compliance,
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
  },
})
