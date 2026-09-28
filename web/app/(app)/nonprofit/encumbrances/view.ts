import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import {
  encumbranceSubsidiaryId,
  getEncumbranceDetail,
} from '@openbooks/engine/src/nonprofit/encumbrances.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { can, requirePermission, subsidiaryScopeAllows } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { nonprofitGroupTabs } from '../../../../components/module-home/group-tabs'

/**
 * The encumbrance register, split into a loader and a spec.
 *
 * The fixed-asset register archetype: the list itself is the universal
 * EntityListView (`encumbrance`), so it arrives through the slot that
 * re-derives Authz server-side. The spec carries only the record type, the
 * current params, and a widget ref for the drawer — never an org id. The
 * drawer payload (stored commitment, derived open balance, linked actuals,
 * and the appropriation comparison) is ledger truth read here, beside the
 * list, exactly like the asset pickers.
 *
 * Commitments carry their stored subsidiary: a drawer outside the caller's
 * scope renders nothing, exactly like the record-level 404.
 */

export interface EncumbranceCandidateLine {
  documentLineId: string
  documentNumber: string
  amount: string
}

export interface EncumbranceRecordDrawer {
  mode: 'record'
  remountKey: string
  detail: NonNullable<Awaited<ReturnType<typeof getEncumbranceDetail>>>
  candidates: EncumbranceCandidateLine[]
  canManage: boolean
  closeHref: string
}

export interface EncumbranceCreateDrawer {
  mode: 'create'
  accountOptions: { id: string; number: string | null; name: string }[]
  subsidiaryOptions: { id: string; name: string }[]
  fundOptions: { id: string; code: string; name: string }[]
  canManage: boolean
  closeHref: string
}

export type EncumbranceDrawerData = EncumbranceRecordDrawer | EncumbranceCreateDrawer

export interface EncumbrancesData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: Awaited<ReturnType<typeof nonprofitGroupTabs>>
  drawer: EncumbranceDrawerData | null
}

export async function loadEncumbrances(
  sp: Record<string, string | string[] | undefined>,
): Promise<EncumbrancesData> {
  const authz = await requirePermission('encumbrances.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'encumbrances')
  const t = await getTranslations('nonprofit')
  const tabs = await nonprofitGroupTabs(authz, '/nonprofit/encumbrances')

  const base: EncumbrancesData = {
    title: t('encumbrances.title'),
    description: t('encumbrances.description'),
    currentParams: sp,
    tabs,
    drawer: null,
  }

  const encumbranceId = pickString(sp.encumbrance)
  if (!encumbranceId) return base
  if (encumbranceId === 'new') {
    const [accounts, subsidiaries, funds] = await Promise.all([
      db.execute<{ id: string; number: string | null; name: string }>(sql`
        select id::text as id, number, name from accounts
         where org_id = ${orgId} and is_active and not is_summary
           and type in ('cogs', 'expense', 'expense_other', 'expense_deferred')
         order by number nulls last, name limit 200`),
      db.execute<{ id: string; name: string }>(sql`
        select id::text as id, name from subsidiaries
         where org_id = ${orgId} and is_active
         order by name limit 200`),
      db.execute<{ id: string; code: string; name: string }>(sql`
        select sv.id::text as id, sv.code, sv.name
          from funds f
          join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
         where f.org_id = ${orgId} and sv.is_active
         order by sv.code limit 200`),
    ])
    // Creation offers only subsidiaries in the caller's scope: an
    // unrestricted caller sees every active subsidiary, a restricted caller
    // sees their allowlist, and hidden subsidiary names never reach the page.
    const allowedSubsidiaryIds = authz.allowedSubsidiaryIds
    const inScope =
      allowedSubsidiaryIds === null
        ? subsidiaries.rows
        : subsidiaries.rows.filter((row) => allowedSubsidiaryIds.has(row.id))
    return {
      ...base,
      drawer: {
        mode: 'create',
        accountOptions: accounts.rows,
        subsidiaryOptions: inScope,
        fundOptions: funds.rows,
        canManage: can(authz, 'encumbrances.manage'),
        closeHref: '/nonprofit/encumbrances',
      },
    }
  }
  if (!isUuid(encumbranceId)) return base
  // The stored subsidiary gates every downstream read: a missing record and
  // an out-of-scope record both render no drawer, with no detail, links,
  // figures, or candidates loaded and no subsidiary name disclosed.
  const storedSubsidiaryId = await encumbranceSubsidiaryId(orgId, encumbranceId)
  if (!storedSubsidiaryId || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, storedSubsidiaryId)) return base
  const detail = await getEncumbranceDetail(orgId, encumbranceId, await businessToday(orgId))
  if (!detail) return base
  const candidates = detail.status === 'open'
    ? await db.execute<{ document_line_id: string; document_number: string; amount: string }>(sql`
      select dl.id as document_line_id, d.document_number, dl.amount::text as amount
        from document_lines dl
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
       where dl.org_id = ${orgId}
         and d.status in ('draft', 'pending_approval', 'approved', 'posted')
         and dl.account_id = ${detail.accountId}
         and coalesce(dl.subsidiary_id, d.subsidiary_id) = ${detail.subsidiaryId}
         and dl.department_id is not distinct from ${detail.departmentId}::uuid
         and dl.project_id is not distinct from ${detail.projectId}::uuid
         and dl.location_id is not distinct from ${detail.locationId}::uuid
         and dl.class_id is not distinct from ${detail.classId}::uuid
         and dl.extra_dims = ${JSON.stringify(detail.extraDims)}::jsonb
         and dl.amount > 0
         and not exists (
           select 1 from encumbrance_links l
            where l.org_id = dl.org_id and l.document_line_id = dl.id
         )
       order by d.document_number, dl.id limit 50
    `)
    : { rows: [] as { document_line_id: string; document_number: string; amount: string }[] }
  return {
    ...base,
    drawer: {
      mode: 'record',
      remountKey: detail.id,
      detail,
      candidates: candidates.rows.map((row) => ({
        documentLineId: row.document_line_id,
        documentNumber: row.document_number,
        amount: row.amount,
      })),
      canManage: can(authz, 'encumbrances.manage'),
      closeHref: '/nonprofit/encumbrances',
    },
  }
}

const f = ref<EncumbrancesData>()

export function encumbrancesSpec(data: EncumbrancesData): PageSpec {
  return page({
    route: '/nonprofit/encumbrances',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'encumbrance',
          sp: data.currentParams,
          drawer: [data.drawer ? { widget: 'encumbrance-drawer', props: { drawer: data.drawer } } : null].filter(
            Boolean,
          ),
          emptyAction: null,
        }),
      },
    ],
  })
}
