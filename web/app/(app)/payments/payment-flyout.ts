import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { loadPaymentDocument, openItemsForParty, PAYMENT_KIND_SIDE, type PaymentKind } from '@openbooks/engine/payments/documents'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { paymentSharedSubsidiaryFilter } from '@/lib/payment-run-access'
import { resolveFormLayout } from '@/lib/customization/resolve'
import type { FormLayoutConfig } from '@openbooks/customization'
import { isFeatureEnabled } from '@/lib/features'
import { can, type Authz } from '@/lib/authz'
import type { OpenItemClient, PaymentPayload } from './PaymentDrawer'

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
  mode: 'record'
  payment: PaymentPayload
  initialOpenItems: OpenItemClient[]
  parties: { id: string; display_name: string }[]
  bankAccounts: { id: string; number: string | null; name: string }[]
  side: 'ap' | 'ar'
  layout: FormLayoutConfig
  storedValue: {
    tenders: { accountId: string; codeLast4: string; amount: string }[]
    customerCredits: { accountId: string; codeLast4: string; currency: string; balance: string }[]
  } | null
}

export interface PaymentFlyoutCreate {
  mode: 'create'
  payment: PaymentPayload
  initialOpenItems: OpenItemClient[]
  parties: { id: string; display_name: string }[]
  bankAccounts: { id: string; number: string | null; name: string }[]
  side: 'ap' | 'ar'
  layout: FormLayoutConfig
  storedValue: null
}

export type PaymentFlyout = PaymentFlyoutRecord | PaymentFlyoutCreate

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
  prefill?: { partyId?: string; documentId?: string }
  /** Persisted record to open; omitted for the unsaved-create drawer. */
  paymentId?: string
  /** Unsaved-create: no persisted row exists. Opening writes nothing and no
   *  number is allocated until the drawer's explicit Save commits. */
  creating: boolean
  kind: PaymentKind
  orgId: string
  userId: string
  userRoles: readonly string[]
  authz: Authz
  formId?: string
}): Promise<PaymentFlyout | null> {
  const side = PAYMENT_KIND_SIDE[kind]
  if (!creating && !paymentId) return null
  const openPayment = !creating && paymentId
    ? await loadPaymentDocument(paymentId, kind, orgId, authz.allowedSubsidiaryIds)
    : null
  if (!creating && !openPayment) return null
  const partyFilter =
    side === 'ap'
      ? sql`exists (select 1 from vendor_roles vr where vr.org_id = p.org_id and vr.party_id = p.id and vr.is_active)`
      : sql`exists (select 1 from customer_roles cr where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)`
  const [parties, banks, defaults] = await Promise.all([
    db.execute<{ id: string; display_name: string }>(sql`
      select id, display_name from parties p
       where p.org_id = ${orgId} and ${partyFilter} and is_active ${paymentSharedSubsidiaryFilter(sql`p.subsidiary_id`, authz)}
       order by display_name limit 2000`),
    db.execute<{ id: string; number: string | null; name: string }>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
       order by number nulls last, name`),
    // Unsaved-create defaults: today's date plus the org currency.
    // Read-only lookups — opening the drawer still writes nothing.
    creating
      ? Promise.all([
          businessToday(orgId),
          db.execute<{ base_currency: string }>(sql`
            select base_currency from orgs where id = ${orgId}`),
        ])
      : null,
  ])
  const initialOpenItems: OpenItemClient[] =
    openPayment && openPayment.doc.status === 'draft' && openPayment.doc.party_id
      ? await openItemsForParty(openPayment.doc.party_id as string, side, orgId, authz.allowedSubsidiaryIds, { paymentDocumentId: String(openPayment.doc.id) })
      : []
  // Stored-value tenders (receipts only): already-saved snapshots from the
  // draft plus the receipt party's verified credit for the picker. Null
  // while the feature is off or unreadable, so the drawer section never
  // renders without the read surface behind it.
  const storedValueEnabled =
    side === 'ar' &&
    (await isFeatureEnabled(orgId, 'storedValue')) &&
    can(authz, 'stored_value.read')
  const storedValueTenders =
    storedValueEnabled && openPayment
      ? (((openPayment.doc.custom ?? {}) as { storedValueTenders?: unknown }).storedValueTenders as
        | { accountId: string; codeLast4: string; amount: string }[] ?? [])
      : []
  const storedValueCredits =
    storedValueEnabled && openPayment?.doc.party_id
      ? (await db.execute<{ accountId: string; codeLast4: string; currency: string; balance: string }>(sql`
        select id as "accountId", code_last4 as "codeLast4", currency,
               (balance_minor::numeric / 10000)::text as balance
          from stored_value_accounts
         where org_id = ${orgId} and customer_party_id = ${openPayment.doc.party_id as string}
           and status in ('active', 'frozen') and balance_minor > 0
         order by currency, code_last4`)).rows
      : []
  const resolvedForm = await resolveFormLayout({
    orgId,
    userId,
    recordType: kind,
    userRoles: [...userRoles],
    headerDefs: [],
    lineDefs: [],
    explicitLayoutId: formId,
  })
  if (creating) {
    // The unsaved-create payload: no row exists, so the drawer edits blanks
    // and posts them once. Draft by default, dated today; party, bank
    // account, and applications start empty for the operator to fill —
    // unless another record opened the drawer for a known party (and
    // document), which preselects them. Opening still writes nothing.
    const currency = defaults?.[1].rows[0]?.base_currency ?? ''
    const prefillParty = prefill?.partyId
      ? parties.rows.find((party) => party.id === prefill.partyId) ?? null
      : null
    const prefillItems: OpenItemClient[] = prefillParty
      ? await openItemsForParty(prefillParty.id, side, orgId, authz.allowedSubsidiaryIds)
      : []
    // Same-currency items of the named document, unreserved, on one control
    // account: exactly the selection the drawer itself would accept.
    const documentItems = prefill?.documentId
      ? prefillItems.filter((item) =>
          item.documentId === prefill.documentId && item.currency === currency && !item.reservedByRun)
      : []
    const prefillAccount = documentItems[0]?.accountId
    const prefillAllocations = documentItems
      .filter((item) => item.accountId === prefillAccount)
      .map((item) => ({
        openLineId: item.lineId,
        sourceTransactionAmount: item.transactionOpen,
        targetTransactionAmount: item.transactionOpen,
        settlementRate: '1',
        settlementRateSource: 'same_currency' as const,
        settlementRateReference: 'same transaction currency',
      }))
    return {
      mode: 'create',
      payment: {
        doc: {
          id: '',
          kind,
          status: 'draft',
          currency,
          total: '0',
          document_number: null,
          party_id: prefillParty?.id ?? null,
          party_name: prefillParty?.display_name ?? null,
          document_date: defaults?.[0] ?? '',
          reference_number: null,
          memo: null,
          updated_at: '',
          entry_id: null,
          bank_account_number: null,
          bank_account_name: null,
        },
        // A sole eligible bank account is an unambiguous draft default;
        // the shared drawer still requires explicit Save and posting.
        bankAccountId: banks.rows.length === 1 ? banks.rows[0]!.id : null,
        allocations: prefillAllocations,
        applied: [],
        withholdingEnabled: kind === 'vendor_payment' && await isFeatureEnabled(orgId, 'contractorWithholding'),
      } as PaymentPayload,
      initialOpenItems: prefillItems,
      parties: parties.rows,
      bankAccounts: banks.rows,
      side,
      layout: resolvedForm.layout,
      storedValue: null,
    }
  }
  return {
    mode: 'record',
    payment: openPayment!,
    initialOpenItems,
    parties: parties.rows,
    bankAccounts: banks.rows,
    side,
    layout: resolvedForm.layout,
    storedValue: storedValueEnabled ? { tenders: storedValueTenders, customerCredits: storedValueCredits } : null,
  }
}
