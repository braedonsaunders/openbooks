import 'server-only'
import { loadModuleSettingRows, moduleSettingDrawerEntity } from '../../../../../lib/setup/module-settings'

import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button } from '@openbooks/ui'
import { requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import {
  SETUP_ENTITY_BY_KEY,
  setupEntityForFeatureState,
} from '../../../../../lib/setup/registry'
import { resolveDynamicSetupOptions } from '../../../../../lib/setup/dynamic-options'
import { resolvedFeatureState, featureEnabled } from '../../../../../lib/features'
import {
  isUuid,
  mergeHref,
  parsePrefixedListParams,
  pickString,
} from '../../../../../lib/list-params'
import { loadRefOptions } from '../../../../../lib/setup/ref-options'
import { CompanyTab } from './CompanyTab'
import { CloseSetupPage } from './CloseSetupPage'
import { FxProviderPage } from './FxProviderPage'
import { SetupDrawer } from './SetupDrawer'
import { TaxReturnBoxesTab, type TaxReturnBoxRow } from './TaxReturnBoxesTab'
import { TaxRatesTab, type TaxRateRow } from './TaxRatesTab'
import { SegmentValuesTab, type SegmentValueRow } from './SegmentValuesTab'

/**
 * Composite cells and slots for the generic setup-entity list.
 *
 * The main table's plain cells are loader-resolved strings, so ordinary
 * columns bind `text`/`badge`/`link` directly. What stays a component:
 *
 * - `SetupDescription`: the description paragraph carries an inline "Learn
 *   more" link (with its significant leading space) when the entity declares
 *   a doc slug. A conditional pair inside one `<p>` is a component, not a
 *   spec construct.
 * - `SetupCodeCell`: a `code`-kind cell renders `<span className="font-mono
 *   text-xs">` when it has a value and a bare em-dash otherwise. With `href`
 *   it is the first-column linked variant (span inside the row link).
 * - `SetupBadgeLinkCell`: the one badge-kind first column in the registry
 *   (`information-return-box-rules.formType`) renders a Badge inside the row
 *   link — a `link` cell renders text, never a Badge.
 * - `SetupDrawerSlot` / `SetupCompanySlot` / `SetupCloseSlot` / `SetupFxSlot`:
 *   the create/edit drawer (with its nested sub-tabs and stacked child
 *   drawers) and the three bespoke entity pages own client state and need an
 *   org id. Capabilities never travel through a spec, so each slot re-derives
 *   authz from the session and the spec carries only the entity key, the URL
 *   it was already rendering with, and plain booleans.
 */

export function SetupDescription({
  description,
  docHref,
  learnMore,
}: {
  description: string
  docHref: string | null
  learnMore: string
}) {
  return (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      {description}
      {docHref ? (
        <>
          {' '}
          <Link
            href={docHref}
            className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {learnMore}
          </Link>
        </>
      ) : null}
    </p>
  )
}

const ROW_LINK_CLASS = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

export function SetupCodeCell({
  text,
  shown,
  href,
}: {
  text: string
  shown: boolean
  href?: string
}) {
  if (!shown) return <>{text}</>
  const inner = <span className="font-mono text-xs">{text}</span>
  if (!href) return inner
  return (
    <Link href={href} className={ROW_LINK_CLASS}>
      {inner}
    </Link>
  )
}

export function SetupBadgeLinkCell({
  label,
  variant,
  href,
}: {
  label: string
  variant: 'default' | 'secondary' | 'outline'
  href: string
}) {
  return (
    <Link href={href} className={ROW_LINK_CLASS}>
      <Badge variant={variant}>{label}</Badge>
    </Link>
  )
}

type RefOption = { value: string; label: string }

/**
 * The setup create/edit drawer with its nested sub-tabs and stacked child
 * drawers, rendered whole from session + URL. Everything below mirrors the
 * native page's drawer section line for line; the loader never duplicates it.
 */
export async function SetupDrawerSlot({
  entityKey,
  sp,
}: {
  entityKey: string
  sp: Record<string, string | string[] | undefined>
}) {
  const authz = await requirePermission('admin.setup.manage')
  const { orgId } = authz.user

  const baseEntity = SETUP_ENTITY_BY_KEY.get(entityKey)
  if (!baseEntity || baseEntity.nestedUnder || baseEntity.rehomed) return null
  const features = await resolvedFeatureState(orgId)
  if (baseEntity.featureKey && !featureEnabled(features, baseEntity.featureKey)) return null
  const entity = resolveDynamicSetupOptions(setupEntityForFeatureState(baseEntity, {
    multiSubsidiary: featureEnabled(features, 'multiSubsidiary'),
    equipment: featureEnabled(features, 'equipment'),
    fieldTickets: featureEnabled(features, 'fieldTickets'),
  }))

  const t = await getTranslations('admin.setup')
  const rowParam = typeof sp.row === 'string' ? sp.row : undefined
  const closeHref = mergeHref(`/admin/setup/${entity.key}`, sp, {
    row: undefined,
    setupTab: undefined,
    boxRow: undefined,
    rateRow: undefined,
    taxBoxQ: undefined,
    taxBoxPage: undefined,
    taxRateQ: undefined,
    taxRatePage: undefined,
    valueRow: undefined,
    segValQ: undefined,
    segValPage: undefined,
  })

  if (entity.dataSource === 'module-settings') {
    if (!rowParam || rowParam === 'new') return null
    const row = (await loadModuleSettingRows(orgId)).find((candidate) => candidate.id === rowParam)
    if (!row) return null
    return <SetupDrawer entity={moduleSettingDrawerEntity(entity, row)} row={row} members={[]} refOptions={{}} closeHref={closeHref} />
  }
  if (rowParam === 'new' && entity.allowCreate === false) return null
  const refOptions = await loadRefOptions(entity, orgId)

  const idColumn = entity.idColumn ?? 'id'
  const open = rowParam
    ? rowParam === 'new'
      ? { creating: true, row: (null), members: [] as string[] }
      : await (async () => {
          const selected = ((await db.execute(sql`
            select * from ${sql.raw(entity.table)}
             where ${sql.raw(idColumn)} = ${rowParam}
             ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
             limit 1`)))
          const found = selected.rows[0] ?? null
          let members: string[] = []
          const multi = entity.fields.find((f) => f.kind === 'multiref')
          if (found && multi) {
            const m = ((await db.execute(sql`
              select tgm.tax_code_id
                from tax_group_members tgm
                join tax_groups tg on tg.id = tgm.tax_group_id and tg.org_id = ${orgId}
               where tgm.tax_group_id = ${found.id}
               order by tgm.sequence`)))
            members = m.rows.map((x) => x.tax_code_id as string)
          }
          return { creating: false, row: found, members }
        })()
    : null
  if (!open) return null

  const taxCodeRow = entity.key === 'tax-codes' ? open?.row : null
  const taxReturnRow = entity.key === 'tax-return-forms' ? open?.row : null

  const taxRateEntity = SETUP_ENTITY_BY_KEY.get('tax-rates')!
  const taxRateList = parsePrefixedListParams(sp, 'taxRate', {
    sort: 'default',
    allowedSorts: ['default'] as const,
    perPage: 10,
  })
  const taxRateTabActive = Boolean(taxCodeRow) && pickString(sp.setupTab) === 'tax-rates'
  let taxRateRows: TaxRateRow[] = []
  let taxRateTotal = 0
  let taxRateRefOptions: Record<string, RefOption[]> = {}
  let taxRateOpen: { creating: boolean; row: Record<string, unknown> | null } | null = null

  if (taxRateTabActive) {
    const taxCodeId = String(taxCodeRow![idColumn])
    const taxRateSearch = `%${taxRateList.q ?? ''}%`
    const taxRateFilter = sql`where org_id = ${orgId} and tax_code_id = ${taxCodeId}
      ${taxRateList.q ? sql`and (
        cast(rate_percent as text) ilike ${taxRateSearch}
        or cast(effective_from as text) ilike ${taxRateSearch}
        or coalesce(cast(effective_to as text), '') ilike ${taxRateSearch}
      )` : sql``}`
    const [rateRowsRes, rateCountRes, childRefs] = await Promise.all([
      db.execute(sql`
        select id, rate_percent, effective_from, effective_to
          from tax_rates ${taxRateFilter}
         order by effective_from desc
         limit ${taxRateList.perPage} offset ${(taxRateList.page - 1) * taxRateList.perPage}`) as any,
      (db.execute(sql`select count(*)::int as n from tax_rates ${taxRateFilter}`)),
      loadRefOptions(taxRateEntity, orgId),
    ])
    taxRateRows = rateRowsRes.rows as TaxRateRow[]
    taxRateTotal = Number(rateCountRes.rows[0]?.n ?? 0)
    taxRateRefOptions = childRefs

    const rateRowParam = pickString(sp.rateRow)
    if (rateRowParam) {
      if (rateRowParam === 'new') {
        taxRateOpen = { creating: true, row: null }
      } else if (isUuid(rateRowParam)) {
        const selected = ((await db.execute(sql`
          select * from tax_rates
           where id = ${rateRowParam} and org_id = ${orgId} and tax_code_id = ${taxCodeId}
           limit 1`)))
        taxRateOpen = selected.rows[0] ? { creating: false, row: selected.rows[0] } : null
      }
    }
  }

  const taxRateCloseHref = mergeHref('/admin/setup/tax-codes', sp, {
    setupTab: 'tax-rates',
    rateRow: undefined,
  })
  const taxRateTab = taxCodeRow ? await TaxRatesTab({
    taxCode: String(taxCodeRow.code),
    rows: taxRateRows,
    total: taxRateTotal,
    page: taxRateList.page,
    perPage: taxRateList.perPage,
    currentParams: sp,
  }) : null

  const taxBoxEntity = SETUP_ENTITY_BY_KEY.get('tax-report-lines')!
  const taxBoxList = parsePrefixedListParams(sp, 'taxBox', {
    sort: 'default',
    allowedSorts: ['default'] as const,
    perPage: 10,
  })
  const taxBoxTabActive = Boolean(taxReturnRow) && pickString(sp.setupTab) === 'tax-return-boxes'
  let taxBoxRows: TaxReturnBoxRow[] = []
  let taxBoxTotal = 0
  let taxBoxRefOptions: Record<string, RefOption[]> = {}
  let taxBoxOpen: { creating: boolean; row: Record<string, unknown> | null } | null = null

  if (taxBoxTabActive) {
    const returnCode = String(taxReturnRow!.code)
    const taxBoxSearch = `%${taxBoxList.q ?? ''}%`
    const taxBoxFilter = sql`where org_id = ${orgId} and report_code = ${returnCode}
      ${taxBoxList.q ? sql`and (
        line_code ilike ${taxBoxSearch}
        or label ilike ${taxBoxSearch}
        or coalesce(basis, '') ilike ${taxBoxSearch}
        or coalesce(formula, '') ilike ${taxBoxSearch}
      )` : sql``}`
    const [boxRowsRes, boxCountRes, childRefs] = await Promise.all([
      db.execute(sql`
        select id, report_code, line_code, label, basis, formula, tax_code_id
          from tax_report_lines ${taxBoxFilter}
         order by report_code, sequence, line_code
         limit ${taxBoxList.perPage} offset ${(taxBoxList.page - 1) * taxBoxList.perPage}`) as any,
      (db.execute(sql`select count(*)::int as n from tax_report_lines ${taxBoxFilter}`)),
      loadRefOptions(taxBoxEntity, orgId),
    ])
    taxBoxRows = boxRowsRes.rows as TaxReturnBoxRow[]
    taxBoxTotal = Number(boxCountRes.rows[0]?.n ?? 0)
    taxBoxRefOptions = childRefs

    const boxRowParam = pickString(sp.boxRow)
    if (boxRowParam) {
      if (boxRowParam === 'new') {
        taxBoxOpen = { creating: true, row: null }
      } else if (isUuid(boxRowParam)) {
        const selected = ((await db.execute(sql`
          select * from tax_report_lines
           where id = ${boxRowParam} and org_id = ${orgId}
             and report_code = ${returnCode}
           limit 1`)))
        taxBoxOpen = selected.rows[0] ? { creating: false, row: selected.rows[0] } : null
      }
    }
  }

  const taxBoxCloseHref = mergeHref('/admin/setup/tax-return-forms', sp, {
    setupTab: 'tax-return-boxes',
    boxRow: undefined,
  })
  const taxBoxTab = taxReturnRow ? await TaxReturnBoxesTab({
    returnCode: String(taxReturnRow.code),
    rows: taxBoxRows,
    total: taxBoxTotal,
    page: taxBoxList.page,
    perPage: taxBoxList.perPage,
    currentParams: sp,
  }) : null

  // --- Segment values, nested under an open Segment definition ----------------
  // Custom segments own their values (managed here); built-in dimensions keep
  // their values on the dedicated Classes/Departments/Locations tabs, so their
  // drawer shows a pointer there instead of an editable list.
  const segmentDefRow = entity.key === 'segment-definitions' ? open?.row : null
  const segmentIsCustom = segmentDefRow?.source_kind === 'custom'
  const segValEntity = SETUP_ENTITY_BY_KEY.get('segment-values')!
  const segValList = parsePrefixedListParams(sp, 'segVal', {
    sort: 'default',
    allowedSorts: ['default'] as const,
    perPage: 10,
  })
  const segValTabActive =
    Boolean(segmentDefRow) && segmentIsCustom && pickString(sp.setupTab) === 'segment-values'
  let segValRows: SegmentValueRow[] = []
  let segValTotal = 0
  let segValRefOptions: Record<string, RefOption[]> = {}
  let segValOpen: { creating: boolean; row: Record<string, unknown> | null } | null = null

  if (segValTabActive) {
    const segmentId = String(segmentDefRow![idColumn])
    const segValSearch = `%${segValList.q ?? ''}%`
    const segValFilter = sql`where org_id = ${orgId} and segment_id = ${segmentId}
      ${segValList.q ? sql`and (
        coalesce(code, '') ilike ${segValSearch}
        or name ilike ${segValSearch}
      )` : sql``}`
    const [valRowsRes, valCountRes, childRefs] = await Promise.all([
      db.execute(sql`
        select id, code, name, is_active
          from segment_values ${segValFilter}
         order by name
         limit ${segValList.perPage} offset ${(segValList.page - 1) * segValList.perPage}`) as any,
      (db.execute(sql`select count(*)::int as n from segment_values ${segValFilter}`)),
      loadRefOptions(segValEntity, orgId),
    ])
    segValRows = valRowsRes.rows as SegmentValueRow[]
    segValTotal = Number(valCountRes.rows[0]?.n ?? 0)
    segValRefOptions = childRefs

    const valueRowParam = pickString(sp.valueRow)
    if (valueRowParam) {
      if (valueRowParam === 'new') {
        segValOpen = { creating: true, row: null }
      } else if (isUuid(valueRowParam)) {
        const selected = ((await db.execute(sql`
          select * from segment_values
           where id = ${valueRowParam} and org_id = ${orgId} and segment_id = ${segmentId}
           limit 1`)))
        segValOpen = selected.rows[0] ? { creating: false, row: selected.rows[0] } : null
      }
    }
  }

  const segValCloseHref = mergeHref('/admin/setup/segment-definitions', sp, {
    setupTab: 'segment-values',
    valueRow: undefined,
  })

  // Built-in dimensions store their values in a dedicated domain table surfaced
  // on its own setup tab; map the storage column to that tab for a deep link.
  const BUILTIN_VALUE_TAB: Record<string, string> = {
    department_id: 'departments',
    location_id: 'locations',
    class_id: 'classes',
    subsidiary_id: 'subsidiaries',
  }
  const segmentDisplayName = segmentDefRow
    ? String(segmentDefRow.plural_name ?? segmentDefRow.name)
    : ''
  const builtinValueTab = segmentDefRow
    ? BUILTIN_VALUE_TAB[String(segmentDefRow.storage_column)]
    : undefined

  const segValTabContent = segmentDefRow ? (
    segmentIsCustom ? (
      await SegmentValuesTab({
        segmentName: segmentDisplayName,
        rows: segValRows,
        total: segValTotal,
        page: segValList.page,
        perPage: segValList.perPage,
        currentParams: sp,
      })
    ) : (
      <div className="space-y-3 p-1 text-sm">
        <p className="text-slate-600 dark:text-slate-300">
          {builtinValueTab
            ? t('segmentValues.builtinNotice', { name: segmentDisplayName })
            : t('segmentValues.builtinNoticeNoLink', { name: segmentDisplayName })}
        </p>
        {builtinValueTab ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/setup/${builtinValueTab}`}>
              {t('segmentValues.builtinLink', { name: segmentDisplayName })}
            </Link>
          </Button>
        ) : null}
      </div>
    )
  ) : null

  return (
    <>
      <SetupDrawer
        entity={entity}
        row={open.row}
        members={open.members}
        refOptions={refOptions}
        closeHref={closeHref}
        nestedTab={taxCodeRow ? {
          key: 'tax-rates',
          label: t('entities.tax-rates.title'),
          content: taxRateTab,
        } : taxReturnRow ? {
          key: 'tax-return-boxes',
          label: t('entities.tax-report-lines.title'),
          content: taxBoxTab,
        } : segmentDefRow ? {
          key: 'segment-values',
          label: t('entities.segment-values.title'),
          content: segValTabContent,
        } : undefined}
      />

      {segValOpen && segmentDefRow ? (
        <SetupDrawer
          entity={segValEntity}
          row={segValOpen.row}
          members={[]}
          refOptions={segValRefOptions}
          closeHref={segValCloseHref}
          fixedValues={{ segmentId: segmentDefRow[idColumn] }}
          stacked
        />
      ) : null}

      {taxRateOpen && taxCodeRow ? (
        <SetupDrawer
          entity={taxRateEntity}
          row={taxRateOpen.row}
          members={[]}
          refOptions={taxRateRefOptions}
          closeHref={taxRateCloseHref}
          fixedValues={{ taxCodeId: taxCodeRow[idColumn] }}
          stacked
        />
      ) : null}

      {taxBoxOpen && taxReturnRow ? (
        <SetupDrawer
          entity={taxBoxEntity}
          row={taxBoxOpen.row}
          members={[]}
          refOptions={taxBoxRefOptions}
          closeHref={taxBoxCloseHref}
          fixedValues={{ reportCode: taxReturnRow.code }}
          stacked
        />
      ) : null}
    </>
  )
}

/** Company & Accounting settings tab, rendered from the session alone. */
export async function SetupCompanySlot() {
  const authz = await requirePermission('admin.setup.manage')
  return <CompanyTab orgId={authz.user.orgId} />
}

/** Period-close workspace. `canReopen` is a loader-resolved boolean. */
export async function SetupCloseSlot({
  sp,
  canReopen,
}: {
  sp: Record<string, string | string[] | undefined>
  canReopen: boolean
}) {
  const authz = await requirePermission('admin.setup.manage')
  return (
    <CloseSetupPage orgId={authz.user.orgId} searchParams={sp} canReopen={canReopen} />
  )
}

/** FX provider page, rendered from the session alone. */
export async function SetupFxSlot() {
  const authz = await requirePermission('admin.setup.manage')
  await requireFeatureEnabled(authz.user.orgId, 'multiCurrency')
  return <FxProviderPage orgId={authz.user.orgId} />
}
