import "server-only";

import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { isUuid, pickString } from "../../../lib/list-params";
import { can, requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import { CASH_SALE_KINDS, DOC_KINDS, isDocumentCreateKind } from "../../../lib/document-kinds.ts";
import {
  accountOptions,
  createDocumentSeed,
  dimensionOptions,
  taxCodeOptions,
  taxGroupOptions,
} from "../../../lib/documents.ts";
import {
  listScopedPartyOptions,
  listScopedPartyOptionsWithCurrent,
} from "../../../lib/scoped-options";
import { loadDocument } from "@openbooks/engine/documents";
import { documentSubmitRouting } from "@/lib/document-submit-routing";
import type { DocKindConfig } from "../../../lib/document-kinds";
import {
  customFieldViewerFor,
  loadFieldDefs,
  visibleCustomFieldDefs,
} from "../../../lib/custom-fields";
import { isMultiSubsidiary, subsidiaryOptions } from "../../../lib/subsidiaries";
import { resolveFormLayout } from "../../../lib/customization/resolve";
import { featureEnabled, isFeatureEnabled, resolvedFeatureState } from "../../../lib/features";
import { readCashSalesSettings } from "../../../lib/company-settings";
import { buildDuplicateSeed } from "../../../lib/cash-sales-duplicate";
import { postedReturnQuantity } from "@openbooks/engine/inventory";
import { fromUnits, mul, toUnits } from "@openbooks/engine/money";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import type { DocumentDrawer } from "../../../components/document-drawer";
import { readProviderTransactionsForDocument } from "@openbooks/engine/tax";
import type { TaxProviderChipRow } from "../../../components/tax-provider-chip";
import { TAX_FILING_WRITE_PERMISSION } from "../../../lib/tax-filing-permission";

/**
 * Cash sales + cash refunds, split into a loader and a spec.
 *
 * One list, not two: both paid-at-sale kinds render here with the shared
 * kind filter; refunds are prefilled from a posted sale through the drawer's
 * Refund action. The list itself is the universal RecordListView — see the
 * invoices view for why the spec names widgets and the loader does the work.
 */

type DocumentDrawerProps = Parameters<typeof DocumentDrawer>[0];
type LoadedDocument = NonNullable<Awaited<ReturnType<typeof loadDocument>>>;

export interface CashSalesDrawer {
  /** Remount key: switching documents must reset the drawer's client state. */
  remountKey: string;
  basePath: string;
  payload: LoadedDocument | { doc: Record<string, unknown>; lines: Record<string, unknown>[] };
  /** Unsaved create: the drawer edits a blank payload; Save POSTs the collection. */
  createMode: boolean;
  config: DocKindConfig;
  initialMode: "edit" | "view";
  /** cash_sales.create: edit, save and delete drafts. */
  canCreate: DocumentDrawerProps["canCreate"];
  /** cash_sales.post: post drafts. */
  canPost: DocumentDrawerProps["canPost"];
  parties: DocumentDrawerProps["parties"];
  accounts: DocumentDrawerProps["accounts"];
  taxCodes: DocumentDrawerProps["taxCodes"];
  taxGroups: DocumentDrawerProps["taxGroups"];
  departments: DocumentDrawerProps["departments"];
  projects: DocumentDrawerProps["projects"];
  locations: DocumentDrawerProps["locations"];
  classes: DocumentDrawerProps["classes"];
  segments: DocumentDrawerProps["segments"];
  stockLocations: DocumentDrawerProps["stockLocations"];
  subsidiaries: DocumentDrawerProps["subsidiaries"];
  headerDefs: DocumentDrawerProps["headerDefs"];
  lineDefs: DocumentDrawerProps["lineDefs"];
  recordType: DocumentDrawerProps["recordType"];
  allocationsEntryEnabled: DocumentDrawerProps["allocationsEntryEnabled"];
  tenderAccounts: DocumentDrawerProps["tenderAccounts"];
  refundHref: DocumentDrawerProps["refundHref"];
  submitRoutesForApproval?: DocumentDrawerProps["submitRoutesForApproval"];
  defaultTenderAccountId: DocumentDrawerProps["defaultTenderAccountId"];
  /** Active employees for the close-out server picker; empty pools tips. */
  serverOptions: DocumentDrawerProps["serverOptions"];
  /** cash_sales.deposit: record till drops from a posted cash sale. */
  canDeposit: DocumentDrawerProps["canDeposit"];
  /** Till-drop destinations; empty names Company Settings as the remedy. */
  depositAccounts: DocumentDrawerProps["depositAccounts"];
  /** Org-today default for the drop date. */
  depositDefaultDate: DocumentDrawerProps["depositDefaultDate"];
  /** Provider commit rows for a posted cash document; null while the
   *  document is a draft or has nothing to commit to. */
  taxProvider: {
    documentNumber: string;
    provider: string;
    rows: TaxProviderChipRow[];
    canRetry: boolean;
  } | null;
  /** Active marketplace facilitators for the per-line "tax collected by"
   *  column. Empty hides the column. */
  marketplaceFacilitators: { name: string }[];
}

export interface CashSalesData {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  canCreate: boolean;
  canPost: boolean;
  currentParams: Record<string, string | string[] | undefined>;
  newButton: {
    items: Array<{ kind: string; label: string; href?: string }>;
    basePath: string;
    triggerLabel: string;
  };
  drawerOpen: boolean;
  drawer: CashSalesDrawer | null;
}

const BASE_PATH = "/cash-sales";

/**
 * Returnable (unreturned) quantities per sale line location for the refund
 * prefill. A stocked line split across locations prefills one line per issue
 * movement at its still-unreturned remainder, priced at the original unit
 * price; fully-returned movements drop out so the proposal can never
 * over-return on arrival. Non-stocked lines prefill in full with no return
 * evidence. Issue movements store negative quantities, so the shipped
 * quantity is the magnitude, and prior returns count through the same rule
 * the credit posting enforces.
 */
async function returnableSaleLines(orgId: string, saleId: string) {
  const rows = await db.execute<{
    lineId: string;
    itemId: string | null;
    accountId: string;
    amount: string;
    quantity: string;
    unitPrice: string | null;
    description: string | null;
    taxCodeId: string | null;
    stockLocationId: string | null;
    marketplaceFacilitator: string | null;
    issueMovementId: string | null;
    shipped: string | null;
  }>(
    sql`
    select l.id as "lineId", l.item_id as "itemId", l.account_id as "accountId",
           l.amount::text as amount, l.quantity::text as quantity,
           l.unit_price::text as "unitPrice", l.description,
           l.tax_code_id as "taxCodeId", l.stock_location_id as "stockLocationId",
           l.marketplace_facilitator as "marketplaceFacilitator",
           m.id as "issueMovementId", (-m.quantity)::text as shipped
      from document_lines l
      left join inventory_movements m
        on m.org_id = l.org_id and m.document_line_id = l.id
       and l.item_id is not null and m.kind = 'issue' and m.status = 'posted'
     where l.org_id = ${orgId} and l.document_id = ${saleId}
     order by l.line_number, m.moved_at, m.id`,
    "objects",
  );
  const returnable = [];
  for (const row of rows) {
    if (!row.issueMovementId || row.shipped === null) {
      returnable.push(row);
      continue;
    }
    const returned = await postedReturnQuantity(db, orgId, {
      returnKind: "receipt",
      evidenceKey: "sourceIssueMovementId",
      sourceMovementId: row.issueMovementId,
    });
    const remaining = fromUnits(toUnits(row.shipped) - toUnits(returned));
    if (toUnits(remaining) <= 0n) continue;
    returnable.push({
      ...row,
      quantity: remaining,
      amount: row.unitPrice === null ? row.amount : mul(row.unitPrice, remaining),
    });
  }
  return returnable;
}

export async function loadCashSales(
  sp: Record<string, string | string[] | undefined>,
): Promise<CashSalesData> {
  const authz = await requirePermission("cash_sales.read");
  await requireFeatureEnabled(authz.user.orgId, "cashSales");
  const tAr = await getTranslations("ar");
  const canCreate = can(authz, "cash_sales.create");
  const canPost = can(authz, "cash_sales.post");
  const canDeposit = can(authz, "cash_sales.deposit");
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, "inventory");
  const equipmentEnabled = await isFeatureEnabled(authz.user.orgId, "fixedAssets");
  const featureState = await resolvedFeatureState(authz.user.orgId);
  const docId = pickString(sp.doc);
  const newItems: Array<{ kind: string; label: string; href?: string }> = [
    { kind: "cash_sale", label: tAr("actions.newCashSale") },
    { kind: "cash_refund", label: tAr("actions.newCashRefund") },
  ];
  const newDocument = {
    widget: "new-document",
    props: {
      items: newItems,
      basePath: BASE_PATH,
      triggerLabel: tAr("actions.new"),
    },
  };

  // Drawer + form layout resolve only when a flyout is open.
  // Org guard: never render another tenant's document in the drawer.
  const fieldViewer = customFieldViewerFor(authz);
  const loadedDoc =
    docId && docId !== "new" ? await loadDocument(docId, authz.user.orgId, fieldViewer) : null;
  const openDoc =
    loadedDoc &&
    loadedDoc.doc.org_id === authz.user.orgId &&
    (!authz.allowedSubsidiaryIds ||
      authz.allowedSubsidiaryIds.has(String(loadedDoc.doc.subsidiary_id)))
      ? loadedDoc
      : null;
  const documentOptionScope = openDoc
    ? new Set([String(openDoc.doc.subsidiary_id)])
    : authz.allowedSubsidiaryIds;
  const openKind = openDoc?.doc.kind as string | undefined;
  // Unsaved create: `?doc=new&kind=` renders the shared drawer in createMode
  // over a blank in-memory payload. The kind must belong to this page, the
  // caller must hold its create permission, and nothing is read or written
  // for an id — the document exists only after an explicit Save.
  const createKind =
    typeof sp.kind === "string" &&
    (CASH_SALE_KINDS as readonly string[]).includes(sp.kind) &&
    isDocumentCreateKind(sp.kind)
      ? sp.kind
      : undefined;
  const isCreate = docId === "new" && !!createKind && canCreate;
  const drawerKind = openKind ?? createKind;
  const drawerOpen =
    !!(openDoc && openKind && (CASH_SALE_KINDS as readonly string[]).includes(openKind)) ||
    isCreate;
  const [loadedHeaderDefs, loadedLineDefs] = drawerOpen
    ? await Promise.all([
        loadFieldDefs("documents", drawerKind!),
        loadFieldDefs("document_lines", drawerKind!),
      ])
    : [[], []];
  const headerDefs = visibleCustomFieldDefs(loadedHeaderDefs, fieldViewer);
  const lineDefs = visibleCustomFieldDefs(loadedLineDefs, fieldViewer);
  // Till defaults: the walk-in customer unattributed sales post against and
  // the per-channel accounts new tenders prefill.
  const tillDefaults = drawerOpen
    ? readCashSalesSettings(
        (
          await db.execute<{ settings: unknown }>(
            sql`
          select settings->'cashSales' as settings from orgs where id = ${authz.user.orgId}`,
            "objects",
          )
        )[0]?.settings,
      )
    : null;
  const walkInCustomer = tillDefaults?.walkInCustomerId
    ? ((
        await db.execute<{ id: string; display_name: string }>(
          sql`
        select id, display_name from parties
         where org_id = ${authz.user.orgId} and id = ${tillDefaults.walkInCustomerId} and is_active limit 1`,
          "objects",
        )
      )[0] ?? null)
    : null;
  // Refund prefill: `?doc=new&kind=cash_refund&refundFrom=<sale>` proposes a
  // complete refund for review — sale lines at their original amounts with
  // return evidence on the still-unreturned stocked quantities, tenders
  // mirrored as payouts. Nothing is written; Save creates the draft.
  const refundFromId =
    isCreate &&
    createKind === "cash_refund" &&
    typeof sp.refundFrom === "string" &&
    isUuid(sp.refundFrom)
      ? sp.refundFrom
      : null;
  // Refund tenders mirror the sale's table rows (never custom): a cash
  // refund pays back through the same channels, so the operator starts from
  // the settled methods and adjusts.
  const refundSource = refundFromId
    ? ((
        await db.execute<{
          id: string;
          kind: string;
          status: string;
          party_id: string | null;
          custom: unknown;
          tenders: unknown;
        }>(
          sql`
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
         limit 1`,
          "objects",
        )
      )[0] ?? null)
    : null;
  const refundLines = refundSource
    ? await returnableSaleLines(authz.user.orgId, refundSource.id)
    : [];
  // Duplicate prefill: `?doc=new&kind=cash_sale&duplicateFrom=<sale>` copies
  // yesterday's batch as today's draft template — same lines and tender
  // shape with today's date. Close-out facts never copy: yesterday's tips,
  // fees, over/short and server belong to yesterday. Nothing is written;
  // Save creates the draft through the native path.
  const duplicateFromId =
    isCreate &&
    createKind === "cash_sale" &&
    typeof sp.duplicateFrom === "string" &&
    isUuid(sp.duplicateFrom)
      ? sp.duplicateFrom
      : null;
  const duplicateSource = duplicateFromId
    ? ((
        await db.execute<{ id: string; party_id: string | null; lines: unknown; tenders: unknown }>(
          sql`
        select d.id, d.party_id,
               coalesce((
                 select jsonb_agg(row_to_json(l) order by l.line_number)
                   from (
                     select l.line_number, l.account_id, l.item_id,
                            l.quantity::text as quantity, l.unit_price::text as unit_price,
                            l.amount::text as amount, l.description,
                            l.tax_code_id, l.tax_group_id
                       from document_lines l
                      where l.org_id = d.org_id and l.document_id = d.id
                   ) l
               ), '[]'::jsonb) as lines,
               coalesce((
                 select jsonb_agg(row_to_json(t) order by t.position)
                   from (
                     select t.position, t.kind, t.method_label, t.account_id,
                            t.stored_value_account_id,
                            ((t.amount_minor / 10000)::text || '.' || lpad((t.amount_minor % 10000)::text, 4, '0')) as amount,
                            t.reference
                       from document_tenders t
                      where t.org_id = d.org_id and t.document_id = d.id
                   ) t
               ), '[]'::jsonb) as tenders
          from documents d
         where d.org_id = ${authz.user.orgId} and d.id = ${duplicateFromId} and d.kind = 'cash_sale' and d.status <> 'voided'
         ${authz.allowedSubsidiaryIds ? sql`and d.subsidiary_id = any(${[...authz.allowedSubsidiaryIds]}::uuid[])` : sql``}
         limit 1`,
          "objects",
        )
      )[0] ?? null)
    : null;
  const duplicateSeed = duplicateSource
    ? buildDuplicateSeed({
        partyId: duplicateSource.party_id,
        lines: (duplicateSource.lines ?? []) as Parameters<typeof buildDuplicateSeed>[0]["lines"],
        tenders: (duplicateSource.tenders ?? []) as Parameters<
          typeof buildDuplicateSeed
        >[0]["tenders"],
      })
    : null;
  // "Duplicate yesterday" source: the latest non-voided cash sale dated
  // before the org's business today — usually yesterday's batch. The
  // button copies its lines and tender shape as today's draft.
  const yesterdaySaleId = canCreate
    ? ((
        await db.execute<{ id: string }>(
          sql`
        select d.id from documents d
         where d.org_id = ${authz.user.orgId} and d.kind = 'cash_sale' and d.status <> 'voided'
           and d.document_date < (${await businessToday(authz.user.orgId)})::date
           ${authz.allowedSubsidiaryIds ? sql`and d.subsidiary_id = any(${[...authz.allowedSubsidiaryIds]}::uuid[])` : sql``}
         order by d.document_date desc, d.created_at desc limit 1`,
          "objects",
        )
      )[0]?.id ?? null)
    : null;
  // Fast paths join the New menu only for creators: duplicating yesterday's
  // batch as today's draft, and one-form daily summary entry. Href items
  // navigate instead of opening the drawer.
  if (canCreate) {
    if (yesterdaySaleId) {
      newItems.push({
        kind: "cash_sale",
        label: tAr("list.cashDuplicateYesterday"),
        href: `${BASE_PATH}?doc=new&kind=cash_sale&duplicateFrom=${yesterdaySaleId}`,
      });
    }
    newItems.push({
      kind: "cash_sale",
      label: tAr("list.cashDailySummary"),
      href: `${BASE_PATH}/daily-summary`,
    });
  }
  // The create seed carries no lines, so the keep-existing-items clause
  // matches nothing — the same items list a blank draft would see.
  const existingDocId = openDoc ? docId : null;
  // Tax choices price as of the open document's own date, so a draft dated
  // before a rate change keeps the rate its amounts were entered at.
  const openDocumentFields = openDoc?.doc as Record<string, unknown> | undefined;
  const openDocumentDate =
    typeof openDocumentFields?.document_date === "string"
      ? openDocumentFields.document_date
      : undefined;
  const [pickers, resolvedForm] = await Promise.all([
    drawerOpen
      ? Promise.all([
          listScopedPartyOptionsWithCurrent(
            authz.user.orgId,
            documentOptionScope,
            "customer",
            openDoc?.doc.party_id ? String(openDoc.doc.party_id) : undefined,
          ),
          accountOptions(
            DOC_KINDS[drawerKind! as "cash_sale"]!,
            authz.user.orgId,
            documentOptionScope,
          ),
          taxCodeOptions(undefined, openDocumentDate),
          taxGroupOptions(undefined, openDocumentDate),
          dimensionOptions(authz.user.orgId, undefined, documentOptionScope),
          db.execute(
            sql`
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
             order by coalesce(it.code, it.name), it.name limit 2000`,
            "objects",
          ),
          // Multi-subsidiary orgs only — null keeps ALL subsidiary UI hidden.
          isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
            if (!multi) return null;
            const options = await subsidiaryOptions();
            return authz.allowedSubsidiaryIds
              ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
              : options;
          }),
          // Warehouses for the line-level stock-location picker. Empty hides
          // the picker; a single location is stamped silently instead.
          inventoryEnabled
            ? db
                .execute<Record<string, unknown>>(
                  sql`
              select id, code from stock_locations
               where org_id = ${authz.user.orgId} and is_active order by code`,
                )
                .then((r) => r.rows)
            : [],
          // Tender settlement accounts: bank + asset clearing. The edit
          // guard refuses receivables/payables by name, so the picker only
          // offers accounts a tender may actually settle into.
          db.execute(
            sql`
            select id, number, name from accounts
             where org_id = ${authz.user.orgId} and is_active and not is_summary
               and type in ('asset_bank', 'asset_current_other')
             order by number nulls last, name`,
            "objects",
          ),
          // Close-out server picker: active employees the tips belong to.
          // Cash kinds only — other drawers have no close-out, and an empty
          // list pools tips for the house split instead of refusing.
          drawerKind === "cash_sale" || drawerKind === "cash_refund"
            ? listScopedPartyOptions(authz.user.orgId, documentOptionScope, {
                role: "employee",
                activeOnly: true,
              })
            : Promise.resolve([]),
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
  ]);
  // Blank in-memory payload for unsaved create. The subsidiary defaults to
  // the first in-scope option in multi-subsidiary orgs so the form opens
  // submittable; unrestricted orgs keep the factory root default. A
  // configured walk-in customer is proposed as the party; the operator can
  // clear it for a fully anonymous sale or pick the real customer.
  const createSeed =
    isCreate && createKind ? await createDocumentSeed(authz.user.orgId, createKind) : null;
  if (createSeed && walkInCustomer && !refundSource) {
    (createSeed.doc as Record<string, unknown>).party_id = walkInCustomer.id;
    (createSeed.doc as Record<string, unknown>).party_name = walkInCustomer.display_name;
  }
  if (createSeed && duplicateSeed) {
    const seed = createSeed.doc as Record<string, unknown>;
    if (duplicateSeed.partyId) seed.party_id = duplicateSeed.partyId;
    seed.custom = {
      ...((seed.custom ?? {}) as Record<string, unknown>),
      tenders: duplicateSeed.tenders,
    };
    (createSeed as { lines: Record<string, unknown>[] }).lines = duplicateSeed.lines.map(
      (line) => ({
        item_id: line.itemId ?? null,
        account_id: line.accountId,
        quantity: line.quantity ?? "1",
        unit_price: line.unitPrice ?? line.amount,
        amount: line.amount,
        description: line.description ?? null,
        tax_code_id: line.taxCodeId ?? null,
        tax_group_id: line.taxGroupId ?? null,
      }),
    );
  }
  if (createSeed && refundSource) {
    const seed = createSeed.doc as Record<string, unknown>;
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
    }));
  }
  // A restricted subsidiary scope narrows the seed default the same way
  // the picker list narrows: the first visible subsidiary wins.
  const createSubsidiaryDefault = (() => {
    if (!createSeed || !pickers) return null;
    const options = (pickers[6] ?? []) as { id: string }[];
    if (options.length === 0) return null;
    const inScope = authz.allowedSubsidiaryIds
      ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
      : options;
    return inScope[0]?.id ?? null;
  })();
  if (createSeed && createSubsidiaryDefault) {
    (createSeed.doc as Record<string, unknown>).subsidiary_id = createSubsidiaryDefault;
  }
  const drawerPayload = openDoc ?? createSeed;
  // Provider commit rows for a posted cash document: posting enqueues them
  // in its own transaction, so by the time the drawer opens they are here.
  // Facilitator names load for every open drawer — the collector choice is
  // made on the draft, before posting.
  const providerRows =
    drawerOpen && openDoc && !isCreate && String(openDoc.doc.status) === "posted"
      ? await readProviderTransactionsForDocument(authz.user.orgId, String(openDoc.doc.id))
      : [];
  const taxProvider =
    providerRows.length > 0 && openDoc
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
      : null;
  const facilitatorRows = drawerOpen
    ? await db.execute<{ name: string }>(
        sql`
        select name from marketplace_facilitators
         where org_id = ${authz.user.orgId} and is_active
         order by name`,
        "objects",
      )
    : [];
  const tenderAccountOptions = (pickers?.[8] ?? []) as {
    id: string;
    number: string | null;
    name: string | null;
  }[];
  const defaultTenderAccountId =
    tillDefaults?.defaultCashAccountId ?? tenderAccountOptions[0]?.id ?? null;
  // Till-drop destinations: the configured deposit accounts among the
  // tender settlement accounts. Empty disables drops in the drawer — the
  // deposit endpoint refuses with this screen as the remedy either way.
  const depositAccountIds = new Set(tillDefaults?.depositAccountIds ?? []);
  const depositAccounts =
    drawerKind === "cash_sale"
      ? tenderAccountOptions.filter((a) => depositAccountIds.has(a.id))
      : [];
  const depositDefaultDate =
    drawerKind === "cash_sale" && canDeposit ? await businessToday(authz.user.orgId) : "";
  const submitRouting = drawerOpen
    ? await documentSubmitRouting(
        authz.user.orgId,
        openDoc?.doc as Record<string, unknown> | undefined,
      )
    : {};
  const drawer =
    drawerPayload && pickers && resolvedForm && drawerKind
      ? {
          basePath: BASE_PATH,
          remountKey: openDoc ? String(openDoc.doc.id) : `new:${drawerKind}`,
          payload: drawerPayload,
          createMode: isCreate,
          allocationsEntryEnabled: featureEnabled(featureState, "allocationsAtEntry"),
          config: DOC_KINDS[drawerKind]!,
          initialMode: (isCreate || pickString(sp.mode) === "edit" ? "edit" : "view") as
            "edit" | "view",
          // The drawer's edit, save, delete and post affordances read these
          // grants; without them every draft rendered read-only for every
          // role. The document routes enforce the same permissions.
          canCreate,
          canPost,
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
          headerDefs: headerDefs as DocumentDrawerProps["headerDefs"],
          lineDefs: lineDefs as DocumentDrawerProps["lineDefs"],
          recordType: drawerKind,
          tenderAccounts: tenderAccountOptions,
          refundHref:
            drawerKind === "cash_sale" &&
            openDoc &&
            String(openDoc.doc.status) === "posted" &&
            canCreate
              ? `${BASE_PATH}?doc=new&kind=cash_refund&refundFrom=${openDoc.doc.id}`
              : null,
          ...submitRouting,
          defaultTenderAccountId,
          canDeposit,
          depositAccounts,
          depositDefaultDate,
          serverOptions: ((pickers?.[9] ?? []) as { id: string; display_name: string }[]).map(
            (s) => ({
              value: s.id,
              label: s.display_name ?? "",
            }),
          ),
          taxProvider,
          marketplaceFacilitators: facilitatorRows,
          storedValueEnabled: featureEnabled(featureState, "storedValue"),
        }
      : null;
  return {
    title: tAr("list.cashTitle"),
    description: tAr("list.cashDescription"),
    emptyTitle: tAr("list.cashEmptyTitle"),
    emptyDescription: tAr("list.cashEmptyDescription"),
    currentParams: sp,
    canCreate,
    canPost,
    newButton: newDocument.props,
    drawerOpen: Boolean(drawer),
    drawer,
  };
}

const f = ref<CashSalesData>();

export function cashSalesSpec(data: CashSalesData): PageSpec {
  const newDocument = {
    widget: "new-document",
    props: {
      items: data.newButton.items,
      basePath: BASE_PATH,
      triggerLabel: data.newButton.triggerLabel,
    },
  };
  return page({
    route: "/cash-sales",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [widget(newDocument.widget, newDocument.props, f("canCreate"))],
      }),
    ],
    body: [
      widgetBlock("record-list-view", {
        recordType: "cash_sale",
        basePath: BASE_PATH,
        sp: data.currentParams,
        drawer: data.drawer ? { widget: "document-drawer", props: { drawer: data.drawer } } : null,
        emptyTitle: f("emptyTitle"),
        emptyDescription: f("emptyDescription"),
        emptyAction: data.canCreate ? newDocument : null,
      }),
    ],
  });
}
