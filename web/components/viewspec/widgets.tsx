import { Fragment, type ComponentProps, type ReactNode } from 'react'
import type { WidgetRef } from '@openbooks/viewspec'
import { isFieldRef, resolvePath } from '@openbooks/viewspec'
import { ExportMenu } from '../../app/(app)/reports/ExportMenu'
import { SaveViewButton } from '../../app/(app)/reports/SaveViewButton'
import { ScheduleReportButton } from '../../app/(app)/reports/ScheduleReportButton'
import { StatementMatrixTable } from '../../app/(app)/reports/StatementMatrixTable'
import { SubsidiarySwitcher } from '../subsidiary-switcher'
import { ModuleHomeTabs, LiveDirectory } from '../module-home/ui'
import { TrendChart } from '../../app/(app)/analytics/_ui/charts'
import { ApPulse, AttentionList, CommitmentsSection, DirectorySection } from '../../app/(app)/purchasing/sections'
import { JournalEntryHeading } from '../../app/(app)/reports/journal/sections'
import { AccountHeading, EntryCell } from '../../app/(app)/reports/general-ledger/sections'
import { ResourceCell, RowCountsCell } from '../../app/(app)/data/import/history/sections'
import { PartyHeading } from '../../app/(app)/reports/registers/sections'
import { PartyLinkCell } from '../../app/(app)/reports/aging/sections'
import { AgingStrip } from '../../app/(app)/reports/statements/[partyId]/sections'
import { StatementRows, ReconciliationNote } from '../../app/(app)/reports/StatementRows'
import { ViewNameCell, ViewActionsCell } from '../../app/(app)/knowledge/views/sections'
import { NewViewButton } from '../../app/(app)/knowledge/views/NewViewButton'
import { ViewStudio } from '../../app/(app)/knowledge/views/ViewStudio'
import { EmptyState } from '@openbooks/ui'
import { DashboardNameCell } from '../../app/(app)/insights/dashboards/sections'
import { NewDashboardButton } from '../../app/(app)/insights/dashboards/NewDashboardButton'
import { InsightsTabs } from '../../app/(app)/insights/InsightsTabs'
import { CardNameCell, VizCell } from '../../app/(app)/insights/sections'
import { NewCardButton } from '../../app/(app)/insights/NewCardButton'
import { CardStudio } from '../../app/(app)/insights/CardStudio'
import { RecordCountCell, InNavCell } from '../../app/(app)/records/types/sections'
import { NewTypeButton } from '../../app/(app)/records/types/NewTypeButton'
import { TypeBuilderDrawer } from '../../app/(app)/records/types/TypeBuilderDrawer'
import { WaiverNumberCell } from '../../app/(app)/compliance/lien-waivers/sections'
import { LienWaiverToolbar } from '../../app/(app)/compliance/lien-waivers/LienWaiverToolbar'
import { LienWaiverDrawer } from '../../app/(app)/compliance/lien-waivers/LienWaiverDrawer'
import { NewFilingButton } from '../../app/(app)/compliance/information-returns/NewFilingButton'
import { IdentityCell, ActingCell, AccessControlCell } from '../../app/(app)/platform/access/sections'
import { GrantAccessForm } from '../../app/(app)/platform/_components/GrantAccessForm'
import { KeyRound, Building2, Users } from 'lucide-react'
import {
  UserIdentityCell,
  UserRolesCell,
  UserGrantsCell,
  UserManageCell,
} from '../../app/(app)/platform/users/sections'
import {
  OrgNameCell,
  OrgEnvironmentCell,
  OrgLocaleCell,
  OrgUsersCell,
  OrgOpenCell,
} from '../../app/(app)/platform/organizations/sections'
import { SearchInput } from '../search-input'
import { FilterChips } from '../filter-bar'
import { NewKeyButton, KeyDrawer } from '../../app/(app)/admin/api-keys/KeyDrawer'
import { FieldDrawer, NewFieldButton } from '../../app/(app)/admin/custom-fields/FieldDrawer'
import { NewScriptButton, ScriptDrawer } from '../../app/(app)/admin/scripts/ScriptDrawer'
import { Badge, Button } from '@openbooks/ui'
import Link from 'next/link'

/**
 * Widget registry — the closed set of interactive components a spec may place
 * into a slot.
 *
 * Native pages pass arbitrary JSX into slots like the filter bar's `actions`.
 * A spec cannot express JSX, so it names a widget instead and the host
 * resolves the name here. Keeping the registry closed is a security property,
 * not a convenience: a spec that could name any component would be able to
 * mount anything the bundle contains, which is exactly the escape hatch the
 * block-vocabulary design exists to prevent.
 *
 * Placing a widget grants no capability. Each widget re-checks permission on
 * the host side exactly as it does when a native page renders it, so a spec
 * author who lacks a permission gets the same empty result a user would.
 */

type WidgetRenderer = (props: Record<string, unknown>) => ReactNode

function str(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key]
  return typeof value === 'string' ? value : undefined
}

function stringRecord(props: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = props[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export const WIDGET_REGISTRY: Record<string, WidgetRenderer> = {
  /**
   * The statement matrix. Placed whole rather than decomposed into `table`
   * blocks: it owns variance percentages, scale divisors, hierarchical line
   * rendering and its own drill construction, and re-expressing that as
   * generic columns would reimplement it rather than compose it. The loader
   * hands over the `StatementView` it already built.
   */
  'statement-matrix': (props) => (
    <StatementMatrixTable
      view={props.view as ComponentProps<typeof StatementMatrixTable>['view']}
      scale={props.scale as ComponentProps<typeof StatementMatrixTable>['scale']}
      currency={str(props, 'currency')}
      drill={props.drill as ComponentProps<typeof StatementMatrixTable>['drill']}
    />
  ),
  /* --- purchasing cockpit ------------------------------------------------ */
  'subsidiary-switcher': (props) => (
    <SubsidiarySwitcher
      picker={props.picker as ComponentProps<typeof SubsidiarySwitcher>['picker']}
      value={str(props, 'value') ?? ''}
      label={str(props, 'label') ?? ''}
    />
  ),
  'module-home-tabs': (props) => (
    <ModuleHomeTabs tabs={props.tabs as ComponentProps<typeof ModuleHomeTabs>['tabs']} />
  ),
  'commitments-section': (props) => (
    <CommitmentsSection
      rows={props.rows as ComponentProps<typeof CommitmentsSection>['rows']}
      showPurchaseOrders={props.showPurchaseOrders === true}
      empty={str(props, 'empty') ?? ''}
    />
  ),
  'ap-pulse': (props) => (
    <ApPulse
      outstanding={str(props, 'outstanding') ?? ''}
      overdue={str(props, 'overdue') ?? ''}
      dueNext7={str(props, 'dueNext7') ?? ''}
      overdueIsNegative={props.overdueIsNegative === true}
      labels={props.labels as ComponentProps<typeof ApPulse>['labels']}
      href={str(props, 'href') ?? ''}
    />
  ),
  'trend-chart': (props) => (
    <TrendChart
      labels={props.labels as ComponentProps<typeof TrendChart>['labels']}
      series={props.series as ComponentProps<typeof TrendChart>['series']}
      height={typeof props.height === 'number' ? props.height : undefined}
      area={props.area === true}
    />
  ),
  'directory-section': (props) => (
    <DirectorySection
      items={props.items as ComponentProps<typeof DirectorySection>['items']}
      title={str(props, 'title') ?? ''}
    />
  ),
  'attention-list': (props) => (
    <AttentionList
      items={props.items as ComponentProps<typeof AttentionList>['items']}
      allClear={str(props, 'allClear') ?? ''}
    />
  ),
  'live-directory': (props) => (
    <LiveDirectory items={props.items as ComponentProps<typeof LiveDirectory>['items']} />
  ),

  /* --- reports ----------------------------------------------------------- */
  'journal-entry-heading': (props) => (
    <JournalEntryHeading
      entryId={str(props, 'entryId') ?? ''}
      docKind={(props.docKind as string | null) ?? null}
      docId={(props.docId as string | null) ?? null}
      entryNumber={(props.entryNumber as string | null) ?? null}
      date={str(props, 'date') ?? ''}
      originLabel={str(props, 'originLabel') ?? ''}
      memo={(props.memo as string | null) ?? null}
    />
  ),
  'account-heading': (props) => (
    <AccountHeading
      accountId={str(props, 'accountId') ?? ''}
      from={str(props, 'from') ?? ''}
      to={str(props, 'to') ?? ''}
      number={(props.number as string | null) ?? null}
      name={str(props, 'name') ?? ''}
    />
  ),
  'entry-cell': (props) => (
    <EntryCell
      entryId={str(props, 'entryId') ?? ''}
      docKind={(props.docKind as string | null) ?? null}
      docId={(props.docId as string | null) ?? null}
      entryNumber={(props.entryNumber as string | null) ?? null}
    />
  ),
  /** A primary action button that navigates — the common page-header action. */
  'link-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild>
        <Link href={href as never}>{str(props, 'label') ?? ''}</Link>
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
  'party-heading': (props) => (
    <PartyHeading
      partyId={(props.partyId as string | null) ?? null}
      partyName={str(props, 'partyName') ?? ''}
      statementHref={str(props, 'statementHref') ?? ''}
      closingLabel={str(props, 'closingLabel') ?? ''}
      closing={str(props, 'closing') ?? ''}
      closingDrill={props.closingDrill as ComponentProps<typeof PartyHeading>['closingDrill']}
    />
  ),
  /* --- admin lists -------------------------------------------------------- */
  'search-input': (props) => <SearchInput placeholder={str(props, 'placeholder')} />,
  'filter-chips': (props) => (
    <FilterChips
      basePath={str(props, 'basePath')}
      currentParams={(props.currentParams as ComponentProps<typeof FilterChips>['currentParams']) ?? {}}
      paramKey={str(props, 'paramKey') ?? ''}
      label={str(props, 'label') ?? ''}
      allLabel={str(props, 'allLabel')}
      options={(props.options as ComponentProps<typeof FilterChips>['options']) ?? []}
    />
  ),
  /** A monospaced inline code cell (key previews, identifiers). */
  'code-cell': (props) => (
    <code className="font-mono text-[12px] text-slate-500 dark:text-slate-400">
      {str(props, 'text') ?? ''}
    </code>
  ),
  'new-api-key': () => <NewKeyButton />,
  'api-key-drawer': (props) => (
    <KeyDrawer keyRow={(props.keyRow as ComponentProps<typeof KeyDrawer>['keyRow']) ?? null} />
  ),

  'new-custom-field': () => <NewFieldButton />,
  'custom-field-drawer': (props) => (
    <FieldDrawer
      def={(props.def as ComponentProps<typeof FieldDrawer>['def']) ?? null}
      hiddenKinds={(props.hiddenKinds as string[]) ?? []}
      hiddenTables={(props.hiddenTables as string[]) ?? []}
    />
  ),
  'new-script': () => <NewScriptButton />,
  'script-drawer': (props) => (
    <ScriptDrawer
      script={(props.script as ComponentProps<typeof ScriptDrawer>['script']) ?? null}
      runs={(props.runs as ComponentProps<typeof ScriptDrawer>['runs']) ?? []}
      customTypes={(props.customTypes as ComponentProps<typeof ScriptDrawer>['customTypes']) ?? []}
    />
  ),
  'party-link-cell': (props) => (
    <PartyLinkCell
      partyId={(props.partyId as string | null) ?? null}
      partyName={str(props, 'partyName') ?? ''}
      href={str(props, 'href') ?? ''}
    />
  ),
  'aging-strip': (props) => (
    <AgingStrip
      cells={(props.cells as ComponentProps<typeof AgingStrip>['cells']) ?? []}
      totalLabel={str(props, 'totalLabel') ?? ''}
      total={str(props, 'total') ?? ''}
      totalDrill={props.totalDrill as ComponentProps<typeof AgingStrip>['totalDrill']}
    />
  ),
  'statement-rows': (props) => (
    <StatementRows rows={(props.rows as ComponentProps<typeof StatementRows>['rows']) ?? []} />
  ),
  'reconciliation-note': (props) => (
    <ReconciliationNote
      label={str(props, 'label') ?? ''}
      status={str(props, 'status') ?? ''}
      reconciled={props.reconciled === true}
    />
  ),
  'empty-state': (props) => {
    // `action` names a widget rather than carrying JSX, so an empty state can
    // offer its create button without the spec expressing a component.
    const action = str(props, 'action')
    const renderer = action ? WIDGET_REGISTRY[action] : undefined
    // Icons are components, so the spec names one from a closed map rather
    // than carrying it — same rule as every other component reference.
    const icons: Record<string, ReactNode> = { 'key-round': <KeyRound />, building: <Building2 />, users: <Users /> }
    const iconKey = str(props, 'icon')
    return (
      <EmptyState
        icon={iconKey ? icons[iconKey] : undefined}
        title={str(props, 'title') ?? ''}
        description={str(props, 'description')}
        action={renderer ? renderer({}) : undefined}
      />
    )
  },
  'insights-tabs': (props) => (
    <InsightsTabs active={(str(props, 'active') ?? '') as ComponentProps<typeof InsightsTabs>['active']} />
  ),
  'new-dashboard': () => <NewDashboardButton />,
  'new-card': () => <NewCardButton />,
  'new-record-type': () => <NewTypeButton />,
  'waiver-number-cell': (props) => (
    <WaiverNumberCell
      waiverNumber={str(props, 'waiverNumber') ?? ''}
      href={str(props, 'href') ?? ''}
      directionLabel={str(props, 'directionLabel') ?? ''}
    />
  ),
  'user-identity-cell': (props) => (
    <UserIdentityCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      email={str(props, 'email') ?? ''}
      isSuperAdmin={props.isSuperAdmin === true}
      isActive={props.isActive === true}
    />
  ),
  'user-roles-cell': (props) => <UserRolesCell roles={(props.roles as string[]) ?? []} />,
  'user-grants-cell': (props) => (
    <UserGrantsCell label={str(props, 'label') ?? ''} emphasised={props.emphasised === true} />
  ),
  'user-manage-cell': (props) => <UserManageCell href={str(props, 'href') ?? ''} />,
  'org-name-cell': (props) => (
    <OrgNameCell name={str(props, 'name') ?? ''} subtitle={str(props, 'subtitle') ?? ''} />
  ),
  'org-environment-cell': (props) => (
    <OrgEnvironmentCell
      envKind={str(props, 'envKind') ?? ''}
      variant={(str(props, 'variant') ?? 'secondary') as ComponentProps<typeof OrgEnvironmentCell>['variant']}
      parentNote={str(props, 'parentNote') ?? ''}
    />
  ),
  'org-locale-cell': (props) => (
    <OrgLocaleCell country={str(props, 'country') ?? ''} currency={str(props, 'currency') ?? ''} />
  ),
  'org-users-cell': (props) => (
    <OrgUsersCell active={str(props, 'active') ?? ''} total={str(props, 'total') ?? ''} />
  ),
  'org-open-cell': (props) => <OrgOpenCell orgId={str(props, 'orgId') ?? ''} />,
  'identity-cell': (props) => (
    <IdentityCell name={str(props, 'name') ?? ''} detail={str(props, 'detail') ?? ''} />
  ),
  'acting-cell': (props) => (
    <ActingCell name={str(props, 'name') ?? ''} email={str(props, 'email') ?? ''} />
  ),
  'access-control-cell': (props) => (
    <AccessControlCell grantId={str(props, 'grantId') ?? ''} isActive={props.isActive === true} />
  ),
  'grant-access-form': (props) => (
    <GrantAccessForm {...(props.options as ComponentProps<typeof GrantAccessForm>)} />
  ),
  'new-filing': (props) => (
    <NewFilingButton
      formTypes={(props.formTypes as ComponentProps<typeof NewFilingButton>['formTypes']) ?? []}
      defaultYear={Number(props.defaultYear ?? 0)}
    />
  ),
  'lien-waiver-toolbar': (props) => (
    <LienWaiverToolbar
      direction={str(props, 'direction') ?? ''}
      status={str(props, 'status') ?? ''}
      projects={props.projects as ComponentProps<typeof LienWaiverToolbar>['projects']}
      vendors={props.vendors as ComponentProps<typeof LienWaiverToolbar>['vendors']}
      canManage={props.canManage === true}
    />
  ),
  'lien-waiver-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof LienWaiverDrawer> | null
    if (!drawer) return null
    return <LienWaiverDrawer {...drawer} />
  },
  'record-count-cell': (props) => (
    <RecordCountCell
      count={str(props, 'count') ?? ''}
      href={str(props, 'href') ?? ''}
      linked={props.linked === true}
    />
  ),
  /** A badge when present, an em-dash placeholder when not. Generic because
   *  several lists use exactly this "flag or nothing" cell. */
  'badge-or-dash': (props) => {
    if (props.shown !== true) return <span className={str(props, 'dashClassName') ?? 'text-slate-300 dark:text-slate-600'}>—</span>
    return (
      <Badge variant={(str(props, 'variant') ?? 'default') as ComponentProps<typeof Badge>['variant']}>
        {str(props, 'label') ?? ''}
      </Badge>
    )
  },
  'in-nav-cell': (props) => (
    <InNavCell shown={props.shown === true} label={str(props, 'label') ?? ''} />
  ),
  'type-builder-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof TypeBuilderDrawer> | null
    if (!drawer) return null
    return <TypeBuilderDrawer {...drawer} />
  },
  'card-name-cell': (props) => (
    <CardNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      description={(props.description as string | null) ?? null}
    />
  ),
  'viz-cell': (props) => (
    <VizCell vizType={str(props, 'vizType') ?? ''} label={str(props, 'label') ?? ''} />
  ),
  'card-studio': (props) => {
    const studio = props.studio as ComponentProps<typeof CardStudio> | null
    if (!studio) return null
    return <CardStudio {...studio} />
  },
  'dashboard-name-cell': (props) => (
    <DashboardNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      description={(props.description as string | null) ?? null}
    />
  ),
  'new-saved-view': () => <NewViewButton />,
  'view-name-cell': (props) => (
    <ViewNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      description={(props.description as string | null) ?? null}
    />
  ),
  'view-actions-cell': (props) => (
    <ViewActionsCell
      runHref={str(props, 'runHref') ?? ''}
      runLabel={str(props, 'runLabel') ?? ''}
      editHref={str(props, 'editHref') ?? ''}
      editLabel={str(props, 'editLabel') ?? ''}
      canEdit={props.canEdit === true}
    />
  ),
  'view-studio': (props) => {
    const studio = props.studio as ComponentProps<typeof ViewStudio> | null
    if (!studio) return null
    return <ViewStudio {...studio} />
  },
  'save-view': () => <SaveViewButton />,
  'export-menu': (props) => (
    <ExportMenu kind={str(props, 'kind')} params={stringRecord(props, 'params')} baseHref={str(props, 'baseHref')} />
  ),
  'schedule-report': (props) => {
    const definitionId = str(props, 'definitionId')
    if (!definitionId) return null
    return (
      <ScheduleReportButton
        definitionId={definitionId}
        statementParams={stringRecord(props, 'statementParams')}
        historyHref={str(props, 'historyHref')}
      />
    )
  },
}

/**
 * Resolve any field references in a widget's props against the current scope.
 * One level deep — enough for per-item widgets inside `repeat`, and shallow
 * enough that it stays a lookup rather than a traversal language.
 */
export function resolveWidgetProps(
  props: Record<string, unknown> | undefined,
  scope: unknown,
): Record<string, unknown> {
  if (!props) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    out[key] = isFieldRef(value) ? resolvePath(scope, value.$) : value
  }
  return out
}

export class UnknownWidgetError extends Error {
  readonly name = 'UnknownWidgetError'
}

/**
 * Render a slot's widgets. A `when` reference that resolves falsy omits the
 * widget entirely — that is how a spec expresses the native pages' conditional
 * `{x ? <Button/> : null}` without gaining a conditional operator.
 */
export function WidgetSlot({ widgets, scope }: { widgets: WidgetRef[] | undefined; scope: unknown }) {
  if (!widgets || widgets.length === 0) return null
  return (
    <>
      {widgets.map((ref, index) => {
        if (ref.when && !resolvePath(scope, ref.when.$)) return null
        const renderer = WIDGET_REGISTRY[ref.widget]
        if (!renderer) throw new UnknownWidgetError(`unknown widget: ${ref.widget}`)
        // A Fragment, not a wrapper element: the native pages place these
        // widgets as direct children of the slot, and any real element here
        // (even display:contents) is markup the native render does not have.
        return <Fragment key={`${ref.widget}-${index}`}>{renderer(resolveWidgetProps(ref.props, scope))}</Fragment>
      })}
    </>
  )
}

/** Render one widget by name — the `widget` block's renderer. */
export function WidgetBlockView({
  name,
  props,
  scope,
}: {
  name: string
  props: Record<string, unknown>
  scope: unknown
}) {
  const renderer = WIDGET_REGISTRY[name]
  if (!renderer) throw new UnknownWidgetError(`unknown widget: ${name}`)
  return <>{renderer(resolveWidgetProps(props, scope))}</>
}
