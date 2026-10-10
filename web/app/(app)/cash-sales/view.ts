import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { isUuid, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { CASH_SALE_KINDS, DOC_KINDS, isDocumentCreateKind } from "../../../lib/document-kinds.ts";
import { accountOptions, createDocumentSeed, dimensionOptions, taxCodeOptions, taxGroupOptions } from "../../../lib/documents.ts";
import { listScopedPartyOptionsWithCurrent } from "../../../lib/scoped-options";
import { loadDocument } from "@openbooks/engine/documents";
import type { DocKindConfig } from '../../../lib/document-kinds'
import { loadFieldDefs } from '../../../lib/custom-fields'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { featureEnabled, isFeatureEnabled, resolvedFeatureState } from '../../../lib/features'
import { readCashSalesSettings } from '../../../lib/company-settings'
import type { DocumentDrawer } from '../../../components/document-drawer'
import { readProviderTransactionsForDocument } from '@openbooks/engine/tax'
import type { TaxProviderChipRow } from '../../../components/tax-provider-chip'
import { TAX_FILING_WRITE_PERMISSION } from '../../../lib/tax-filing-permission'

/**
 * Cash sales + cash refunds, split into a loader and a spec.
 *
 * One list, not two: both paid-at-sale kinds render here with the shared
 * kind filter; refunds are prefilled from a posted sale through the drawer's
 * Refund action. The list itself is the universal RecordListView — see the
 * invoices view for why the spec names widgets and the loader does the work.
 */

type DocumentDrawerProps = Parameters<typeof DocumentDrawer>[0]
type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>

export interface CashSalesDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string
  basePath: string
  payload: LoadedDocument | { doc: Record<string, unknown>; lines: Record<string, unknown>[] }
  /** Unsaved create: the drawer edits a blank payload; Save POSTs the collection. */
  createMode: boolean
  config: DocKindConfig
  initialMode: 'edit' | 'view'
  parties: DocumentDrawerProps['parties']
  accounts: DocumentDrawerProps['accounts']
  taxCodes: DocumentDrawerProps['taxCodes']
  taxGroups: DocumentDrawerProps['taxGroups']
  departments: DocumentDrawerProps['departments']
  projects: DocumentDrawerProps['projects']
  locations: DocumentDrawerProps['locations']
  classes: DocumentDrawerProps['classes']
  segments: DocumentDrawerProps['segments']
  stockLocations: DocumentDrawerProps['stockLocations']
  subsidiaries: DocumentDrawerProps['subsidiaries']
  headerDefs: DocumentDrawerProps['headerDefs']
  lineDefs: DocumentDrawerProps['lineDefs']
  recordType: DocumentDrawerProps['recordType']
  allocationsEntryEnabled: DocumentDrawerProps['allocationsEntryEnabled']
  tenderAccounts: DocumentDrawerProps['tenderAccounts']
  refundHref: DocumentDrawerProps['refundHref']
  defaultTenderAccountId: DocumentDrawerProps['defaultTenderAccountId']
  /** Provider commit rows for a posted cash document; null while the
   *  document is a draft or has nothing to commit to. */
  taxProvider: { documentNumber: string; provider: string; rows: TaxProviderChipRow[]; canRetry: boolean } | null
  /** Active marketplace facilitators for the per-line "tax collected by"
   *  column. Empty hides the column. */
  marketplaceFacilitators: { name: string }[]
}

export interface CashSalesData {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  canCreate: boolean
  canPost: boolean
  currentParams: Record<string, string | string[] | undefined>
  newButton: { items: Array<{ kind: string; label: string }>; basePath: string; triggerLabel: string }
  drawerOpen: boolean
  drawer: CashSalesDrawer | null
}

const BASE_PATH = '/cash-sales'

/** Returnable (unreturned) quantities per sale line location for the refund prefill. */
async function returnableSaleLines(orgId: string, saleId: string) {
  const rows = (await db.execute<{
    lineId: string; itemId: string | null; accountId: string; amount: string;
    quantity: string; unitPrice: string | null; description: string | null;
    taxCodeId: string | null; stockLocationId: string | null;
    marketplaceFacilitator: string | null;
    issueMovementId: string | null; shipped: string | null; returned: string;
  }>(sql`
    with shipped as (
      select m.document_line_id as line_id, m.id as movement_id, m.stock_location_id,
             m.quantity as shipped_qty
        from inventory_movements m
       where m.org_id = ${orgId} and m.document_line_id in (
         select id from document_lines where org_id = ${orgId} and document_id = ${saleId} and item_id is not null
       )
         and m.kind = 'issue' and m.status = 'posted'
    ),
    returned as (
      select (l.custom->'inventoryReturn'->>'sourceIssueMovementId') as issue_id,
             coalesce(sum(case when m.kind = 'receipt' then m.quantity else -m.quantity end), 0) as qty
        from document_lines l
        join documents d on d.id = l.document_id and d.org_id = l.org_id
        left join inventory_movements m on m.document_line_id = l.id and m.org_id = l.org_id
         and m.kind in ('receipt', 'reversal') and m.status = 'posted'
       where l.org_id = ${orgId}
         and l.custom->'inventoryReturn'->>'sourceIssueMovementId' in (select movement_id from shipped)
         and d.status = 'posted'
       group by 1
    )
    select l.id as "lineId", l.item_id as "itemId", l.account_id as "accountId",
           -- A stocked line split across locations prefills one line per
           -- issue movement at its still-unreturned remainder, priced at the
           -- original unit price; fully-returned movements drop out so the
           -- proposal can never over-return on arrival. Non-stocked lines
           -- prefill in full with no return evidence.
           case when s.movement_id is null then l.amount
                else (l.unit_price * greatest(s.shipped_qty - coalesce(r.qty, 0), 0)) end::text as amount,
           case when s.movement_id is null then l.quantity
                else greatest(s.shipped_qty - coalesce(r.qty, 0), 0) end::text as quantity,
           l.unit_price::text as "unitPrice", l.description,
           l.tax_code_id as "taxCodeId", l.stock_location_id as "stockLocationId",
           l.marketplace_facilitator as "marketplaceFacilitator",
           s.movement_id as "issueMovementId", s.shipped_qty::text as shipped,
           coalesce(r.qty, 0)::text as returned
      from document_lines l
      left join shipped s on s.line_id = l.id
      left join returned r on r.issue_id = s.movement_id
     where l.org_id = ${orgId} and l.document_id = ${saleId}
       and (s.movement_id is null or s.shipped_qty - coalesce(r.qty, 0) > 0)
     order by l.line_number`)).rows
  return rows
}

export async function loadCashSales(
  sp: Record<string, string | string[] | undefined>,
): Promise<CashSalesData> {
  const authz = await requirePermission('cash_sales.read')
  await requireFeatureEnabled(authz.user.orgId, 'cashSales')
  const tAr = await getTranslations('ar')
  const canCreate = can(authz, 'cash_sales.create')
  const canPost = can(authz, 'cash_sales.post')
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, 'inventory')
  const equipmentEnabled = await isFeatureEnabled(authz.user.orgId, 'fixedAssets')
  const featureState = await resolvedFeatureState(authz.user.orgId)
  const docId = pickString(sp.doc)
  const newDocument = {
    widget: 'new-document',
    props: {
      items: [
        { kind: 'cash_sale', label: tAr('actions.newCashSale') },
        { kind: 'cash_refund', label: tAr('actions.newCashRefund') },
      ],
      basePath: BASE_PATH,
      triggerLabel: tAr('actions.new'),
    },
  }

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const loadedDoc = docId && docId !== 'new' ? await loadDocument(docId, authz.user.orgId) : null
  const openDoc = loadedDoc && loadedDoc.doc.org_id === authz.user.orgId
    && (!authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
    ? loadedDoc : null
  const documentOptionScope = openDoc
    ? new Set([String(openDoc.doc.subsidiary_id)])
    : authz.allowedSubsidiaryIds
  const openKind = openDoc?.doc.kind as string | undefined
  // Unsaved create: `?doc=new&kind=` renders the shared drawer in createMode
  // over a blank in-memory payload. The kind must belong to this page, the
  // caller must hold its create permission, and nothing is read or written
  // for an id — the document exists only after an explicit Save.
  const createKind = typeof sp.kind === 'string' && (CASH_SALE_KINDS as readonly string[]).includes(sp.kind)
    && isDocumentCreateKind(sp.kind) ? sp.kind : undefined
  const isCreate = docId === 'new' && !!createKind && canCreate
  const drawerKind = openKind ?? createKind
  const drawerOpen = !!(openDoc && openKind && (CASH_SALE_KINDS as readonly string[]).includes(openKind)) || isCreate
  const [headerDefs, lineDefs] = drawerOpen
    ? await Promise.all([loadFieldDefs('documents', drawerKind!), loadFieldDefs('document_lines', drawerKind!)])
    : [[], []]
  // Till defaults: the walk-in customer unattributed sales post against and
  // the per-channel accounts new tenders prefill.
  const tillDefaults = drawerOpen
    ? readCashSalesSettings(
        (await db.execute<{ settings: unknown }>(sql`
          select settings->'cashSales' as settings from orgs where id = ${authz.user.orgId}`)).rows[0]?.settings,
      )
    : null
  const walkInCustomer = tillDefaults?.walkInCustomerId
    ? (await db.execute<{ id: string; display_name: string }>(sql`
        select id, display_name from parties
         where org_id = ${authz.user.orgId} and id = ${tillDefaults.walkInCustomerId} and is_active limit 1`)).rows[0] ?? null
    : null
  // Refund prefill: `?doc=new&kind=cash_refund&refundFrom=<sale>` proposes a
  // complete refund for review — sale lines at their original amounts with
  // return evidence on the still-unreturned stocked quantities, tenders
  // mirrored as payouts. Nothing is written; Save creates the draft.
  const refundFromId = isCreate && createKind === 'cash_refund' && typeof sp.refundFrom === 'string' && isUuid(sp.refundFrom)
    ? sp.refundFrom
    : null
  // Refund tenders mirror the sale's table rows (never custom): a cash
  // refund pays back through the same channels, so the operator starts from
  // the settled methods and adjusts.
  const refundSource = refundFromId
    ? (await db.execute<{ id: string; kind: string; status: string; party_id: string | null; custom: unknown; tenders: unknown }>(sql`
        select d.id, d.kind, d.status, d.party_id, d.custom,
               coalesce((
                 select jsonb_agg(row_to_json(t) order by t.position)
                   from (
                     select t.position, t.kind, t.method_label as "methodLabel",
                            t.account_id as "accountId",
                            t.stored_value_account_id as "storedValueAccountId",
                            ((t.amount_minor / 10000)::text || '.' || lpad((t.amount_minor % 10000)::text, 4, '0')) as amount,
                            t.currency, t.reference, t.external_ref as "externalRef"
                       from document_tenders t
                      where t.org_id = d.org_id and t.document_id = d.id
                   ) t
               ), '[]'::jsonb) as tenders
          from documents d
         where d.org_id = ${authz.user.orgId} and d.id = ${refundFromId} and d.kind = 'cash_sale' and d.status = 'posted'
         ${authz.allowedSubsidiaryIds ? sql`and d.subsidiary_id = any(${[...authz.allowedSubsidiaryIds]}::uuid[])` : sql``}
         limit 1`)).rows[0] ?? null
    : null
  const refundLines = refundSource ? await returnableSaleLines(authz.user.orgId, refundSource.id) : []
  // The create seed carries no lines, so the keep-existing-items clause
  // matches nothing — the same items list a blank draft would see.
  const existingDocId = openDoc ? docId : null
  const [pickers, resolvedForm] = await Promise.all([
    drawerOpen
      ? Promise.all([
          listScopedPartyOptionsWithCurrent(
            authz.user.orgId,
            documentOptionScope,
            'customer',
            openDoc?.doc.party_id ? String(openDoc.doc.party_id) : undefined,
          ),
          accountOptions(DOC_KINDS[drawerKind! as 'cash_sale']!, authz.user.orgId, documentOptionScope),
          taxCodeOptions(),
          taxGroupOptions(),
          dimensionOptions(authz.user.orgId, undefined, documentOptionScope),
          db.execute(sql`
            select it.id, it.code, it.name,
                   exists (select 1 from item_inventory_profiles p where p.org_id = it.org_id and p.item_id = it.id) as has_inventory_profile
             from items it
             where it.org_id = ${authz.user.orgId} and it.is_active
               and (
                 ${inventoryEnabled ? sql`true` : sql`it.kind not in ('inventory', 'assembly', 'kit')`}
                 ${equipmentEnabled ? sql`` : sql`and it.kind <> 'equipment_charge'`}
                 or it.id in (
                   select item_id from document_lines
                    where org_id = ${authz.user.orgId} and document_id = ${existingDocId} and item_id is not null
                 )
               )
             order by coalesce(it.code, it.name), it.name limit 2000`).then((r) => r.rows),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null
            const options = await subsidiaryOptions()
            return authz.allowedSubsidiaryIds
              ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
              : options
          }),
          // Warehouses for the line-level stock-location picker. Empty hides
          // the picker; a single location is stamped silently instead.
          inventoryEnabled
            ? db.execute(sql`
              select id, code from stock_locations
               where org_id = ${authz.user.orgId} and is_active order by code`).then((r) => r.rows)
            : [],
          // Tender settlement accounts: bank + asset clearing. The edit
          // guard refuses receivables/payables by name, so the picker only
          // offers accounts a tender may actually settle into.
          db.execute(sql`
            select id, number, name from accounts
             where org_id = ${authz.user.orgId} and is_active and not is_summary
               and type in ('asset_bank', 'asset_current_other')
             order by number nulls last, name`).then((r) => r.rows),
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
  // submittable; unrestricted orgs keep the factory root default. A
  // configured walk-in customer is proposed as the party; the operator can
  // clear it for a fully anonymous sale or pick the real customer.
  const createSeed = isCreate && createKind ? await createDocumentSeed(authz.user.orgId, createKind) : null
  if (createSeed && walkInCustomer && !refundSource) {
    (createSeed.doc as Record<string, unknown>).party_id = walkInCustomer.id;
    (createSeed.doc as Record<string, unknown>).party_name = walkInCustomer.display_name
  }
  if (createSeed && refundSource) {
    const seed = createSeed.doc as Record<string, unknown>
    seed.party_id = refundSource.party_id;
    seed.custom = {
      ...((seed.custom ?? {}) as Record<string, unknown>),
      tenders: refundSource.tenders ?? [],
    };
    (createSeed as { lines: Record<string, unknown>[] }).lines = refundLines.map((line) => ({
      item_id: line.itemId,
      account_id: line.accountId,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      amount: line.amount,
      description: line.description,
      tax_code_id: line.taxCodeId,
      stock_location_id: line.stockLocationId,
      // The refund returns the sale's own tax treatment: a marketplace-collected
      // line stays marketplace-collected, so the collector is proposed, not dropped.
      marketplace_facilitator: line.marketplaceFacilitator,
      ...(line.issueMovementId
        ? { custom: { inventoryReturn: { sourceIssueMovementId: line.issueMovementId } } }
        : {}),
    }))
  }
  // A restricted subsidiary scope narrows the seed default the same way
  // the picker list narrows: the first visible subsidiary wins.
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
  // Provider commit rows for a posted cash document: posting enqueues them
  // in its own transaction, so by the time the drawer opens they are here.
  // Facilitator names load for every open drawer — the collector choice is
  // made on the draft, before posting.
  const providerRows = drawerOpen && openDoc && !isCreate && String(openDoc.doc.status) === 'posted'
    ? await readProviderTransactionsForDocument(authz.user.orgId, String(openDoc.doc.id))
    : []
  const taxProvider = providerRows.length > 0 && openDoc
    ? {
        documentNumber: String(openDoc.doc.document_number),
        provider: String(providerRows[0]!.provider),
        rows: providerRows.map((row): TaxProviderChipRow => ({
          id: String(row.id),
          status: String(row.status),
          lastError: row.lastError,
        })),
        canRetry: can(authz, TAX_FILING_WRITE_PERMISSION),
      }
    : null
  const facilitatorRows = drawerOpen
    ? (await db.execute<{ name: string }>(sql`
        select name from marketplace_facilitators
         where org_id = ${authz.user.orgId} and is_active
         order by name`)).rows
    : []
  const tenderAccountOptions = (pickers?.[8] ?? []) as { id: string; number: string | null; name: string | null }[]
  const defaultTenderAccountId = tillDefaults?.defaultCashAccountId
    ?? tenderAccountOptions[0]?.id ?? null
  const drawer =
    drawerPayload && pickers && resolvedForm && drawerKind
      ? {
          basePath: BASE_PATH,
          remountKey: openDoc ? String(openDoc.doc.id) : `new:${drawerKind}`,
          payload: drawerPayload,
          createMode: isCreate,
          allocationsEntryEnabled: featureEnabled(featureState, 'allocationsAtEntry'),
          config: DOC_KINDS[drawerKind]!,
          initialMode: (isCreate || pickString(sp.mode) === 'edit' ? 'edit' : 'view') as 'edit' | 'view',
          parties: pickers[0],
          accounts: pickers[1],
          taxCodes: pickers[2],
          taxGroups: pickers[3],
          departments: pickers[4].departments,
          projects: pickers[4].projects,
          locations: pickers[4].locations,
          classes: pickers[4].classes,
          segments: pickers[4].segments,
          stockLocations: (pickers[7] ?? []) as { id: string; code: string | null }[],
          subsidiaries: pickers[6] ?? undefined,
          headerDefs: headerDefs as DocumentDrawerProps['headerDefs'],
          lineDefs: lineDefs as DocumentDrawerProps['lineDefs'],
          recordType: drawerKind,
          tenderAccounts: tenderAccountOptions,
          refundHref:
            drawerKind === 'cash_sale' && openDoc && String(openDoc.doc.status) === 'posted' && canCreate
              ? `${BASE_PATH}?doc=new&kind=cash_refund&refundFrom=${openDoc.doc.id}`
              : null,
          defaultTenderAccountId,
          taxProvider,
          marketplaceFacilitators: facilitatorRows,
          storedValueEnabled: featureEnabled(featureState, 'storedValue'),
        }
      : null
  return {
    title: tAr('list.cashTitle'),
    description: tAr('list.cashDescription'),
    emptyTitle: tAr('list.cashEmptyTitle'),
    emptyDescription: tAr('list.cashEmptyDescription'),
    currentParams: sp,
    canCreate,
    canPost,
    newButton: newDocument.props,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<CashSalesData>()

export function cashSalesSpec(data: CashSalesData): PageSpec {
  const newDocument = {
    widget: 'new-document',
    props: {
      items: data.newButton.items,
      basePath: BASE_PATH,
      triggerLabel: data.newButton.triggerLabel,
    },
  }
  return page({
    route: '/cash-sales',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newDocument.widget, newDocument.props, f('canCreate'))],
      }),
    ],
    body: [
      widgetBlock('record-list-view', {
        recordType: 'cash_sale',
        basePath: BASE_PATH,
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'document-drawer', props: { drawer: data.drawer } } : null,
        emptyTitle: f('emptyTitle'),
        emptyDescription: f('emptyDescription'),
        emptyAction: data.canCreate ? newDocument : null,
        rowActions: { widget: 'document-row-actions', props: { basePath: BASE_PATH, canPost: data.canPost } },
      }),
    ],
  })
}
