import { type ComponentProps } from 'react'
import { ModuleHomeTabs } from '../module-home/ui'
import { RelationshipsSection, ArPulse as CustomerArPulse } from '../../app/(app)/customers/sections'
import { ArCockpit } from '../../app/(app)/ar/cockpit/ArCockpit'
import { SubcontractsWorkspace } from '../../app/(app)/subcontracts/SubcontractsWorkspace'
import { ApCockpit } from '../../app/(app)/ap/cockpit/ApCockpit'
import { ApHeaderActions } from '../../app/(app)/ap/sections'
import { CollectionsShell } from '../../app/(app)/collections/sections'
import { ExpensesDashboard } from '../../app/(app)/expenses/ExpensesDashboard'
import { ContractDrawer } from '../../app/(app)/revenue/ContractDrawer'
import { RunRecognitionButton } from '../../app/(app)/revenue/RunRecognitionButton'
import { WipBillingWorkspace } from '../../app/(app)/projects/wip-billing/WipBillingWorkspace'
import { PropertyManagementWorkspace } from '../../app/(app)/property-management/PropertyManagementWorkspace'
import { CaptureList } from '../../app/(app)/ap/capture/sections'
import { CaptureReviewDrawer } from '../../app/(app)/ap/capture/CaptureReviewDrawer'
import { CaptureUploadButton } from '../../app/(app)/ap/capture/CaptureUploadButton'
import { FieldTicketDrawer } from '../../app/(app)/field-tickets/FieldTicketDrawer'
import { ItemDrawer } from '../../app/(app)/items/ItemDrawer'
import { NewItemButton } from '../../app/(app)/items/NewItemButton'
import { NewMovementButton } from '../../app/(app)/inventory/NewMovementButton'
import { InventoryActionDrawer } from '../../app/(app)/inventory/InventoryActionDrawer'
import { NewExpenseButton } from '../../app/(app)/expenses/NewExpenseButton'
import { ExpenseDrawer } from '../../app/(app)/expenses/ExpenseDrawer'
import { ExpenseActions } from '../../app/(app)/expenses/ExpenseActions'
import { buildListDrawerHref } from '../../lib/list-params'
import { NewOrderButton } from '../../app/(app)/_order/NewOrderButton'
import { NewOrderRedirect } from '../../app/(app)/_order/NewOrderRedirect'
import { OrderDrawer } from '../../app/(app)/_order/OrderDrawer'
import { NewProjectButton } from '../../app/(app)/projects/NewProjectButton'
import { NewProjectRedirect } from '../../app/(app)/projects/NewProjectRedirect'
import { ProjectDrawer } from '../../app/(app)/projects/ProjectDrawer'
import Link from 'next/link'
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
      newCreatingLabel={str(props, 'newCreatingLabel') ?? ''}
      newFailedLabel={str(props, 'newFailedLabel') ?? ''}
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
      subscriptionsEnabled={props.subscriptionsEnabled === true}
      advancedSubscriptionsEnabled={props.advancedSubscriptionsEnabled === true}
      customers={(props.customers as ComponentProps<typeof CollectionsShell>['customers']) ?? []}
      incomeAccounts={(props.incomeAccounts as ComponentProps<typeof CollectionsShell>['incomeAccounts']) ?? []}
    />
  ),

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
  'run-recognition': () => <RunRecognitionButton />,

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
  'field-ticket-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof FieldTicketDrawer> | null
    if (!drawer) return null
    return <FieldTicketDrawer {...drawer} />
  },

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
