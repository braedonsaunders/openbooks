import { type ComponentProps } from 'react'
import { RecordCountCell, InNavCell } from '../../app/(app)/records/types/sections'
import { TypeBuilderDrawer } from '../../app/(app)/records/types/TypeBuilderDrawer'
import { PartyRolesCell } from '../../app/(app)/parties/sections'
import { CrmSetupWorkspace } from '../../app/(app)/admin/setup/crm/CrmSetupWorkspace'
import { ExportClient } from '../../app/(app)/data/export/ExportClient'
import { ImportWizard } from '../../app/(app)/data/import/ImportWizard'
import { TrashList } from '../../app/(app)/documents/trash/TrashList'
import { TrashBackLink } from '../../app/(app)/documents/trash/sections'
import { FolderTree } from '../../app/(app)/documents/FolderTree'
import { FileList } from '../../app/(app)/documents/FileList'
import { FileDrawer } from '../../app/(app)/documents/FileDrawer'
import { FolderDrawer } from '../../app/(app)/documents/FolderDrawer'
import { UploadButton } from '../../app/(app)/documents/UploadButton'
import { NewFolderButton } from '../../app/(app)/documents/NewFolderButton'
import { DocumentsActions, DocumentsBreadcrumb } from '../../app/(app)/documents/sections'
import { WeeklyGrid } from '../../app/(app)/timesheets/WeeklyGrid'
import { CrmNewButton } from '../../app/(app)/crm/CrmNewButton'
import { OpportunityDrawer } from '../../app/(app)/crm/OpportunityDrawer'
import { OpportunityViewSwitcher } from '../../app/(app)/crm/OpportunityKanban'
import { ActivityDrawer } from '../../app/(app)/crm/ActivityDrawer'
import { ForecastKpiGroup, ManageQuotasButton, QuotaEmptyAction, ForecastSnapshotAction } from '../../app/(app)/crm/forecasts/sections'
import { NewRecordButton } from '../../app/(app)/records/[typeKey]/NewRecordButton'
import { RecordDrawer } from '../../app/(app)/records/[typeKey]/RecordDrawer'
import { DocumentDrawer } from '../document-drawer'
import { DocumentRowActions } from '../document-row-actions'
import { NewDocumentButton } from '../new-document-button'
import { PaymentLinksPanel } from '../payment-links-panel'
import { AppliedPaymentsPanel, type AppliedPayment } from '../applied-payments-panel'
import { DOC_KINDS } from '../../lib/document-kinds'
import { NewPartyButton } from '../../app/(app)/parties/NewPartyButton'
import { NewPartyRedirect } from '../../app/(app)/parties/NewPartyRedirect'
import { PartyDrawer } from '../../app/(app)/parties/PartyDrawer'
import { RelatedTxnSlot } from './related-txn-slot'
import { Badge } from '@openbooks/ui'
import Link from 'next/link'
import { str, type WidgetRenderer } from './widget-props'

/** People, pipeline and content adapters: parties, CRM, forecasts, documents and record types. Compose native components without changing their props or boundaries. */
export const RECORDS_WIDGETS = {

  'data-export': () => <ExportClient />,
  /** Also no props: the import wizard owns its own `WizardLayout` shell and
   *  every step's state. `bare` layout, or the chrome nests. */

  'import-wizard': () => <ImportWizard />,

  'trash-back-link': (props) => (
    <TrashBackLink href={str(props, 'href') ?? '/documents'} label={str(props, 'label') ?? ''} />
  ),
  /** Passed whole: per-row busy state, the purge confirm dialog and the
   *  restore/delete fetches are client behaviour. */

  'trash-list': (props) => (
    <TrashList items={(props.rows as ComponentProps<typeof TrashList>['items']) ?? []} />
  ),

  'crm-setup-workspace': (props) => (
    <CrmSetupWorkspace {...(props as ComponentProps<typeof CrmSetupWorkspace>)} />
  ),

  /* --- admin apps ------------------------------------------------------------ */
  /** Not `link-button` (solid, no icon) and not `docs-link-button` (BookOpen):
   *  the library action uses the same default size as the primary New button. */

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

  'forecast-kpi-group': (props) => (
    <ForecastKpiGroup
      currency={str(props, 'currency') ?? ''}
      items={(props.items as ComponentProps<typeof ForecastKpiGroup>['items']) ?? []}
    />
  ),

  'new-record': (props) => (
    <NewRecordButton typeKey={str(props, 'typeKey') ?? ''} typeName={str(props, 'typeName') ?? ''} basePath={str(props, 'basePath')} currentParams={props.currentParams as Record<string, string | string[] | undefined> | undefined} />
  ),

  'record-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof RecordDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <RecordDrawer key={remountKey} {...rest} />
  },

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
} satisfies Record<string, WidgetRenderer>
