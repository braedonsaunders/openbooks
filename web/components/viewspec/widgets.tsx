import { NativeExtension } from '../../app/(app)/apps/[key]/NativeExtension'
import { Fragment, type ComponentProps, type ReactNode } from 'react'
import type { WidgetRef } from '@braedonsaunders/appkit-viewspec'
import { isFieldRef, resolvePath } from '@braedonsaunders/appkit-viewspec'
import { SubsidiarySwitcher } from '../subsidiary-switcher'
import { ModuleHomeTabs, LiveDirectory } from '../module-home/ui'
import { TrendChart } from '../../app/(app)/analytics/_ui/charts'
import { ApPulse, AttentionList, CommitmentsSection, DirectorySection } from '../../app/(app)/purchasing/sections'
import { ResourceCell, RowCountsCell } from '../../app/(app)/data/import/history/sections'
import { CurrencyBasisControl, type CurrencyOption } from '../../app/(app)/reports/aging/currency-basis'
import { ViewNameCell, ViewActionsCell } from '../../app/(app)/knowledge/views/sections'
import { NewViewButton } from '../../app/(app)/knowledge/views/NewViewButton'
import { ViewStudio } from '../../app/(app)/knowledge/views/ViewStudio'
import { EmptyState } from '@openbooks/ui'
import { Pagination } from '../pagination'
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
import { Activity, Building2, CheckCircle2, KeyRound, Mail, Send, Settings, Trash2, Users } from 'lucide-react'
import { EmailSubjectCell, EmailEvidenceCell } from '../../app/(app)/platform/email-log/sections'
import { VendorComplianceMatrix } from '../../app/(app)/compliance/vendors/Matrix'
import { PartyRolesCell } from '../../app/(app)/parties/sections'
import { KindChips, ApprovalTabs, ApprovalEngineCell, SubmittedDocumentCell } from '../../app/(app)/approvals/sections'
import { ApprovalsTable } from '../../app/(app)/approvals/ApprovalsTable'
import { DelegationBanner, OutOfOfficeButton } from '../../app/(app)/approvals/DelegationControls'
import { AccountNameCell, AccountRegisterCell } from '../../app/(app)/accounts/sections'
import { AccountsHierarchyTable } from '../../app/(app)/accounts/AccountsHierarchyTable'
import { AccountDrawer } from '../../app/(app)/accounts/AccountDrawer'
import { NewAccountButton } from '../../app/(app)/accounts/NewAccountButton'
import { EntityListSlot } from './entity-list-slot'
import { RecordListSlot } from './record-list-slot'
import { SetupSectionSlot } from './setup-section-slot'
import { PlatformUserHeader, GrantActingCell, GrantControlCell, NoGrantsBody, IdentityRecordCard } from '../../app/(app)/platform/users/[id]/sections'
import { AdminRolesTable } from '../../app/(app)/admin/roles/sections'
import { NewRoleButton } from '../../app/(app)/admin/roles/RoleEditor'
import { AuditRowsTable, AuditEventFlyout, AuditDocsLink } from '../../app/(app)/admin/audit/sections'
import { NotificationsInbox, NotificationsMarkAllRead } from '../../app/(app)/notifications/NotificationsInbox'
import { HrmHeadcountTable, HrmPendingRequests, HrmReadiness, HrmRecentChanges, HrmUpcomingChanges } from '../../app/(app)/hrm/sections'
import { ChangeRequestQueue } from '../../app/(app)/hrm/change-requests/QueueClient'
import { PositionDrawer, PositionSegments, PositionsTable, VacancyTable } from '../../app/(app)/hrm/positions/sections'
import { ListChecks, ShieldCheck, ScrollText } from 'lucide-react'
import { QueryConsole } from '../../app/(app)/query/sections'
import { HealthHero } from '../../app/(app)/accounting/sections'
import { AdminHubCard } from '../../app/(app)/admin/sections'
import { BuildHubCard } from '../../app/(app)/admin/build/sections'
import { Library, ArrowLeft } from 'lucide-react'
import { CrmSetupWorkspace } from '../../app/(app)/admin/setup/crm/CrmSetupWorkspace'
import { DocsHome } from '../../app/(app)/docs/sections'
import { DocArticleView } from '../../app/(app)/docs/[slug]/sections'
import { LibraryEmptyIcon, ListingCard } from '../../app/(app)/apps/library/sections'
import { ExportClient } from '../../app/(app)/data/export/ExportClient'
import { ImportWizard } from '../../app/(app)/data/import/ImportWizard'
import { TrashList } from '../../app/(app)/documents/trash/TrashList'
import { TrashBackLink } from '../../app/(app)/documents/trash/sections'
import { AssistantApp } from '../assistant/assistant-app'
import { ChatMarkdown } from '../assistant/markdown'
import { DashboardHeader } from '../../app/(app)/dashboard/_dashboard-header'
import { DashboardGridSlot } from './dashboard-grid-slot'
import { DashboardEditSlot } from './dashboard-edit-slot'
import { CustomizeDashboardHeader } from '../../app/(app)/dashboard/customize/sections'
import { PlatformClient } from '../../app/(app)/sync/PlatformClient'
import { NavEditor } from '../../app/(app)/admin/navigation/NavEditor'
import { FeaturesWorkspace } from '../../app/(app)/admin/setup/features/FeaturesWorkspace'
import { AgentsLastRunCell } from '../../app/(app)/admin/setup/agents/AgentsLastRunCell'
import { AgentsPackActions } from '../../app/(app)/admin/setup/agents/AgentsPackActions'
import { AgentsPackFindings } from '../../app/(app)/admin/setup/agents/AgentsPackFindings'
import { AgentsPackCard } from '../../app/(app)/admin/setup/agents/library/AgentsPackCard'
import { AgentPolicyForm } from '../../app/(app)/admin/setup/agents/[agentKey]/AgentPolicyForm'
import { AgentsRunActions } from '../../app/(app)/admin/setup/agents/activity/AgentsRunActions'
import { AgentsTriageKeys } from '../../app/(app)/agents/AgentsTriageKeys'
import { MovedNotice } from '../../app/(app)/agents/MovedNotice'
import { AgentsBriefingActions } from '../../app/(app)/agents/AgentsBriefingActions'
import { EmailSettingsForm } from '../../app/(app)/admin/email/EmailSettingsForm'
import { AiSettingsForm } from '../../app/(app)/admin/ai/AiSettingsForm'
import { InvoicingSettingsWorkspace } from '../../app/(app)/admin/setup/invoicing/InvoicingSettingsWorkspace'
import { TemplatesList } from '../../app/(app)/admin/pdf-templates/TemplatesList'
import PdfTemplateEditor from '../../app/(app)/admin/pdf-templates/[id]/PdfTemplateEditor'
import FlowBuilder from '../../app/(app)/admin/flows/[id]/FlowBuilder'
import { FilingWorksheet } from '../../app/(app)/compliance/information-returns/[id]/FilingWorksheet'
import { SandboxManager } from '../../app/(app)/admin/sandboxes/SandboxManager'
import { ChangeSetDrawer } from '../../app/(app)/admin/sandboxes/change-sets/ChangeSetDrawer'
import { PaymentProvidersClient } from '../../app/(app)/admin/setup/payment-providers/PaymentProvidersClient'
import { ProjectTypesWorkspace } from '../../app/(app)/admin/setup/project-types/ProjectTypesWorkspace'
import { SecurityPageContent } from '../../app/(app)/settings/security/sections'
import { ApiConsole } from '../../app/(app)/api-docs/ApiConsole'
import { SetupWizard } from '../../app/(app)/admin/setup/wizard/SetupWizard'
import { AppNotice, AppRuntimeChrome } from '../../app/(app)/apps/[key]/sections'
import { KpiStrip } from '../kpi-strip'
import { DashboardBuilder } from '../../app/(app)/insights/dashboards/[id]/DashboardBuilder'
import { PlatformNotice, PlatformTile } from '../../app/(app)/platform/sections'
import { BackupManager } from '../../app/(app)/admin/backups/BackupManager'
import { AppLauncherCard, AppsEmptyIcon, AppsLauncherButton } from '../../app/(app)/apps/sections'
import { AppKeyCell } from '../../app/(app)/admin/apps/sections'
import { OverheadApplicationTabSlot, OverheadLifecycleTabSlot, OverheadModelBody, OverheadModelHeader, OverheadRatesTabSlot } from '../../app/(app)/admin/setup/overhead/sections'
import { AllocationsDriversTabSlot, AllocationsRuleDrawerSlot, AllocationsRulesTabSlot, AllocationsRunsTabSlot, AllocationsSetupHeader } from '../../app/(app)/admin/setup/allocations/sections'
import { SetupReadinessCheckCard, SetupReadinessHero } from '../../app/(app)/admin/setup/readiness/sections'
import { FlowNameCell, FlowLastRunCell, FlowRowActionsCell, NewFlowButton as NewFlowListButton } from '../../app/(app)/admin/flows/sections'
import { BlockedBillsSection, ComplianceSetupBanner, ExpiringVendorsSection, ReadinessPanel, WaiversPanel } from '../../app/(app)/compliance/sections'
import { AdminUsersTable } from '../../app/(app)/admin/users/sections'
import { InviteUserButton } from '../../app/(app)/admin/users/InviteDialog'
import { Plus } from 'lucide-react'
import { FolderTree } from '../../app/(app)/documents/FolderTree'
import { FileList } from '../../app/(app)/documents/FileList'
import { FileDrawer } from '../../app/(app)/documents/FileDrawer'
import { FolderDrawer } from '../../app/(app)/documents/FolderDrawer'
import { UploadButton } from '../../app/(app)/documents/UploadButton'
import { NewFolderButton } from '../../app/(app)/documents/NewFolderButton'
import { DocumentsActions, DocumentsBreadcrumb } from '../../app/(app)/documents/sections'
import { NewBudgetButton } from '../../app/(app)/budgets/NewBudgetButton'
import { BudgetDrawer } from '../../app/(app)/budgets/BudgetDrawer'
import { WeeklyGrid } from '../../app/(app)/timesheets/WeeklyGrid'
import { CrmNewButton } from '../../app/(app)/crm/CrmNewButton'
import { OpportunityDrawer } from '../../app/(app)/crm/OpportunityDrawer'
import { OpportunityKanbanBoard, OpportunityViewSwitcher } from '../../app/(app)/crm/OpportunityKanban'
import { ActivityDrawer } from '../../app/(app)/crm/ActivityDrawer'
import { CloseActionCell, CloseReadinessCell, CloseStatusCell, SingleBookLabel } from '../../app/(app)/close/sections'
import { NewSetupButton } from '../../app/(app)/admin/setup/[entity]/SetupDrawer'
import { TaxReturnLibrary } from '../../app/(app)/admin/setup/[entity]/TaxReturnLibrary'
import { SetupBadgeLinkCell, SetupCloseSlot, SetupCodeCell, SetupCompanySlot, SetupDescription, SetupDrawerSlot, SetupFxSlot } from '../../app/(app)/admin/setup/[entity]/sections'
import { JournalDraftsPanel } from '../../app/(app)/journal/sections'
import { JournalDrawer } from '../../app/(app)/journal/JournalDrawer'
import { NewJournalButton } from '../../app/(app)/journal/NewJournalButton'
import { Gauge, History, Camera, BellRing } from 'lucide-react'
import { DateRangeFilter } from '../date-range-filter'
import { ForecastSectionHeading, ForecastKpiGroup, ForecastFilters, ManageQuotasButton, QuotaEmptyAction, ForecastSnapshotAction } from '../../app/(app)/crm/forecasts/sections'
import { NewRecordButton } from '../../app/(app)/records/[typeKey]/NewRecordButton'
import { RecordDrawer } from '../../app/(app)/records/[typeKey]/RecordDrawer'
import { DocumentDrawer } from '../document-drawer'
import { DocumentRowActions } from '../document-row-actions'
import { NewDocumentButton } from '../new-document-button'
import { ScanLine } from 'lucide-react'
import { PaymentLinksPanel } from '../payment-links-panel'
import { AppliedPaymentsPanel, type AppliedPayment } from '../applied-payments-panel'
import { DOC_KINDS } from '../../lib/document-kinds'
import { SearchSelectFilter } from '../filter-bar'
import { FormDesigner, NewFormButton } from '../../app/(app)/admin/customization/FormDesigner'
import { ListViewDesigner, NewViewButton as NewListViewButton } from '../../app/(app)/admin/customization/ListViewDesigner'
import { CustomizationTabs, FormDefaultCell, ViewScopeCell } from '../../app/(app)/admin/customization/sections'
import { BookOpen } from 'lucide-react'
import { TabNav, Metric, ReportsCardHeading, NarrativeEntry, FindingCell } from '../../app/(app)/continuous-close/sections'
import { WorkItemDrawer } from '../../app/(app)/continuous-close/WorkItemDrawer'
import { NarrativeDrawer } from '../../app/(app)/continuous-close/NarrativeDrawer'
import { NewPartyButton } from '../../app/(app)/parties/NewPartyButton'
import { NewPartyRedirect } from '../../app/(app)/parties/NewPartyRedirect'
import { PartyDrawer } from '../../app/(app)/parties/PartyDrawer'
import { RelatedTxnSlot } from './related-txn-slot'
import { MatrixFilters } from '../../app/(app)/compliance/vendors/MatrixFilters'
import { VendorComplianceDrawer } from '../../app/(app)/compliance/vendors/VendorComplianceDrawer'
import { UserIdentityCell, UserRolesCell, UserGrantsCell, UserManageCell } from '../../app/(app)/platform/users/sections'
import { OrgNameCell, OrgEnvironmentCell, OrgLocaleCell, OrgUsersCell, OrgOpenCell } from '../../app/(app)/platform/organizations/sections'
import { SearchInput } from '../search-input'
import { ShowInactivesToggle } from '../show-inactives-toggle'
import { FilterChips } from '../filter-bar'
import { NewKeyButton, KeyDrawer } from '../../app/(app)/admin/api-keys/KeyDrawer'
import { FieldDrawer, NewFieldButton } from '../../app/(app)/admin/custom-fields/FieldDrawer'
import { LayoutDrawer } from '../../app/(app)/admin/page-layouts/LayoutDrawer'
import { CloseWizard } from '../../app/(app)/close/CloseWizard'
import { NewScriptButton, ScriptDrawer } from '../../app/(app)/admin/scripts/ScriptDrawer'
import { Badge, Button } from '@openbooks/ui'
import Link from 'next/link'
import { PAYROLL_WIDGETS } from './widgets-payroll'
import { BANKING_WIDGETS } from './widgets-banking'
import { REPORTING_WIDGETS } from './widgets-reporting'
import { ASSETS_TAX_WIDGETS } from './widgets-assets-tax'
import { COMMERCE_WIDGETS } from './widgets-commerce'
import { str, num, stringRecord, type WidgetRenderer } from './widget-props'


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

export const WIDGET_REGISTRY: Record<string, WidgetRenderer> = {
  'statement-matrix': REPORTING_WIDGETS['statement-matrix'],
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
      maxTicks={typeof props.maxTicks === 'number' ? props.maxTicks : undefined}
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
  'journal-entry-heading': REPORTING_WIDGETS['journal-entry-heading'],
  'account-heading': REPORTING_WIDGETS['account-heading'],
  'entry-cell': REPORTING_WIDGETS['entry-cell'],
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
  'party-heading': REPORTING_WIDGETS['party-heading'],
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
  /**
   * The period-close run wizard, placed whole.
   *
   * A leaf, not a frame: it owns six stage bodies, its own navigation and its
   * own full-height shell, and decomposing eleven hundred lines of it into
   * blocks would reimplement it rather than compose it. Its page uses
   * `layout: 'bare'` so the wizard's shell is the only one.
   */
  'close-wizard': (props) => {
    const wizard = props.wizard as ComponentProps<typeof CloseWizard> | null
    if (!wizard) return null
    return <CloseWizard {...wizard} />
  },
  'page-layout-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof LayoutDrawer>['drawer'] | null
    if (!drawer) return null
    return <LayoutDrawer drawer={drawer} />
  },
  /** The "N of M routes customized" line under the list. */
  'page-layout-summary': (props) => (
    <p className="px-1 pt-2 text-xs text-slate-500 dark:text-slate-400">{str(props, 'text') ?? ''}</p>
  ),
  'new-script': () => <NewScriptButton />,
  'script-drawer': (props) => (
    <ScriptDrawer
      script={(props.script as ComponentProps<typeof ScriptDrawer>['script']) ?? null}
      runs={(props.runs as ComponentProps<typeof ScriptDrawer>['runs']) ?? []}
      customTypes={(props.customTypes as ComponentProps<typeof ScriptDrawer>['customTypes']) ?? []}
    />
  ),
  'party-link-cell': REPORTING_WIDGETS['party-link-cell'],
  'aging-strip': REPORTING_WIDGETS['aging-strip'],
  'statement-rows': REPORTING_WIDGETS['statement-rows'],
  'reconciliation-note': REPORTING_WIDGETS['reconciliation-note'],
  'empty-state': (props) => {
    // `action` names a widget rather than carrying JSX, so an empty state can
    // offer its create button without the spec expressing a component.
    const action = str(props, 'action')
    const renderer = action ? WIDGET_REGISTRY[action] : undefined
    // Icons are components, so the spec names one from a closed map rather
    // than carrying it — same rule as every other component reference.
    const icons: Record<string, ReactNode> = { 'key-round': <KeyRound />, building: <Building2 />, users: <Users />, mail: <Mail />, activity: <Activity />, send: <Send />, 'check-circle': <CheckCircle2 />, gauge: <Gauge />, camera: <Camera />, 'shield-check': <ShieldCheck />, 'scroll-text': <ScrollText />, trash: <Trash2 />, bell: <BellRing /> }
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
  /** A pill that renders nothing when the label is empty. The table's
   *  `badge` cell always emits its wrapper, so optional flags bind through
   *  here instead of leaving an empty pill behind. */
  'optional-badge': (props) => {
    const label = str(props, 'label')
    if (!label) return null
    const variant = str(props, 'variant') as ComponentProps<typeof Badge>['variant']
    return <Badge variant={variant}>{label}</Badge>
  },
  /** Due-date cell: the formatted date plus a red Overdue pill when past
   *  due — the house date-plus-flag arrangement, one cell. */
  'agents-due-cell': (props) => {
    const date = str(props, 'date')
    const overdueLabel = str(props, 'overdueLabel')
    if (!date && !overdueLabel) return null
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {date ? <span>{date}</span> : null}
        {overdueLabel ? <Badge variant="destructive">{overdueLabel}</Badge> : null}
      </span>
    )
  },
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
  'approvals-pagination': (props) => (
    <Pagination
      basePath="/approvals"
      currentParams={stringRecord(props, 'params') ?? {}}
      total={num(props, 'total') ?? 0}
      page={num(props, 'page') ?? 1}
      perPage={num(props, 'perPage') ?? 25}
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
      // Session remount key (F-t10-002): a duplicate opened after an edit
      // must not inherit the edit's mount-only state (notably isDefault).
      key={str(props, 'drawerKey') ?? 'form-drawer'}
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
      hrmEnabled={props.hrmEnabled === true}
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
   *  serves the page and the widget registry. */
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

  /* --- notifications inbox ---------------------------------------------------- */
  /** Not a `table` block: the inbox is a read/unread list whose rows mark
   *  themselves read on the way to the record they point at. */
  'notifications-inbox': (props) => (
    <NotificationsInbox
      rows={(props.rows as ComponentProps<typeof NotificationsInbox>['rows']) ?? []}
    />
  ),
  'notifications-mark-all-read': (props) => (
    <NotificationsMarkAllRead unread={num(props, 'unread') ?? 0} />
  ),
  'banking-roster': BANKING_WIDGETS['banking-roster'],
  'banking-match': BANKING_WIDGETS['banking-match'],
  'banking-attention-list': BANKING_WIDGETS['banking-attention-list'],
  'analytics-hub': REPORTING_WIDGETS['analytics-hub'],
  'reports-hub': REPORTING_WIDGETS['reports-hub'],
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
  /** The queue body: loader-resolved rows (newest first) plus loader-
   *  resolved strings. Lifecycle actions ride the existing
   *  ChangeRequestActions and API routes inside the island; no org id,
   *  user id or Authz crosses the spec. */
  'hrm-change-request-queue': (props) => (
    <ChangeRequestQueue
      rows={(props.rows as ComponentProps<typeof ChangeRequestQueue>['rows']) ?? []}
      columns={props.columns as ComponentProps<typeof ChangeRequestQueue>['columns']}
      canManage={props.canManage === true}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ChangeRequestQueue>['departmentOptions']) ?? []}
      proposeTitle={str(props, 'proposeTitle') ?? ''}
      proposeButton={str(props, 'proposeButton') ?? ''}
      proposeEmploymentLabel={str(props, 'proposeEmploymentLabel') ?? ''}
      proposeEmploymentPlaceholder={str(props, 'proposeEmploymentPlaceholder') ?? ''}
      proposeEmpty={str(props, 'proposeEmpty') ?? ''}
      proposeFailed={str(props, 'proposeFailed') ?? ''}
      draftBadge={str(props, 'draftBadge') ?? ''}
      openEmployee={str(props, 'openEmployee') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
      emptyTitle={str(props, 'emptyTitle') ?? ''}
      emptyDescription={str(props, 'emptyDescription') ?? ''}
      truncated={props.truncated === true}
      truncatedNote={str(props, 'truncatedNote') ?? ''}
    />
  ),
  /** Pending change requests: the five newest beside the queue link, or
   *  the scope refusal with its remedy intact. */
  'hrm-pending-requests': (props) => (
    <HrmPendingRequests
      items={(props.items as ComponentProps<typeof HrmPendingRequests>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      viewAllHref={str(props, 'viewAllHref') ?? ''}
      viewAllLabel={str(props, 'viewAllLabel') ?? ''}
      refusal={str(props, 'refusal') ?? null}
      notAvailable={str(props, 'notAvailable') ?? ''}
    />
  ),
  /** The honesty panel: unmigrated employees by count, the sentence that
   *  headcount excludes them, and the migration article. */
  'hrm-readiness': (props) => (
    <HrmReadiness
      message={str(props, 'message') ?? ''}
      docHref={str(props, 'docHref') ?? ''}
      docLabel={str(props, 'docLabel') ?? ''}
      tone={props.tone === 'warning' ? 'warning' : 'positive'}
    />
  ),
  /** The last recorded employment change events with their reasons. */
  'hrm-recent-changes': (props) => (
    <HrmRecentChanges
      items={(props.items as ComponentProps<typeof HrmRecentChanges>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
    />
  ),
  /** Starts and ends in the next 30 days, each half with its own empty state. */
  'hrm-upcoming-changes': (props) => (
    <HrmUpcomingChanges
      starts={(props.starts as ComponentProps<typeof HrmUpcomingChanges>['starts']) ?? []}
      ends={(props.ends as ComponentProps<typeof HrmUpcomingChanges>['ends']) ?? []}
      startsTitle={str(props, 'startsTitle') ?? ''}
      startsEmpty={str(props, 'startsEmpty') ?? ''}
      endsTitle={str(props, 'endsTitle') ?? ''}
      endsEmpty={str(props, 'endsEmpty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
      truncated={props.truncated === true}
      truncatedNote={str(props, 'truncatedNote') ?? ''}
    />
  ),
  /** A widget, not a slot: the loader already resolved headcount through the
   *  canonical read service and passes rows plus loader-resolved strings as
   *  data, so no org id, user id or Authz crosses the spec. */
  'hrm-headcount-table': (props) => (
    <HrmHeadcountTable
      groups={(props.groups as ComponentProps<typeof HrmHeadcountTable>['groups']) ?? []}
      total={num(props, 'total') ?? 0}
      employerColumn={str(props, 'employerColumn') ?? ''}
      departmentColumn={str(props, 'departmentColumn') ?? ''}
      headcountColumn={str(props, 'headcountColumn') ?? ''}
      unassigned={str(props, 'unassigned') ?? ''}
      empty={str(props, 'empty') ?? ''}
      totalLabel={str(props, 'totalLabel') ?? ''}
    />
  ),
  /** Status segments: server-side filter pills with per-status counts over
   *  loader-computed hrefs. A widget, not `filter-chips`: the hrefs carry the
   *  effective date as well as the status, so they are resolved in the loader
   *  and passed whole rather than rebuilt from a param key. */
  'hrm-position-segments': (props) => (
    <PositionSegments
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      segments={(props.segments as ComponentProps<typeof PositionSegments>['segments']) ?? []}
    />
  ),
  /** The funded-establishment vacancy table over loader-resolved rows plus
   *  loader-resolved strings — the same PositionsTable the native page
   *  renders, so the two cannot drift. */
  'hrm-positions-table': (props) => (
    <PositionsTable
      columns={(props.columns as ComponentProps<typeof PositionsTable>['columns']) ?? {}}
      rows={(props.rows as ComponentProps<typeof PositionsTable>['rows']) ?? []}
      empty={str(props, 'empty') ?? ''}
      totals={(props.totals as ComponentProps<typeof PositionsTable>['totals']) ?? { plannedFte: '0', fundedFte: '0', filledFte: '0', vacantFte: '0' }}
      totalLabel={str(props, 'totalLabel') ?? ''}
    />
  ),
  /** The position flyout: a URL drawer around the shared PositionDrawerBody
   *  that closes by navigation. Null payload renders nothing — the spec's
   *  `when` gate already omits it, so this is the second half of the same
   *  guard. */
  'hrm-position-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof PositionDrawer>['drawer']
    if (!drawer) return null
    return <PositionDrawer drawer={drawer} />
  },
  /** A widget, not a slot: the loader already resolved vacancy through the
   *  canonical position read service and passes rows plus loader-resolved
   *  strings as data, so no org id, user id or Authz crosses the spec. */
  'hrm-vacancy-table': (props) => (
    <VacancyTable
      groups={(props.groups as ComponentProps<typeof VacancyTable>['groups']) ?? []}
      total={(props.total as ComponentProps<typeof VacancyTable>['total']) ?? { positions: 0, plannedFte: '0.0000', fundedFte: '0.0000', filledFte: '0.0000', vacantFte: '0.0000' }}
      departmentColumn={str(props, 'departmentColumn') ?? ''}
      employerColumn={str(props, 'employerColumn') ?? ''}
      positionsColumn={str(props, 'positionsColumn') ?? ''}
      plannedColumn={str(props, 'plannedColumn') ?? ''}
      fundedColumn={str(props, 'fundedColumn') ?? ''}
      filledColumn={str(props, 'filledColumn') ?? ''}
      vacantColumn={str(props, 'vacantColumn') ?? ''}
      empty={str(props, 'empty') ?? ''}
      totalLabel={str(props, 'totalLabel') ?? ''}
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
  'paper-view': REPORTING_WIDGETS['paper-view'],
  /* --- app launcher ----------------------------------------------------------- */
  /** Flat props: widget props resolve one level deep, so the loader
   *  denormalizes each row and the spec binds per-item fields. */
  'app-launcher-card': (props) => (
    <AppLauncherCard
      href={str(props, 'href') ?? ''}
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      iconKey={str(props, 'iconKey') ?? ''}
      name={str(props, 'name') ?? ''}
      versionLine={str(props, 'versionLine') ?? ''}
      description={str(props, 'description') ?? ''}
      openLabel={str(props, 'openLabel') ?? ''}
    />
  ),
  'apps-empty-icon': () => <AppsEmptyIcon />,
  /** One parametric entry for three button shapes this page renders; none of
   *  the existing link buttons match any of them. */
  'apps-launcher-button': (props) => (
    <AppsLauncherButton
      href={str(props, 'href') ?? ''}
      label={str(props, 'label') ?? ''}
      icon={str(props, 'icon') === 'book' ? 'book' : 'library'}
      variant={str(props, 'variant') === 'outline' ? 'outline' : undefined}
      size={str(props, 'size') === 'sm' ? 'sm' : undefined}
      className={str(props, 'className')}
    />
  ),
  'payment-operations-tabs': BANKING_WIDGETS['payment-operations-tabs'],
  'new-setup-record': BANKING_WIDGETS['new-setup-record'],
  'payment-schedule-next-run': BANKING_WIDGETS['payment-schedule-next-run'],
  'payment-operations-editor': BANKING_WIDGETS['payment-operations-editor'],
  'reconcile-status-badge': BANKING_WIDGETS['reconcile-status-badge'],
  'reconcile-stats': BANKING_WIDGETS['reconcile-stats'],
  'reconcile-workspace': BANKING_WIDGETS['reconcile-workspace'],

  /* --- admin backups ---------------------------------------------------------- */
  /** Whole: a per-field schedule form, polling effects and fetch mutations
   *  are client state and capabilities, not spec vocabulary. */
  'backup-manager': (props) => (
    <BackupManager
      policy={(props.policy as ComponentProps<typeof BackupManager>['policy']) ?? null}
      runs={(props.runs as ComponentProps<typeof BackupManager>['runs']) ?? []}
      s3Enabled={props.s3Enabled === true}
      workerOnline={props.workerOnline === true}
    />
  ),

  /* --- platform hub ----------------------------------------------------------- */
  'platform-notice': () => <PlatformNotice />,
  /** Flat props, every value a string — not a single `tile` object. The icon
   *  is an `iconKey` lookup resolved here so the spec carries only data. */
  'platform-tile': (props) => (
    <PlatformTile
      href={str(props, 'href') ?? '#'}
      iconKey={
        (['building-2', 'users', 'key-round', 'mail'] as const).find(
          (k) => k === str(props, 'iconKey'),
        ) ?? 'building-2'
      }
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      stat={str(props, 'stat') ?? ''}
      detail={str(props, 'detail') ?? ''}
    />
  ),

  /* --- docs article ----------------------------------------------------------- */
  /** Conditional pairs throughout (category span, related block, prev/next
   *  with a bare-span placeholder) plus a client Markdown renderer. */
  'doc-article': (props) => (
    <DocArticleView content={props.content as ComponentProps<typeof DocArticleView>['content']} />
  ),
  'cash-cockpit': BANKING_WIDGETS['cash-cockpit'],

  /* --- data export ------------------------------------------------------------------ */
  /** No props: `ExportClient` fetches its own resource descriptors after
   *  mount and owns every string. The `query-console` precedent. */
  'data-export': () => <ExportClient />,
  /** Also no props: the import wizard owns its own `WizardLayout` shell and
   *  every step's state. `bare` layout, or the chrome nests. */
  'import-wizard': () => <ImportWizard />,
  'subcontracts-workspace': COMMERCE_WIDGETS['subcontracts-workspace'],
  'ap-header-actions': COMMERCE_WIDGETS['ap-header-actions'],
  'ap-cockpit': COMMERCE_WIDGETS['ap-cockpit'],
  'collections-shell': COMMERCE_WIDGETS['collections-shell'],

  /* --- document trash --------------------------------------------------------------- */
  /** Not `pageHeader({ back })`: that slot renders UiBackLink (`← label`),
   *  and this page's native back link is a chevron with its own classes. */
  'trash-back-link': (props) => (
    <TrashBackLink href={str(props, 'href') ?? '/documents'} label={str(props, 'label') ?? ''} />
  ),
  /** Passed whole: per-row busy state, the purge confirm dialog and the
   *  restore/delete fetches are client behaviour. */
  'trash-list': (props) => (
    <TrashList items={(props.rows as ComponentProps<typeof TrashList>['items']) ?? []} />
  ),
  'expenses-dashboard': COMMERCE_WIDGETS['expenses-dashboard'],
  'contract-drawer': COMMERCE_WIDGETS['contract-drawer'],
  'run-recognition': COMMERCE_WIDGETS['run-recognition'],

  /* --- platform sync ---------------------------------------------------------------- */
  /** No props. The console holds every fetch and mutation — a 2.5s live poll
   *  while a run is in flight, run/test/toggle-mirror/schedule/delete with
   *  busy flags, `window.open` for OAuth and the QWC download. */
  'sync-console': () => <PlatformClient />,
  'retro-workspace': PAYROLL_WIDGETS['retro-workspace'],
  'remittance-cockpit': PAYROLL_WIDGETS['remittance-cockpit'],
  'remittance-ap-note': PAYROLL_WIDGETS['remittance-ap-note'],
  'year-end-workspace': PAYROLL_WIDGETS['year-end-workspace'],

  /* --- admin islands ---------------------------------------------------------------- */
  /** The org nav-layout editor: unsaved client state, prompt() dialogs, a
   *  four-pin mobile limit with a toast, and a PUT save. */
  'nav-editor': (props) => (
    <NavEditor
      initial={props.initial as ComponentProps<typeof NavEditor>['initial']}
      apps={(props.apps as ComponentProps<typeof NavEditor>['apps']) ?? []}
    />
  ),
  /** THREE FLAT props, no wrapper bag — the bank-feeds division. */
  'features-workspace': (props) => (
    <FeaturesWorkspace {...(props as unknown as ComponentProps<typeof FeaturesWorkspace>)} />
  ),
  /** One pack's last-run cell: run-status badge, relative instant, muted next run. */
  'agents-pack-last-run': (props) => (
    <AgentsLastRunCell
      hasRun={props.hasRun === true}
      statusLabel={str(props, 'statusLabel') ?? ''}
      statusVariant={
        (props.statusVariant as ComponentProps<typeof AgentsLastRunCell>['statusVariant']) ?? 'secondary'
      }
      dateLine={str(props, 'dateLine') ?? ''}
      nextLine={str(props, 'nextLine') ?? null}
    />
  ),
  /** One pack's open-findings cell: link when above zero, muted text at zero. */
  'agents-pack-findings': (props) => (
    <AgentsPackFindings
      openFindings={typeof props.openFindings === 'number' ? props.openFindings : 0}
      findingsLine={str(props, 'findingsLine') ?? ''}
      reviewHref={str(props, 'reviewHref') ?? ''}
    />
  ),
  /** One pack's fenced enable switch + run-now for the Agents overview table. */
  'agents-pack-actions': (props) => (
    <AgentsPackActions
      agentKey={str(props, 'agentKey') ?? ''}
      policy={(props.policy as ComponentProps<typeof AgentsPackActions>['policy']) ?? {}}
      packTitle={str(props, 'packTitle') ?? ''}
      enabled={props.enabled === true}
      featureEnabled={props.featureEnabled === true}
      configureHref={str(props, 'configureHref') ?? ''}
      configureLabel={str(props, 'configureLabel') ?? ''}
    />
  ),
  /** One agent-pack marketplace card: medallion, reads/proposes, checks, install/configure footer. */
  'agents-pack-card': (props) => (
    <AgentsPackCard
      agentKey={str(props, 'agentKey') ?? ''}
      name={str(props, 'name') ?? ''}
      description={str(props, 'description') ?? ''}
      reads={str(props, 'reads') ?? ''}
      proposes={str(props, 'proposes') ?? ''}
      installed={props.installed === true}
      installedLabel={str(props, 'installedLabel') ?? ''}
      installLabel={str(props, 'installLabel') ?? ''}
      installPolicy={(props.installPolicy as ComponentProps<typeof AgentsPackCard>['installPolicy']) ?? {}}
      featureEnabled={props.featureEnabled === true}
      permissions={(props.permissions as string[]) ?? []}
      needsLabel={str(props, 'needsLabel') ?? ''}
      moduleLine={str(props, 'moduleLine') ?? ''}
      readsLabel={str(props, 'readsLabel') ?? ''}
      proposesLabel={str(props, 'proposesLabel') ?? ''}
      checksTitle={str(props, 'checksTitle') ?? ''}
      checksNote={str(props, 'checksNote') ?? ''}
      detectors={(props.detectors as ComponentProps<typeof AgentsPackCard>['detectors']) ?? []}
      configureHref={str(props, 'configureHref') ?? ''}
      configureLabel={str(props, 'configureLabel') ?? ''}
    />
  ),
  /** One pack's policy form: shared Card sections, shared form fields. */
  'agents-policy-form': (props) => (
    <AgentPolicyForm
      statusLabel={str(props, 'statusLabel') ?? ''}
      statusEnabled={props.statusEnabled === true}
      description={str(props, 'description') ?? ''}
      runLine={str(props, 'runLine') ?? ''}
      currency={str(props, 'currency') ?? ''}
      pack={props.pack as ComponentProps<typeof AgentPolicyForm>['pack']}
      specs={(props.specs as ComponentProps<typeof AgentPolicyForm>['specs']) ?? []}
      notification={(props.notification as ComponentProps<typeof AgentPolicyForm>['notification']) ?? null}
      roles={(props.roles as ComponentProps<typeof AgentPolicyForm>['roles']) ?? []}
      users={(props.users as ComponentProps<typeof AgentPolicyForm>['users']) ?? []}
      usersTruncated={props.usersTruncated === true}
      featureEnabled={props.featureEnabled === true}
    />
  ),
  /** One run's findings link + re-run for the Agents activity table. */
  'agents-run-actions': (props) => (
    <AgentsRunActions
      agentKey={str(props, 'agentKey') ?? ''}
      findingsHref={str(props, 'findingsHref') ?? ''}
      findingsLabel={str(props, 'findingsLabel') ?? ''}
    />
  ),
  /** Keyboard + bulk selection over the inbox's row links — the shared list
   *  cannot host ephemeral selection or global key handling. */
  'agents-triage-keys': (props) => (
    <AgentsTriageKeys {...(props as unknown as ComponentProps<typeof AgentsTriageKeys>)} />
  ),
  /** Muted keyboard helper for the paging row (never above the KPIs). The
   *  loader computed the localized sentence; this only binds the key caps —
   *  the first token of each ·-separated part — in the house kbd style. */
  'agents-triage-hint': (props) => {
    const text = str(props, 'text')
    if (!text) return null
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {text.split('·').map((part, index) => {
          const trimmed = part.trim()
          const space = trimmed.indexOf(' ')
          const key = space === -1 ? trimmed : trimmed.slice(0, space)
          const rest = space === -1 ? '' : trimmed.slice(space)
          return (
            <Fragment key={index}>
              {index > 0 ? ' · ' : null}
              <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                {key}
              </kbd>
              {rest}
            </Fragment>
          )
        })}
      </p>
    )
  },
  /** Loader-formatted `Kpi[]` straight through: the KPI strip's markup is not
   *  the stat-tile block's (same arrangement as `equipment-kpi-strip`). */
  'agents-kpi-strip': (props) => (
    <KpiStrip items={(props.items as ComponentProps<typeof KpiStrip>['items']) ?? []} />
  ),
  /** Retired-route landing notice (?from=continuous-close): loader-resolved
   *  strings, session-local dismiss. Renders nothing without a title. */
  'moved-notice': (props) => {
    const title = str(props, 'title')
    if (!title) return null
    return (
      <MovedNotice
        title={title}
        description={str(props, 'description') ?? ''}
        dismissLabel={str(props, 'dismissLabel') ?? ''}
      />
    )
  },
  /** The cached narrative's markdown. A widget, not a block, because no spec
   *  block renders markdown — the loader computed the text, this only binds
   *  the renderer. Null text renders nothing. */
  'agents-briefing-body': (props) => {
    const text = str(props, 'text')
    if (!text) return null
    return <ChatMarkdown>{text}</ChatMarkdown>
  },
  /** The briefing tab's only interactivity: generate + send buttons. */
  'agents-briefing-actions': (props) => (
    <AgentsBriefingActions {...(props as unknown as ComponentProps<typeof AgentsBriefingActions>)} />
  ),
  /** ONE prop. The secret ciphertext never leaves the engine module; only
   *  `hasSecret` crosses into the redacted view the loader reads. */
  'email-settings-form': (props) => (
    <EmailSettingsForm initial={props.initial as ComponentProps<typeof EmailSettingsForm>['initial']} />
  ),

  /** `selectedAgentKey` uses a typeof guard rather than `str()`, because the
   *  native page passes `null` for an unrecognized key and `undefined` would
   *  not reproduce it. */
  'ai-settings-form': (props) => (
    <AiSettingsForm
      specs={props.specs as ComponentProps<typeof AiSettingsForm>['specs']}
      initial={props.initial as ComponentProps<typeof AiSettingsForm>['initial']}
    />
  ),
  /** SEVEN FLAT props, no wrapper bag. The page is seven conditional PAIRS
   *  (a badge plus an optional count line; a footer CTA that swaps both href
   *  and label on one flag) — presence omits, it never chooses. */
  'invoicing-setup-workspace': (props) => (
    <InvoicingSettingsWorkspace
      {...(props as unknown as ComponentProps<typeof InvoicingSettingsWorkspace>)}
    />
  ),
  /** Whole, not a `table` block: search, the type dropdown and pagination are
   *  PagedTable CLIENT state that reads no URL params, so spec table blocks
   *  would navigate where the native page never does. */
  'pdf-templates-list': (props) => (
    <TemplatesList
      templates={(props.templates as ComponentProps<typeof TemplatesList>['templates']) ?? []}
      starters={(props.starters as ComponentProps<typeof TemplatesList>['starters']) ?? []}
      recordTypes={(props.recordTypes as ComponentProps<typeof TemplatesList>['recordTypes']) ?? []}
    />
  ),

  /* --- installed-app runtime -------------------------------------------------------- */
  /** ONE entry for BOTH notice branches (not-found and disabled): the markup
   *  is identical and only the strings differ, so a second entry would be a
   *  duplicate that drifts. */
  'app-notice': (props) => (
    <AppNotice
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      backHref={str(props, 'backHref') ?? '/apps'}
      backLabel={str(props, 'backLabel') ?? ''}
    />
  ),
  /** `context` is plain data — app id/key/name plus the caller's id, name and
   *  role KEYS — not an `Authz`. The sandbox that consumes it lives inside
   *  `AppFrame`. */
  'native-extension': props => <NativeExtension appKey={str(props, 'appKey') ?? ''} searchParams={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />,
  'app-runtime-chrome': (props) => (
    <AppRuntimeChrome
      appKey={str(props, 'appKey') ?? ''}
      appName={str(props, 'appName') ?? ''}
      appsHref={str(props, 'appsHref') ?? '/apps'}
      appsLabel={str(props, 'appsLabel') ?? ''}
      context={props.context as ComponentProps<typeof AppRuntimeChrome>['context']}
    />
  ),
  'provision-runs-table': ASSETS_TAX_WIDGETS['provision-runs-table'],
  'provision-compute-button': ASSETS_TAX_WIDGETS['provision-compute-button'],
  'equipment-header-links': ASSETS_TAX_WIDGETS['equipment-header-links'],
  'equipment-kpi-strip': ASSETS_TAX_WIDGETS['equipment-kpi-strip'],
  /** The generic KPI strip — every KPI row is the house KpiStrip. */
  'kpi-strip': (props) => (
    <KpiStrip items={(props.items as ComponentProps<typeof KpiStrip>['items']) ?? []} />
  ),
  'new-equipment': ASSETS_TAX_WIDGETS['new-equipment'],
  'equipment-drawer': ASSETS_TAX_WIDGETS['equipment-drawer'],

  /* --- insights dashboard builder --------------------------------------------------- */
  /** Whole: a drag-and-drop board with a card palette, placement state and
   *  publish/pin mutations. The two decisions that matter — draft-card
   *  visibility and the palette's `insightVisibilitySql` fence — are made in
   *  the loader, where they belong. */
  'insights-dashboard-builder': (props) => (
    <DashboardBuilder
      dashboard={props.dashboard as ComponentProps<typeof DashboardBuilder>['dashboard']}
      cards={props.cards as ComponentProps<typeof DashboardBuilder>['cards']}
      availableCards={props.availableCards as ComponentProps<typeof DashboardBuilder>['availableCards']}
      pinned={props.pinned === true}
      canCreate={props.canCreate === true}
      canPublish={props.canPublish === true}
    />
  ),

  /* --- API console ------------------------------------------------------------------ */
  /** The schema IS server data — the same plain-data prop the native page
   *  hands the component — so it travels as a literal widget prop. Nothing
   *  here is a capability or an org id, so no slot is needed. */
  'api-console': (props) => (
    <ApiConsole schema={(props.schema as ComponentProps<typeof ApiConsole>['schema']) ?? []} />
  ),
  'opening-balances-grid': PAYROLL_WIDGETS['opening-balances-grid'],
  'entitlement-openings-grid': PAYROLL_WIDGETS['entitlement-openings-grid'],
  'tax-setup-header': ASSETS_TAX_WIDGETS['tax-setup-header'],
  'tax-setup-guide': ASSETS_TAX_WIDGETS['tax-setup-guide'],

  /* --- setup wizard ----------------------------------------------------------------- */
  /** FIVE FLAT props. Ten animated steps, each owning state, mutations and
   *  framer-motion transitions. */
  'setup-wizard': (props) => (
    <SetupWizard {...(props as unknown as ComponentProps<typeof SetupWizard>)} />
  ),

  /* --- payment providers setup ------------------------------------------------------ */
  /** No props: the island fetches its own providers, bank accounts and
   *  surcharge rules and owns every form. */
  'payment-providers-workspace': () => <PaymentProvidersClient />,
  'depreciation-setup-header': ASSETS_TAX_WIDGETS['depreciation-setup-header'],

  /* --- security settings ------------------------------------------------------------ */
  /** No props. Every control is client state or a fetch to /api/auth/*. */
  'security-panel': () => <SecurityPageContent />,

  /* --- project types setup ---------------------------------------------------------- */
  /** FOUR FLAT props. `incomeAccounts` is loaded but currently unread by the
   *  workspace (it destructures it away) — passed anyway, so both renders
   *  carry identical data and a future read cannot diverge them. */
  'project-types-workspace': (props) => (
    <ProjectTypesWorkspace {...(props as unknown as ComponentProps<typeof ProjectTypesWorkspace>)} />
  ),
  'separations-workspace': PAYROLL_WIDGETS['separations-workspace'],

  /* --- sandboxes -------------------------------------------------------------------- */
  /** Whole, and the per-row mutations are the reason: create / refresh /
   *  reset / delete / setSchedule / promote are BOUND SERVER ACTIONS. A spec
   *  may not carry one, so they stay inside the component wherever it renders
   *  rather than being lifted into props. */
  /** The remount key rides along as a prop: reviewing a different change set
   *  must reset the drawer's approval state. */
  'change-set-drawer': (props) => {
    const drawer = props.drawer as
      | (ComponentProps<typeof ChangeSetDrawer> & { remountKey: string })
      | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <ChangeSetDrawer key={remountKey} {...rest} />
  },
  'sandbox-manager': (props) => (
    <SandboxManager
      sandboxes={props.sandboxes as ComponentProps<typeof SandboxManager>['sandboxes']}
      periods={props.periods as ComponentProps<typeof SandboxManager>['periods']}
    />
  ),
  'delivery-panel': REPORTING_WIDGETS['delivery-panel'],
  /** Whole: per-row adjustment forms, the reason capture and the file/void
   *  actions are client state. The ledger figure and the filed figure are both
   *  on every row by design — never one silently replacing the other. */
  'filing-worksheet': (props) => (
    <FilingWorksheet
      filing={props.filing as ComponentProps<typeof FilingWorksheet>['filing']}
      boxes={props.boxes as ComponentProps<typeof FilingWorksheet>['boxes']}
      canManage={props.canManage === true}
      canFile={props.canFile === true}
    />
  ),
  /** `permissions` is PERMISSION_CATALOGUE — the static list of permission
   *  KEYS the app defines, for the gate inspector's picker. A catalogue, not a
   *  grant: nothing about it is caller-specific and it confers nothing. */
  'flow-builder': (props) => (
    <FlowBuilder
      flow={props.flow as ComponentProps<typeof FlowBuilder>['flow']}
      runs={props.runs as ComponentProps<typeof FlowBuilder>['runs']}
      profile={props.profile as ComponentProps<typeof FlowBuilder>['profile']}
      users={props.users as ComponentProps<typeof FlowBuilder>['users']}
      roles={props.roles as ComponentProps<typeof FlowBuilder>['roles']}
      permissions={props.permissions as ComponentProps<typeof FlowBuilder>['permissions']}
    />
  ),
  'report-builder': REPORTING_WIDGETS['report-builder'],
  /** The GrapesJS canvas: its own document model, drag-and-drop, the
   *  merge-field palette and every save/preview mutation. */
  'pdf-template-editor': (props) => (
    <PdfTemplateEditor
      template={props.template as ComponentProps<typeof PdfTemplateEditor>['template']}
      mergeFields={props.mergeFields as ComponentProps<typeof PdfTemplateEditor>['mergeFields']}
      collections={props.collections as ComponentProps<typeof PdfTemplateEditor>['collections']}
    />
  ),
  'wip-billing-workspace': COMMERCE_WIDGETS['wip-billing-workspace'],

  /* --- home dashboard --------------------------------------------------------------- */
  /** The greeting row. The loader resolves the greeting string (locale +
   *  first name, org zone) and passes the name through so the header can
   *  re-derive the stem in the browser zone on mount; the Customize link
   *  lives inside the component. */
  'dashboard-header': (props) => <DashboardHeader greeting={str(props, 'greeting') ?? ''} name={str(props, 'name') ?? null} />,
  /** A SLOT, not a props widget. `DashboardGrid` needs rendered tile nodes
   *  and a bound `saveQuickActions` server action — component references and
   *  a capability, neither of which a spec may carry. The slot re-derives
   *  both from the session; the spec names the block and nothing else. */
  'dashboard-grid': () => <DashboardGridSlot />,
  /** Not `pageHeader({ back })`: that slot renders UiBackLink, and this page's
   *  back link is a 12px lucide ArrowLeft with different classes again. */
  'dashboard-customize-header': (props) => (
    <CustomizeDashboardHeader
      backHref={str(props, 'backHref') ?? '/dashboard'}
      backLabel={str(props, 'backLabel') ?? ''}
      title={str(props, 'title') ?? ''}
      roleLabel={str(props, 'roleLabel') ?? ''}
    />
  ),
  /** The edit canvas, also a SLOT — and more emphatically than the view one:
   *  besides the tile nodes and the bound save action it needs
   *  `allowedWidgetIds`, a per-caller PERMISSION decision. That must not be
   *  reachable from a spec. */
  'dashboard-edit': () => <DashboardEditSlot />,

  /* --- assistant -------------------------------------------------------------------- */
  /** Whole: sidebar, streaming thread, composer and every fetch. Serves both
   *  /assistant and /assistant/[id]: `activeId` and `initialMessages` default
   *  to the new-conversation values the launcher route passes natively, and
   *  the deep-link route binds real ones. Hardcoding them here would have made
   *  this entry a single route's assumption wearing a general name. */
  'assistant-app': (props) => (
    <AssistantApp
      conversations={props.conversations as ComponentProps<typeof AssistantApp>['conversations']}
      activeId={str(props, 'activeId') ?? null}
      initialMessages={
        (props.initialMessages as ComponentProps<typeof AssistantApp>['initialMessages']) ?? []
      }
      canWrite={props.canWrite === true}
      canConfigureAi={props.canConfigureAi === true}
      aiEnabled={props.aiEnabled === true}
      initialPrompt={str(props, 'initialPrompt')}
      initialFindingId={str(props, 'initialFindingId')}
    />
  ),
  'choose-recon-account': BANKING_WIDGETS['choose-recon-account'],
  'report-period-filter': REPORTING_WIDGETS['report-period-filter'],
  'cashflow-horizon-control': REPORTING_WIDGETS['cashflow-horizon-control'],
  'cashflow-view': REPORTING_WIDGETS['cashflow-view'],
  'financial-health-view': REPORTING_WIDGETS['financial-health-view'],
  'utilization-view': REPORTING_WIDGETS['utilization-view'],
  'spend-velocity-view': REPORTING_WIDGETS['spend-velocity-view'],
  'vendor-view': REPORTING_WIDGETS['vendor-view'],
  'customer-view': REPORTING_WIDGETS['customer-view'],
  'true-cost-view': REPORTING_WIDGETS['true-cost-view'],
  'sentinel-view': REPORTING_WIDGETS['sentinel-view'],

  /* --- app library ---------------------------------------------------------------- */
  /** Seven FLAT props. The install button is not a separate widget: it is
   *  the card's footer and never renders without it. */
  'listing-card': (props) => (
    <ListingCard
      listingId={str(props, 'listingId') ?? ''}
      listingKey={str(props, 'listingKey') ?? ''}
      name={str(props, 'name') ?? ''}
      versionLine={str(props, 'versionLine') ?? ''}
      description={str(props, 'description') ?? ''}
      installed={props.installed === true}
      current={props.current === true}
      canInstall={props.canInstall === undefined || Boolean(props.canInstall)}
    />
  ),
  /** NOT `apps-empty-icon` — that one renders Boxes; this renders Library. */
  'library-empty-icon': () => <LibraryEmptyIcon />,
  'tax-depreciation-header': ASSETS_TAX_WIDGETS['tax-depreciation-header'],
  'tax-depreciation-overview': ASSETS_TAX_WIDGETS['tax-depreciation-overview'],
  'provision-recon-section': ASSETS_TAX_WIDGETS['provision-recon-section'],
  'provision-differences-section': ASSETS_TAX_WIDGETS['provision-differences-section'],
  'provision-status-badge': ASSETS_TAX_WIDGETS['provision-status-badge'],
  'provision-framework-badge': ASSETS_TAX_WIDGETS['provision-framework-badge'],
  'provision-post-button': ASSETS_TAX_WIDGETS['provision-post-button'],
  'parallel-run-workspace': PAYROLL_WIDGETS['parallel-run-workspace'],
  'bank-feeds-workspace': BANKING_WIDGETS['bank-feeds-workspace'],

  /* --- docs home -------------------------------------------------------------- */
  /** A gradient hero, composite link cards and hover-reveal arrows: generic
   *  blocks would need new vocabulary to say any of it, so it stays one
   *  component with a single `content` object. */
  'docs-home': (props) => (
    <DocsHome content={props.content as ComponentProps<typeof DocsHome>['content']} />
  ),
  'property-management-workspace': COMMERCE_WIDGETS['property-management-workspace'],
  'ar-cockpit': COMMERCE_WIDGETS['ar-cockpit'],

  /* --- crm setup -------------------------------------------------------------- */
  /** One client island, like the labor-costing workspace. Six per-tab column
   *  sets with row-click routing are a six-way conditional pair, not presence,
   *  and neither table variant can carry row navigation. */
  'crm-setup-workspace': (props) => (
    <CrmSetupWorkspace {...(props as ComponentProps<typeof CrmSetupWorkspace>)} />
  ),

  /* --- admin apps ------------------------------------------------------------ */
  /** Not `link-button` (solid, no icon) and not `docs-link-button` (BookOpen):
   *  the library action uses the same default size as the primary New button. */
  'apps-library-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline">
        <Link href={href as never}>
          <Library size={15} /> {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  'app-key-cell': (props) => <AppKeyCell appKey={str(props, 'appKey') ?? ''} />,
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
  'capture-upload': COMMERCE_WIDGETS['capture-upload'],
  'capture-list': COMMERCE_WIDGETS['capture-list'],
  'capture-not-configured': COMMERCE_WIDGETS['capture-not-configured'],
  'capture-review-drawer': COMMERCE_WIDGETS['capture-review-drawer'],
  'project-profitability-table': REPORTING_WIDGETS['project-profitability-table'],

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

  /* --- allocations setup ------------------------------------------------------ */
  'allocations-setup-header': (props) => (
    <AllocationsSetupHeader {...(props as ComponentProps<typeof AllocationsSetupHeader>)} />
  ),
  'allocations-rules-tab': (props) => (
    <AllocationsRulesTabSlot {...(props as ComponentProps<typeof AllocationsRulesTabSlot>)} />
  ),
  'allocations-drivers-tab': () => <AllocationsDriversTabSlot />,
  'allocations-rule-drawer': (props) => (
    <AllocationsRuleDrawerSlot {...(props as ComponentProps<typeof AllocationsRuleDrawerSlot>)} />
  ),
  'allocations-runs-tab': () => <AllocationsRunsTabSlot />,

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
      progressOf={str(props, 'progressOf') ?? ''}
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
  'saved-view-header': REPORTING_WIDGETS['saved-view-header'],
  'saved-view-meta': REPORTING_WIDGETS['saved-view-meta'],
  'result-view': REPORTING_WIDGETS['result-view'],
  'balance-check': REPORTING_WIDGETS['balance-check'],
  'match-workspace': BANKING_WIDGETS['match-workspace'],
  'psp-settlements': BANKING_WIDGETS['psp-settlements'],
  'payroll-setup-header': PAYROLL_WIDGETS['payroll-setup-header'],
  'payroll-setup-banner': PAYROLL_WIDGETS['payroll-setup-banner'],
  'payroll-setup-tabs': PAYROLL_WIDGETS['payroll-setup-tabs'],
  'payroll-packs-tab': PAYROLL_WIDGETS['payroll-packs-tab'],
  'payroll-accounts-tab': PAYROLL_WIDGETS['payroll-accounts-tab'],
  'payroll-payday-tab': PAYROLL_WIDGETS['payroll-payday-tab'],
  'payroll-rates-tab': PAYROLL_WIDGETS['payroll-rates-tab'],
  'payroll-schedules-tab': PAYROLL_WIDGETS['payroll-schedules-tab'],
  'payroll-derived-preview-tab': PAYROLL_WIDGETS['payroll-derived-preview-tab'],
  'payroll-holidays-tab': PAYROLL_WIDGETS['payroll-holidays-tab'],
  'payroll-holiday-calendar-tab': PAYROLL_WIDGETS['payroll-holiday-calendar-tab'],

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
  'labor-costing-header-actions': PAYROLL_WIDGETS['labor-costing-header-actions'],
  'labor-costing-tabs': PAYROLL_WIDGETS['labor-costing-tabs'],
  'labor-costing-workspace': PAYROLL_WIDGETS['labor-costing-workspace'],
  'labor-pricing-heading': PAYROLL_WIDGETS['labor-pricing-heading'],
  'labor-pricing-view': PAYROLL_WIDGETS['labor-pricing-view'],
  'pay-run-wizard': PAYROLL_WIDGETS['pay-run-wizard'],
  'payroll-settings-banner': PAYROLL_WIDGETS['payroll-settings-banner'],
  'payroll-current-period': PAYROLL_WIDGETS['payroll-current-period'],
  'payroll-previous-run': PAYROLL_WIDGETS['payroll-previous-run'],
  'payroll-manage-links': PAYROLL_WIDGETS['payroll-manage-links'],

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
  'tax-page': ASSETS_TAX_WIDGETS['tax-page'],
  'tax-filing-drawer': ASSETS_TAX_WIDGETS['tax-filing-drawer'],
  'relationships-section': COMMERCE_WIDGETS['relationships-section'],
  'customer-ar-pulse': COMMERCE_WIDGETS['customer-ar-pulse'],

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
  /** Invite entry point for the Users page header. The button owns its own
   *  drawer and strings (like the roles page's `new-role`), so the widget
   *  carries only the role picker options. */
  'invite-user': (props) => (
    <InviteUserButton
      allRoles={(props.allRoles as ComponentProps<typeof InviteUserButton>['allRoles']) ?? []}
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
  'new-payment': BANKING_WIDGETS['new-payment'],
  'new-payment-run': BANKING_WIDGETS['new-payment-run'],
  'payments-view-tabs': BANKING_WIDGETS['payments-view-tabs'],
  'receipts-view-tabs': BANKING_WIDGETS['receipts-view-tabs'],
  'payments-section': BANKING_WIDGETS['payments-section'],
  'payment-runs-section': BANKING_WIDGETS['payment-runs-section'],

  /* --- file cabinet --------------------------------------------------------- */
  'documents-actions': (props) => (
    <DocumentsActions
      trashHref={str(props, 'trashHref') ?? '/documents/trash'}
      trashLabel={str(props, 'trashLabel') ?? ''}
      newFolder={<NewFolderButton />}
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
  'bank-feed-panel': BANKING_WIDGETS['bank-feed-panel'],

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
  'new-pay-run': PAYROLL_WIDGETS['new-pay-run'],
  'pay-run-row-actions': PAYROLL_WIDGETS['pay-run-row-actions'],
  'field-ticket-drawer': COMMERCE_WIDGETS['field-ticket-drawer'],
  'new-bank-rule': BANKING_WIDGETS['new-bank-rule'],
  'run-bank-rules': BANKING_WIDGETS['run-bank-rules'],
  'bank-rule-drawer': BANKING_WIDGETS['bank-rule-drawer'],

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
  'items-header-actions': COMMERCE_WIDGETS['items-header-actions'],
  'new-item': COMMERCE_WIDGETS['new-item'],
  'new-item-redirect': COMMERCE_WIDGETS['new-item-redirect'],
  'item-drawer': COMMERCE_WIDGETS['item-drawer'],
  'new-movement': COMMERCE_WIDGETS['new-movement'],
  'inventory-action-drawer': COMMERCE_WIDGETS['inventory-action-drawer'],
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
      body={(props.body as Record<string, unknown> | undefined) ?? undefined}
    />
  ),
  'activity-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof ActivityDrawer> | null
    if (!drawer) return null
    return <ActivityDrawer {...drawer} />
  },
  'opportunity-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof OpportunityDrawer> | null
    if (!drawer) return null
    return <OpportunityDrawer {...drawer} />
  },
  'opportunity-view-switcher': (props) => {
    const view = (props.view as 'board' | 'list') ?? 'list'
    return <OpportunityViewSwitcher view={view} />
  },
  'opportunity-kanban-board': (props) => {
    const statuses = (props.statuses as ComponentProps<typeof OpportunityKanbanBoard>['statuses']) ?? []
    const opportunities = (props.opportunities as ComponentProps<typeof OpportunityKanbanBoard>['opportunities']) ?? []
    const canManage = Boolean(props.canManage)
    const drawerSlot = (props.drawer as unknown[])?.length
      ? <Fragment>{(props.drawer as { widget?: string; props?: Record<string, unknown> }[]).map((d, i) => {
          const r = d.widget ? WIDGET_REGISTRY[d.widget] : undefined
          return r ? <Fragment key={i}>{r(d.props ?? {})}</Fragment> : null
        })}</Fragment>
      : undefined
    return (
      <OpportunityKanbanBoard
        statuses={statuses}
        opportunities={opportunities}
        canManage={canManage}
        drawerSlot={drawerSlot}
      />
    )
  },
  'new-expense': COMMERCE_WIDGETS['new-expense'],
  'expense-row-actions': COMMERCE_WIDGETS['expense-row-actions'],
  'expense-drawer': COMMERCE_WIDGETS['expense-drawer'],

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
  /** The run badge stacked over the lock-detail line (null when unlocked). */
  'close-status-cell': (props) => (
    <CloseStatusCell
      statusLabel={str(props, 'statusLabel') ?? ''}
      statusVariant={
        props.statusVariant === 'success' || props.statusVariant === 'warning'
          ? props.statusVariant
          : 'outline'
      }
      lockLabel={(props.lockLabel as string | null) ?? null}
    />
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
  'new-order': COMMERCE_WIDGETS['new-order'],
  'new-order-redirect': COMMERCE_WIDGETS['new-order-redirect'],
  'order-drawer': COMMERCE_WIDGETS['order-drawer'],

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
  'assets-tabs': ASSETS_TAX_WIDGETS['assets-tabs'],
  'assets-doc-link': ASSETS_TAX_WIDGETS['assets-doc-link'],
  'assets-equipment-link': ASSETS_TAX_WIDGETS['assets-equipment-link'],
  'new-asset': ASSETS_TAX_WIDGETS['new-asset'],
  'new-asset-redirect': ASSETS_TAX_WIDGETS['new-asset-redirect'],
  'run-depreciation': ASSETS_TAX_WIDGETS['run-depreciation'],
  'asset-drawer': ASSETS_TAX_WIDGETS['asset-drawer'],
  'tax-pools': ASSETS_TAX_WIDGETS['tax-pools'],

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
    <NewRecordButton typeKey={str(props, 'typeKey') ?? ''} typeName={str(props, 'typeName') ?? ''} basePath={str(props, 'basePath')} currentParams={props.currentParams as Record<string, string | string[] | undefined> | undefined} />
  ),
  'record-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof RecordDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <RecordDrawer key={remountKey} {...rest} />
  },
  'account-stats': BANKING_WIDGETS['account-stats'],
  'unmatched-count-cell': BANKING_WIDGETS['unmatched-count-cell'],
  'recon-action-cell': BANKING_WIDGETS['recon-action-cell'],
  'import-statement': BANKING_WIDGETS['import-statement'],
  'start-reconciliation': BANKING_WIDGETS['start-reconciliation'],
  'statement-drawer': BANKING_WIDGETS['statement-drawer'],

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
          appliedPayments?: { payments: AppliedPayment[]; currency: string } | null
        })
      | null
    if (!drawer) return null
    const { remountKey, paymentLinks, appliedPayments, ...rest } = drawer
    return (
      <DocumentDrawer
        key={remountKey}
        {...rest}
        afterContent={
          paymentLinks || appliedPayments ? (
            <>
              {appliedPayments ? (
                <AppliedPaymentsPanel payments={appliedPayments.payments} currency={appliedPayments.currency} />
              ) : null}
              {paymentLinks ? (
                <PaymentLinksPanel documentId={paymentLinks.documentId} canManage={paymentLinks.canManage} />
              ) : null}
            </>
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
  'new-project': COMMERCE_WIDGETS['new-project'],
  'new-project-redirect': COMMERCE_WIDGETS['new-project-redirect'],
  'project-drawer': COMMERCE_WIDGETS['project-drawer'],

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
    // same fragment the page passed.
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
  'new-report': REPORTING_WIDGETS['new-report'],
  'report-name-cell': REPORTING_WIDGETS['report-name-cell'],
  'custom-report-actions': REPORTING_WIDGETS['custom-report-actions'],
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
  'save-view': REPORTING_WIDGETS['save-view'],
  'export-menu': REPORTING_WIDGETS['export-menu'],
  'schedule-report': REPORTING_WIDGETS['schedule-report'],
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
