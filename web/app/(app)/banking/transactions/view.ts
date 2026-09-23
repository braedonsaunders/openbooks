import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { pickString } from '../../../../lib/list-params'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { BANK_KINDS, DOC_KINDS, createPermission, isDocumentCreateKind } from "../../../../lib/document-kinds.ts";
import { accountOptions, bankAccountOptions, cardLiabilityAccountOptions, cardOptions, createDocumentSeed, dimensionOptions, partyOptions, taxCodeOptions, taxGroupOptions } from "../../../../lib/documents.ts";
import { loadDocument } from "../../../../../engine/src/ledger/document-service.ts";
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
  payload: LoadedDocument | { doc: Record<string, unknown>; lines: Record<string, unknown>[] }
  /** Unsaved create: the drawer edits a blank payload; Save POSTs the collection. */
  createMode: boolean
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
  cardAccounts: DocumentDrawerProps['cardAccounts']
  bankAccounts: DocumentDrawerProps['bankAccounts']
  parties: DocumentDrawerProps['parties']
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
  /**
   * Per-namespace post decisions for the row actions. Banking kinds span
   * namespaces (card/check post under ap.post, deposit/transfer under
   * gl.post), so one page-level boolean would offer Post to a holder of the
   * wrong grant — the row widget picks by the row's kind.
   */
  canPostAp: boolean
  canPostGl: boolean
  newButton: {
    items: { kind: string; label: string }[]
    basePath: string
    triggerLabel: string
  }
  drawerOpen: boolean
  drawer: BankingTransactionsDrawer | null
}

export async function loadBankingTransactions(
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingTransactionsData> {
  const authz = await requirePermission('banking.read')
  // Per-kind create gating: deposits/transfers need gl.post, card/check need
  // ap.create. A visible New action must never dead-end at the loader's
  // per-kind refusal below, so the menu lists only creatable kinds and the
  // page-level gate follows the filtered list. Server enforcement stays.
  const creatableKinds = NEW_KINDS.filter((kind) => can(authz, createPermission(kind)))
  const canCreate = creatableKinds.length > 0
  const [inventoryEnabled, equipmentEnabled] = await Promise.all([
    isFeatureEnabled(authz.user.orgId, 'inventory'),
    isFeatureEnabled(authz.user.orgId, 'equipment'),
  ])
  const t = await getTranslations('banking')
  const basePath = '/banking/transactions'

  // -- open document drawer (?doc=<id>) -------------------------------------
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId && docId !== 'new' ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const openKind = openDoc?.doc.kind as string | undefined
  // Unsaved create: `?doc=new&kind=` renders the shared drawer in createMode
  // over a blank in-memory payload. The kind must belong to this page, the
  // caller must hold its create permission (gl.post for deposits/transfers,
  // ap.create for the rest), and nothing is read or written for an id — the
  // document exists only after an explicit Save.
  const createKind = typeof sp.kind === 'string' && (BANK_KINDS as readonly string[]).includes(sp.kind)
    && isDocumentCreateKind(sp.kind) ? sp.kind : undefined
  const isCreate = docId === 'new' && !!createKind && can(authz, createPermission(createKind))
  const drawerKind = openKind ?? createKind
  const drawerOpen = !!(openDoc && openKind && (BANK_KINDS as readonly string[]).includes(openKind)) || isCreate
  // The create seed carries no lines, so the keep-existing-items clause
  // matches nothing — the same items list a blank draft would see.
  const existingDocId = openDoc ? docId : null
  const pickers = drawerOpen
    ? await Promise.all([
        accountOptions(DOC_KINDS[drawerKind! as 'card_charge']!),
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
                  where org_id = ${authz.user.orgId} and document_id = ${existingDocId} and item_id is not null
               )
             )
           order by coalesce(code, name), name limit 2000`).then((r) => r.rows),
        cardOptions(),
        bankAccountOptions(),
        loadFieldDefs('documents', drawerKind!),
        loadFieldDefs('document_lines', drawerKind!),
        // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
        isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
          if (!multi) return null
          const options = await subsidiaryOptions()
          return authz.allowedSubsidiaryIds
            ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
            : options
        }),
        // Payee options for the optional check payee (checks only — appended
        // last so the indices above never shift).
        drawerKind === 'check' ? partyOptions('vendor') : Promise.resolve([]),
        // Card-liability fallback for the card-charge picker when no card
        // instruments exist (F-t05-020) — appended after the payee slot so
        // no index above shifts.
        drawerKind === 'card_charge' || drawerKind === 'card_refund' ? cardLiabilityAccountOptions() : Promise.resolve([]),
      ])
    : null
  const resolvedForm = drawerOpen && pickers
    ? await resolveFormLayout({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        recordType: drawerKind!,
        userRoles: authz.user.roles.map(({ key }) => key),
        headerDefs: (pickers[7]),
        lineDefs: (pickers[8]),
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const newButton = {
    items: creatableKinds.map((kind) => ({ kind, label: t(`txKinds.${kind}`) })),
    basePath,
    triggerLabel: t('actions.new'),
  }

  // Blank in-memory payload for unsaved create. The subsidiary defaults to
  // the first in-scope option in multi-subsidiary orgs so the form opens
  // submittable; unrestricted orgs keep the factory root default.
  const createSeed = isCreate && createKind ? await createDocumentSeed(authz.user.orgId, createKind) : null
  const createSubsidiaryDefault = (() => {
    if (!createSeed || !pickers) return null
    const options = (pickers[9] ?? []) as { id: string }[]
    if (options.length === 0) return null
    const inScope = authz.allowedSubsidiaryIds
      ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
      : options
    return inScope[0]?.id ?? null
  })()
  if (createSeed && createSubsidiaryDefault) {
    (createSeed.doc as Record<string, unknown>).subsidiary_id = createSubsidiaryDefault
  }
  const drawerPayload = openDoc ?? createSeed
  const drawer =
    drawerPayload && pickers && resolvedForm && drawerKind
      ? {
          basePath: '/banking/transactions',
          remountKey: openDoc ? String(openDoc.doc.id) : `new:${drawerKind}`,
          payload: drawerPayload,
          createMode: isCreate,
          config: DOC_KINDS[drawerKind]!,
          initialMode: (isCreate || pickString(sp.mode) === 'edit' ? 'edit' : 'view') as 'edit' | 'view',
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
          cardAccounts: pickers[11] as DocumentDrawerProps['cardAccounts'],
          bankAccounts: pickers[6],
          parties: pickers[10] as DocumentDrawerProps['parties'],
          subsidiaries: pickers[9] ?? undefined,
          headerDefs: pickers[7] as DocumentDrawerProps['headerDefs'],
          lineDefs: pickers[8] as DocumentDrawerProps['lineDefs'],
          canCreate,
          canPost: can(authz, 'ap.post') || can(authz, 'gl.post'),
          layout: resolvedForm.layout,
          availableLayouts: resolvedForm.available,
          currentLayoutId: resolvedForm.row?.id ?? null,
          recordType: drawerKind,
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
    canPostAp: can(authz, 'ap.post'),
    canPostGl: can(authz, 'gl.post'),
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
        rowActions: { widget: 'document-row-actions', props: { basePath: '/banking/transactions', canPostAp: data.canPostAp, canPostGl: data.canPostGl } },
      }),
    ],
  })
}
