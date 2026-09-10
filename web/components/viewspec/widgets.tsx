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
import { RecordListSlot } from './record-list-slot'
import { NewSetupButton } from '../../app/(app)/admin/setup/[entity]/SetupDrawer'
import { TaxReturnLibrary } from '../../app/(app)/admin/setup/[entity]/TaxReturnLibrary'
import {
  SetupBadgeLinkCell,
  SetupCloseSlot,
  SetupCodeCell,
  SetupCompanySlot,
  SetupDescription,
  SetupDrawerSlot,
  SetupFxSlot,
} from '../../app/(app)/admin/setup/[entity]/sections'
import { JournalDraftsPanel } from '../../app/(app)/journal/sections'
import { JournalDrawer } from '../../app/(app)/journal/JournalDrawer'
import { NewJournalButton } from '../../app/(app)/journal/NewJournalButton'
import { AssetsTabs, AssetsDocLink, AssetsEquipmentLink } from '../../app/(app)/assets/sections'
import { NewAssetButton } from '../../app/(app)/assets/NewAssetButton'
import { NewAssetRedirect } from '../../app/(app)/assets/NewAssetRedirect'
import { RunDepreciationButton } from '../../app/(app)/assets/RunDepreciationButton'
import { AssetDrawer } from '../../app/(app)/assets/AssetDrawer'
import { TaxPoolsView } from '../../app/(app)/assets/tax-pools/TaxPoolsView'
import { Gauge, History, Camera } from 'lucide-react'
import { DateRangeFilter } from '../date-range-filter'
import {
  ForecastSectionHeading,
  ForecastKpiGroup,
  ForecastFilters,
  ManageQuotasButton,
  QuotaEmptyAction,
  ForecastSnapshotAction,
} from '../../app/(app)/crm/forecasts/sections'
import { NewRecordButton } from '../../app/(app)/records/[typeKey]/NewRecordButton'
import { RecordDrawer } from '../../app/(app)/records/[typeKey]/RecordDrawer'
import {
  AccountStats,
  UnmatchedCountCell,
  ReconActionCell,
} from '../../app/(app)/banking/[accountId]/sections'
import { ImportStatementButton } from '../../app/(app)/banking/[accountId]/ImportStatementButton'
import { StartReconciliationButton } from '../../app/(app)/banking/[accountId]/StartReconciliationButton'
import { StatementDrawer } from '../../app/(app)/banking/[accountId]/StatementDrawer'
import { DocumentDrawer } from '../document-drawer'
import { DocumentRowActions } from '../document-row-actions'
import { NewDocumentButton } from '../new-document-button'
import { ScanLine } from 'lucide-react'
import { PaymentLinksPanel } from '../payment-links-panel'
import { DOC_KINDS } from '../../lib/document-kinds'
import { SearchSelectFilter } from '../filter-bar'
import { FormDesigner, NewFormButton } from '../../app/(app)/admin/customization/FormDesigner'
import {
  ListViewDesigner,
  NewViewButton as NewListViewButton,
} from '../../app/(app)/admin/customization/ListViewDesigner'
import {
  CustomizationTabs,
  FormDefaultCell,
  ViewScopeCell,
} from '../../app/(app)/admin/customization/sections'
import { BookOpen } from 'lucide-react'
import { NewProjectButton } from '../../app/(app)/projects/NewProjectButton'
import { NewProjectRedirect } from '../../app/(app)/projects/NewProjectRedirect'
import { ProjectDrawer } from '../../app/(app)/projects/ProjectDrawer'
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
import { RelatedTxnSlot } from './related-txn-slot'
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
    const icons: Record<string, ReactNode> = { 'key-round': <KeyRound />, building: <Building2 />, users: <Users />, mail: <Mail />, activity: <Activity />, send: <Send />, 'check-circle': <CheckCircle2 />, gauge: <Gauge />, camera: <Camera /> }
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

  /* --- customization designer --------------------------------------------- */
  'customization-tabs': (props) => (
    <CustomizationTabs
      formsHref={str(props, 'formsHref') ?? ''}
      viewsHref={str(props, 'viewsHref') ?? ''}
      formsLabel={str(props, 'formsLabel') ?? ''}
      viewsLabel={str(props, 'viewsLabel') ?? ''}
      formsActive={props.formsActive === true}
      showForms={props.showForms !== false}
    />
  ),
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
  'form-default-cell': (props) => (
    <FormDefaultCell
      showDefault={props.showDefault === true}
      defaultLabel={str(props, 'defaultLabel') ?? ''}
      rolesLabel={str(props, 'rolesLabel') ?? ''}
    />
  ),
  'view-scope-cell': (props) => (
    <ViewScopeCell
      scopeLabel={str(props, 'scopeLabel') ?? ''}
      scopeVariant={str(props, 'scopeVariant') === 'default' ? 'default' : 'secondary'}
      showDefault={props.showDefault === true}
      defaultLabel={str(props, 'defaultLabel') ?? ''}
    />
  ),
  'new-form': (props) => <NewFormButton recordType={str(props, 'recordType') ?? ''} />,
  'new-view': (props) => <NewListViewButton recordType={str(props, 'recordType') ?? ''} />,
  /** Not `link-button`: that is a solid Button with no icon; this is the
   *  outline+icon treatment the designer header actually renders. */
  'docs-link-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={href as never}>
          <BookOpen size={14} aria-hidden />
          {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  'form-drawer': (props) => (
    <FormDesigner
      recordType={str(props, 'recordType') ?? ''}
      def={(props.def as ComponentProps<typeof FormDesigner>['def']) ?? null}
      headerDefs={(props.headerDefs as ComponentProps<typeof FormDesigner>['headerDefs']) ?? null}
      lineDefs={(props.lineDefs as ComponentProps<typeof FormDesigner>['lineDefs']) ?? null}
      duplicateFrom={(props.duplicateFrom as ComponentProps<typeof FormDesigner>['duplicateFrom']) ?? null}
      subsidiaryEnabled={props.subsidiaryEnabled === true}
    />
  ),
  'list-view-drawer': (props) => (
    <ListViewDesigner
      recordType={str(props, 'recordType') ?? ''}
      def={(props.def as ComponentProps<typeof ListViewDesigner>['def']) ?? null}
      canManageOrg={props.canManageOrg === true}
      userId={str(props, 'userId') ?? ''}
      showInListDefs={(props.showInListDefs as ComponentProps<typeof ListViewDesigner>['showInListDefs']) ?? []}
      filterOptions={(props.filterOptions as ComponentProps<typeof ListViewDesigner>['filterOptions']) ?? {}}
      inventoryEnabled={props.inventoryEnabled === true}
      crmEnabled={props.crmEnabled === true}
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

  /* --- setup workspace ------------------------------------------------------ */
  /** The inline "Learn more" link (with its significant leading space) appears
   *  only when the entity declares a doc slug — a conditional pair inside one
   *  paragraph, so a component. */
  'setup-description': (props) => (
    <SetupDescription
      description={str(props, 'description') ?? ''}
      docHref={(props.docHref as string | null) ?? null}
      learnMore={str(props, 'learnMore') ?? ''}
    />
  ),
  /** A client component that pushes `?row=new` — not a link, so `link-button`
   *  cannot stand in for it. */
  'new-setup-button': (props) => (
    <NewSetupButton entityKey={str(props, 'entityKey') ?? ''} label={str(props, 'label') ?? ''} />
  ),
  'tax-return-library': (props) => (
    <TaxReturnLibrary
      packs={(props.packs as ComponentProps<typeof TaxReturnLibrary>['packs']) ?? []}
      installedCodes={(props.installedCodes as string[]) ?? []}
      open={props.open === true}
      openHref={str(props, 'openHref') ?? ''}
      closeHref={str(props, 'closeHref') ?? ''}
    />
  ),
  'setup-code-cell': (props) => (
    <SetupCodeCell
      text={str(props, 'text') ?? ''}
      shown={props.shown === true}
      href={str(props, 'href')}
    />
  ),
  'setup-badge-link-cell': (props) => (
    <SetupBadgeLinkCell
      label={str(props, 'label') ?? ''}
      variant={(str(props, 'variant') ?? 'default') as ComponentProps<typeof SetupBadgeLinkCell>['variant']}
      href={str(props, 'href') ?? ''}
    />
  ),
  /** The drawer, its nested sub-tabs and its stacked child drawers arrive
   *  through a slot that re-derives Authz; the spec carries only the entity
   *  key and the current URL. */
  'setup-drawer': (props) => (
    <SetupDrawerSlot
      entityKey={str(props, 'entityKey') ?? ''}
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  'setup-company': () => <SetupCompanySlot />,
  'setup-close': (props) => (
    <SetupCloseSlot
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      canReopen={props.canReopen === true}
    />
  ),
  'setup-fx': () => <SetupFxSlot />,

  /* --- journal ------------------------------------------------------------- */
  'journal-drafts': (props) => (
    <JournalDraftsPanel
      heading={str(props, 'heading') ?? ''}
      drafts={(props.drafts as ComponentProps<typeof JournalDraftsPanel>['drafts']) ?? []}
    />
  ),
  /** No remount key: the native page renders this drawer keyless and resets
   *  its state from an effect on the document id. */
  'journal-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof JournalDrawer> | null
    if (!drawer) return null
    return <JournalDrawer {...drawer} />
  },
  'new-journal': () => <NewJournalButton />,

  /* --- fixed assets --------------------------------------------------------- */
  'assets-tabs': (props) => (
    <AssetsTabs tabs={(props.tabs as ComponentProps<typeof AssetsTabs>['tabs']) ?? []} />
  ),
  'assets-doc-link': (props) => <AssetsDocLink label={str(props, 'label') ?? ''} />,
  'assets-equipment-link': (props) => <AssetsEquipmentLink label={str(props, 'label') ?? ''} />,
  'new-asset': () => <NewAssetButton />,
  'new-asset-redirect': () => <NewAssetRedirect />,
  'run-depreciation': (props) => (
    <RunDepreciationButton
      books={(props.books as ComponentProps<typeof RunDepreciationButton>['books']) ?? []}
    />
  ),
  'asset-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof AssetDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <AssetDrawer key={remountKey} {...rest} />
  },
  'tax-pools': (props) => (
    <TaxPoolsView
      canRun={props.canRun === true}
      canConfigure={props.canConfigure === true}
      regimes={(props.regimes as ComponentProps<typeof TaxPoolsView>['regimes']) ?? []}
      defaultTaxYear={typeof props.defaultTaxYear === 'number' ? props.defaultTaxYear : 0}
    />
  ),

  /* --- sales forecasts ------------------------------------------------------ */
  'forecast-snapshot-button': (props) => (
    <ForecastSnapshotAction
      periodStart={str(props, 'periodStart') ?? ''}
      periodEnd={str(props, 'periodEnd') ?? ''}
      ownerUserId={(props.ownerUserId as string | null) ?? null}
      salesTeamId={(props.salesTeamId as string | null) ?? null}
    />
  ),
  'manage-quotas-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <ManageQuotasButton
        href={href}
        label={str(props, 'label') ?? ''}
        ariaLabel={str(props, 'ariaLabel') ?? ''}
      />
    )
  },
  /** The empty-quota CTA is the SOLID SMALL button; `link-button` is the
   *  default size, so reusing it would be a visible difference. */
  'quota-empty-action': (props) => (
    <QuotaEmptyAction
      href={str(props, 'href') ?? ''}
      label={str(props, 'label') ?? ''}
      size={str(props, 'size') ?? 'sm'}
    />
  ),
  'date-range-filter': (props) => (
    <DateRangeFilter
      fromKey={str(props, 'fromKey') ?? 'from'}
      toKey={str(props, 'toKey') ?? 'to'}
      fromLabel={str(props, 'fromLabel') ?? ''}
      toLabel={str(props, 'toLabel') ?? ''}
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
  'forecast-kpi-group': (props) => (
    <ForecastKpiGroup
      currency={str(props, 'currency') ?? ''}
      items={(props.items as ComponentProps<typeof ForecastKpiGroup>['items']) ?? []}
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

  /* --- custom record modules ----------------------------------------------- */
  'new-record': (props) => (
    <NewRecordButton typeKey={str(props, 'typeKey') ?? ''} typeName={str(props, 'typeName') ?? ''} />
  ),
  'record-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof RecordDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <RecordDrawer key={remountKey} {...rest} />
  },

  /* --- bank account workspace ---------------------------------------------- */
  /** One widget, not four stat tiles: the native tiles are plain bordered divs
   *  with conditional content, while `stat-tile` renders the cockpit tile. */
  'account-stats': (props) => (
    <AccountStats
      glBalanceLabel={str(props, 'glBalanceLabel') ?? ''}
      glBalanceValue={str(props, 'glBalanceValue') ?? ''}
      reconciledThroughLabel={str(props, 'reconciledThroughLabel') ?? ''}
      reconciledThrough={(props.reconciledThrough as string | null) ?? null}
      neverLabel={str(props, 'neverLabel') ?? ''}
      unmatchedLinesLabel={str(props, 'unmatchedLinesLabel') ?? ''}
      unmatchedLinesValue={str(props, 'unmatchedLinesValue') ?? ''}
      reconciliationLabel={str(props, 'reconciliationLabel') ?? ''}
      reconBadgeLabel={str(props, 'reconBadgeLabel') ?? ''}
      reconBadgeVariant={(props.reconBadgeVariant as 'warning' | 'secondary') ?? 'secondary'}
    />
  ),
  'unmatched-count-cell': (props) => (
    <UnmatchedCountCell display={str(props, 'display') ?? ''} isZero={props.isZero === true} />
  ),
  'recon-action-cell': (props) => (
    <ReconActionCell href={str(props, 'href') ?? ''} label={str(props, 'label') ?? ''} />
  ),
  'import-statement': (props) => <ImportStatementButton accountId={str(props, 'accountId') ?? ''} />,
  'start-reconciliation': (props) => (
    <StartReconciliationButton
      accountId={str(props, 'accountId') ?? ''}
      openReconciliationId={(props.openReconciliationId as string | null) ?? null}
      glBalance={str(props, 'glBalance') ?? ''}
    />
  ),
  /** The statement drawer owns its own sl* search/sort/pagination internally,
   *  so the whole payload passes through — the api-key-drawer precedent. */
  'statement-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof StatementDrawer> | null
    if (!drawer) return null
    return <StatementDrawer {...drawer} />
  },

  /* --- documents lists ----------------------------------------------------- */
  'new-document': (props) => (
    <NewDocumentButton
      items={(props.items as ComponentProps<typeof NewDocumentButton>['items']) ?? []}
      basePath={str(props, 'basePath') ?? ''}
      triggerLabel={str(props, 'triggerLabel') ?? ''}
      creatingLabel={str(props, 'creatingLabel') ?? ''}
      failedLabel={str(props, 'failedLabel') ?? ''}
    />
  ),
  /**
   * The universal record list. `drawer` and `emptyAction` name widgets, one or
   * several, exactly as `entity-list-view` does. `rowActions` names ONE widget
   * rendered per row: `renderRowActions` is a function, and a spec can never
   * carry a function, so the registry builds it from the ref here.
   */
  'record-list-view': (props) => {
    const one = (value: unknown, key: number) => {
      if (!value || typeof value !== 'object') return null
      const ref = value as { widget?: string; props?: Record<string, unknown> }
      const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
      if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
      return renderer ? <Fragment key={key}>{renderer(ref.props ?? {})}</Fragment> : null
    }
    const slot = (value: unknown) => {
      if (Array.isArray(value)) {
        const rendered = value.map(one).filter(Boolean)
        return rendered.length > 0 ? <>{rendered}</> : undefined
      }
      return one(value, 0) ?? undefined
    }
    const rowActionsRef =
      props.rowActions && typeof props.rowActions === 'object'
        ? (props.rowActions as { widget?: string; props?: Record<string, unknown> })
        : undefined
    const rowActionsRenderer = rowActionsRef?.widget ? WIDGET_REGISTRY[rowActionsRef.widget] : undefined
    if (rowActionsRef?.widget && !rowActionsRenderer) throw new UnknownWidgetError(rowActionsRef.widget)
    return (
      <RecordListSlot
        recordType={str(props, 'recordType') ?? ''}
        basePath={str(props, 'basePath') ?? ''}
        sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
        drawer={slot(props.drawer)}
        emptyAction={slot(props.emptyAction)}
        renderRowActions={
          rowActionsRenderer
            ? (row) =>
                rowActionsRenderer({
                  ...(rowActionsRef?.props ?? {}),
                  id: row.id,
                  status: row.status,
                  kind: row.kind,
                })
            : undefined
        }
      />
    )
  },
  /** The remount key rides along as a prop: switching documents must reset the
   *  drawer's client state, and a widget at a fixed position would otherwise
   *  be reused (same as `account-drawer` / `party-drawer`). */
  'document-drawer': (props) => {
    const drawer = props.drawer as
      | (ComponentProps<typeof DocumentDrawer> & {
          remountKey: string
          paymentLinks?: { documentId: string; canManage: boolean } | null
        })
      | null
    if (!drawer) return null
    const { remountKey, paymentLinks, ...rest } = drawer
    return (
      <DocumentDrawer
        key={remountKey}
        {...rest}
        afterContent={
          paymentLinks ? (
            <PaymentLinksPanel documentId={paymentLinks.documentId} canManage={paymentLinks.canManage} />
          ) : null
        }
      />
    )
  },
  /** `config` is re-derived from the row's kind via the static DOC_KINDS map;
   *  the loader never ships a registry entry as data. */
  'document-row-actions': (props) => (
    <DocumentRowActions
      id={String(props.id ?? '')}
      status={String(props.status ?? '')}
      config={DOC_KINDS[String(props.kind ?? '')]!}
      openHref={`${str(props, 'basePath') ?? ''}?doc=${String(props.id ?? '')}`}
    />
  ),

  /* --- projects ----------------------------------------------------------- */
  'new-project': () => <NewProjectButton />,
  'new-project-redirect': () => <NewProjectRedirect />,
  'project-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof ProjectDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <ProjectDrawer key={remountKey} {...rest} />
  },

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
    const one = (value: unknown, key: number) => {
      if (!value || typeof value !== 'object') return null
      const ref = value as { widget?: string; props?: Record<string, unknown> }
      const renderer = ref.widget ? WIDGET_REGISTRY[ref.widget] : undefined
      if (ref.widget && !renderer) throw new UnknownWidgetError(ref.widget)
      return renderer ? <Fragment key={key}>{renderer(ref.props ?? {})}</Fragment> : null
    }
    // A slot may name one widget or several — a project list's drawer slot
    // holds a create-redirect, the record flyout and a transaction flyout, the
    // same fragment the native page passes.
    const slot = (value: unknown) => {
      if (Array.isArray(value)) {
        const rendered = value.map(one).filter(Boolean)
        return rendered.length > 0 ? <>{rendered}</> : undefined
      }
      return one(value, 0) ?? undefined
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
  /** The related-transaction drawer, for any record that opens one. */
  'related-txn-drawer': (props) => {
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
