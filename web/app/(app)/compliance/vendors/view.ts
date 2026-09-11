import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { FORM_TYPES } from '@openbooks/engine/src/information-returns.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  loadComplianceClasses,
  loadComplianceMatrix,
  loadVendorCertificates,
  loadVendorWaivers,
  requireComplianceFeature,
  type ComplianceMatrix,
} from '../../../../lib/compliance'
import { loadRequirementPolicies } from '@openbooks/engine/src/compliance.ts'
import { pickString } from '../../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from '../tabs'

/**
 * The subcontractor compliance matrix, split into a loader and a spec.
 *
 * The grid itself is a component, not a `table` block, because its COLUMNS come
 * from data — one per active policy. The table block deliberately models a
 * fixed column list over a row collection; generating columns per request would
 * make a serialized spec describe only the render that produced it, which
 * defeats the point of a spec being data.
 *
 * So the spec here composes very little: header, tabs, filters, matrix, drawer.
 * That is the honest outcome for a page whose content is one domain component,
 * and it is the same call made for the statement matrix on the P&L.
 */

export interface ComplianceVendorsData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof complianceTabs>>
  filters: Record<string, unknown>
  emptyTitle: string
  emptyDescription: string
  isEmpty: boolean
  hasRows: boolean
  matrix: {
    rows: ComplianceMatrix['rows']
    columns: ComplianceMatrix['policies']
    classId: string | null
    stateFilter: string | null
    labels: Record<string, unknown>
  }
  drawerOpen: boolean
  drawerProps: Record<string, unknown> | null
}

export async function loadComplianceVendors(
  sp: Record<string, string | string[] | undefined>,
): Promise<ComplianceVendorsData> {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const t = await getTranslations('compliance')
  const { money } = await getMoneyFormatter()
  const classId = pickString(sp.class) ?? null
  const stateFilter = pickString(sp.state) ?? null
  const openVendor = pickString(sp.vendor) ?? null

  const [matrix, projectsEnabled] = await Promise.all([
    loadComplianceMatrix({
      orgId,
      classId,
      states:
        stateFilter === 'attention'
          ? ['missing', 'expired', 'insufficient', 'awaiting_verification', 'rejected']
          : stateFilter === 'expiring'
            ? ['expiring']
            : undefined,
    }),
    isFeatureEnabled(orgId, 'projects'),
  ])
  const tabs = await complianceTabs('/compliance/vendors', { projectsEnabled })

  // The drawer's data loads only when a vendor is actually open.
  const drawerData = openVendor
    ? await (async () => {
        const [vendor, certificates, exceptions, policies, classes, projects] = await Promise.all([
          db.execute<Record<string, unknown>>(sql`
            select p.id, p.display_name as name, p.legal_name as "legalName",
                   vr.compliance_class_id as "complianceClassId",
                   vr.information_return_form as "informationReturnForm",
                   vr.information_return_box as "informationReturnBox",
                   vr.tax_classification as "taxClassification",
                   vr.tin_last4 as "tinLast4", vr.tin_type as "tinType",
                   coalesce(vr.backup_withholding, false) as "backupWithholding",
                   coalesce(vr.is_t4a, false) as reportable
              from parties p
              join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
             where p.org_id = ${orgId} and p.id = ${openVendor}`),
          loadVendorCertificates(orgId, openVendor),
          loadVendorWaivers(orgId, openVendor),
          loadRequirementPolicies(orgId),
          loadComplianceClasses(orgId),
          db.execute<{ id: string; label: string }>(sql`
            select id, coalesce(code || ' · ' || name, name) as label from projects
             where org_id = ${orgId} and is_active order by code nulls last, name limit 500`),
        ])
        const row = vendor.rows[0]
        if (!row) return null
        return {
          vendor: row as never,
          certificates,
          exceptions,
          policies,
          classes,
          projects: projects.rows,
          status: matrix.rows.find((r) => r.partyId === openVendor) ?? null,
        }
      })()
    : null

  const closeHref = `/compliance/vendors?${new URLSearchParams({
    ...(classId ? { class: classId } : {}),
    ...(stateFilter ? { state: stateFilter } : {}),
  })}`

  return {
    title: t('vendors.title'),
    description: t('vendors.description'),
    tabs,
    filters: { classes: matrix.classes, classId, state: stateFilter },
    emptyTitle: t('vendors.empty.title'),
    emptyDescription: t('vendors.empty.description'),
    isEmpty: matrix.rows.length === 0,
    hasRows: matrix.rows.length > 0,
    matrix: {
      rows: matrix.rows,
      columns: matrix.policies,
      classId,
      stateFilter,
      // Label lookups are resolved here so the component takes strings rather
      // than a translator, keeping it free of request-scoped context.
      labels: {
        vendor: t('vendors.columns.vendor'),
        class: t('vendors.columns.class'),
        status: t('vendors.columns.status'),
        exposure: t('vendors.columns.exposure'),
        states: Object.fromEntries(
          [...new Set(matrix.rows.flatMap((r) => [r.overall, ...r.findings.map((f) => f.state)]))].map(
            (state) => [state, t(`states.${state}`)],
          ),
        ),
        reasons: Object.fromEntries(
          [...new Set(matrix.rows.flatMap((r) => r.findings.flatMap((f) => f.reasons)))].map(
            (reason) => [reason, t(`reasons.${reason}`)],
          ),
        ),
        money: Object.fromEntries(matrix.rows.map((r) => [r.partyId, money(r.openBalance)])),
      },
    },
    drawerOpen: Boolean(drawerData),
    drawerProps: drawerData
      ? {
          data: drawerData,
          closeHref,
          formTypes: [...FORM_TYPES],
          canManage: can(authz, 'compliance.manage'),
          canVerify: can(authz, 'compliance.verify'),
          canWaive: can(authz, 'compliance.waive'),
          currentUserId: authz.user.id,
        }
      : null,
  }
}

const f = ref<ComplianceVendorsData>()

export function complianceVendorsSpec(data: ComplianceVendorsData): PageSpec {
  return page({
    route: '/compliance/vendors',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), description: f('description') }),
      widgetBlock('module-home-tabs', { tabs: data.tabs }),
    ],
    body: [
      widgetBlock('matrix-filters', data.filters),
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      { ...widgetBlock('compliance-matrix', data.matrix), when: f('hasRows') },
      widgetBlock('vendor-compliance-drawer', { drawer: data.drawerProps }, f('drawerOpen')),
    ],
  })
}
