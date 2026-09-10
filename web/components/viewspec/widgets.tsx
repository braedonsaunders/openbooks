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
import { KeyRound, Building2, Users, Mail, Activity, Settings, Send, CheckCircle2 } from 'lucide-react'
import { EmailSubjectCell, EmailEvidenceCell } from '../../app/(app)/platform/email-log/sections'
import { VendorComplianceMatrix } from '../../app/(app)/compliance/vendors/Matrix'
import { ReportNameCell } from '../../app/(app)/reports/custom/sections'
import { PartyRolesCell } from '../../app/(app)/parties/sections'
import {
  KindChips,
  ApprovalTabs,
  ApprovalEngineCell,
  SubmittedDocumentCell,
} from '../../app/(app)/approvals/sections'
import { ApprovalsTable } from '../../app/(app)/approvals/ApprovalsTable'
import { DelegationBanner, OutOfOfficeButton } from '../../app/(app)/approvals/DelegationControls'
import { AccountNameCell, AccountRegisterCell } from '../../app/(app)/accounts/sections'
import { AccountsHierarchyTable } from '../../app/(app)/accounts/AccountsHierarchyTable'
import { AccountDrawer } from '../../app/(app)/accounts/AccountDrawer'
import { NewAccountButton } from '../../app/(app)/accounts/NewAccountButton'
import { EntityListSlot } from './entity-list-slot'
import {
  TabNav,
  Metric,
  ReportsCardHeading,
  NarrativeEntry,
  FindingCell,
} from '../../app/(app)/continuous-close/sections'
import { WorkItemDrawer } from '../../app/(app)/continuous-close/WorkItemDrawer'
import { NarrativeDrawer } from '../../app/(app)/continuous-close/NarrativeDrawer'
import { NewPartyButton } from '../../app/(app)/parties/NewPartyButton'
import { NewPartyRedirect } from '../../app/(app)/parties/NewPartyRedirect'
import { PartyDrawer } from '../../app/(app)/parties/PartyDrawer'
import { RelatedTxnSlot } from '../../app/(app)/parties/RelatedTxnSlot'
import { NewReportButton } from '../../app/(app)/reports/custom/NewReportButton'
import { CustomReportActions } from '../../app/(app)/reports/custom/CustomReportActions'
import { MatrixFilters } from '../../app/(app)/compliance/vendors/MatrixFilters'
import { VendorComplianceDrawer } from '../../app/(app)/compliance/vendors/VendorComplianceDrawer'
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
import { ShowInactivesToggle } from '../show-inactives-toggle'
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
    // Icons are components, so the spec names one from a closed map — the same
    // rule the empty state follows.
    const icons: Record<string, ReactNode> = { settings: <Settings size={14} /> }
    const iconKey = str(props, 'iconKey')
    const variant = str(props, 'variant') as ComponentProps<typeof Button>['variant']
    return (
      <Button asChild variant={variant}>
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
  'search-input': (props) => (
    <SearchInput
      placeholder={str(props, 'placeholder')}
      paramKey={str(props, 'paramKey')}
      pageParamKey={str(props, 'pageParamKey')}
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
    const icons: Record<string, ReactNode> = { 'key-round': <KeyRound />, building: <Building2 />, users: <Users />, mail: <Mail />, activity: <Activity />, send: <Send />, 'check-circle': <CheckCircle2 /> }
    const iconKey = str(props, 'icon')
    return (
      <EmptyState
        icon={iconKey ? icons[iconKey] : undefined}
        title={str(props, 'title') ?? ''}
        description={str(props, 'description')}
        action={renderer ? renderer((props.actionProps as Record<string, unknown>) ?? {}) : undefined}
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
  /* --- approvals ---------------------------------------------------------- */
  'out-of-office': (props) => (
    <OutOfOfficeButton users={(props.users as ComponentProps<typeof OutOfOfficeButton>['users']) ?? []} />
  ),
  'delegation-banner': (props) => (
    <DelegationBanner users={(props.users as ComponentProps<typeof DelegationBanner>['users']) ?? []} />
  ),
  'approval-tabs': (props) => (
    <ApprovalTabs tabs={(props.tabs as ComponentProps<typeof ApprovalTabs>['tabs']) ?? []} />
  ),
  'kind-chips': (props) => (
    <KindChips
      chips={(props.chips as ComponentProps<typeof KindChips>['chips']) ?? []}
      clearHref={str(props, 'clearHref') ?? null}
      clearLabel={str(props, 'clearLabel') ?? ''}
    />
  ),
  'approval-engine-cell': (props) => <ApprovalEngineCell name={str(props, 'name') ?? ''} />,
  'submitted-document-cell': (props) => (
    <SubmittedDocumentCell
      documentNumber={str(props, 'documentNumber') ?? ''}
      href={str(props, 'href') ?? null}
    />
  ),
  'approvals-table': (props) => (
    <ApprovalsTable
      rows={(props.rows as ComponentProps<typeof ApprovalsTable>['rows']) ?? []}
      users={(props.users as ComponentProps<typeof ApprovalsTable>['users']) ?? []}
      bulk={props.bulk === true}
      showAssignee={props.showAssignee === true}
      actionsEnabled={props.actionsEnabled === true}
    />
  ),

  /* --- chart of accounts -------------------------------------------------- */
  'new-account': (props) => (
    <NewAccountButton
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
      label={str(props, 'label') ?? ''}
    />
  ),
  'account-name-cell': (props) => (
    <AccountNameCell
      number={str(props, 'number') ?? ''}
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      isSummary={props.isSummary === true}
      inactiveLabel={str(props, 'inactiveLabel') ?? null}
      parentPath={str(props, 'parentPath') ?? null}
    />
  ),
  'account-register-cell': (props) => (
    <AccountRegisterCell
      accountId={str(props, 'accountId') ?? ''}
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      title={str(props, 'title') ?? ''}
    />
  ),
  'accounts-hierarchy': (props) => (
    <AccountsHierarchyTable
      groups={(props.groups as ComponentProps<typeof AccountsHierarchyTable>['groups']) ?? []}
      labels={props.labels as ComponentProps<typeof AccountsHierarchyTable>['labels']}
    />
  ),
  'account-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof AccountDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <AccountDrawer key={remountKey} {...rest} />
  },
  /**
   * The universal entity list. `drawer` and `emptyAction` name widgets rather
   * than carrying components — a spec cannot express JSX, so the indirection is
   * the same one the empty state already uses for its action.
   */
  'entity-list-view': (props) => {
    const slot = (value: unknown) => {
      if (!value || typeof value !== 'object') return undefined
      const ref = value as { widget?: string; props?: Record<string, unknown> }
      const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
      if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
      return renderer ? renderer(ref.props ?? {}) : undefined
    }
    return (
      <EntityListSlot
        recordType={str(props, 'recordType') ?? ''}
        sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
        drawer={slot(props.drawer)}
        emptyAction={slot(props.emptyAction)}
      />
    )
  },

  /* --- continuous close -------------------------------------------------- */
  'tab-nav': (props) => (
    <TabNav
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      tabs={(props.tabs as ComponentProps<typeof TabNav>['tabs']) ?? []}
    />
  ),
  'metric-tile': (props) => (
    <Metric
      label={str(props, 'label') ?? ''}
      value={Number(props.value ?? 0)}
      locale={str(props, 'locale') ?? 'en'}
      tone={str(props, 'tone')}
    />
  ),
  'reports-card-heading': (props) => (
    <ReportsCardHeading
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
    />
  ),
  'narrative-entry': (props) => (
    <NarrativeEntry
      narrative={(props.narrative as Record<string, unknown>) ?? {}}
      href={str(props, 'href') ?? ''}
      labels={props.labels as ComponentProps<typeof NarrativeEntry>['labels']}
    />
  ),
  'finding-cell': (props) => (
    <FindingCell
      title={str(props, 'title') ?? ''}
      href={str(props, 'href') ?? ''}
      summary={str(props, 'summary') ?? ''}
    />
  ),
  'work-item-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof WorkItemDrawer> | null
    if (!drawer) return null
    return <WorkItemDrawer {...drawer} />
  },
  'narrative-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof NarrativeDrawer> | null
    if (!drawer) return null
    return <NarrativeDrawer {...drawer} />
  },

  'new-party': () => <NewPartyButton />,
  'new-party-redirect': () => <NewPartyRedirect />,
  'party-roles-cell': (props) => (
    <PartyRolesCell badges={(props.badges as ComponentProps<typeof PartyRolesCell>['badges']) ?? []} />
  ),
  /** The remount key rides along as a prop: switching parties must reset the
   *  drawer's client state, and a widget at a fixed position would otherwise
   *  be reused. */
  'party-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof PartyDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <PartyDrawer key={remountKey} {...rest} />
  },
  'party-txn-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof RelatedTxnSlot> | null
    if (!drawer) return null
    return <RelatedTxnSlot {...drawer} />
  },
  'show-inactives-toggle': (props) => (
    <ShowInactivesToggle
      basePath={str(props, 'basePath') ?? ''}
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  'new-report': () => <NewReportButton />,
  'report-name-cell': (props) => (
    <ReportNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      summary={str(props, 'summary') ?? ''}
    />
  ),
  'custom-report-actions': (props) => (
    <CustomReportActions
      id={str(props, 'id') ?? ''}
      kind={str(props, 'kind') === 'built_in' ? 'built_in' : 'custom'}
      canCreate={props.canCreate === true}
    />
  ),
  'compliance-matrix': (props) => (
    <VendorComplianceMatrix
      rows={props.rows as ComponentProps<typeof VendorComplianceMatrix>['rows']}
      columns={props.columns as ComponentProps<typeof VendorComplianceMatrix>['columns']}
      classId={(props.classId as string | null) ?? null}
      stateFilter={(props.stateFilter as string | null) ?? null}
      labels={props.labels as ComponentProps<typeof VendorComplianceMatrix>['labels']}
    />
  ),
  'matrix-filters': (props) => (
    <MatrixFilters
      classes={props.classes as ComponentProps<typeof MatrixFilters>['classes']}
      classId={(props.classId as string | null) ?? null}
      state={(props.state as string | null) ?? null}
    />
  ),
  'vendor-compliance-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof VendorComplianceDrawer> | null
    if (!drawer) return null
    return <VendorComplianceDrawer {...drawer} />
  },
  'email-subject-cell': (props) => (
    <EmailSubjectCell subject={str(props, 'subject') ?? ''} category={str(props, 'category') ?? ''} />
  ),
  'email-evidence-cell': (props) => (
    <EmailEvidenceCell summary={str(props, 'summary') ?? ''} error={str(props, 'error') ?? ''} />
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
