import { customRecordReportCatalog } from '@/lib/custom-record-report-catalog'
import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { defaultRowsQuery, REPORT_ENTITY_MAP } from '@openbooks/reports'
import { requirePermission } from '../../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../../lib/features'
import { isUuid } from '../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
import { orgBranding } from '../../../../../../lib/report-pdf'
import { statementPageHref } from '../../../../../../lib/report-run'
import { canRunReportEntity, hiddenReportEntityKeys } from '../../../../../../lib/report-authz'
import type { ReportBuilder } from './ReportBuilder'

/**
 * The custom-report query builder, split into a loader and a spec.
 *
 * One whole client island: an entity picker, a condition tree, column and
 * grouping editors and a live preview, all client state over fetch. The spec
 * places it and binds already-resolved props.
 *
 * `hiddenEntityKeys` is the interesting one and it is why this loader could
 * not be thinner. It is a per-caller PERMISSION result — the set of report
 * entities this reader may not query — and the builder uses it to fence its
 * own picker. It is resolved here and travels as a plain string array; the
 * `Authz` it came from does not.
 *
 * The statement redirect stays in the loader too: standard statement reports
 * keep their rich drill-through pages, and the entity query-builder edits
 * `query` definitions only. Both render paths redirect identically.
 */

type BuilderProps = Parameters<typeof ReportBuilder>[0]

export interface ReportBuilderData {
  customEntities: BuilderProps['customEntities']
  hiddenEntityKeys: BuilderProps['hiddenEntityKeys']
  inventoryEnabled: boolean
  company: string
  definition: BuilderProps['definition']
  createMode: boolean
}

export async function loadReportBuilder(id: string): Promise<ReportBuilderData> {
  const authz = await requirePermission('reports.create')
  const createMode = id === 'new'
  if (!createMode && !isUuid(id)) notFound()
  const [definition, branding, inventoryEnabled, customEntities, hiddenEntityKeys] = await Promise.all([
    createMode ? Promise.resolve(null) : loadReportDefinition(authz.user.orgId, id),
    orgBranding(),
    isFeatureEnabled(authz.user.orgId, 'inventory'),
    customRecordReportCatalog(authz),
    hiddenReportEntityKeys(authz),
  ])
  if (!createMode && !definition) notFound()
  // Standard statement reports keep their rich drill-through pages — the entity
  // query-builder edits `query` definitions only.
  if (definition?.report_type === 'statement') redirect(statementPageHref(definition.statement))
  if (definition && (!definition.query || !(await canRunReportEntity(authz, definition.query)))) notFound()

  return {
    customEntities: Object.values(customEntities),
    hiddenEntityKeys,
    inventoryEnabled,
    company: branding.orgName,
    definition: definition
      ? {
          id: definition.id,
          kind: definition.kind,
          name: definition.name,
          description: definition.description,
          query: definition.query!,
          layout: definition.layout,
        }
      : {
          id: '',
          kind: 'custom',
          name: '',
          description: null,
          query: defaultRowsQuery(REPORT_ENTITY_MAP.ledger_lines!),
          layout: null,
        },
    createMode,
  }
}

export function reportBuilderSpec(data: ReportBuilderData): PageSpec {
  return page({
    route: '/reports/custom/builder/[id]',
    // The builder owns its own full-height shell; the native page wraps it in
    // nothing at all.
    layout: 'bare',
    header: [],
    body: [
      widgetBlock('report-builder', {
        customEntities: data.customEntities,
        hiddenEntityKeys: data.hiddenEntityKeys,
        inventoryEnabled: data.inventoryEnabled,
        company: data.company,
        definition: data.definition,
        createMode: data.createMode,
      }),
    ],
  })
}
