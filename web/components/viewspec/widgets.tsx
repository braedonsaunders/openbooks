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
import { SetupSectionSlot } from './setup-section-slot'
import {
  PlatformUserHeader,
  GrantActingCell,
  GrantControlCell,
  NoGrantsBody,
  IdentityRecordCard,
} from '../../app/(app)/platform/users/[id]/sections'
import { AdminRolesTable } from '../../app/(app)/admin/roles/sections'
import { NewRoleButton } from '../../app/(app)/admin/roles/RoleEditor'
import { AuditRowsTable, AuditEventFlyout, AuditDocsLink } from '../../app/(app)/admin/audit/sections'
import { AccountsRosterPanel } from '../../app/(app)/banking/AccountsRoster'
import { BankingAttentionList } from '../../app/(app)/banking/sections'
import { ListChecks, ShieldCheck, ScrollText } from 'lucide-react'
import { AnalyticsHub } from '../../app/(app)/analytics/AnalyticsHub'
import { ReportsHub } from '../../app/(app)/reports/ReportsHub'
import { QueryConsole } from '../../app/(app)/query/sections'
import { HealthHero } from '../../app/(app)/accounting/sections'
import { RelationshipsSection, ArPulse as CustomerArPulse } from '../../app/(app)/customers/sections'
import { AdminHubCard } from '../../app/(app)/admin/sections'
import { BuildHubCard } from '../../app/(app)/admin/build/sections'
import { MatchWorkspace } from '../../app/(app)/banking/match/MatchWorkspace'
import { BalanceCheck } from '../../app/(app)/reports/balance-sheet/sections'
import { Library, ArrowLeft } from 'lucide-react'
import { AppsToolbar, AppDrawer } from '../../app/(app)/admin/apps/AppDrawer'
import { CrmSetupWorkspace } from '../../app/(app)/admin/setup/crm/CrmSetupWorkspace'
import { AppKeyCell } from '../../app/(app)/admin/apps/sections'
import { CaptureList } from '../../app/(app)/ap/capture/sections'
import { CaptureReviewDrawer } from '../../app/(app)/ap/capture/CaptureReviewDrawer'
import { CaptureUploadButton } from '../../app/(app)/ap/capture/CaptureUploadButton'
import { ProjectProfitabilityTable } from '../../app/(app)/reports/project-profitability/ProjectProfitabilityTable'
import {
  OverheadApplicationTabSlot,
  OverheadLifecycleTabSlot,
  OverheadModelBody,
  OverheadModelHeader,
  OverheadRatesTabSlot,
} from '../../app/(app)/admin/setup/overhead/sections'
import { SavedViewHeader, SavedViewMeta } from '../../app/(app)/knowledge/views/[id]/sections'
import {
  SetupReadinessCheckCard,
  SetupReadinessHero,
} from '../../app/(app)/admin/setup/readiness/sections'
import { ResultView } from '../../app/(app)/reports/custom/ResultView'
import { PaperView } from '../../app/(app)/reports/PaperView'
import {
  FlowNameCell,
  FlowLastRunCell,
  FlowRowActionsCell,
  NewFlowButton as NewFlowListButton,
} from '../../app/(app)/admin/flows/sections'
import { LaborCostingWorkspace } from '../../app/(app)/admin/setup/labor-costing/LaborCostingWorkspace'
import {
  LaborPricingHeading,
  LaborPricingView,
} from '../../app/(app)/admin/setup/labor-pricing/sections'
import { RunWizard } from '../../app/(app)/payroll/runs/[id]/RunWizard'
import {
  PayrollSetupHeader,
  PayrollSetupBanner,
  PayrollSetupTabs,
  PacksTabSlot,
  AccountsTabSlot,
  PaydayTabSlot,
  RatesTabSlot,
  WorkSchedulesTabSlot,
  DerivedPreviewTabSlot,
  HolidaysTabSlot,
  HolidayCalendarTabSlot,
} from '../../app/(app)/admin/setup/payroll/sections'
import { Sparkles } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { PspSettlementsWorkspace } from '../../app/(app)/banking/psp-settlements/sections'
import {
  PayrollChecklistBanner,
  PayrollPreviousRun,
  PayrollManageLinks,
  PayrollScheduleList,
  type PayrollPreviousRunProps,
  type PayrollScheduleListProps,
} from '../../app/(app)/payroll/sections'
import {
  BlockedBillsSection,
  ComplianceSetupBanner,
  ExpiringVendorsSection,
  ReadinessPanel,
  WaiversPanel,
} from '../../app/(app)/compliance/sections'
import {
  TaxFilingDrawer,
  TaxHistoryTable,
  TaxPageHeader,
  TaxPageShell,
  TaxPreparePanel,
  TaxTabPanels,
  TaxTabs,
} from '../../app/(app)/tax/sections'
import { AdminUsersTable } from '../../app/(app)/admin/users/sections'
import { PaymentsSectionSlot, RunsSectionSlot } from './payments-slots'
import { ViewTabs as PaymentsViewTabs } from '../../app/(app)/payments/sections'
import { ReceiptsViewTabs } from '../../app/(app)/receipts/sections'
import { NewPaymentButton } from '../../app/(app)/payments/NewPaymentButton'
import { Plus } from 'lucide-react'
import { FolderTree } from '../../app/(app)/documents/FolderTree'
import { FileList } from '../../app/(app)/documents/FileList'
import { FileDrawer } from '../../app/(app)/documents/FileDrawer'
import { FolderDrawer } from '../../app/(app)/documents/FolderDrawer'
import { UploadButton } from '../../app/(app)/documents/UploadButton'
import { NewFolderButton } from '../../app/(app)/documents/NewFolderButton'
import { DocumentsActions, DocumentsBreadcrumb } from '../../app/(app)/documents/sections'
import { BankFeedPanel } from '../../app/(app)/banking/imports/sections'
import { NewBudgetButton } from '../../app/(app)/budgets/NewBudgetButton'
import { BudgetDrawer } from '../../app/(app)/budgets/BudgetDrawer'
import { NewRunButton } from '../../app/(app)/payroll/_ui/NewRunButton'
import { FieldTicketDrawer } from '../../app/(app)/field-tickets/FieldTicketDrawer'
import { NewRuleButton, RunRulesButton, RuleDrawer } from '../../app/(app)/banking/rules/RuleDrawer'
import { ArrowUpRight } from 'lucide-react'
import { WeeklyGrid } from '../../app/(app)/timesheets/WeeklyGrid'
import { ItemDrawer } from '../../app/(app)/items/ItemDrawer'
import { NewItemButton } from '../../app/(app)/items/NewItemButton'
import { NewItemRedirect } from '../../app/(app)/items/NewItemRedirect'
import { NewMovementButton } from '../../app/(app)/inventory/NewMovementButton'
import { InventoryActionDrawer } from '../../app/(app)/inventory/InventoryActionDrawer'
import { CrmNewButton } from '../../app/(app)/crm/CrmNewButton'
import { OpportunityDrawer } from '../../app/(app)/crm/OpportunityDrawer'
import { NewExpenseButton } from '../../app/(app)/expenses/NewExpenseButton'
import { ExpenseDrawer } from '../../app/(app)/expenses/ExpenseDrawer'
import { ExpenseActions } from '../../app/(app)/expenses/ExpenseActions'
import { buildListDrawerHref } from '../../lib/list-params'
import {
  CloseActionCell,
  CloseReadinessCell,
  SingleBookLabel,
} from '../../app/(app)/close/sections'
import { NewOrderButton } from '../../app/(app)/_order/NewOrderButton'
import { NewOrderRedirect } from '../../app/(app)/_order/NewOrderRedirect'
import { OrderDrawer } from '../../app/(app)/_order/OrderDrawer'
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
    const icons: Record<string, ReactNode> = { 'key-round': <KeyRound />, building: <Building2 />, users: <Users />, mail: <Mail />, activity: <Activity />, send: <Send />, 'check-circle': <CheckCircle2 />, gauge: <Gauge />, camera: <Camera />, 'shield-check': <ShieldCheck />, 'scroll-text': <ScrollText /> }
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

  /* --- platform user record --------------------------------------------------- */
  //
  // Every entry here exists because a bound SERVER ACTION is involved. A bound
  // action is a capability, not data, so the widget takes ids and binds the
  // action itself — the spec says which user, the host decides what may be
  // done to them.
  'platform-user-header': (props) => (
    <PlatformUserHeader
      userId={str(props, 'userId') ?? ''}
      name={str(props, 'name') ?? ''}
      subtitle={str(props, 'subtitle') ?? ''}
      isActive={props.isActive === true}
      isSuperAdmin={props.isSuperAdmin === true}
      isSelf={props.isSelf === true}
      backHref={str(props, 'backHref') ?? '/platform/users'}
      backLabel={str(props, 'backLabel') ?? ''}
    />
  ),
  'grant-acting-cell': (props) => (
    <GrantActingCell name={str(props, 'name') ?? ''} email={str(props, 'email') ?? ''} />
  ),
  'grant-control-cell': (props) => (
    <GrantControlCell grantId={str(props, 'grantId') ?? ''} isActive={props.isActive === true} />
  ),
  'no-grants-body': () => <NoGrantsBody />,
  'identity-record-card': (props) => (
    <IdentityRecordCard
      title={str(props, 'title') ?? ''}
      facts={(props.facts as ComponentProps<typeof IdentityRecordCard>['facts']) ?? []}
    />
  ),

  /* --- org roles ------------------------------------------------------------- */
  /** Same doctrine as `admin-users-table`: the native page hand-rolls a plain
   *  `<table>` the spec's table vocabulary cannot name, so one component
   *  serves both render paths. */
  'admin-roles-table': (props) => (
    <AdminRolesTable
      roles={(props.roles as ComponentProps<typeof AdminRolesTable>['roles']) ?? []}
      subsidiaries={
        (props.subsidiaries as ComponentProps<typeof AdminRolesTable>['subsidiaries']) ?? null
      }
      basePath={str(props, 'basePath') ?? '/admin/roles'}
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
      sort={str(props, 'sort') ?? 'name'}
      dir={str(props, 'dir') === 'desc' ? 'desc' : 'asc'}
      labels={props.labels as ComponentProps<typeof AdminRolesTable>['labels']}
    />
  ),
  'new-role': (props) => (
    <NewRoleButton
      subsidiaries={(props.subsidiaries as ComponentProps<typeof NewRoleButton>['subsidiaries']) ?? null}
    />
  ),

  /* --- audit log ------------------------------------------------------------- */
  /** Not `docs-link-button`: that one is a 14px icon with no space before the
   *  label, this one a 15px icon with one. Same-looking buttons that are not
   *  the same button. */
  'audit-docs-link': (props) => (
    <AuditDocsLink href={str(props, 'href') ?? ''} label={str(props, 'label') ?? ''} />
  ),
  'audit-rows-table': (props) => (
    <AuditRowsTable
      rows={(props.rows as ComponentProps<typeof AuditRowsTable>['rows']) ?? []}
      selectedId={
        (str(props, 'selectedId') ?? undefined) as ComponentProps<typeof AuditRowsTable>['selectedId']
      }
    />
  ),
  'audit-event-drawer': (props) => {
    const drawer = props.drawer as {
      event: ComponentProps<typeof AuditEventFlyout>['event']
      closeHref: string
    } | null
    if (!drawer) return null
    return <AuditEventFlyout event={drawer.event} closeHref={drawer.closeHref} />
  },

  /* --- banking cockpit ------------------------------------------------------- */
  /** A widget, not a slot: the LOADER already did the roster's server work and
   *  passes the prefs through as data, so no org id, user id or Authz crosses
   *  the spec. Persistence rides the session cookie inside the component. */
  'banking-roster': (props) => (
    <AccountsRosterPanel
      accounts={props.accounts as ComponentProps<typeof AccountsRosterPanel>['accounts']}
      totalCash={Number(props.totalCash ?? 0)}
      totalCards={Number(props.totalCards ?? 0)}
      layoutPrefs={props.layoutPrefs as ComponentProps<typeof AccountsRosterPanel>['layoutPrefs']}
    />
  ),
  /** A conditional PAIR — a count label when there is unmatched activity, a
   *  plain one when clean — so the choice lives here, not in the spec. */
  'banking-match': (props) => (
    <Button
      variant={(str(props, 'variant') ?? 'outline') as ComponentProps<typeof Button>['variant']}
      asChild
    >
      <Link href={(str(props, 'href') ?? '/banking/match') as never}>
        <ListChecks size={14} />
        {props.showCount === true ? (str(props, 'countLabel') ?? '') : (str(props, 'label') ?? '')}
      </Link>
    </Button>
  ),
  'banking-attention-list': (props) => (
    <BankingAttentionList
      items={(props.items as ComponentProps<typeof BankingAttentionList>['items']) ?? []}
      allClear={str(props, 'allClear') ?? ''}
    />
  ),

  /* --- launchers and consoles ------------------------------------------------ */
  /** Both are whole client components that own their own search, icon maps and
   *  editor state. Decomposing either would reimplement it, not compose it. */
  'analytics-hub': (props) => (
    <AnalyticsHub
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      groups={(props.groups as ComponentProps<typeof AnalyticsHub>['groups']) ?? []}
    />
  ),
  'reports-hub': (props) => (
    <ReportsHub
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      groups={(props.groups as ComponentProps<typeof ReportsHub>['groups']) ?? []}
      canCreate={props.canCreate === true}
    />
  ),
  'query-console': () => <QueryConsole />,

  /* --- accounting cockpit ---------------------------------------------------- */
  'health-hero': (props) => (
    <HealthHero
      gaugeValue={typeof props.gaugeValue === 'number' ? props.gaugeValue : 0}
      gaugeLabel={str(props, 'gaugeLabel') ?? ''}
      categories={props.categories as ComponentProps<typeof HealthHero>['categories']}
      ratios={props.ratios as ComponentProps<typeof HealthHero>['ratios']}
      ratioLabels={props.ratioLabels as ComponentProps<typeof HealthHero>['ratioLabels']}
      fullAnalysisLabel={str(props, 'fullAnalysisLabel') ?? ''}
    />
  ),

  /** The build hub's card. NOT `admin-hub-card`: the shells match but the icon
   *  maps are disjoint and the fallbacks differ, so each hub keeps its own. */
  'build-hub-card': (props) => (
    <BuildHubCard
      href={str(props, 'href') ?? '#'}
      iconKey={str(props, 'iconKey') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      accent={
        (['teal', 'violet', 'amber', 'sky'] as const).find((a) => a === str(props, 'accent')) ??
        'teal'
      }
    />
  ),

  /** The accounting-equation check: a conditional pair, so the loader decides
   *  and the component renders the decision. */
  /** The generic tabular report paper: it owns the chrome, the column
   *  alignment and the money formatting for any report shaped as groups of
   *  rows. The loader assembles the data; this places the component. */
  'paper-view': (props) => (
    <PaperView
      company={str(props, 'company') ?? ''}
      currency={str(props, 'currency')}
      emptyLabel={str(props, 'emptyLabel') ?? ''}
      data={props.data as ComponentProps<typeof PaperView>['data']}
    />
  ),
  /* --- crm setup -------------------------------------------------------------- */
  /** One client island, like the labor-costing workspace. Six per-tab column
   *  sets with row-click routing are a six-way conditional pair, not presence,
   *  and neither table variant can carry row navigation. */
  'crm-setup-workspace': (props) => (
    <CrmSetupWorkspace {...(props as ComponentProps<typeof CrmSetupWorkspace>)} />
  ),

  /* --- admin apps ------------------------------------------------------------ */
  /** Not `link-button` (solid, no icon) and not `docs-link-button` (BookOpen):
   *  the native action is outline-small with a 15px Library icon. Diffed. */
  'apps-library-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={href as never}>
          <Library size={15} /> {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  'apps-toolbar': () => <AppsToolbar />,
  'app-key-cell': (props) => <AppKeyCell appKey={str(props, 'appKey') ?? ''} />,
  /** The whole app flyout stays one widget: its body is three tabs of per-row
   *  client state (dirty flags, selected file, open dirs) — a workspace, not a
   *  spec. */
  'app-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof AppDrawer> | null
    if (!drawer) return null
    return <AppDrawer {...drawer} />
  },

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
  /** The button owns its own label; the spec only gates it. */
  'capture-upload': (props) => <CaptureUploadButton disabled={props.disabled === true} />,
  /** A widget, not a `table` block — the same call `AdminUsersTable` made. It
   *  owns row selection, per-row checkboxes (materialized rows unselectable)
   *  and three bulk actions; neither table variant can name that. */
  'capture-list': (props) => <CaptureList {...(props as ComponentProps<typeof CaptureList>)} />,
  /** The not-configured banner text with an optional configure link. */
  'capture-not-configured': (props) => (
    <>
      {str(props, 'text') ?? ''}{' '}
      {props.showConfigureLink === true ? (
        <Link
          href={(str(props, 'configureHref') ?? '/admin/ai') as never}
          className="font-medium underline"
        >
          {str(props, 'configureLabel') ?? ''}
        </Link>
      ) : null}
    </>
  ),
  'capture-review-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof CaptureReviewDrawer> | null
    if (!drawer) return null
    return <CaptureReviewDrawer {...drawer} />
  },

  /* --- project profitability -------------------------------------------------- */
  /** Not `paper-view`: that would restyle the page's section wrappers and
   *  silently drop the negative-money colouring. Diffed, kept separate. */
  'project-profitability-table': (props) => (
    <ProjectProfitabilityTable {...(props as ComponentProps<typeof ProjectProfitabilityTable>)} />
  ),

  /* --- overhead model --------------------------------------------------------- */
  'overhead-model-header': (props) => (
    <OverheadModelHeader {...(props as ComponentProps<typeof OverheadModelHeader>)} />
  ),
  'overhead-model-body': (props) => (
    <OverheadModelBody {...(props as ComponentProps<typeof OverheadModelBody>)} />
  ),
  'overhead-rates-tab': (props) => (
    <OverheadRatesTabSlot {...(props as ComponentProps<typeof OverheadRatesTabSlot>)} />
  ),
  'overhead-lifecycle-tab': () => <OverheadLifecycleTabSlot />,
  'overhead-application-tab': () => <OverheadApplicationTabSlot />,

  /* --- setup readiness -------------------------------------------------------- */
  //
  // NOT the existing `readiness-panel`: that one renders the compliance 1099
  // queue and shares no markup with this page. Two names, two components.
  'setup-readiness-hero': (props) => (
    <SetupReadinessHero
      kicker={str(props, 'kicker') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      badgeLabel={str(props, 'badgeLabel') ?? ''}
      badgeReady={props.badgeReady === true}
      progressLabel={str(props, 'progressLabel') ?? ''}
      progressCount={Number(props.progressCount ?? 0)}
      progressTotal={Number(props.progressTotal ?? 0)}
      progressPercent={Number(props.progressPercent ?? 0)}
      progressMin={Number(props.progressMin ?? 0)}
      progressMax={Number(props.progressMax ?? 0)}
      progressNow={Number(props.progressNow ?? 0)}
    />
  ),
  /** `state` is a closed complete | review | waiting vocabulary the loader
   *  resolves; the component switches icon and tile classes on it, never the
   *  spec. */
  'setup-readiness-check-card': (props) => (
    <SetupReadinessCheckCard
      indexLabel={str(props, 'indexLabel') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      href={str(props, 'href') ?? ''}
      action={str(props, 'action') ?? ''}
      state={
        str(props, 'state') === 'review'
          ? 'review'
          : str(props, 'state') === 'waiting'
            ? 'waiting'
            : 'complete'
      }
      stateLabel={str(props, 'stateLabel') ?? ''}
    />
  ),

  /* --- saved view run --------------------------------------------------------- */
  'saved-view-header': (props) => (
    <SavedViewHeader
      viewId={str(props, 'viewId') ?? ''}
      name={str(props, 'name') ?? ''}
      scope={str(props, 'scope') ?? ''}
      scopeLabel={str(props, 'scopeLabel') ?? ''}
      subtitle={str(props, 'subtitle') ?? ''}
      backHref={str(props, 'backHref') ?? '/knowledge/views'}
      backLabel={str(props, 'backLabel') ?? ''}
      canEdit={props.canEdit === true}
      labels={props.labels as ComponentProps<typeof SavedViewHeader>['labels']}
    />
  ),
  'saved-view-meta': (props) => (
    <SavedViewMeta
      typeLabel={str(props, 'typeLabel') ?? ''}
      lastUpdated={str(props, 'lastUpdated') ?? ''}
      rowsRange={str(props, 'rowsRange') ?? null}
    />
  ),
  'result-view': (props) => (
    <ResultView
      company={str(props, 'company') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? null}
      result={props.result as ComponentProps<typeof ResultView>['result']}
      drillTarget={props.drillTarget as ComponentProps<typeof ResultView>['drillTarget']}
    />
  ),
  'balance-check': (props) => (
    <BalanceCheck
      equation={str(props, 'equation') ?? ''}
      balanced={props.balanced === true}
      label={str(props, 'label') ?? ''}
    />
  ),

  /* --- bank matching workspace ------------------------------------------------ */
  /** Whole: it owns selection state across three paginated lists plus the
   *  match/unmatch calls and an add-journal form. Decomposing it would strand
   *  the selection from the actions it drives. */
  'match-workspace': (props) => (
    <MatchWorkspace
      accounts={(props.accounts as ComponentProps<typeof MatchWorkspace>['accounts']) ?? []}
      offsetAccounts={
        (props.offsetAccounts as ComponentProps<typeof MatchWorkspace>['offsetAccounts']) ?? []
      }
      account={(props.account as ComponentProps<typeof MatchWorkspace>['account']) ?? null}
      session={(props.session as ComponentProps<typeof MatchWorkspace>['session']) ?? null}
      data={(props.data as ComponentProps<typeof MatchWorkspace>['data']) ?? null}
      totals={(props.totals as ComponentProps<typeof MatchWorkspace>['totals']) ?? null}
      currentParams={(props.currentParams as ComponentProps<typeof MatchWorkspace>['currentParams']) ?? {}}
      tab={(str(props, 'tab') ?? 'match') as ComponentProps<typeof MatchWorkspace>['tab']}
    />
  ),

  'psp-settlements': (props) => (
    <PspSettlementsWorkspace
      strings={props.strings as ComponentProps<typeof PspSettlementsWorkspace>['strings']}
      initialRows={
        (props.initialRows as ComponentProps<typeof PspSettlementsWorkspace>['initialRows']) ?? null
      }
    />
  ),

  /* --- payroll setup workspace ------------------------------------------------ */
  //
  // The tab bodies are SLOTS, not widgets with props: each re-derives the org
  // id, the registry entry and the manage gate from the session, so the spec
  // carries only which tab is open and the URL it was rendering with.
  'payroll-setup-header': (props) => (
    <PayrollSetupHeader
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      launcher={props.launcher as ComponentProps<typeof PayrollSetupHeader>['launcher']}
    />
  ),
  'payroll-setup-banner': (props) => (
    <PayrollSetupBanner
      launcher={props.launcher as ComponentProps<typeof PayrollSetupBanner>['launcher']}
    />
  ),
  /** The active-vs-plain link pair (and aria-current set vs omitted) lives in
   *  the component; every `active` flag is loader-resolved data. */
  'payroll-setup-tabs': (props) => (
    <PayrollSetupTabs
      groups={(props.groups as ComponentProps<typeof PayrollSetupTabs>['groups']) ?? []}
      activeGroup={str(props, 'activeGroup') ?? ''}
      tabsAria={str(props, 'tabsAria') ?? ''}
      subTabs={(props.subTabs as ComponentProps<typeof PayrollSetupTabs>['subTabs']) ?? []}
    />
  ),
  'payroll-packs-tab': () => <PacksTabSlot />,
  'payroll-accounts-tab': () => <AccountsTabSlot />,
  'payroll-payday-tab': () => <PaydayTabSlot />,
  'payroll-rates-tab': () => <RatesTabSlot />,
  'payroll-schedules-tab': () => <WorkSchedulesTabSlot />,
  'payroll-derived-preview-tab': (props) => (
    <DerivedPreviewTabSlot sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
  ),
  'payroll-holidays-tab': (props) => (
    <HolidaysTabSlot
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') ?? '/admin/setup/payroll'}
    />
  ),
  'payroll-holiday-calendar-tab': (props) => (
    <HolidayCalendarTabSlot sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
  ),

  /* --- automation flows ------------------------------------------------------- */
  'new-flow': () => <NewFlowListButton />,
  'flow-name-cell': (props) => (
    <FlowNameCell name={str(props, 'name') ?? ''} href={str(props, 'href') ?? ''} />
  ),
  'flow-last-run-cell': (props) => (
    <FlowLastRunCell
      status={str(props, 'status') ?? null}
      variant={
        (str(props, 'variant') ?? 'outline') as ComponentProps<typeof FlowLastRunCell>['variant']
      }
      at={str(props, 'at') ?? null}
      fallback={str(props, 'fallback') ?? ''}
    />
  ),
  'flow-row-actions': (props) => (
    <FlowRowActionsCell
      id={str(props, 'id') ?? ''}
      name={str(props, 'name') ?? ''}
      enabled={props.enabled === true}
      updatedAt={str(props, 'updatedAt') ?? ''}
    />
  ),

  /* --- labor costing / pricing ------------------------------------------------ */
  /** Not `link-button`: that renders one 14px icon with no space and no
   *  `size="sm"`. This cluster is two sized buttons with spaced icons plus a
   *  teal text link carrying a literal arrow. Diffed, kept separate. */
  'labor-costing-header-actions': (props) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href={(str(props, 'guideHref') ?? '') as never}>
          <Sparkles size={14} aria-hidden /> {str(props, 'guideLabel') ?? ''}
        </Link>
      </Button>
      <Button asChild variant="ghost" size="sm">
        <Link href="/docs/labor-costing">
          <BookOpen size={14} aria-hidden /> {str(props, 'docsLabel') ?? ''}
        </Link>
      </Button>
      <Link
        href="/admin/setup/overhead"
        className="px-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
      >
        {str(props, 'overheadLabel') ?? ''} →
      </Link>
    </div>
  ),
  /** Not `module-home-tabs`: that is a pill strip; these are underline links
   *  with no `aria-current`. */
  'labor-costing-tabs': (props) => {
    const tabs = (props.tabs as { href: string; label: string; active: boolean }[]) ?? []
    return (
      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href as never}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab.active
                ? 'border-teal-600 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    )
  },
  /** The spec spreads the workspace's props directly, as the loader builds
   *  them — there is no nested `workspace` bag. */
  'labor-costing-workspace': (props) => (
    <LaborCostingWorkspace {...(props as unknown as ComponentProps<typeof LaborCostingWorkspace>)} />
  ),
  'labor-pricing-heading': (props) => (
    <LaborPricingHeading
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      docsHref={str(props, 'docsHref') ?? '/docs/labor-pricing'}
      docsLabel={str(props, 'docsLabel') ?? ''}
    />
  ),
  'labor-pricing-view': (props) => (
    <LaborPricingView {...(props as unknown as ComponentProps<typeof LaborPricingView>)} />
  ),

  /* --- pay run wizard --------------------------------------------------------- */
  /** Five freely-navigable steps whose every control is a fetch flow plus
   *  client state a spec cannot name — the /tax shape. */
  'pay-run-wizard': (props) => (
    <RunWizard {...(props as unknown as ComponentProps<typeof RunWizard>)} />
  ),

  /* --- payroll cockpit ------------------------------------------------------- */
  'payroll-settings-banner': (props) => (
    <PayrollChecklistBanner
      text={str(props, 'text') ?? ''}
      settings={str(props, 'settings') ?? ''}
      openSettingsLabel={str(props, 'openSettingsLabel') ?? ''}
    />
  ),
  /** Includes its own empty state: a negated conditional pair is not a spec
   *  construct, the same call the purchasing cockpit made. */
  'payroll-current-period': (props) => (
    <PayrollScheduleList
      schedules={(props.schedules as PayrollScheduleListProps['schedules']) ?? []}
      emptyText={str(props, 'emptyText') ?? ''}
      showSetupLink={props.showSetupLink === true}
      setupLabel={str(props, 'setupLabel') ?? ''}
      labels={
        (props.labels as PayrollScheduleListProps['labels']) ?? {
          frequency: {},
          period: '',
          payDate: '',
          employees: '',
          net: '',
        }
      }
    />
  ),
  'payroll-previous-run': (props) => (
    <PayrollPreviousRun
      run={(props.run as PayrollPreviousRunProps['run']) ?? null}
      periodLabel={str(props, 'periodLabel') ?? ''}
      payDateLabel={str(props, 'payDateLabel') ?? ''}
      netLabel={str(props, 'netLabel') ?? ''}
      employeesLabel={str(props, 'employeesLabel') ?? ''}
      noneText={str(props, 'noneText') ?? ''}
    />
  ),
  'payroll-manage-links': (props) => (
    <PayrollManageLinks
      paySchedulesLabel={str(props, 'paySchedulesLabel') ?? ''}
      payComponentsLabel={str(props, 'payComponentsLabel') ?? ''}
    />
  ),

  /* --- compliance cockpit ---------------------------------------------------- */
  //
  // The two right-hand panels are whole components rather than `panel` blocks
  // because `panel` has no actions slot, and the setup prompt is an Alert
  // rather than the dashed-card empty state.
  'compliance-setup-banner': (props) => (
    <ComplianceSetupBanner
      prompt={str(props, 'prompt') ?? ''}
      actionHref={str(props, 'actionHref') ?? ''}
      actionLabel={str(props, 'actionLabel') ?? ''}
    />
  ),
  'blocked-bills': (props) => (
    <BlockedBillsSection
      rows={props.rows as ComponentProps<typeof BlockedBillsSection>['rows']}
      empty={str(props, 'empty') ?? ''}
    />
  ),
  'expiring-vendors': (props) => (
    <ExpiringVendorsSection
      rows={props.rows as ComponentProps<typeof ExpiringVendorsSection>['rows']}
      empty={str(props, 'empty') ?? ''}
    />
  ),
  'waivers-panel': (props) => (
    <WaiversPanel
      title={str(props, 'title') ?? ''}
      hint={str(props, 'hint') ?? ''}
      actionHref={str(props, 'actionHref') ?? ''}
      actionLabel={str(props, 'actionLabel') ?? ''}
      rows={props.rows as ComponentProps<typeof WaiversPanel>['rows']}
      empty={str(props, 'empty') ?? ''}
    />
  ),
  'readiness-panel': (props) => (
    <ReadinessPanel
      title={str(props, 'title') ?? ''}
      hint={str(props, 'hint') ?? ''}
      actionHref={str(props, 'actionHref') ?? ''}
      actionLabel={str(props, 'actionLabel') ?? ''}
      rows={props.rows as ComponentProps<typeof ReadinessPanel>['rows']}
      empty={str(props, 'empty') ?? ''}
    />
  ),

  /* --- tax ------------------------------------------------------------------- */
  /**
   * The whole tax page through one widget, and coarse by necessity: the native
   * page sits inside `PageContainer`, whose motion wrappers carry
   * `data-page-motion` attributes and post-animation inline styles a spec grid
   * (a plain div) cannot reproduce. Every unit below is a shared component the
   * native branch also renders; this only binds loader data to props. The tab
   * flags are loader-computed and applied inside `TaxTabPanels`, because a
   * `when` cannot cross a widget boundary.
   */
  'tax-page': (props) => (
    <TaxPageShell>
      <TaxPageHeader
        title={str(props, 'title') ?? ''}
        description={str(props, 'description') ?? ''}
        setupHref={str(props, 'setupHref') ?? '/admin/setup/tax-return-forms'}
        setupLabel={str(props, 'setupLabel') ?? ''}
        canManageSetup={props.canManageSetup === true}
      />
      <TaxTabs tabs={(props.tabs as ComponentProps<typeof TaxTabs>['tabs']) ?? []} />
      <TaxTabPanels
        tabKey={str(props, 'tabKey') ?? 'prepare'}
        onPrepare={props.onPrepare === true}
        onHistory={props.onHistory === true}
        prepare={
          <TaxPreparePanel
            forms={(props.forms as ComponentProps<typeof TaxPreparePanel>['forms']) ?? []}
            canSave={props.canSave === true}
            canManageSetup={props.canManageSetup === true}
          />
        }
        history={<TaxHistoryTable {...(props.history as ComponentProps<typeof TaxHistoryTable>)} />}
      />
    </TaxPageShell>
  ),
  'tax-filing-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof TaxFilingDrawer>['drawer']
    if (!drawer) return null
    return <TaxFilingDrawer drawer={drawer} />
  },

  /* --- customers cockpit ----------------------------------------------------- */
  'relationships-section': (props) => (
    <RelationshipsSection
      rows={(props.rows as ComponentProps<typeof RelationshipsSection>['rows']) ?? []}
      crmEnabled={props.crmEnabled !== false}
      empty={str(props, 'empty') ?? ''}
    />
  ),
  /** The AR strip. Named `customer-ar-pulse`, not `ar-pulse`: the purchasing
   *  cockpit already owns `ap-pulse`, and two similarly named entries pointing
   *  at different components is exactly how a registry starts lying. */
  'customer-ar-pulse': (props) => (
    <CustomerArPulse
      outstanding={str(props, 'outstanding') ?? ''}
      overdue={str(props, 'overdue') ?? ''}
      overdueIsNegative={props.overdueIsNegative === true}
      dso={str(props, 'dso') ?? ''}
      labels={props.labels as ComponentProps<typeof CustomerArPulse>['labels']}
      href={str(props, 'href') ?? ''}
    />
  ),

  /* --- admin hub ------------------------------------------------------------ */
  /** One hub navigation card. The icon and the accent are lookups resolved
   *  here, so the spec carries only data — and the accent's Tailwind classes
   *  stay complete literals in the component, or the scanner purges them. */
  'admin-hub-card': (props) => (
    <AdminHubCard
      href={str(props, 'href') ?? '#'}
      iconKey={str(props, 'iconKey') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      accent={
        (['teal', 'violet', 'amber', 'sky'] as const).find((a) => a === str(props, 'accent')) ??
        'teal'
      }
    />
  ),

  /* --- org users ------------------------------------------------------------ */
  /** A widget, not a `table` block: this page hand-rolls a plain <table> with
   *  its own classes, and the spec's table block offers only the two real
   *  table variants the app has. */
  'admin-users-table': (props) => (
    <AdminUsersTable
      users={(props.users as ComponentProps<typeof AdminUsersTable>['users']) ?? []}
      allRoles={(props.allRoles as ComponentProps<typeof AdminUsersTable>['allRoles']) ?? []}
      basePath={str(props, 'basePath') ?? '/admin/users'}
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
      sort={str(props, 'sort') ?? 'name'}
      dir={str(props, 'dir') === 'desc' ? 'desc' : 'asc'}
      labels={props.labels as ComponentProps<typeof AdminUsersTable>['labels']}
    />
  ),
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

  /* --- payments ------------------------------------------------------------- */
  'new-payment': (props) => (
    <NewPaymentButton
      kind={(str(props, 'kind') ?? 'vendor_payment') as ComponentProps<typeof NewPaymentButton>['kind']}
      basePath={str(props, 'basePath') ?? '/payments'}
      label={str(props, 'label') ?? ''}
    />
  ),
  /** The create-run action is a plain link button, not the payment button —
   *  the two are a conditional pair the loader chooses between. */
  'new-payment-run': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild>
        <Link href={href as never}>
          <Plus size={16} />
          {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  'payments-view-tabs': (props) => (
    <PaymentsViewTabs
      view={(str(props, 'view') ?? 'payments') as 'payments' | 'runs'}
      labels={props.labels as ComponentProps<typeof PaymentsViewTabs>['labels']}
    />
  ),
  /** Not the payments strip: this one carries no hover treatment and no
   *  transition class, and the harness compares class strings exactly. */
  'receipts-view-tabs': (props) => (
    <ReceiptsViewTabs
      view={(str(props, 'view') ?? 'receipts') as 'receipts' | 'runs'}
      labels={props.labels as ComponentProps<typeof ReceiptsViewTabs>['labels']}
    />
  ),
  'payments-section': (props) => (
    <PaymentsSectionSlot
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') ?? '/payments'}
      kind={str(props, 'kind') === 'customer_payment' ? 'customer_payment' : 'vendor_payment'}
    />
  ),
  'payment-runs-section': (props) => (
    <RunsSectionSlot
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') === '/receipts' ? '/receipts' : '/payments'}
      direction={str(props, 'direction') === 'inbound' ? 'inbound' : 'outbound'}
    />
  ),

  /* --- file cabinet --------------------------------------------------------- */
  'documents-actions': (props) => (
    <DocumentsActions
      trashHref={str(props, 'trashHref') ?? '/documents/trash'}
      trashLabel={str(props, 'trashLabel') ?? ''}
      newFolder={<NewFolderButton parentId={str(props, 'newFolderParentId') ?? undefined} />}
      upload={<UploadButton folderId={str(props, 'newFolderParentId') ?? undefined} />}
    />
  ),
  'documents-breadcrumb': (props) => (
    <DocumentsBreadcrumb
      homeHref={str(props, 'homeHref') ?? '/documents'}
      homeLabel={str(props, 'homeLabel') ?? ''}
      crumbs={(props.crumbs as ComponentProps<typeof DocumentsBreadcrumb>['crumbs']) ?? []}
    />
  ),
  'folder-tree': (props) => (
    <FolderTree
      folders={(props.folders as ComponentProps<typeof FolderTree>['folders']) ?? []}
      activeFolderId={str(props, 'activeFolderId') ?? undefined}
    />
  ),
  /** Passed whole, like the approvals table: selection state, context-menu
   *  targets and bulk fetches are client state a spec cannot name. */
  'file-list': (props) => (
    <FileList
      folders={(props.folders as ComponentProps<typeof FileList>['folders']) ?? []}
      files={(props.files as ComponentProps<typeof FileList>['files']) ?? []}
      activeFolderId={str(props, 'activeFolderId') ?? undefined}
      showLocation={props.showLocation === true}
      canEdit={props.canEdit === true}
      canDelete={props.canDelete === true}
      currentParams={(props.currentParams as ComponentProps<typeof FileList>['currentParams']) ?? {}}
      sort={str(props, 'sort') ?? 'name'}
      dir={(str(props, 'dir') ?? 'asc') as ComponentProps<typeof FileList>['dir']}
    />
  ),
  'file-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof FileDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <FileDrawer key={remountKey} {...rest} />
  },
  'folder-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof FolderDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <FolderDrawer key={remountKey} {...rest} />
  },

  /* --- bank feeds ----------------------------------------------------------- */
  /** One widget, not a table: every row is a bundle of conditional pairs (a
   *  last-attempt date or nothing, an error line or nothing, a paused marker
   *  or nothing), and a spec must never express those. */
  'bank-feed-panel': (props) => (
    <BankFeedPanel
      title={str(props, 'title') ?? ''}
      manageLabel={str(props, 'manageLabel') ?? ''}
      emptyMessage={str(props, 'emptyMessage') ?? ''}
      lastSyncLabel={str(props, 'lastSyncLabel') ?? ''}
      lastAttemptLabel={str(props, 'lastAttemptLabel') ?? ''}
      neverLabel={str(props, 'neverLabel') ?? ''}
      feeds={(props.feeds as ComponentProps<typeof BankFeedPanel>['feeds']) ?? []}
    />
  ),

  /* --- budgets -------------------------------------------------------------- */
  'new-budget': (props) => (
    <NewBudgetButton
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  'budget-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof BudgetDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <BudgetDrawer key={remountKey} {...rest} />
  },

  /* --- pay runs ------------------------------------------------------------- */
  'new-pay-run': (props) => (
    <NewRunButton
      schedules={(props.schedules as ComponentProps<typeof NewRunButton>['schedules']) ?? []}
      finalPayCandidates={
        (props.finalPayCandidates as ComponentProps<typeof NewRunButton>['finalPayCandidates']) ?? []
      }
      today={str(props, 'today') ?? ''}
    />
  ),
  /** A pay run opens a full wizard page, not a drawer, so its row action is a
   *  plain link built from the row id. */
  'pay-run-row-actions': (props) => (
    <Link
      href={`/payroll/runs/${String(props.id ?? '')}` as never}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
      aria-label={str(props, 'label') ?? ''}
      title={str(props, 'label') ?? ''}
    >
      <ArrowUpRight size={15} />
    </Link>
  ),

  /* --- field tickets -------------------------------------------------------- */
  /** Keyless, like `journal-drawer`: the native page renders no key and the
   *  drawer resets from effects on the ticket id. */
  'field-ticket-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof FieldTicketDrawer> | null
    if (!drawer) return null
    return <FieldTicketDrawer {...drawer} />
  },

  /* --- bank rules ----------------------------------------------------------- */
  'new-bank-rule': () => <NewRuleButton />,
  'run-bank-rules': (props) => (
    <RunRulesButton
      accounts={(props.accounts as ComponentProps<typeof RunRulesButton>['accounts']) ?? []}
    />
  ),
  'bank-rule-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof RuleDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <RuleDrawer key={remountKey} {...rest} />
  },

  /* --- entity role lists ---------------------------------------------------- */
  'new-role-party': (props) => (
    <NewPartyButton
      basePath={str(props, 'basePath') ?? '/parties'}
      role={(str(props, 'role') ?? 'customer') as 'customer' | 'vendor' | 'employee'}
      label={str(props, 'label') ?? ''}
    />
  ),
  'new-role-party-redirect': (props) => (
    <NewPartyRedirect
      basePath={str(props, 'basePath') ?? '/parties'}
      role={(str(props, 'role') ?? 'customer') as 'customer' | 'vendor' | 'employee'}
    />
  ),

  /* --- timesheets ----------------------------------------------------------- */
  'new-timesheet': (props) => (
    <Link
      href={(str(props, 'href') ?? '/timesheets') as never}
      className="inline-flex h-8 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-teal-800"
    >
      {str(props, 'label') ?? ''}
    </Link>
  ),
  'timesheet-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof WeeklyGrid> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <WeeklyGrid key={remountKey} {...rest} />
  },

  /* --- items ---------------------------------------------------------------- */
  /** One widget for the whole header slot: the native markup differs per view
   *  (the catalog wraps tabs+button, rate books passes bare tabs), and `wrap`
   *  selects between them as data rather than as a branch in the spec. */
  'items-header-actions': (props) => {
    const tabs = (props.tabs as ComponentProps<typeof ModuleHomeTabs>['tabs']) ?? []
    const inner = (
      <>
        <ModuleHomeTabs tabs={tabs} />
        {props.showNew === true ? <NewItemButton /> : null}
      </>
    )
    return props.wrap === true ? <div className="flex items-center gap-3">{inner}</div> : inner
  },
  'new-item': () => <NewItemButton />,
  'new-item-redirect': () => <NewItemRedirect />,
  'item-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof ItemDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <ItemDrawer key={remountKey} {...rest} />
  },

  /* --- inventory ------------------------------------------------------------ */
  'new-movement': () => <NewMovementButton />,
  'inventory-action-drawer': (props) => (
    <InventoryActionDrawer
      items={(props.items as ComponentProps<typeof InventoryActionDrawer>['items']) ?? []}
      stockLocations={
        (props.stockLocations as ComponentProps<typeof InventoryActionDrawer>['stockLocations']) ?? []
      }
      accounts={(props.accounts as ComponentProps<typeof InventoryActionDrawer>['accounts']) ?? []}
    />
  ),
  /** A registry-backed configuration surface re-homed onto another module's
   *  tab. The registry entry is CODE, so the spec names it by key and the slot
   *  looks it up; org id and the manage gate are re-derived from the session. */
  'setup-section': (props) => (
    <SetupSectionSlot
      entityKey={str(props, 'entityKey') ?? ''}
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') ?? ''}
    />
  ),

  /* --- crm opportunities ---------------------------------------------------- */
  'crm-new-button': (props) => (
    <CrmNewButton
      apiPath={str(props, 'apiPath') ?? ''}
      basePath={str(props, 'basePath') ?? ''}
      param={str(props, 'param') ?? ''}
      label={str(props, 'label') ?? ''}
      failed={str(props, 'failed') ?? ''}
    />
  ),
  'opportunity-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof OpportunityDrawer> | null
    if (!drawer) return null
    return <OpportunityDrawer {...drawer} />
  },

  /* --- expense reports ------------------------------------------------------ */
  /** The button owns its own labels — it is a client component reading the
   *  message catalog directly, so the spec passes nothing. */
  'new-expense': () => <NewExpenseButton />,
  /**
   * Per-row expense actions. The open href is BUILT here from the row id and
   * the current URL, because the native page builds it the same way and a
   * spec cannot construct a query string. `canSubmit`/`canPost` arrive as
   * loader-resolved booleans, not as a capability object.
   */
  'expense-row-actions': (props) => (
    <ExpenseActions
      id={String(props.id ?? '')}
      status={String(props.status ?? '')}
      canSubmit={props.canSubmit === true}
      canPost={props.canPost === true}
      openHref={buildListDrawerHref(
        '/expenses/reports',
        (props.sp as Record<string, string | string[] | undefined>) ?? {},
        'expense',
        String(props.id ?? ''),
      )}
    />
  ),
  'expense-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof ExpenseDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <ExpenseDrawer key={remountKey} {...rest} />
  },

  /* --- period close --------------------------------------------------------- */
  /** `size: 'sm'` is load-bearing here: the default renders h-10 where the
   *  native header is h-8. */
  'manage-books-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={href as never}>{str(props, 'label') ?? ''}</Link>
      </Button>
    )
  },
  'single-book-label': (props) => (
    <SingleBookLabel label={str(props, 'label') ?? ''} name={str(props, 'name') ?? ''} />
  ),
  'close-readiness-cell': (props) => (
    <CloseReadinessCell readiness={Number(props.readiness ?? 0)} />
  ),
  /** The action cell's conditional triple — resume link, start control, or an
   *  em-dash. The LOADER decides which applies; the component renders the
   *  decision it is given. */
  'close-action-cell': (props) => (
    <CloseActionCell
      actionHref={(props.actionHref as string | null) ?? null}
      actionLabel={str(props, 'actionLabel') ?? ''}
      actionLinkClassName={str(props, 'actionLinkClassName') ?? ''}
      canStart={props.canStart === true}
      startPeriodId={str(props, 'startPeriodId') ?? ''}
      startBooks={(props.startBooks as { id: string; name: string }[]) ?? []}
      startDefaultBookId={str(props, 'startDefaultBookId') ?? ''}
    />
  ),

  /* --- orders (quotes, sales orders, purchase orders) ----------------------- */
  //
  // One set of entries for all three order pages: they render the same
  // `_order` components and differ only in the api path, base path and param
  // the loader resolves. Three near-identical registry entries would have been
  // three places to drift.
  'new-order': (props) => (
    <NewOrderButton
      apiPath={str(props, 'apiPath') ?? ''}
      base={str(props, 'base') ?? ''}
      param={str(props, 'param') ?? ''}
      label={str(props, 'label') ?? ''}
      createFailedMessage={str(props, 'createFailedMessage') ?? ''}
    />
  ),
  'new-order-redirect': (props) => (
    <NewOrderRedirect
      apiPath={str(props, 'apiPath') ?? ''}
      base={str(props, 'base') ?? ''}
      param={str(props, 'param') ?? ''}
      createFailedMessage={str(props, 'createFailedMessage') ?? ''}
    />
  ),
  'order-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof OrderDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <OrderDrawer key={remountKey} {...rest} />
  },

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
  /** Two callers, two shapes: the access list hands over the whole options
   *  bundle, the user record spreads its own fields and adds a default
   *  member. Accepting either keeps ONE entry in front of one component
   *  rather than a second entry that would drift from it. */
  'grant-access-form': (props) => {
    const options = (props.options as ComponentProps<typeof GrantAccessForm> | undefined) ?? {
      members: (props.members as ComponentProps<typeof GrantAccessForm>['members']) ?? [],
      organizations:
        (props.organizations as ComponentProps<typeof GrantAccessForm>['organizations']) ?? [],
      actingUsers: (props.actingUsers as ComponentProps<typeof GrantAccessForm>['actingUsers']) ?? [],
    }
    return (
      <GrantAccessForm {...options} defaultMemberUserId={str(props, 'defaultMemberUserId') ?? ''} />
    )
  },
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
