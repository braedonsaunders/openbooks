import { type ComponentProps, type ReactNode } from 'react'
import { ResourceCell, RowCountsCell } from '../../app/(app)/data/import/history/sections'
import { CurrencyBasisControl, type CurrencyOption } from '../../app/(app)/reports/aging/currency-basis'
import { Settings, ArrowLeft, Plus, Gauge, History, ScanLine } from 'lucide-react'
import { KpiStrip } from '../kpi-strip'
import { DateRangeFilter } from '../date-range-filter'
import { ForecastSectionHeading, ForecastFilters } from '../../app/(app)/crm/forecasts/sections'
import { SearchSelectFilter, FilterChips } from '../filter-bar'
import { SearchInput } from '../search-input'
import { ShowInactivesToggle } from '../show-inactives-toggle'
import { Badge, Button } from '@openbooks/ui'
import Link from 'next/link'
import { str, type WidgetRenderer } from './widget-props'

/** Shared spec controls adapters: links, filters, badges and headings. Compose native components without changing their props or boundaries. */
export const CONTROLS_WIDGETS = {
  /** A primary action button that navigates — the common page-header action. */
  'link-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    // Icons are components, so the spec names one from a closed map — the same
    // rule the empty state follows.
    const icons: Record<string, ReactNode> = { settings: <Settings size={14} />, plus: <Plus size={16} /> }
    const iconKey = str(props, 'iconKey')
    const variant = str(props, 'variant') as ComponentProps<typeof Button>['variant']
    const size = str(props, 'size') as ComponentProps<typeof Button>['size']
    return (
      <Button asChild variant={variant} size={size}>
        <Link href={href as never}>
          {iconKey ? icons[iconKey] : null}
          {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  'resource-cell': (props) => (
    <ResourceCell label={str(props, 'label') ?? ''} fileName={(props.fileName as string | null) ?? null} />
  ),
  'row-counts-cell': (props) => (
    <RowCountsCell
      created={Number(props.created ?? 0)}
      updated={Number(props.updated ?? 0)}
      failed={Number(props.failed ?? 0)}
    />
  ),
  /* --- admin lists -------------------------------------------------------- */
  'search-input': (props) => (
    <SearchInput
      placeholder={str(props, 'placeholder')}
      paramKey={str(props, 'paramKey')}
      pageParamKey={str(props, 'pageParamKey')}
      className={str(props, 'className')}
    />
  ),
  'filter-chips': (props) => (
    <FilterChips
      basePath={str(props, 'basePath')}
      currentParams={(props.currentParams as ComponentProps<typeof FilterChips>['currentParams']) ?? {}}
      paramKey={str(props, 'paramKey') ?? ''}
      label={str(props, 'label') ?? ''}
      allLabel={str(props, 'allLabel')}
      pageParamKey={str(props, 'pageParamKey')}
      hideAll={props.hideAll === true}
      defaultValue={str(props, 'defaultValue')}
      options={(props.options as ComponentProps<typeof FilterChips>['options']) ?? []}
    />
  ),
  /** A monospaced inline code cell (key previews, identifiers). */
  'code-cell': (props) => (
    <code className="font-mono text-[12px] text-slate-500 dark:text-slate-400">
      {str(props, 'text') ?? ''}
    </code>
  ),
  /** A pill that renders nothing when the label is empty. The table's
   *  `badge` cell always emits its wrapper, so optional flags bind through
   *  here instead of leaving an empty pill behind. */
  'optional-badge': (props) => {
    const label = str(props, 'label')
    if (!label) return null
    const variant = str(props, 'variant') as ComponentProps<typeof Badge>['variant']
    return <Badge variant={variant}>{label}</Badge>
  },
  /** Not `filter-chips`: a different component AND a different contract
   *  (router.replace + resetParamKeys, no basePath navigation). */
  'search-select-filter': (props) => (
    <SearchSelectFilter
      paramKey={str(props, 'paramKey') ?? ''}
      label={str(props, 'label') ?? ''}
      options={(props.options as ComponentProps<typeof SearchSelectFilter>['options']) ?? []}
      allLabel={str(props, 'allLabel')}
      resetParamKeys={(props.resetParamKeys as string[]) ?? []}
      className={str(props, 'className')}
    />
  ),

  /** The AP capture shortcut: outline button with a scan icon. */
  'ap-capture-link': (props) => (
    <Button asChild variant="outline">
      <Link href={(str(props, 'href') ?? '/ap/capture') as never}>
        <ScanLine size={14} aria-hidden />
        {str(props, 'label') ?? ''}
      </Link>
    </Button>
  ),
  /** The generic KPI strip — every KPI row is the house KpiStrip. */
  'kpi-strip': (props) => (
    <KpiStrip items={(props.items as ComponentProps<typeof KpiStrip>['items']) ?? []} />
  ),
  /** The whole app flyout stays one widget: its body is three tabs of per-row
   *  client state (dirty flags, selected file, open dirs) — a workspace, not a
   *  spec. */


  /* --- AP capture ------------------------------------------------------------ */
  /** Diffed against `plain-link-button` (Link outside Button, no icon) and
   *  `docs-link-button` (small, 14px icon, no space): neither renders this
   *  shape, so it keeps its own entry. */
  'back-link-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline">
        <Link href={href as never}>
          <ArrowLeft size={14} />
          {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  /** A link wrapped in a Button — the plain form several admin headers use,
   *  distinct from `link-button` only in that the Link is on the OUTSIDE. */
  'plain-link-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    const variant = str(props, 'variant') as ComponentProps<typeof Button>['variant']
    return (
      <Link href={href as never}>
        <Button variant={variant}>{str(props, 'label') ?? ''}</Button>
      </Link>
    )
  },
  'date-range-filter': (props) => (
    <DateRangeFilter
      fromKey={str(props, 'fromKey') ?? 'from'}
      toKey={str(props, 'toKey') ?? 'to'}
      fromLabel={str(props, 'fromLabel') ?? ''}
      toLabel={str(props, 'toLabel') ?? ''}
      // Forwarded, not dropped: the component's default is the hardcoded
      // English "Clear dates", so a page that translated the label was having
      // it thrown away. `pageParamKey` likewise decides which pager this
      // filter resets, and defaulting it silently resets the wrong one.
      clearLabel={str(props, 'clearLabel')}
      pageParamKey={str(props, 'pageParamKey')}
      defaultFrom={str(props, 'defaultFrom')}
      defaultTo={str(props, 'defaultTo')}
      clearable={props.clearable !== false}
    />
  ),
  'forecast-filters': (props) => (
    <ForecastFilters
      fromKey={str(props, 'fromKey') ?? 'from'}
      toKey={str(props, 'toKey') ?? 'to'}
      fromLabel={str(props, 'fromLabel') ?? ''}
      toLabel={str(props, 'toLabel') ?? ''}
      defaultFrom={str(props, 'defaultFrom') ?? ''}
      defaultTo={str(props, 'defaultTo') ?? ''}
      ownerLabel={str(props, 'ownerLabel') ?? ''}
      ownerOptions={(props.ownerOptions as ComponentProps<typeof ForecastFilters>['ownerOptions']) ?? []}
      teamLabel={str(props, 'teamLabel') ?? ''}
      teamOptions={(props.teamOptions as ComponentProps<typeof ForecastFilters>['teamOptions']) ?? []}
    />
  ),
  'section-heading': (props) => {
    const icons: Record<string, ReactNode> = {
      gauge: <Gauge size={17} />,
      history: <History size={17} />,
    }
    const iconKey = str(props, 'iconKey')
    return (
      <ForecastSectionHeading
        id={str(props, 'id') ?? ''}
        icon={iconKey ? icons[iconKey] : undefined}
        title={str(props, 'title') ?? ''}
        description={str(props, 'description')}
      />
    )
  },
  'show-inactives-toggle': (props) => (
    <ShowInactivesToggle
      basePath={str(props, 'basePath') ?? ''}
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  'currency-basis': (props) => (
    <CurrencyBasisControl
      currencies={(props.currencies as CurrencyOption[]) ?? []}
      currency={str(props, 'currency') ?? ''}
      currencyBasis={str(props, 'currencyBasis') === 'transaction' ? 'transaction' : 'base'}
      currencyLabel={str(props, 'currencyLabel') ?? ''}
      basisLabel={str(props, 'basisLabel') ?? ''}
      baseLabel={str(props, 'baseLabel') ?? ''}
      transactionLabel={str(props, 'transactionLabel') ?? ''}
    />
  ),
} satisfies Record<string, WidgetRenderer>
