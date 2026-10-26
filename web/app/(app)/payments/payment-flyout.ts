import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { fromUnits } from "@openbooks/engine/money";
import {
  loadPaymentDocument,
  openItemsForParty,
  receiptFundingSubsidiaryOptions,
  PAYMENT_KIND_SIDE,
  type PaymentKind,
} from "@openbooks/engine/payments/documents";
import { receiptAccountOptions } from "@/lib/documents";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { paymentSharedSubsidiaryFilter } from "@/lib/payment-run-access";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { resolveFormLayout } from "@/lib/customization/resolve";
import type { FormLayoutConfig } from "@openbooks/customization";
import { isFeatureEnabled } from "@/lib/features";
import { can, type Authz } from "@/lib/authz";
import type { OpenItemClient, PaymentPayload } from "./PaymentDrawer";

/**
 * Shared payment/receipt flyout resolution: the record (or the unsaved
 * create blanks), its pickers, open items, form layout and stored-value
 * bundle behind one payment drawer. The list page and the list-drawer route
 * both read it, so the drawer opens with identical data from a list row, a
 * deep link or another record's reference. Returns null when there is
 * nothing to open, or when the persisted record is missing, of another
 * kind, or outside the caller's subsidiary scope. Resolving writes nothing.
 */
export interface PaymentFlyoutRecord {
  mode: "record";
  payment: PaymentPayload;
  initialOpenItems: OpenItemClient[];
  parties: { id: string; display_name: string }[];
  bankAccounts: { id: string; number: string | null; name: string }[];
  side: "ap" | "ar";
  layout: FormLayoutConfig;
  storedValue: {
    tenders: { accountId: string; codeLast4: string; amount: string }[];
    customerCredits: { accountId: string; codeLast4: string; currency: string; balance: string }[];
  } | null;
}

export interface PaymentFlyoutCreate {
  mode: "create";
  payment: PaymentPayload;
  initialOpenItems: OpenItemClient[];
  parties: { id: string; display_name: string }[];
  bankAccounts: { id: string; number: string | null; name: string }[];
  side: "ap" | "ar";
  layout: FormLayoutConfig;
  storedValue: PaymentFlyoutRecord["storedValue"];
}

export type PaymentFlyout = PaymentFlyoutRecord | PaymentFlyoutCreate;

export async function loadPaymentFlyout({
  paymentId,
  creating,
  kind,
  orgId,
  userId,
  userRoles,
  authz,
  formId,
  prefill,
}: {
  /** Unsaved-create prefill from another record's "Receive payment" / "Pay
   *  bill" action: the party, and optionally one of its posted documents
   *  whose open items are selected in full. Ids outside the caller's party
   *  list or the party's open items are ignored, never trusted. */
  prefill?: { partyId?: string; documentId?: string };
  /** Persisted record to open; omitted for the unsaved-create drawer. */
  paymentId?: string;
  /** Unsaved-create: no persisted row exists. Opening writes nothing and no
   *  number is allocated until the drawer's explicit Save commits. */
  creating: boolean;
  kind: PaymentKind;
  orgId: string;
  userId: string;
  userRoles: readonly string[];
  authz: Authz;
  formId?: string;
}): Promise<PaymentFlyout | null> {
  const side = PAYMENT_KIND_SIDE[kind];
  if (!creating && !paymentId) return null;
  const openPayment =
    !creating && paymentId
      ? await loadPaymentDocument(paymentId, kind, orgId, authz.allowedSubsidiaryIds)
      : null;
  if (!creating && !openPayment) return null;
  const partyFilter =
    side === "ap"
      ? sql`exists (select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id and vr.is_active)`
      : sql`exists (select 1 from customer_roles cr where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)`;
  const [parties, defaults] = await Promise.all([
    db.execute<{ id: string; display_name: string; subsidiary_id: string | null }>(
      sql`
      select id, display_name, subsidiary_id from parties p
       where p.org_id = ${orgId} and ${partyFilter} and is_active ${paymentSharedSubsidiaryFilter(sql`p.subsidiary_id`, authz)}
       order by display_name limit 2000`,
      "objects",
    ),
    // Unsaved-create defaults: today's date plus the org currency.
    // Read-only lookups — opening the drawer still writes nothing.
    creating
      ? Promise.all([
          businessToday(orgId),
          db.execute<{ base_currency: string }>(sql`
            select base_currency from orgs where id = ${orgId}`),
        ])
      : null,
  ]);
  const selectedParty =
    creating && prefill?.partyId ? parties.find((party) => party.id === prefill.partyId) : null;
  const prefillSubject =
    selectedParty && prefill?.documentId
      ? (
          await db.execute<{ subsidiary_id: string | null; currency: string }>(
            sql`
      select coalesce(d.subsidiary_id, e.subsidiary_id) as subsidiary_id, d.currency from documents d
        join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
       where d.org_id = ${orgId} and d.id = ${prefill.documentId} and d.party_id = ${selectedParty.id}
         and d.status = 'posted' ${paymentSharedSubsidiaryFilter(sql`coalesce(d.subsidiary_id, e.subsidiary_id)`, authz)}`,
            "objects",
          )
        )[0]
      : null;
  const needsFundingOptions =
    creating ||
    (openPayment?.doc.status === "draft" && can(authz, side === "ar" ? "ar.pay" : "ap.pay"));
  const fundingSubsidiaries = needsFundingOptions
    ? await receiptFundingSubsidiaryOptions(orgId, userId, kind, authz.allowedSubsidiaryIds)
    : [];
  const root = (
    await db.execute<{ id: string }>(
      sql`select id from subsidiaries where org_id = ${orgId} and parent_id is null`,
      "objects",
    )
  )[0]?.id;
  const proposedSubsidiaryId =
    (openPayment?.doc.subsidiary_id as string | null | undefined) ??
    prefillSubject?.subsidiary_id ??
    selectedParty?.subsidiary_id ??
    root;
  const fundingSubsidiaryId = !needsFundingOptions
    ? proposedSubsidiaryId
    : fundingSubsidiaries.some((sub) => sub.id === proposedSubsidiaryId)
      ? proposedSubsidiaryId
      : fundingSubsidiaries.length === 1
        ? fundingSubsidiaries[0]!.id
        : undefined;
  const fundingCurrency =
    (openPayment?.doc.currency as string | undefined) ??
    prefillSubject?.currency ??
    defaults?.[1].rows[0]?.base_currency ??
    "";
  const fundingDate =
    (openPayment?.doc.document_date as string | undefined) ??
    defaults?.[0] ??
    (await businessToday(orgId));
  const banks = {
    rows:
      needsFundingOptions && fundingSubsidiaryId
        ? await receiptAccountOptions({
            orgId,
            actorId: userId,
            kind,
            subsidiaryId: fundingSubsidiaryId,
            currency: fundingCurrency,
            onDate: fundingDate,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          })
        : [],
  };
  const initialOpenItems: OpenItemClient[] =
    openPayment && openPayment.doc.status === "draft" && openPayment.doc.party_id
      ? await openItemsForParty(
          openPayment.doc.party_id as string,
          side,
          orgId,
          fundingSubsidiaryId ? new Set([fundingSubsidiaryId]) : new Set(),
          { paymentDocumentId: String(openPayment.doc.id) },
        )
      : [];
  // Stored-value tenders (receipts only): already-saved snapshots from the
  // draft plus the receipt party's verified credit for the picker. Null
  // while the feature is off or unreadable, so the drawer section never
  // renders without the read surface behind it.
  const storedValueEnabled =
    side === "ar" &&
    (await isFeatureEnabled(orgId, "storedValue")) &&
    can(authz, "stored_value.read");
  const storedValueTenders =
    storedValueEnabled && openPayment
      ? ((((openPayment.doc.custom ?? {}) as { storedValueTenders?: unknown })
          .storedValueTenders as { accountId: string; codeLast4: string; amount: string }[]) ?? [])
      : [];
  const storedValuePartyId = creating
    ? selectedParty?.id
    : (openPayment?.doc.party_id as string | undefined);
  const storedValueCredits =
    storedValueEnabled && storedValuePartyId
      ? (
          await db.execute<{
            accountId: string;
            codeLast4: string;
            currency: string;
            balanceMinor: string;
          }>(
            sql`
        select id as "accountId", code_last4 as "codeLast4", currency,
               balance_minor::text as "balanceMinor"
          from stored_value_accounts
         where org_id = ${orgId} and customer_party_id = ${storedValuePartyId}
           and status in ('active', 'frozen') and balance_minor > 0
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, authz.allowedSubsidiaryIds)}
         order by currency, code_last4`,
            "objects",
          )
        ).map((row) => ({ ...row, balance: fromUnits(BigInt(row.balanceMinor)) }))
      : [];
  const resolvedForm = await resolveFormLayout({
    orgId,
    userId,
    recordType: kind,
    userRoles: [...userRoles],
    headerDefs: [],
    lineDefs: [],
    explicitLayoutId: formId,
  });
  // Whether posting this kind routes through approval: an enabled on_submit
  // flow owns the post. The drawer labels its primary action from this so
  // "Post" never promises a direct posting a flow will intercept. With the
  // Flows feature off nothing can govern, whatever rows exist.
  // The functional currency of the payment's legal entity: the drawer binds
  // an explicit settlement rate to exactly this currency and displays the
  // pair, so it comes from the live entity row, never from client state.
  const functionalCurrency = fundingSubsidiaryId
    ? ((
        await db.execute<{ base_currency: string }>(
          sql`
        select base_currency from subsidiaries
         where org_id = ${orgId} and id = ${fundingSubsidiaryId} and is_active and not is_elimination`,
          "objects",
        )
      )[0]?.base_currency ?? null)
    : null;
  const governedByFlow =
    (await isFeatureEnabled(orgId, "flows")) &&
    (
      await db.execute<{ one: number }>(
        sql`
      select 1 as one from flows
       where org_id = ${orgId} and subject_kind = ${kind} and enabled
         and graph->'nodes' @> '[{"data":{"kind":"trigger","trigger":{"trigger":"on_submit"}}}]'::jsonb
       limit 1`,
        "objects",
      )
    ).length > 0;
  if (creating) {
    // The unsaved-create payload: no row exists, so the drawer edits blanks
    // and posts them once. Draft by default, dated today; party, bank
    // account, and applications start empty for the operator to fill —
    // unless another record opened the drawer for a known party (and
    // document), which preselects them. Opening still writes nothing.
    const currency = fundingCurrency;
    const prefillParty = prefill?.partyId
      ? (parties.find((party) => party.id === prefill.partyId) ?? null)
      : null;
    const prefillItems = prefillParty
      ? await openItemsForParty(
          prefillParty.id,
          side,
          orgId,
          fundingSubsidiaryId ? new Set([fundingSubsidiaryId]) : new Set(),
        )
      : [];
    // Same-currency items of the named document, unreserved, on one control
    // account: exactly the selection the drawer itself would accept.
    const documentItems = prefill?.documentId
      ? prefillItems.filter(
          (item) =>
            item.documentId === prefill.documentId &&
            item.currency === currency &&
            !item.reservedByRun,
        )
      : [];
    const prefillAccount = documentItems[0]?.accountId;
    const prefillAllocations = documentItems
      .filter((item) => item.accountId === prefillAccount)
      .map((item) => ({
        openLineId: item.lineId,
        sourceTransactionAmount: item.transactionOpen,
        targetTransactionAmount: item.transactionOpen,
        settlementRate: "1",
        settlementRateSource: "same_currency" as const,
        settlementRateReference: "same transaction currency",
      }));
    return {
      mode: "create",
      payment: {
        doc: {
          id: "",
          kind,
          status: "draft",
          currency,
          functional_currency: functionalCurrency,
          subsidiary_id: fundingSubsidiaryId ?? null,
          funding_subsidiaries: fundingSubsidiaries,
          total: "0",
          document_number: null,
          party_id: prefillParty?.id ?? null,
          party_name: prefillParty?.display_name ?? null,
          document_date: defaults?.[0] ?? "",
          reference_number: null,
          memo: null,
          updated_at: "",
          entry_id: null,
          bank_account_number: null,
          bank_account_name: null,
        },
        // A sole eligible bank account is an unambiguous draft default;
        // the shared drawer still requires explicit Save and posting.
        bankAccountId: banks.rows.length === 1 ? banks.rows[0]!.id : null,
        allocations: prefillAllocations,
        applied: [],
        governedByFlow,
        withholdingEnabled:
          kind === "vendor_payment" && (await isFeatureEnabled(orgId, "contractorWithholding")),
      } as PaymentPayload,
      initialOpenItems: prefillItems,
      parties,
      bankAccounts: banks.rows,
      side,
      layout: resolvedForm.layout,
      storedValue: storedValueEnabled ? { tenders: [], customerCredits: storedValueCredits } : null,
    };
  }
  return {
    mode: "record",
    payment: {
      ...openPayment!,
      doc: {
        ...openPayment!.doc,
        functional_currency: functionalCurrency,
        subsidiary_id: fundingSubsidiaryId ?? openPayment!.doc.subsidiary_id,
      },
      governedByFlow,
      canRetryPostingEffects:
        can(authz, side === "ar" ? "ar.pay" : "ap.pay") &&
        (await isFeatureEnabled(orgId, "banking")),
      canApplyUnapplied: can(authz, side === "ar" ? "ar.pay" : "ap.pay"),
    },
    initialOpenItems,
    parties,
    bankAccounts: banks.rows,
    side,
    layout: resolvedForm.layout,
    storedValue: storedValueEnabled
      ? { tenders: storedValueTenders, customerCredits: storedValueCredits }
      : null,
  };
}
