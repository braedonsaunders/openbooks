import { NativeListDrawer } from '../native-list-drawer'
import { type ComponentProps } from 'react'
import { ModuleHomeTabs } from '../module-home/ui'
import { RelationshipsSection, ArPulse as CustomerArPulse } from '../../app/(app)/customers/sections'
import { ArCockpit } from '../../app/(app)/ar/cockpit/ArCockpit'
import { SubcontractsWorkspace } from '../../app/(app)/subcontracts/SubcontractsWorkspace'
import { ApCockpit } from '../../app/(app)/ap/cockpit/ApCockpit'
import { ApHeaderActions } from '../../app/(app)/ap/sections'
import { CollectionsShell } from '../../app/(app)/collections/sections'
import { AttemptDrawer } from '../../app/(app)/collections/AttemptDrawer'
import { RecoveryDashboard } from '../../app/(app)/collections/RecoveryDashboard'
import { ExpensesDashboard } from '../../app/(app)/expenses/ExpensesDashboard'
import { ContractDrawer } from '../../app/(app)/revenue/ContractDrawer'
import { RunRecognitionButton } from '../../app/(app)/revenue/RunRecognitionButton'
import { ContractCostDrawer } from '../../app/(app)/revenue/contract-costs/ContractCostDrawer'
import { ContractCostWorkspace } from '../../app/(app)/revenue/contract-costs/ContractCostWorkspace'
import { CapitalizeButton } from '../../app/(app)/revenue/contract-costs/CapitalizeButton'
import { ImportCommissionsButton } from '../../app/(app)/revenue/contract-costs/ImportCommissionsButton'
import { RunAmortizationButton } from '../../app/(app)/revenue/contract-costs/RunAmortizationButton'
import { WipBillingWorkspace } from '../../app/(app)/projects/wip-billing/WipBillingWorkspace'
import { PropertyManagementWorkspace } from '../../app/(app)/property-management/PropertyManagementWorkspace'
import { CaptureList } from '../../app/(app)/ap/capture/sections'
import { CaptureReviewDrawer } from '../../app/(app)/ap/capture/CaptureReviewDrawer'
import { CaptureUploadButton } from '../../app/(app)/ap/capture/CaptureUploadButton'
import { ItemDrawer } from '../../app/(app)/items/ItemDrawer'
import { ItemDrawerSlot } from '../../app/(app)/items/ItemDrawerSlot'
import { NewItemButton } from '../../app/(app)/items/NewItemButton'
import { NewMovementButton } from '../../app/(app)/inventory/NewMovementButton'
import { InventoryActionDrawer } from '../../app/(app)/inventory/InventoryActionDrawer'
import { NewExpenseButton } from '../../app/(app)/expenses/NewExpenseButton'
import { ExpenseActions } from '../../app/(app)/expenses/ExpenseActions'
import { buildListDrawerHref } from '../../lib/list-params'
import { NewOrderButton } from '../../app/(app)/_order/NewOrderButton'
import { NewOrderRedirect } from '../../app/(app)/_order/NewOrderRedirect'
import { StoredValueDrawer, StoredValueIssueDrawer } from '../../app/(app)/stored-value/StoredValueDrawers'
import { NewProjectButton } from '../../app/(app)/projects/NewProjectButton'
import { NewProjectRedirect } from '../../app/(app)/projects/NewProjectRedirect'
import { ProjectDrawer } from '../../app/(app)/projects/ProjectDrawer'
import Link from 'next/link'
import { DemandPlanActions } from '../../app/(app)/inventory/planning/DemandPlanActions'
import { DemandSuggestionDrawer } from '../../app/(app)/inventory/planning/DemandSuggestionDrawer'
import { ChannelOrderDrawerSlot, ChannelReplayAll } from '../../app/(app)/channels/ChannelWidgets'
import { ChannelPostingForm } from '../../app/(app)/channels/ChannelPostingForm'
import type { ChannelOrderDrawerData } from '../../app/(app)/channels/order-detail'
import { str, type WidgetRenderer } from './widget-props'

/** Commerce adapters. Compose native components without changing their props or boundaries. */
export const COMMERCE_WIDGETS = {

  /* --- subcontracts ----------------------------------------------------------------- */
  /** SIX FLAT props (`projects`, `vendors`, `expenseAccounts`, `parties`,
   *  `multiCurrency`, `permissions`) — no nested bag. Six drawer tabs, the
   *  register fetch and every mutation are client state. */
  'subcontracts-workspace': (props) => (
    <SubcontractsWorkspace {...(props as unknown as ComponentProps<typeof SubcontractsWorkspace>)} />
  ),

  /* --- AP cockpit ------------------------------------------------------------------- */
  /** The capture link and the create menu as ONE widget, because the native
   *  header nests them in their own `gap-2` row. */
  'ap-header-actions': (props) => (
    <ApHeaderActions
      captureHref={str(props, 'captureHref') ?? ''}
      captureLabel={str(props, 'captureLabel') ?? ''}
      canCreate={props.canCreate === true}
      newItems={(props.newItems as ComponentProps<typeof ApHeaderActions>['newItems']) ?? []}
      newBasePath={str(props, 'newBasePath') ?? ''}
      newTriggerLabel={str(props, 'newTriggerLabel') ?? ''}
    />
  ),
  /** Whole, exactly as `ar-cockpit`: vitals, the pay-run planner, aging bars,
   *  the cash-out schedule, the vendor table and three on-demand flyouts. */
  'ap-cockpit': (props) => (
    <ApCockpit
      data={props.data as ComponentProps<typeof ApCockpit>['data']}
      canConfigure={props.canConfigure === true}
      canPay={props.canPay === true}
    />
  ),

  /* --- collections ------------------------------------------------------------------ */
  /** The shell (container + PageHeader + client island) is ONE component
   *  because the island's four-way panel switch is tab state: presence omits
   *  a block, it never chooses between four. */
  'collections-shell': (props) => (
    <CollectionsShell
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      worklistHref={(props.worklistHref as string | null) ?? null}
      worklistLabel={str(props, 'worklistLabel') ?? ''}
      subscriptionsEnabled={props.subscriptionsEnabled === true}
      advancedSubscriptionsEnabled={props.advancedSubscriptionsEnabled === true}
      customers={(props.customers as ComponentProps<typeof CollectionsShell>['customers']) ?? []}
      incomeAccounts={(props.incomeAccounts as ComponentProps<typeof CollectionsShell>['incomeAccounts']) ?? []}
    />
  ),
  /** Recovery vitals above the console: KPIs plus the three queues that
   *  need a human. Null (surface off) renders nothing — the shell owns the
   *  empty state, never the dashboard. */
  'recovery-dashboard': (props) => (
    <RecoveryDashboard data={(props.data as ComponentProps<typeof RecoveryDashboard>['data']) ?? null} />
  ),
  /** One collection attempt with its retry action. Null (no attempt open)
   *  renders nothing — the list owns the empty state, never the drawer. */
  'collection-attempt-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof AttemptDrawer>['drawer'] & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <AttemptDrawer key={remountKey} drawer={rest} />
  },

  /* --- expenses cockpit ------------------------------------------------------------- */
  'expenses-dashboard': (props) => (
    <ExpensesDashboard data={props.data as ComponentProps<typeof ExpensesDashboard>['data']} />
  ),

  /* --- revenue ---------------------------------------------------------------------- */
  /** No remount key: the native page renders `<ContractDrawer>` keyless (the
   *  journal-drawer arrangement — its state resets via closeHref navigation),
   *  so a key here would diverge. This differs from the account / party /
   *  document drawers deliberately. */
  'contract-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof ContractDrawer> | null
    if (!drawer) return null
    return <ContractDrawer {...drawer} />
  },
  /** Presence is the spec's `when` on `canRun`, not a check in here. */
  /** Whole: the button owns the review drawer it opens, and the drawer owns
   *  preview/confirm state. Scope options are data from the loader. */
  'run-recognition': (props) => (
    <RunRecognitionButton
      books={(props.books as ComponentProps<typeof RunRecognitionButton>['books']) ?? []}
      periods={(props.periods as ComponentProps<typeof RunRecognitionButton>['periods']) ?? []}
      candidates={(props.candidates as ComponentProps<typeof RunRecognitionButton>['candidates']) ?? []}
    />
  ),

  /* --- WIP and prebilling ----------------------------------------------------------- */
  /** Whole: the create drawer, the detail drawer, per-line edit/hold/release
   *  forms and every transition. Decomposing would strand that state from
   *  the actions it drives — the `match-workspace` reason. */
  'wip-billing-workspace': (props) => (
    <WipBillingWorkspace {...(props as unknown as ComponentProps<typeof WipBillingWorkspace>)} />
  ),

  /* --- property management ---------------------------------------------------- */
  'property-management-workspace': (props) => (
    <PropertyManagementWorkspace
      {...(props as unknown as ComponentProps<typeof PropertyManagementWorkspace>)}
    />
  ),

  /* --- AR cockpit ------------------------------------------------------------- */
  /** Whole: schedule bars, a collections worklist and a week drill that
   *  fetches on demand are client behaviour a spec cannot name. */
  'ar-cockpit': (props) => (
    <ArCockpit
      data={props.data as ComponentProps<typeof ArCockpit>['data']}
      canCollect={props.canCollect === true}
    />
  ),
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

  /* --- field tickets -------------------------------------------------------- */
  /** Keyless, like `journal-drawer`: the native page renders no key and the
   *  drawer resets from effects on the ticket id. */
  'field-ticket-drawer': (props) => <NativeListDrawer widget="field-ticket-drawer" drawer={props.drawer} />,

  /* --- items ---------------------------------------------------------------- */
  /** One widget for the whole header slot: the native markup differs per view
   *  (the catalog wraps button+tabs, rate books passes bare tabs), and `wrap`
   *  selects between them as data rather than as a branch in the spec. The
   *  primary New action comes first and the ModuleHomeTabs strip is last. */
  'items-header-actions': (props) => {
    const tabs = (props.tabs as ComponentProps<typeof ModuleHomeTabs>['tabs']) ?? []
    const inner = (
      <>
        {props.showNew === true ? <NewItemButton /> : null}
        <ModuleHomeTabs tabs={tabs} />
      </>
    )
    return props.wrap === true ? <div className="flex items-center gap-3">{inner}</div> : inner
  },
  'new-item': () => <NewItemButton />,
  'item-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof ItemDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    return <ItemDrawerSlot drawer={drawer} sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
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
      subsidiaries={(props.subsidiaries as ComponentProps<typeof InventoryActionDrawer>['subsidiaries']) ?? []}
    />
  ),

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
      openHref={str(props, 'openHref') ?? buildListDrawerHref(
        '/expenses/reports',
        (props.sp as Record<string, string | string[] | undefined>) ?? {},
        'expense',
        String(props.id ?? ''),
      )}
    />
  ),
  'expense-drawer': (props) => <NativeListDrawer widget="expense-drawer" drawer={props.drawer} />,

  /* --- orders (quotes, sales orders, purchase orders) ----------------------- */
  //
  // One set of entries for all three order pages: they render the same
  // `_order` components and differ only in the api path, base path and param
  // the loader resolves. Three near-identical registry entries would have been
  // three places to drift.
  'new-order': (props) => (
    <NewOrderButton
      apiPath={str(props, 'apiPath') ?? undefined}
      base={str(props, 'base') ?? ''}
      param={str(props, 'param') ?? ''}
      createParam={str(props, 'createParam') ?? undefined}
      label={str(props, 'label') ?? ''}
      createFailedMessage={str(props, 'createFailedMessage') ?? undefined}
    />
  ),
  'new-order-redirect': (props) => (
    <NewOrderRedirect
      apiPath={str(props, 'apiPath') ?? undefined}
      base={str(props, 'base') ?? ''}
      param={str(props, 'param') ?? ''}
      createParam={str(props, 'createParam') ?? undefined}
      createFailedMessage={str(props, 'createFailedMessage') ?? undefined}
    />
  ),
  'order-drawer': (props) => <NativeListDrawer widget="order-drawer" drawer={props.drawer} />,

  /* --- contract costs (ASC 340-40) ------------------------------------------------ */
  /** No remount key: the native page renders `<ContractCostDrawer>` keyless
   *  (its state resets via closeHref navigation), like the contract drawer. */
  'contract-cost-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof ContractCostDrawer> | null
    if (!drawer) return null
    return <ContractCostDrawer {...drawer} />
  },
  'contract-costs-workspace': (props) => {
    const p = props as unknown as ComponentProps<typeof ContractCostWorkspace>['data'] & {
      assetBalance?: unknown;
      periodAmortized?: unknown;
      baseCurrency?: unknown;
      attention?: unknown;
      canManage?: unknown;
      policy?: unknown;
    }
    return (
      <ContractCostWorkspace
        data={{
          assetBalance: String(p.assetBalance ?? ''),
          periodAmortized: String(p.periodAmortized ?? ''),
          baseCurrency: String(p.baseCurrency ?? ''),
          attention: (p.attention as ComponentProps<typeof ContractCostWorkspace>['data']['attention']) ?? [],
          canManage: p.canManage === true,
          policy: (p.policy as ComponentProps<typeof ContractCostWorkspace>['data']['policy']) ?? null,
        }}
      />
    )
  },
  'run-amortization': (props) => (
    <RunAmortizationButton
      periods={(props.periods as ComponentProps<typeof RunAmortizationButton>['periods']) ?? []}
      selectedPeriodId={(props.selectedPeriodId as string | null) ?? null}
      activeAssets={Number((props as { activeAssets?: unknown }).activeAssets ?? 0)}
    />
  ),
  'capitalize-cost': (props) => (
    <CapitalizeButton
      contracts={(props.contracts as ComponentProps<typeof CapitalizeButton>['contracts']) ?? []}
      expenseAccounts={(props.expenseAccounts as ComponentProps<typeof CapitalizeButton>['expenseAccounts']) ?? []}
      policy={(props.policy as ComponentProps<typeof CapitalizeButton>['policy']) ?? null}
      baseCurrency={String((props as { baseCurrency?: unknown }).baseCurrency ?? '')}
    />
  ),
  'import-commissions': (props) => (
    <ImportCommissionsButton
      expenseAccounts={(props.expenseAccounts as ComponentProps<typeof ImportCommissionsButton>['expenseAccounts']) ?? []}
      baseCurrency={String((props as { baseCurrency?: unknown }).baseCurrency ?? '')}
    />
  ),
  /* --- stored value --------------------------------------------------------- */
  /** One drawer shell per account: balance stats, ledger/paged entries,
   *  correction tab and program detail. Null when no account is open. */
  'stored-value-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof StoredValueDrawer>['drawer'] & { remountKey: string }) | null
    if (!drawer) return null
    return <StoredValueDrawer key={drawer.remountKey} drawer={drawer} />
  },
  /** "Sell a gift card": mint form, then the code exactly once. */
  'stored-value-issue': (props) => {
    const issue = props.issue as ComponentProps<typeof StoredValueIssueDrawer>['issue'] | null
    if (!issue) return null
    return <StoredValueIssueDrawer issue={issue} />
  },
  /* --- demand planning ------------------------------------------------------ */
  /** Header remedies for the planning work queue: run, confirm-all and
   *  grouped purchase-order creation are client state over the planning API. */
  'demand-plan-actions': (props) => (
    <DemandPlanActions
      subsidiaryId={str(props, 'subsidiaryId') ?? ''}
      subsidiaries={(props.subsidiaries as ComponentProps<typeof DemandPlanActions>['subsidiaries']) ?? []}
    />
  ),
  /** One suggestion's shell: chart, explanation and its confirm / dismiss /
   *  convert step, fetched client-side so the shell survives loading,
   *  refusal and retry without remounting. */
  'demand-suggestion-drawer': (props) => {
    const suggestionId = str(props, 'suggestionId')
    if (!suggestionId) return null
    return (
      <DemandSuggestionDrawer
        key={suggestionId}
        suggestionId={suggestionId}
        closeHref={str(props, 'closeHref') ?? '/inventory/planning'}
        vendors={(props.vendors as ComponentProps<typeof DemandSuggestionDrawer>['vendors']) ?? []}
        locations={(props.locations as ComponentProps<typeof DemandSuggestionDrawer>['locations']) ?? []}
        locale={str(props, 'locale') ?? 'en'}
      />
    )
  },

  /* --- channel orders ------------------------------------------------------- */
  /** One drawer shell per channel order: normalized lines, tenders and the
   *  posting outcome with replay and fix-all-similar. Null when no order
   *  is open. */
  'channel-order-drawer': (props) => {
    const drawer = props.drawer as ChannelOrderDrawerData | null
    if (!drawer) return null
    return <ChannelOrderDrawerSlot drawer={drawer} closeHref={str(props, 'closeHref') ?? '/channels/orders'} />
  },
  /** Fix-all-similar: replay every exception, or every one with one cause. */
  'channel-replay-all': (props) => (
    <ChannelReplayAll
      channelId={str(props, 'channelId')}
      code={str(props, 'code')}
      scope={str(props, 'scope') === 'events' ? 'events' : null}
    />
  ),
  /** Per-channel posting policies with effective dating and history. */
  'channel-posting-form': (props) => (
    <ChannelPostingForm
      canManage={props.canManage === true}
      today={str(props, 'today') ?? ''}
      channels={(props.channels as ComponentProps<typeof ChannelPostingForm>['channels']) ?? []}
      policies={(props.policies as ComponentProps<typeof ChannelPostingForm>['policies']) ?? {}}
      history={(props.history as ComponentProps<typeof ChannelPostingForm>['history']) ?? {}}
      customers={(props.customers as ComponentProps<typeof ChannelPostingForm>['customers']) ?? []}
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
} satisfies Record<string, WidgetRenderer>
