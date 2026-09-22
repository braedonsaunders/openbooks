import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { AP_KINDS, DOC_KINDS, isDocumentCreateKind } from "../../../../lib/document-kinds.ts";
import { accountOptions, createDocumentSeed, dimensionOptions, partyOptions, taxCodeOptions, taxGroupOptions } from "../../../../lib/documents.ts";
import { loadDocument } from "../../../../../engine/src/ledger/document-service.ts";
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { isFeatureEnabled } from '../../../../lib/features'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { pickString } from '../../../../lib/list-params'
import { resolveFormLayout } from '../../../../lib/customization/resolve'

/**
 * Vendor bills + credits — the AP document list, split into a loader and a spec.
 *
 * The list itself is the universal RecordListView (search, filters, saved
 * views, sortable typed table, drill-through, pagination), which needs an org
 * id, a user id, a permission decision and a per-row actions renderer. None of
 * those may travel through a spec, so the list arrives through a NOT-YET-
 * EXISTING slot: see the registry entry for the exact `record-list-slot`
 * proposal, mirroring `entity-list-slot.tsx`. The page owns only the header
 * (title/description/capture link/new button) and the ?doc= document flyout
 * with its form-layout resolution, copied verbatim from page.tsx.
 *
 * The drawer payload keeps its remount key by carrying it as a prop, the same
 * arrangement the parties conversion uses: switching documents must reset the
 * drawer's client state, and a widget at a fixed position would otherwise be
 * reused.
 */

export interface ApBillsDrawer {
  remountKey: string
  /** Posted vendor credits carry the cash-free credit-application panel. */
  creditApplications?: { documentId: string; side: 'ap' | 'ar'; partyId: string | null; canApply: boolean } | null
  basePath: string
  payload: unknown
  /** Unsaved create: the drawer edits a blank payload; Save POSTs the collection. */
  createMode: boolean
  config: unknown
  parties: unknown
  accounts: unknown
  taxCodes: unknown
  taxGroups: unknown
  departments: unknown
  projects: unknown
  locations: unknown
  classes: unknown
  segments: unknown
  builtinSegments: unknown
  items: unknown
  subsidiaries: unknown
  headerDefs: unknown
  lineDefs: unknown
  canCreate: boolean
  canPost: boolean
  initialMode: 'edit' | 'view'
  layout: unknown
  availableLayouts: unknown
  currentLayoutId: string | null
  recordType: string
  canCustomize: boolean
}

export interface ApBillsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  captureHref: string
  captureLabel: string
  canCreate: boolean
  newItems: { kind: string; label: string }[]
  newBasePath: string
  newTriggerLabel: string
  drawerOpen: boolean
  drawer: ApBillsDrawer | null
}

export async function loadApBills(
  sp: Record<string, string | string[] | undefined>,
): Promise<ApBillsData> {
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const [inventoryEnabled, equipmentEnabled] = await Promise.all([
    isFeatureEnabled(authz.user.orgId, 'inventory'),
    isFeatureEnabled(authz.user.orgId, 'equipment'),
  ])
  const t = await getTranslations('ap')
  const docId = typeof sp.doc === 'string' ? sp.doc : undefined

  const newItems = [
    { kind: 'vendor_bill', label: t('actions.newBill') },
    { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
  ]

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId && docId !== 'new' ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc =
    loadedDoc &&
    (loadedDoc.doc as Record<string, unknown>).org_id === authz.user.orgId &&
    (!authz.allowedSubsidiaryIds ||
      authz.allowedSubsidiaryIds.has(String((loadedDoc.doc as Record<string, unknown>).subsidiary_id)))
      ? loadedDoc
      : null
  const openKind = (openDoc?.doc as Record<string, unknown> | undefined)?.kind as string | undefined
  // Unsaved create: `?doc=new&kind=` renders the shared drawer in createMode
  // over a blank in-memory payload. The kind must belong to this page, the
  // caller must hold its create permission, and nothing is read or written
  // for an id — the document exists only after an explicit Save.
  const createKind = typeof sp.kind === 'string' && (AP_KINDS as readonly string[]).includes(sp.kind)
    && isDocumentCreateKind(sp.kind) ? sp.kind : undefined
  const isCreate = docId === 'new' && !!createKind && canCreate
  const drawerKind = openKind ?? createKind
  const drawerOpen = !!(openDoc && openKind && (AP_KINDS as readonly string[]).includes(openKind)) || isCreate
  const [headerDefs, lineDefs] = drawerOpen
    ? await Promise.all([
        loadFieldDefs('documents', drawerKind!),
        loadFieldDefs('document_lines', drawerKind!),
      ])
    : [[], []]
  // The create seed carries no lines, so the keep-existing-items clause
  // matches nothing — the same items list a blank draft would see.
  const existingDocId = openDoc ? docId : null
  const [pickers, resolvedForm] = await Promise.all([
    drawerOpen
      ? Promise.all([
          partyOptions('vendor'),
          accountOptions(DOC_KINDS[drawerKind as 'vendor_bill']!),
          taxCodeOptions(),
          taxGroupOptions(),
          dimensionOptions(),
          db
            .execute(
              sql`
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
             order by coalesce(code, name), name limit 2000`,
            )
            .then((r) => r.rows),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null
            const options = await subsidiaryOptions()
            return authz.allowedSubsidiaryIds
              ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
              : options
          }),
        ])
      : null,
    drawerOpen
      ? resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: drawerKind!,
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs,
          lineDefs,
          explicitLayoutId: pickString(sp.form),
        })
      : null,
  ])
  // Blank in-memory payload for unsaved create. The subsidiary defaults to
  // the first in-scope option in multi-subsidiary orgs so the form opens
  // submittable; unrestricted orgs keep the factory root default.
  const createSeed = isCreate && createKind ? await createDocumentSeed(authz.user.orgId, createKind) : null
  const createSubsidiaryDefault = (() => {
    if (!createSeed || !pickers) return null
    const options = (pickers[6] ?? []) as { id: string }[]
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

  const dimensions = pickers?.[4] as
    | {
        departments: unknown
        projects: unknown
        locations: unknown
        classes: unknown
        segments: unknown
        builtinSegments: unknown
      }
    | undefined
  const drawer: ApBillsDrawer | null =
    drawerPayload && pickers && resolvedForm && drawerKind
      ? {
          basePath: '/ap/bills',
          remountKey: openDoc ? String((openDoc.doc as Record<string, unknown>).id) : `new:${drawerKind}`,
          payload: drawerPayload,
          createMode: isCreate,
          config: DOC_KINDS[drawerKind]!,
          parties: pickers[0],
          accounts: pickers[1],
          taxCodes: pickers[2],
          taxGroups: pickers[3],
          departments: dimensions?.departments,
          projects: dimensions?.projects,
          locations: dimensions?.locations,
          classes: dimensions?.classes,
          segments: dimensions?.segments,
          builtinSegments: dimensions?.builtinSegments,
          items: pickers[5],
          subsidiaries: pickers[6] ?? undefined,
          headerDefs,
          lineDefs,
          canCreate,
          canPost: can(authz, 'ap.post'),
          initialMode: (isCreate || pickString(sp.mode) === 'edit' ? 'edit' : 'view') as 'edit' | 'view',
          layout: resolvedForm.layout,
          availableLayouts: resolvedForm.available,
          currentLayoutId: resolvedForm.row?.id ?? null,
          recordType: drawerKind,
          canCustomize: can(authz, 'admin.customization.manage'),
          // Only a posted vendor credit can settle a bill without cash. The
          // panel reads its own state; the loader supplies identity and the
          // permission, mirroring the customer-credit side.
          creditApplications:
            openDoc && drawerKind === 'vendor_credit'
              && String((openDoc.doc as Record<string, unknown>).status) === 'posted'
              ? {
                  documentId: String((openDoc.doc as Record<string, unknown>).id),
                  side: 'ap' as const,
                  partyId: (openDoc.doc as Record<string, unknown>).party_id
                    ? String((openDoc.doc as Record<string, unknown>).party_id)
                    : null,
                  canApply: can(authz, 'ap.pay'),
                }
              : null,
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    captureHref: '/ap/capture',
    captureLabel: t('actions.capture'),
    canCreate,
    newItems,
    newBasePath: '/ap/bills',
    newTriggerLabel: t('actions.newBill'),
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<ApBillsData>()

export function apBillsSpec(data: ApBillsData): PageSpec {
  const newBill = {
    widget: 'new-document',
    props: {
      items: data.newItems,
      basePath: data.newBasePath,
      triggerLabel: data.newTriggerLabel,
    },
  }
  return page({
    route: '/ap/bills',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-2',
        actions: [
          widget('ap-capture-link', {
            href: data.captureHref,
            label: data.captureLabel,
          }),
          widget(newBill.widget, newBill.props, f('canCreate')),
        ],
      }),
    ],
    body: [
      // No `when`: the list always renders. `drawer`/`emptyAction` arrive as
      // null when closed/absent and their slots render nothing. The record
      // list renders the drawer itself (after the table, inside the slot) —
      // the page places nothing else here, the same arrangement the native
      // page has.
      widgetBlock('record-list-view', {
        recordType: 'vendor_bill',
        basePath: '/ap/bills',
        rowActions: { widget: 'document-row-actions', props: { basePath: '/ap/bills' } },
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'document-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canCreate ? newBill : null,
      }),
    ],
  })
}
