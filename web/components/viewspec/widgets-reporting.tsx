import { type ComponentProps } from 'react'
import {
  ExportMenu,
  SaveViewButton,
  ScheduleReportButton,
  StatementMatrixTable,
  AnalyticsHub,
  ReportsHub,
  ReportBuilder,
  DeliveryPanel,
  ReportFilterBar,
  CashflowView,
  HorizonControl,
  CustomerView,
  FinancialHealthView,
  SentinelView,
  SpendVelocityView,
  UtilizationView,
  ReceivablesView,
  VendorView,
  TrueCostView,
  ProjectProfitabilityTable,
  ResultView,
  PaperView,
  NewReportButton,
  CustomReportActions,
  NlAskPanel,
} from './native-widgets.client'
import { JournalEntryHeading } from '../../app/(app)/reports/journal/sections'
import { AccountHeading, EntryCell } from '../../app/(app)/reports/general-ledger/sections'
import { PartyHeading } from '../../app/(app)/reports/registers/sections'
import { PartyLinkCell } from '../../app/(app)/reports/aging/sections'
import { AgingStrip } from '../../app/(app)/reports/statements/[partyId]/sections'
import { StatementRows, ReconciliationNote } from '../../app/(app)/reports/StatementRows'
import { ReportNameCell } from '../../app/(app)/reports/custom/sections'
import { BalanceCheck } from '../../app/(app)/reports/balance-sheet/sections'
import { SavedViewHeader, SavedViewMeta } from '../../app/(app)/knowledge/views/[id]/sections'
import { str, num, stringRecord, type WidgetRenderer } from './widget-props'

/** Reporting adapters. Compose native components without changing their props or boundaries. */
export const REPORTING_WIDGETS = {
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
  'party-link-cell': (props) => (
    <PartyLinkCell
      partyId={(props.partyId as string | null) ?? null}
      partyName={str(props, 'partyName') ?? ''}
      href={str(props, 'href') ?? ''}
      note={str(props, 'note')}
    />
  ),
  'aging-strip': (props) => (
    <AgingStrip
      cells={(props.cells as ComponentProps<typeof AgingStrip>['cells']) ?? []}
      asOfLabel={str(props, 'asOfLabel') ?? ''}
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

  /* --- launchers and consoles ------------------------------------------------ */
  /** Both are whole client components that own their own search, icon maps and
   *  editor state. Decomposing either would reimplement it, not compose it. */
  'analytics-hub': (props) => (
    <AnalyticsHub
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      groups={(props.groups as ComponentProps<typeof AnalyticsHub>['groups']) ?? []}
      initialLayout={props.initialLayout as ComponentProps<typeof AnalyticsHub>['initialLayout']}
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

  /** Schedule forms, cadence pickers, recipient editing and the run list's
   *  retry actions — all client state. */
  'delivery-panel': (props) => (
    <DeliveryPanel
      definitionId={str(props, 'definitionId') ?? ''}
      schedules={props.schedules as ComponentProps<typeof DeliveryPanel>['schedules']}
      recentRuns={props.recentRuns as ComponentProps<typeof DeliveryPanel>['recentRuns']}
      canSchedule={props.canSchedule === true}
    />
  ),
  /** `hiddenEntityKeys` is a per-caller PERMISSION result — the entities this
   *  reader may not query — resolved in the loader and travelling as a plain
   *  string array. The `Authz` it came from does not. */
  'report-builder': (props) => (
    <ReportBuilder
      customEntities={props.customEntities as ComponentProps<typeof ReportBuilder>['customEntities']}
      hiddenEntityKeys={props.hiddenEntityKeys as ComponentProps<typeof ReportBuilder>['hiddenEntityKeys']}
      inventoryEnabled={props.inventoryEnabled === true}
      company={str(props, 'company') ?? ''}
      definition={props.definition as ComponentProps<typeof ReportBuilder>['definition']}
      createMode={props.createMode === true}
    />
  ),

  /* --- analytics dashboards --------------------------------------------------------- */
  //
  // Seven dashboards, one shape: the `analytics-header` frame over a single
  // bespoke client view. Each view owns charts, drill tables and client
  // filter state; decomposing them into generic blocks would reimplement the
  // component rather than compose it — the `paper-view` precedent.
  //
  // Dashboards share one native period control; point-in-time dashboards
  // may choose a different default without introducing another filter bar.
  'report-period-filter': (props) => <ReportFilterBar controls={{ period: true }} defaultPeriod={str(props, 'defaultPeriod')} periodPresets={props.periodPresets as ComponentProps<typeof ReportFilterBar>['periodPresets']} />,
  'cashflow-horizon-control': (props) => <HorizonControl value={num(props, 'value') ?? 4} />,
  'cashflow-view': (props) => (
    <CashflowView data={props.data as ComponentProps<typeof CashflowView>['data']} />
  ),
  /** `defs` is RATIO_DEFS: a static table of ratio definitions, plain data,
   *  not a component or a capability. */
  'financial-health-view': (props) => (
    <FinancialHealthView
      data={props.data as ComponentProps<typeof FinancialHealthView>['data']}
      defs={props.defs as ComponentProps<typeof FinancialHealthView>['defs']}
      budgetsEnabled={props.budgetsEnabled === true}
      canConfigure={props.canConfigure === true}
    />
  ),
  'utilization-view': (props) => (
    <UtilizationView
      data={props.data as ComponentProps<typeof UtilizationView>['data']}
      canConfigure={props.canConfigure === true}
    />
  ),
  'spend-velocity-view': (props) => (
    <SpendVelocityView
      data={props.data as ComponentProps<typeof SpendVelocityView>['data']}
      canConfigure={props.canConfigure === true}
    />
  ),
  'receivables-view': (props) => <ReceivablesView data={props.data as ComponentProps<typeof ReceivablesView>['data']} canOpenCustomers={props.canOpenCustomers === true} />,
  'vendor-view': (props) => (
    <VendorView
      data={props.data as ComponentProps<typeof VendorView>['data']}
      canConfigure={props.canConfigure === true}
    />
  ),
  'customer-view': (props) => (
    <CustomerView
      data={props.data as ComponentProps<typeof CustomerView>['data']}
      profitability={props.profitability as ComponentProps<typeof CustomerView>['profitability']}
      projectsEnabled={props.projectsEnabled === true}
      canConfigure={props.canConfigure === true}
    />
  ),
  'true-cost-view': (props) => (
    <TrueCostView data={props.data as ComponentProps<typeof TrueCostView>['data']} />
  ),
  'sentinel-view': (props) => (
    <SentinelView
      data={props.data as ComponentProps<typeof SentinelView>['data']}
      canConfigure={props.canConfigure === true}
    />
  ),

  /* --- project profitability -------------------------------------------------- */
  /** Not `paper-view`: that would restyle the page's section wrappers and
   *  silently drop the negative-money colouring. Diffed, kept separate. */
  'project-profitability-table': (props) => (
    <ProjectProfitabilityTable {...(props as ComponentProps<typeof ProjectProfitabilityTable>)} />
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
  'new-report': () => <NewReportButton />,
  /** Ask box: the island null-guards while the actor has no assistant access. */
  'reports-nl-ask': (props) => (
    <NlAskPanel
      ask={(props.ask as ComponentProps<typeof NlAskPanel>['ask']) ?? null}
      canCreate={props.canCreate === true}
    />
  ),
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
} satisfies Record<string, WidgetRenderer>
