import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { Badge, EmptyState } from '@openbooks/ui'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { listJobLevels, listPayBandVersions, type PayBandDTO } from '@openbooks/engine/hrm/compensation'
import { RegisteredListTable } from '../../../../components/registered-list-table'
import { FilterChips } from '../../../../components/filter-bar'
import { formatDecimal } from '../../../../lib/money-format'
import { mergeHref, pickString } from '../../../../lib/list-params'
import { clearSetupChildren } from '../../../../lib/setup/navigation'
import { loadRefOptions } from '../../../../lib/setup/ref-options'
import { JOB_LEVELS_ENTITY, PAY_BANDS_ENTITY } from '../../../../lib/setup/hrm-compensation'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'

const basePath = '/hrm/compensation'
const recordLink = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

/** One range per level and scope; dated versions remain children of the level. */
export async function CompensationBandsWorkspace({ orgId, actorId, allowedSubsidiaryIds, canSetup, searchParams }: {
  orgId: string
  actorId: string
  allowedSubsidiaryIds: ReadonlySet<string> | null
  canSetup: boolean
  searchParams: Record<string, string | string[] | undefined>
}) {
  const [versions, levels, today, refOptions, t, setup, locale] = await Promise.all([
    listPayBandVersions({ orgId, actorId }),
    listJobLevels({ orgId, actorId, includeInactive: true }),
    businessToday(orgId),
    loadRefOptions(PAY_BANDS_ENTITY, orgId, allowedSubsidiaryIds),
    getTranslations('hrm.compensation.workspace'),
    getTranslations('admin.setup'),
    getLocale(),
  ])
  const levelById = new Map(levels.map((level) => [level.id, level]))
  const labels = (source: string) => new Map((refOptions[source] ?? []).map((option) => [option.value, option.label]))
  const employers = labels('subsidiaries')
  const locations = labels('locations')
  const status = (band: PayBandDTO) => band.effectiveFrom > today ? 'upcoming'
    : band.effectiveTo !== null && band.effectiveTo < today ? 'past' : 'active'
  const requested = pickString(searchParams.bandStatus)
  const filter = requested && ['active', 'upcoming', 'past', 'all'].includes(requested) ? requested : 'active'
  const groups = new Map<string, PayBandDTO[]>()
  for (const band of versions) {
    const key = JSON.stringify([band.familyId, band.levelId, band.employerSubsidiaryId, band.locationId, band.currency, band.basis])
    const group = groups.get(key) ?? []
    group.push(band)
    groups.set(key, group)
  }
  const rows = [...groups.values()].flatMap((history) => {
    const matching = filter === 'all' ? history : history.filter((band) => status(band) === filter)
    // Prefer today's range, then the next scheduled range, then the latest ended range.
    const band = matching.find((item) => status(item) === 'active')
      ?? matching.filter((item) => status(item) === 'upcoming').sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0]
      ?? matching[0]
    if (!band) return []
    const level = levelById.get(band.levelId)
    return [{ ...band, levelName: level?.name ?? band.levelId, levelCode: level?.code ?? '', rank: level?.rank ?? 0, versionCount: history.length }]
  }).sort((a, b) => a.rank - b.rank || a.levelName.localeCompare(b.levelName, locale) || a.currency.localeCompare(b.currency))
  const recordHref = (changes: Record<string, string>) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(searchParams)) {
      const scalar = pickString(value)
      if (scalar !== undefined) params.set(key, scalar)
    }
    for (const key of ['family', 'level', 'band', 'setupTab']) params.delete(key)
    clearSetupChildren(params)
    return mergeHref(basePath, Object.fromEntries(params), changes)
  }
  const amount = (value: string | null) => value === null ? '—' : formatDecimal(locale, value, { maximumFractionDigits: 4 })
  const options = ['active', 'upcoming', 'past'].map((value) => ({ value, label: t(`bandStatus.${value}`) }))
  return <>
    <RegisteredListTable source="hrm_compensation_bands" contained
      basePath={basePath} currentParams={searchParams}
      sort={pickString(searchParams.bandSort) ?? 'default'} dir={pickString(searchParams.bandDir) === 'desc' ? 'desc' : 'asc'}
      sortParamKey="bandSort" dirParamKey="bandDir"
      resetPageKey={filter}
      rows={rows} rowKey={(row) => row.id}
      empty={<EmptyState title={t('bandsEmptyFiltered')} />}
      toolbarAfter={<FilterChips label={t('bandStatus.label')} options={options} defaultValue="active"
        basePath={basePath} currentParams={{ ...searchParams, bandStatus: filter }} paramKey="bandStatus" />}
      columns={[
        { key: 'level', sortKey: 'level', sortValue: (row) => row.levelName, header: setup('fields.levelId'), search: (row) => `${row.levelCode} ${row.levelName}`,
          cell: (row) => <Link className={recordLink} href={recordHref({ level: row.levelId, setupTab: 'hrm-pay-bands' }) as never}>{row.levelName}</Link> },
        { key: 'employer', sortKey: 'employer', sortValue: (row) => row.employerSubsidiaryId ? employers.get(row.employerSubsidiaryId) ?? row.employerSubsidiaryId : t('organizationScope'), header: t('employer'), search: (row) => row.employerSubsidiaryId ? employers.get(row.employerSubsidiaryId) ?? '' : t('organizationScope'),
          cell: (row) => row.employerSubsidiaryId ? employers.get(row.employerSubsidiaryId) ?? row.employerSubsidiaryId : t('organizationScope') },
        { key: 'location', sortKey: 'location', sortValue: (row) => row.locationId ? locations.get(row.locationId) ?? row.locationId : null, header: setup('fields.locationId'), search: (row) => row.locationId ? locations.get(row.locationId) ?? '' : '',
          cell: (row) => row.locationId ? locations.get(row.locationId) ?? row.locationId : '—' },
        { key: 'currency', sortKey: 'currency', sortValue: (row) => row.currency, header: setup('fields.currency'), search: (row) => row.currency, cell: (row) => row.currency },
        { key: 'basis', sortKey: 'basis', sortValue: (row) => setup(`options.payBandBasis.${row.basis}`), header: setup('fields.basis'), search: (row) => setup(`options.payBandBasis.${row.basis}`), cell: (row) => setup(`options.payBandBasis.${row.basis}`) },
        { key: 'min', sortKey: 'min', sortValue: (row) => row.min, sortType: 'decimal', header: setup('fields.min'), align: 'right', cell: (row) => amount(row.min) },
        { key: 'target', sortKey: 'target', sortValue: (row) => row.target, sortType: 'decimal', header: setup('fields.target'), align: 'right', cell: (row) => amount(row.target) },
        { key: 'max', sortKey: 'max', sortValue: (row) => row.max, sortType: 'decimal', header: setup('fields.max'), align: 'right', cell: (row) => amount(row.max) },
        { key: 'effectiveFrom', sortKey: 'effectiveFrom', sortValue: (row) => row.effectiveFrom, header: setup('fields.effectiveFrom'), search: (row) => row.effectiveFrom,
          cell: (row) => <Link className={recordLink} href={recordHref({ band: row.id }) as never}>{row.effectiveFrom}</Link> },
        { key: 'status', sortKey: 'status', sortValue: (row) => t(`bandStatus.${status(row)}`), header: t('bandStatus.label'), search: (row) => t(`bandStatus.${status(row)}`),
          cell: (row) => <Badge variant={status(row) === 'active' ? 'success' : 'outline'}>{t(`bandStatus.${status(row)}`)}</Badge> },
        { key: 'history', sortKey: 'history', sortValue: (row) => row.versionCount, header: t('bandHistory'), cell: (row) => <Link className={recordLink}
          href={recordHref({ level: row.levelId, setupTab: 'hrm-pay-bands' }) as never}>{t('bandVersions', { count: row.versionCount })}</Link> },
      ]} />
    <SetupEntitySection
      entity={{ ...(pickString(searchParams.level) && !pickString(searchParams.band) ? JOB_LEVELS_ENTITY : PAY_BANDS_ENTITY), readOnly: !canSetup }}
      orgId={orgId} actorId={actorId} allowedSubsidiaryIds={allowedSubsidiaryIds}
      searchParams={searchParams} basePath={basePath}
      rowParam={pickString(searchParams.level) && !pickString(searchParams.band) ? 'level' : 'band'}
      visibleRowIds={pickString(searchParams.level) && !pickString(searchParams.band) ? undefined : new Set(versions.map((band) => band.id))}
      canManage hideHeader drawerOnly />
  </>
}
