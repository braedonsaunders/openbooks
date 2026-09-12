import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  BANK_KINDS,
  DOC_KINDS,
  accountOptions,
  bankAccountOptions,
  cardOptions,
  dimensionOptions,
  loadDocument,
  taxCodeOptions,
  taxGroupOptions,
} from '../../../../lib/documents'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import type { DocumentDrawer } from '../../../../components/document-drawer'
import type { DocKindConfig } from '../../../../lib/document-kinds'

/**
 * Banking transactions (checks, deposits, card charges/refunds, transfers),
 * split into a loader and a spec.
 *
 * The list itself is the universal RecordListView, so the spec places the
 * shared `record-list-view` slot instead of a table: the slot re-derives
 * org/user/permissions from the session. A spec that could name an org id is
 * a cross-tenant read — the same rule that put EntityListView behind
 * `entity-list-view` and RecordListView behind `record-list-view` on the
 * earlier document-list conversions (ar/invoices, expenses/reports).
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * `banking.read` gate, the `ap.create`/`gl.post` New-menu permission, the
 * ?doc= flyout resolution (org guard, subsidiary guard, BANK-kind guard), the
 * drawer pickers (accounts, cards, bank accounts, items, subsidiaries), and
 * the form-layout resolution. The drawer payload and the New-button labels
 * are data, so they travel through the loader result and the widgets render
 * them.
 */

// The banking transaction kinds that can be created from this page — the
// source platform "Write Checks / Make Deposits / Transfer Funds / Issue Credit Card"
// shortcuts, surfaced as one New menu.
const NEW_KINDS = ['check', 'deposit', 'card_charge', 'card_refund', 'transfer'] as const

type DocumentDrawerProps = Parameters<typeof DocumentDrawer>[0]
type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>

export interface BankingTransactionsDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string
  basePath: string
  payload: LoadedDocument
  config: DocKindConfig
  initialMode: 'edit' | 'view'
  accounts: DocumentDrawerProps['accounts']
  taxCodes: DocumentDrawerProps['taxCodes']
  taxGroups: DocumentDrawerProps['taxGroups']
  departments: DocumentDrawerProps['departments']
  projects: DocumentDrawerProps['projects']
  locations: DocumentDrawerProps['locations']
  classes: DocumentDrawerProps['classes']
  segments: DocumentDrawerProps['segments']
  builtinSegments: DocumentDrawerProps['builtinSegments']
  items: Record<string, unknown>[]
  cards: DocumentDrawerProps['cards']
  bankAccounts: DocumentDrawerProps['bankAccounts']
  subsidiaries: DocumentDrawerProps['subsidiaries']
  headerDefs: DocumentDrawerProps['headerDefs']
  lineDefs: DocumentDrawerProps['lineDefs']
  canCreate: boolean
  canPost: boolean
  layout: DocumentDrawerProps['layout']
  availableLayouts: DocumentDrawerProps['availableLayouts']
  currentLayoutId: DocumentDrawerProps['currentLayoutId']
  recordType: string
  canCustomize: boolean
}

export interface BankingTransactionsData {
  backHref: string
  backLabel: string
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canCreate: boolean
  newButton: {
    items: { kind: string; label: string }[]
    basePath: string
    triggerLabel: string
    creatingLabel: string
    failedLabel: string
  }
  drawerOpen: boolean
  drawer: BankingTransactionsDrawer | null
}

export async function loadBankingTransactions(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingTransactionsData> {
  const authz = await requirePermission('banking.read')
  const canCreate = can(authz, 'ap.create') || can(authz, 'gl.post')
  const [inventoryEnabled, equipmentEnabled] = await Promise.all([
    isFeatureEnabled(authz.user.orgId, 'inventory'),
    isFeatureEnabled(authz.user.orgId, 'equipment'),
  ])
  const t = await getTranslations('banking')
  const tCommon = await getTranslations('common')
  const basePath = '/banking/transactions'

  // -- open document drawer (?doc=<id>) -------------------------------------
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  const drawerOpen = !!(openDoc && openKind && (BANK_KINDS as readonly string[]).includes(openKind))
  const pickers = drawerOpen
    ? await Promise.all([
        accountOptions(DOC_KINDS[openKind! as 'card_charge']!),
        taxCodeOptions(),
        taxGroupOptions(),
        dimensionOptions(),
        db.execute(sql`
          select id, code, name from items
           where org_id = ${authz.user.orgId} and is_active
             and (
               ${inventoryEnabled ? sql`true` : sql`kind not in ('inventory', 'assembly', 'kit')`}
               ${equipmentEnabled ? sql`` : sql`and kind <> 'equipment_charge'`}
               or id in (
                 select item_id from document_lines
                  where org_id = ${authz.user.orgId} and document_id = ${docId} and item_id is not null
               )
             )
           order by coalesce(code, name), name limit 2000`).then((r) => r.rows),
        cardOptions(),
        bankAccountOptions(),
        loadFieldDefs('documents', openKind!),
        loadFieldDefs('document_lines', openKind!),
        // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
        isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
          if (!multi) return null
          const options = await subsidiaryOptions()
          return authz.allowedSubsidiaryIds
            ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
            : options
        }),
      ])
    : null
  const resolvedForm = drawerOpen && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: openKind!,
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: (pickers[7]),
        lineDefs: (pickers[8]),
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const newButton = {
    items: NEW_KINDS.map((kind) => ({ kind, label: t(`txKinds.${kind}`) })),
    basePath,
    triggerLabel: t('actions.new'),
    creatingLabel: tCommon('actions.creating'),
    failedLabel: t('toasts.createDraftFailed'),
  }

  const drawer =
    openDoc && pickers && resolvedForm && openKind
      ? {
          basePath: '/banking/transactions',
          remountKey: String(openDoc.doc.id),
          payload: openDoc,
          config: DOC_KINDS[openKind]!,
          initialMode: (pickString(sp.mode) === 'edit' ? 'edit' : 'view') as 'edit' | 'view',
          accounts: pickers[0],
          taxCodes: pickers[1],
          taxGroups: pickers[2],
          departments: pickers[3].departments,
          projects: pickers[3].projects,
          locations: pickers[3].locations,
          classes: pickers[3].classes,
          segments: pickers[3].segments,
          builtinSegments: pickers[3].builtinSegments,
          items: pickers[4],
          cards: pickers[5],
          bankAccounts: pickers[6],
          subsidiaries: pickers[9] ?? undefined,
          headerDefs: pickers[7] as DocumentDrawerProps['headerDefs'],
          lineDefs: pickers[8] as DocumentDrawerProps['lineDefs'],
          canCreate,
          canPost: can(authz, 'ap.post') || can(authz, 'gl.post'),
          layout: resolvedForm.layout,
          availableLayouts: resolvedForm.available,
          currentLayoutId: resolvedForm.row?.id ?? null,
          recordType: openKind,
          canCustomize: can(authz, 'admin.customization.manage'),
        }
      : null

  return {
    backHref: '/banking',
    backLabel: t('home.title'),
    title: t('transactionsPage.title'),
    description: t('transactionsPage.description'),
    currentParams: sp,
    canCreate,
    newButton,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<BankingTransactionsData>()

export function bankingTransactionsSpec(data: BankingTransactionsData): PageSpec {
  const newDocument = {
    widget: 'new-document',
    props: {
      items: data.newButton.items,
      basePath: data.newButton.basePath,
      triggerLabel: data.newButton.triggerLabel,
      creatingLabel: data.newButton.creatingLabel,
      failedLabel: data.newButton.failedLabel,
    },
  }
  return page({
    route: '/banking/transactions',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actions: [widget(newDocument.widget, newDocument.props, f('canCreate'))],
      }),
    ],
    body: [
      // No `when`: the list always renders. `drawer`/`emptyAction` arrive as
      // null when closed/absent and their slots render nothing. The per-row
      // actions name the SHARED `document-row-actions` widget (verified
      // below), which re-derives each row's config from its kind — the native
      // page's `config={DOC_KINDS[row.kind]!}` is the same lookup, so the
      // two can never disagree about which actions a kind gets.
      widgetBlock('record-list-view', {
        recordType: 'bank_transaction',
        basePath: '/banking/transactions',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'document-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canCreate ? newDocument : null,
        rowActions: { widget: 'document-row-actions', props: { basePath: '/banking/transactions' } },
      }),
    ],
  })
}
