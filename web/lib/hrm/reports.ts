import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { BUILT_IN_REPORT_DEFINITION_MAP, HRM_REPORT_ENTITIES } from '@openbooks/reports'
import { type Authz } from '../authz'
import { canRunReportEntity } from '../report-authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'

/**
 * Workforce reports launch pad — one read for the Reports tab: the HRM
 * workforce report entities and the headcount statement preset as cards
 * into the report builder.
 *
 * The preset card links the org's own report_definitions row by slug (the
 * seeded or org-tuned plan that runs the preset), falling back to the
 * builder catalog when the seed has never materialized — the catalog is
 * where the row appears once the seed runs, so the card never 404s. Entity
 * cards open the builder catalog that authors new workforce reports. Every
 * card is gated by the same entity gate the builder and the run paths
 * enforce, so a card the viewer could not run is omitted, never shown.
 */

export interface HrmReportCard {
  href: string
  iconKey: string
  title: string
  description: string
  accent: 'teal' | 'violet' | 'amber' | 'sky'
}

export interface HrmReportsData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  presetTitle: string
  presetHint: string
  preset: HrmReportCard | null
  entitiesTitle: string
  entitiesHint: string
  entities: HrmReportCard[]
  hubCard: HrmReportCard
}

const HEADCOUNT_PRESET_SLUG = 'headcount-statement'
const HEADCOUNT_ENTITY = 'hrm_headcount'

const ENTITY_ICONS: Record<string, string> = {
  hrm_headcount: 'users',
  hrm_employment_history: 'database',
  hrm_change_requests: 'workflow',
}

export async function loadHrmReports(authz: Authz): Promise<HrmReportsData> {
  // The caller (the reports view) owns the page gate —
  // hrm.employment.read plus reports.read plus the hrm switch with a 404.
  // This loader never re-checks those; it resolves cards for the
  // authorized session it is given.
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')
  const tReports = await getTranslations('reports')

  const entityLabel = (key: string, fallback: string): string =>
    tReports.has(`catalog.entities.${key}.label`) ? tReports(`catalog.entities.${key}.label`) : fallback
  const entityDescription = (key: string, fallback: string): string =>
    tReports.has(`catalog.entities.${key}.description`)
      ? tReports(`catalog.entities.${key}.description`)
      : fallback

  // The org's own plan row for the preset — seeded built-in or org-tuned
  // copy, both of which run the same workforce entity. A missing row is
  // not a refusal: the card falls back to the builder catalog.
  const presetRow = (await db.execute<{ id: string }>(sql`
    select id::text as id from report_definitions
     where org_id = ${orgId}::uuid and slug = ${HEADCOUNT_PRESET_SLUG}
     order by kind = 'built_in' desc, updated_at desc
     limit 1`)).rows[0] ?? null
  const presetDef = BUILT_IN_REPORT_DEFINITION_MAP[HEADCOUNT_PRESET_SLUG]
  const presetEntity = presetDef?.query.entity ?? HEADCOUNT_ENTITY
  const presetAllowed = await canRunReportEntity(authz, { entity: presetEntity })

  const entities: HrmReportCard[] = []
  for (const entity of HRM_REPORT_ENTITIES) {
    if (!(await canRunReportEntity(authz, { entity: entity.key }))) continue
    entities.push({
      href: '/reports/custom',
      iconKey: ENTITY_ICONS[entity.key] ?? 'database',
      title: entityLabel(entity.key, entity.label),
      description: entityDescription(entity.key, entity.description),
      accent: 'sky',
    })
  }

  return {
    title: t('reports.title'),
    description: t('reports.description'),
    tabs: await hrmGroupTabs(authz, '/hrm/reports'),
    presetTitle: t('reports.presetTitle'),
    presetHint: t('reports.presetHint'),
    // The null leg cannot occur under the page gates (it repeats the
    // entity gate the run paths enforce), but a card the viewer could not
    // run must never render — so the panel degrades to title plus hint
    // rather than a link that access-denies.
    preset: presetAllowed
      ? {
          href: presetRow ? `/reports/custom/run/${presetRow.id}` : '/reports/custom',
          iconKey: 'scroll-text',
          title: tReports.has(`builtIns.${HEADCOUNT_PRESET_SLUG}.name`)
            ? tReports(`builtIns.${HEADCOUNT_PRESET_SLUG}.name`)
            : (presetDef?.name ?? HEADCOUNT_PRESET_SLUG),
          description: tReports.has(`builtIns.${HEADCOUNT_PRESET_SLUG}.description`)
            ? tReports(`builtIns.${HEADCOUNT_PRESET_SLUG}.description`)
            : (presetDef?.description ?? ''),
          accent: 'teal',
        }
      : null,
    entitiesTitle: t('reports.entitiesTitle'),
    entitiesHint: t('reports.entitiesHint'),
    entities,
    hubCard: {
      href: '/reports',
      iconKey: 'link',
      title: t('reports.hubTitle'),
      description: t('reports.hubDescription'),
      accent: 'violet',
    },
  }
}
