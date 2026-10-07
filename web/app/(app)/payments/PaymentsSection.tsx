import { can, type Authz } from '@/lib/authz'
import { getTranslations } from 'next-intl/server'
import { PAYMENT_KIND_SIDE, type PaymentKind } from "@openbooks/engine/src/payments/payment-contracts.ts";
import { RecordListView } from '../../../components/record-list-view'
import { isUuid, mergeHref } from '../../../lib/list-params'
import { NewPaymentButton } from './NewPaymentButton'
import { PaymentDrawer } from './PaymentDrawer'
import { loadPaymentFlyout } from './payment-flyout'
import { pickString } from '../../../lib/list-params'

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
  // One shared resolution behind the drawer, whether it opens from this
  // list, a deep link or another record's reference (see payment-flyout).
  const flyout =
    creating || paymentId
      ? await loadPaymentFlyout({
          paymentId,
          creating,
          kind,
          orgId,
          userId,
          userRoles,
          authz,
          formId: pickString(sp.form),
        })
      : null
  const closeHref = mergeHref(basePath, sp, {
    payment: undefined,
    paymentNew: undefined,
    mode: undefined,
    form: undefined,
  })
  // Persisted receipts belong to the shared list host, including server deep
  // links. A separate server drawer would cover the host's second dialog.
  const nativeDrawer = !creating && kind === 'customer_payment' && flyout?.mode === 'record'
    ? { widget: 'payment-drawer' as const, drawer: {
        flyout, basePath, closeHref, initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
      } }
    : null
  let drawer: React.ReactNode = null
  if (flyout && !nativeDrawer) {
    const openPayment = flyout.mode === 'record' ? flyout.payment : null
    drawer = (
      <PaymentDrawer
        payment={flyout.payment}
        key={flyout.mode === 'create' ? 'new-payment' : String(openPayment!.doc.id)}
        initialMode={creating || pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
        initialOpenItems={flyout.initialOpenItems}
        parties={flyout.parties}
        bankAccounts={flyout.bankAccounts}
        side={flyout.side}
        basePath={basePath}
        layout={flyout.layout}
        createMode={creating}
        closeHref={closeHref}
        createTitle={newLabel}
        storedValue={flyout.storedValue}
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
      nativeDrawer={nativeDrawer}
      emptyAction={canCreate ? <NewPaymentButton kind={kind} basePath={basePath} label={newLabel} /> : undefined}
    />
  )
}
