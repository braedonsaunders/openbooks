import { can, type Authz } from '@/lib/authz'
import { paymentSharedSubsidiaryFilter } from '@/lib/payment-run-access'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { loadPaymentDocument, openItemsForParty } from "@openbooks/engine/src/payments/payment-queries.ts";
import { PAYMENT_KIND_SIDE, type PaymentKind } from "@openbooks/engine/src/payments/payment-contracts.ts";
import { RecordListView } from '../../../components/record-list-view'
import { isUuid, mergeHref } from '../../../lib/list-params'
import { NewPaymentButton } from './NewPaymentButton'
import { PaymentDrawer, type OpenItemClient } from './PaymentDrawer'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { pickString } from '../../../lib/list-params'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'

/**
 * Payment/receipt list, shared by /payments (vendor_payment) and /receipts
 * (customer_payment). The whole list — search, filters, saved views, sortable
 * typed table, drill-through, pagination — is the universal RecordListView;
 * this component only resolves the payment-specific ?payment= flyout.
 */
export async function PaymentsSection({
  sp,
  authz,
  basePath,
  kind,
  orgId,
  userId,
  canManage,
  canCreate,
  userRoles,
}: {
  sp: Record<string, string | string[] | undefined>
  authz: Authz
  basePath: string
  kind: PaymentKind
  orgId: string
  userId: string
  /** List-view customization (saved views) — never a creation gate. */
  canManage: boolean
  /** Payment creation (ap.pay / ar.pay by kind) — the single flag the New
   *  button and the ?paymentNew=1 drawer share, so neither is ever offered
   *  without the other. */
  canCreate: boolean
  userRoles: readonly string[]
}) {
  if (authz.user.orgId !== orgId || !can(authz, kind === 'vendor_payment' ? 'ap.pay' : 'ar.pay')) return null
  const t = await getTranslations('payments')
  const side = PAYMENT_KIND_SIDE[kind]
  const newLabel = t('list.newLabel', { side })

  // -- flyout ---------------------------------------------------------------
  // Unsaved-create: ?paymentNew=1 opens an editable drawer on no persisted
  // row. The loader ships pickers plus an empty payload; opening writes
  // nothing, Cancel writes nothing, and the drawer's explicit Save is the
  // single idempotent POST. Gated on the payment permission (canCreate),
  // never on list-view customization: a payer without manage rights must
  // still get the drawer the New button promises. The kind stays fixed by
  // this section's `kind` — the surface decides it.
  const creating = pickString(sp.paymentNew) === '1' && canCreate
  const paymentId = typeof sp.payment === 'string' && isUuid(sp.payment) ? sp.payment : undefined
  const loaded = paymentId ? await loadPaymentDocument(paymentId, kind, orgId, authz.allowedSubsidiaryIds) : null
  const openPayment = loaded ?? null
  const closeHref = mergeHref(basePath, sp, {
    payment: undefined,
    paymentNew: undefined,
    mode: undefined,
    form: undefined,
  })
  let drawer: React.ReactNode = null
  if (openPayment || creating) {
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
      // Read-only lookups — opening the drawer still writes nothing, and no
      // PAY-/RCPT- number is allocated until the explicit Save commits.
      creating
        ? Promise.all([
            businessToday(orgId),
            db.execute<{ base_currency: string }>(sql`
              select base_currency from orgs where id = ${orgId}`),
          ])
        : null,
    ])
    const openItems: OpenItemClient[] =
      !creating && openPayment && openPayment.doc.status === 'draft' && openPayment.doc.party_id
        ? await openItemsForParty(openPayment.doc.party_id as string, side, orgId, authz.allowedSubsidiaryIds)
        : []
    const resolvedForm = await resolveFormLayout({
      orgId,
      userId,
      recordType: kind,
      userRoles: [...userRoles],
      headerDefs: [],
      lineDefs: [],
      explicitLayoutId: pickString(sp.form),
    })
    // The unsaved-create payload: no row exists, so the drawer edits blanks
    // and posts them once. Draft by default, dated today; party, bank
    // account, and applications start empty for the operator to fill.
    const newPaymentPayload = creating
      ? {
          doc: {
            id: '',
            kind,
            status: 'draft',
            currency: defaults?.[1].rows[0]?.base_currency ?? '',
            total: '0',
            document_number: null,
            party_id: null,
            party_name: null,
            document_date: defaults?.[0] ?? '',
            reference_number: null,
            memo: null,
            updated_at: '',
            entry_id: null,
            bank_account_number: null,
            bank_account_name: null,
          },
          bankAccountId: null,
          allocations: [],
          applied: [],
        }
      : null
    drawer = (
      <PaymentDrawer
        payment={(creating ? newPaymentPayload! : openPayment!)}
        key={creating ? 'new-payment' : String(openPayment!.doc.id)}
        initialMode={creating || pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
        initialOpenItems={openItems}
        parties={parties.rows}
        bankAccounts={banks.rows}
        side={side}
        basePath={basePath}
        layout={resolvedForm.layout}
        createMode={creating}
        closeHref={closeHref}
        createTitle={newLabel}
      />
    )
  }

  return (
    <RecordListView
      recordType={kind}
      basePath={basePath}
      orgId={orgId}
      userId={userId}
      canManage={canManage}
      sp={sp}
      drawer={drawer}
      emptyAction={canCreate ? <NewPaymentButton kind={kind} basePath={basePath} label={newLabel} /> : undefined}
    />
  )
}
