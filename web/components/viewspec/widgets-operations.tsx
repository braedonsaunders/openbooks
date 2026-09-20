import { type ComponentProps } from 'react'
import { Pagination } from '../pagination'
import { WaiverNumberCell } from '../../app/(app)/compliance/lien-waivers/sections'
import { LienWaiverToolbar } from '../../app/(app)/compliance/lien-waivers/LienWaiverToolbar'
import { LienWaiverDrawer } from '../../app/(app)/compliance/lien-waivers/LienWaiverDrawer'
import { NewFilingButton } from '../../app/(app)/compliance/information-returns/NewFilingButton'
import { VendorComplianceMatrix } from '../../app/(app)/compliance/vendors/Matrix'
import { KindChips, ApprovalTabs, ApprovalEngineCell, SubmittedDocumentCell } from '../../app/(app)/approvals/sections'
import { ApprovalsTable } from '../../app/(app)/approvals/ApprovalsTable'
import { DelegationBanner, OutOfOfficeButton } from '../../app/(app)/approvals/DelegationControls'
import { AccountNameCell, AccountRegisterCell } from '../../app/(app)/accounts/sections'
import { AccountsHierarchyTable } from '../../app/(app)/accounts/AccountsHierarchyTable'
import { AccountDrawer } from '../../app/(app)/accounts/AccountDrawer'
import { NewAccountButton } from '../../app/(app)/accounts/NewAccountButton'
import { FilingWorksheet } from '../../app/(app)/compliance/information-returns/[id]/FilingWorksheet'
import { BlockedBillsSection, ComplianceSetupBanner, ExpiringVendorsSection, ReadinessPanel, WaiversPanel } from '../../app/(app)/compliance/sections'
import { NewBudgetButton } from '../../app/(app)/budgets/NewBudgetButton'
import { BudgetDrawer } from '../../app/(app)/budgets/BudgetDrawer'
import { CloseActionCell, CloseReadinessCell, CloseStatusCell, SingleBookLabel } from '../../app/(app)/close/sections'
import { JournalDraftsPanel } from '../../app/(app)/journal/sections'
import { JournalDrawer } from '../../app/(app)/journal/JournalDrawer'
import { NewJournalButton } from '../../app/(app)/journal/NewJournalButton'
import { MatrixFilters } from '../../app/(app)/compliance/vendors/MatrixFilters'
import { VendorComplianceDrawer } from '../../app/(app)/compliance/vendors/VendorComplianceDrawer'
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { str, num, stringRecord, type WidgetRenderer } from './widget-props'

/** Financial operations and controls adapters: approvals, close, accounts, journals, budgets, compliance. Compose native components without changing their props or boundaries. */
export const OPERATIONS_WIDGETS = {

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
} satisfies Record<string, WidgetRenderer>
