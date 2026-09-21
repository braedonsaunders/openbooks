import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  panel,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'

/**
 * The field-time setup surface: declared rules, kiosks with token
 * issue/revoke and worker PINs, and the multi-stage chains. Renders
 * for time managers when fieldTime is on — the view 404s otherwise.
 */

export interface FieldSetupData {
  title: string
  description: string
  tabs: { href: string; label: string; active: boolean }[]
  panelTitle: string
  initialSettings: {
    roundingIncrement: number | null
    roundingMode: string | null
    unpaidBreakMinutes: number | null
    autoCloseHours: number | null
    signatureRequired: boolean
    equipmentToleranceHours: string | null
    photoRequired: boolean
  }
  kiosks: {
    id: string
    name: string
    locationId: string | null
    projectId: string | null
    pinRequired: boolean
    photoRequired: boolean
    isActive: boolean
    lastSeenAt: string | null
  }[]
  chains: { subject: string; stages: { order: number; approverKind: string; roleKey?: string | null }[] | null }[]
  kioskLinkBase: string
}

const f = ref<FieldSetupData>()

export async function loadFieldSetupPage(): Promise<FieldSetupData> {
  const authz = await requirePermission('time.manage')
  if (!(await isFeatureEnabled(authz.user.orgId, 'fieldTime'))) notFound()
  const t = await getTranslations('timesheets')
  const orgId = authz.user.orgId
  const settings = (await db.execute<{ settings: unknown }>(sql`
    select settings->'fieldTime' as settings from orgs where id = ${orgId}`)).rows[0]?.settings as Record<string, unknown> | null
  const kiosks = (await db.execute<FieldSetupData['kiosks'][number]>(sql`
    select id::text as id, name, location_id::text as "locationId",
           project_id::text as "projectId", pin_required as "pinRequired",
           photo_required as "photoRequired", is_active as "isActive",
           last_seen_at::text as "lastSeenAt"
      from time_kiosks where org_id = ${orgId} order by name`)).rows
  const chains = (await db.execute<{ subject_kind: string; stages: unknown }>(sql`
    select subject_kind, stages from time_approval_stages where org_id = ${orgId}`)).rows
  return {
    title: t('field.setupTitle'),
    description: t('field.setupDescription'),
    tabs: [
      { href: '/timesheets', label: t('field.timesheetsTab'), active: false },
      { href: '/time/clock', label: t('field.clockTab'), active: false },
      { href: '/time/crew', label: t('field.crewTab'), active: false },
    ],
    panelTitle: t('field.setupPanel'),
    initialSettings: {
      roundingIncrement: typeof settings?.roundingIncrement === 'number' ? (settings.roundingIncrement as number) : null,
      roundingMode: typeof settings?.roundingMode === 'string' ? (settings.roundingMode as string) : null,
      unpaidBreakMinutes: typeof settings?.unpaidBreakMinutes === 'number' ? (settings.unpaidBreakMinutes as number) : null,
      autoCloseHours: typeof settings?.autoCloseHours === 'number' ? (settings.autoCloseHours as number) : null,
      signatureRequired: settings?.signatureRequired !== false,
      equipmentToleranceHours: typeof settings?.equipmentToleranceHours === 'string' ? (settings.equipmentToleranceHours as string) : null,
      photoRequired: settings?.photoRequired === true,
    },
    kiosks,
    chains: ['timesheet_week', 'crew_time_batch'].map((subject) => ({
      subject,
      stages: (chains.find((chain) => chain.subject_kind === subject)?.stages ?? null) as FieldSetupData['chains'][number]['stages'],
    })),
    kioskLinkBase: '/kiosk',
  }
}

export function fieldSetupSpec(data: FieldSetupData): PageSpec {
  return page({
    route: '/time/setup',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      panel({
        title: f('panelTitle'),
        iconKey: 'settings',
        blocks: [
          widgetBlock('hrm-field-time-setup', {
            initialSettings: data.initialSettings,
            kiosks: data.kiosks,
            chains: data.chains,
            kioskLinkBase: data.kioskLinkBase,
          }),
        ],
      }),
    ],
  })
}

export async function fieldSetupTitle(): Promise<string> {
  const t = await getTranslations('timesheets')
  return t('field.setupTitle')
}
