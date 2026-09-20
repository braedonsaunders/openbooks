import { type ComponentProps } from 'react'
import { AccountsRosterPanel } from '../../app/(app)/banking/AccountsRoster'
import { BankingAttentionList } from '../../app/(app)/banking/sections'
import { ListChecks } from 'lucide-react'
import { MatchWorkspace } from '../../app/(app)/banking/match/MatchWorkspace'
import { CashCockpit } from '../../app/(app)/banking/cash/CashCockpit'
import { BankFeedsClient } from '../../app/(app)/admin/setup/bank-feeds/BankFeedsClient'
import { NewSetupRecordButton, PaymentOperationsEditor, PaymentOperationsTabs, PaymentScheduleNextRun } from '../../app/(app)/admin/setup/payment-operations/sections'
import { ReconcileStats, ReconcileStatusBadge } from '../../app/(app)/banking/[accountId]/reconcile/[reconciliationId]/sections'
import { ReconcileWorkspace } from '../../app/(app)/banking/[accountId]/reconcile/[reconciliationId]/ReconcileWorkspace'
import { PspSettlementsWorkspace } from '../../app/(app)/banking/psp-settlements/sections'
import { PaymentsSectionSlot, RunsSectionSlot } from './payments-slots'
import { ViewTabs as PaymentsViewTabs } from '../../app/(app)/payments/sections'
import { ReceiptsViewTabs } from '../../app/(app)/receipts/sections'
import { NewPaymentButton } from '../../app/(app)/payments/NewPaymentButton'
import { Plus } from 'lucide-react'
import { BankFeedPanel } from '../../app/(app)/banking/imports/sections'
import { NewRuleButton, RunRulesButton, RuleDrawer } from '../../app/(app)/banking/rules/RuleDrawer'
import { AccountStats, UnmatchedCountCell, ReconActionCell } from '../../app/(app)/banking/[accountId]/sections'
import { ImportStatementButton } from '../../app/(app)/banking/[accountId]/ImportStatementButton'
import { StartReconciliationButton } from '../../app/(app)/banking/[accountId]/StartReconciliationButton'
import { StatementDrawer } from '../../app/(app)/banking/[accountId]/StatementDrawer'
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { str, type WidgetRenderer } from './widget-props'

/** Banking adapters. Compose native components without changing their props or boundaries. */
export const BANKING_WIDGETS: Record<string, WidgetRenderer> = {

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

  /* --- payment operations ------------------------------------------------------ */
  'payment-operations-tabs': (props) => (
    <PaymentOperationsTabs
      tabs={(props.tabs as ComponentProps<typeof PaymentOperationsTabs>['tabs']) ?? []}
    />
  ),
  /** `link-button`'s closed icon map has no `plus`, and this action carries
   *  one — so it gets its own entry rather than widening that map for a
   *  single caller. */
  'new-setup-record': (props) => (
    <NewSetupRecordButton href={str(props, 'href') ?? ''} label={str(props, 'label') ?? ''} />
  ),
  /** The native row formats this timestamp CLIENT-side, in the browser's
   *  locale and timezone. The loader must not format it, so the raw ISO
   *  string travels and the cell runs the identical expression. */
  'payment-schedule-next-run': (props) => (
    <PaymentScheduleNextRun value={(props.value as string | null) ?? null} />
  ),
  'payment-operations-editor': (props) => {
    const editor = props.editor as ComponentProps<typeof PaymentOperationsEditor>['editor'] | null
    if (!editor) return null
    return <PaymentOperationsEditor editor={editor} />
  },

  /* --- reconciliation workspace ------------------------------------------------ */
  'reconcile-status-badge': (props) => (
    <ReconcileStatusBadge
      label={str(props, 'label') ?? ''}
      variant={(str(props, 'variant') ?? 'secondary') as 'success' | 'warning' | 'secondary'}
    />
  ),
  /** One widget, not four stat tiles: the native tiles are plain bordered
   *  divs, and the difference tile holds a conditional pair (green zero vs
   *  amber nonzero) that a spec must not express. */
  'reconcile-stats': (props) => (
    <ReconcileStats
      statementBalanceLabel={str(props, 'statementBalanceLabel') ?? ''}
      statementBalanceValue={str(props, 'statementBalanceValue') ?? ''}
      clearedBalanceLabel={str(props, 'clearedBalanceLabel') ?? ''}
      clearedBalanceValue={str(props, 'clearedBalanceValue') ?? ''}
      differenceLabel={str(props, 'differenceLabel') ?? ''}
      difference={str(props, 'difference') ?? '0'}
      differenceCurrency={str(props, 'differenceCurrency') ?? ''}
      matchedLabel={str(props, 'matchedLabel') ?? ''}
      matchedValue={str(props, 'matchedValue') ?? ''}
    />
  ),
  /** Whole, like `match-workspace`: selection state across three prefixed
   *  panes plus every mutation. `canReconcile` is a loader-resolved boolean,
   *  never an Authz. */
  'reconcile-workspace': (props) => (
    <ReconcileWorkspace
      basePath={str(props, 'basePath') ?? ''}
      accountPath={str(props, 'accountPath') ?? ''}
      currentParams={
        (props.currentParams as ComponentProps<typeof ReconcileWorkspace>['currentParams']) ?? {}
      }
      reconciliation={props.reconciliation as ComponentProps<typeof ReconcileWorkspace>['reconciliation']}
      difference={str(props, 'difference') ?? '0'}
      canReconcile={props.canReconcile === true}
      stmtRows={(props.stmtRows as ComponentProps<typeof ReconcileWorkspace>['stmtRows']) ?? []}
      stmtTotal={Number(props.stmtTotal ?? 0)}
      stmtParams={props.stmtParams as ComponentProps<typeof ReconcileWorkspace>['stmtParams']}
      glRows={(props.glRows as ComponentProps<typeof ReconcileWorkspace>['glRows']) ?? []}
      glTotal={Number(props.glTotal ?? 0)}
      glParams={props.glParams as ComponentProps<typeof ReconcileWorkspace>['glParams']}
      matchedRows={(props.matchedRows as ComponentProps<typeof ReconcileWorkspace>['matchedRows']) ?? []}
      matchedTotal={Number(props.matchedTotal ?? 0)}
      mParams={props.mParams as ComponentProps<typeof ReconcileWorkspace>['mParams']}
    />
  ),

  /* --- cash control centre ------------------------------------------------------ */
  /** A widget, not a slot: the LOADER already did the server work, so no user
   *  id, org id or Authz crosses the spec. Layout persistence rides the
   *  session cookie inside the component. */
  'cash-cockpit': (props) => (
    <CashCockpit
      data={props.data as ComponentProps<typeof CashCockpit>['data']}
      layoutPrefs={props.layoutPrefs as ComponentProps<typeof CashCockpit>['layoutPrefs']}
      canConfigure={props.canConfigure === true}
      canPayRun={props.canPayRun === true}
      canCollectionRun={props.canCollectionRun === true}
    />
  ),

  /* --- banking reconciliations ------------------------------------------------------ */
  /** The empty-state action. The native page passes it unconditionally (no
   *  permission gate), so the spec does too — it is data, not a branch. */
  'choose-recon-account': (props) => (
    <Button asChild>
      <Link href={(str(props, 'href') ?? '/banking') as never}>{str(props, 'label') ?? ''}</Link>
    </Button>
  ),

  /* --- bank feeds setup --------------------------------------------------------- */
  /** Five FLAT props, spread exactly as the page passed them. */
  'bank-feeds-workspace': (props) => (
    <BankFeedsClient
      connections={(props.connections as ComponentProps<typeof BankFeedsClient>['connections']) ?? []}
      sftpServers={(props.sftpServers as ComponentProps<typeof BankFeedsClient>['sftpServers']) ?? []}
      sftpSchedules={(props.sftpSchedules as ComponentProps<typeof BankFeedsClient>['sftpSchedules']) ?? []}
      accounts={(props.accounts as ComponentProps<typeof BankFeedsClient>['accounts']) ?? []}
      daemon={props.daemon as ComponentProps<typeof BankFeedsClient>['daemon']}
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
      initialSubsidiaries={
        (props.initialSubsidiaries as ComponentProps<typeof PspSettlementsWorkspace>['initialSubsidiaries']) ?? null
      }
    />
  ),

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
}
