import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BillingHistoryError,
  deriveChangesFromInvoices,
  mapChargebeeCoupon,
  mapChargebeeCreditNote,
  mapChargebeeCustomer,
  mapChargebeeEvent,
  mapChargebeeInvoice,
  mapChargebeePayment,
  mapChargebeePlan,
  mapChargebeeSubscription,
  mapMaxioCoupon,
  mapMaxioCustomer,
  mapMaxioInvoice,
  mapMaxioPayment,
  mapMaxioPlan,
  mapMaxioSubscription,
  mapMaxioUsage,
  mapRecurlyCoupon,
  mapRecurlyCredit,
  mapRecurlyCustomer,
  mapRecurlyInvoice,
  mapRecurlyPlan,
  mapRecurlyPayment,
  mapRecurlySubscription,
  mapRecurlyUsage,
  mapZuoraAmendment,
  mapZuoraCreditMemo,
  mapZuoraCustomer,
  mapZuoraInvoice,
  mapZuoraPayment,
  mapZuoraPlan,
  mapZuoraRevenueSchedule,
  mapZuoraSubscription,
  mapZuoraUsage,
  mrrByMonth,
  planBillingPreflight,
  reconcileBillingHistory,
  sourceDeferredRevenue,
  sourceOpenArByCustomer,
  subscriptionStateAtEndOfMonth,
  unwrapMaxio,
  type CanonicalInvoice,
} from "./billing-history.ts";
import { monthlyRecurringRevenue } from "../billing/subscription-billing.ts";

function normalize(amount: string, interval: "weekly" | "monthly" | "quarterly" | "annually", count: number, quantity: string): string {
  return monthlyRecurringRevenue(amount, interval, count, quantity);
}

// --- Chargebee --------------------------------------------------------------------

test("chargebee customer maps names, email and currency", () => {
  const customer = mapChargebeeCustomer({
    id: "16Bq2o3K9vX1abc1",
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.com",
    currency_code: "usd",
    updated_at: 1704067200,
  });
  assert.equal(customer.externalId, "16Bq2o3K9vX1abc1");
  assert.equal(customer.name, "Ada Lovelace");
  assert.equal(customer.email, "ada@example.com");
  assert.equal(customer.currency, "USD");
  assert.equal(customer.updatedAt, "2024-01-01");
});

test("chargebee plan converts minor units through the currency exponent", () => {
  const monthly = mapChargebeePlan({ id: "starter-monthly", name: "Starter", price: 2900, currency_code: "USD", period: 1, period_unit: "month" });
  assert.equal(monthly.amountMajor, "29.0000");
  assert.equal(monthly.interval, "monthly");
  const yen = mapChargebeePlan({ id: "starter-jpy", name: "Starter", price: 2900, currency_code: "JPY", period: 1, period_unit: "month" });
  assert.equal(yen.amountMajor, "2900.0000");
});

test("chargebee subscription upgrade and downgrade events reconstruct the change timeline", () => {
  const created = mapChargebeeEvent({
    event_type: "subscription_created",
    occurred_at: 1704067200,
    content: { subscription: { plan_id: "starter-monthly", plan_quantity: 1 } },
  });
  assert.equal(created, null);
  const upgrade = mapChargebeeEvent({
    event_type: "subscription_changed",
    occurred_at: 1711929600,
    content: { subscription: { plan_id: "growth-monthly", plan_quantity: 3 } },
  });
  assert.equal(upgrade?.kind, "plan_change");
  assert.equal(upgrade?.planExternalId, "growth-monthly");
  assert.equal(upgrade?.quantity, "3");
  assert.equal(upgrade?.derived, false);
  assert.equal(upgrade?.effectiveOn, "2024-04-01");
  const cancel = mapChargebeeEvent({ event_type: "subscription_cancelled", occurred_at: 1725148800, content: {} });
  assert.equal(cancel?.kind, "cancel");
});

test("chargebee invoice balances paid, credited and written-off amounts exactly", () => {
  const invoice = mapChargebeeInvoice({
    id: "inv_1001",
    customer_id: "16Bq2o3K9vX1abc1",
    subscription_id: "sub_1001",
    number: "INV-1001",
    date: 1704067200,
    due_date: 1706745600,
    currency_code: "USD",
    line_items: [
      { description: "Starter plan", quantity: 1, unit_amount: 2900, amount: 2900, tax_amount: 232, entity_id: "starter-monthly" },
    ],
    tax: 232,
    total: 3132,
    amount_paid: 1000,
    credits_applied: 500,
    write_off_amount: 0,
    status: "payment_due",
    updated_at: 1704153600,
  });
  assert.equal(invoice.totalMajor, "31.3200");
  assert.equal(invoice.balanceMajor, "16.3200");
  assert.equal(invoice.status, "past_due");
  assert.equal(invoice.lines[0]?.planExternalId, "starter-monthly");
});

test("chargebee non-payment transactions do not import as receipts", () => {
  const refund = mapChargebeePayment({ id: "txn_r1", customer_id: "c1", type: "refund", amount: 1000, currency_code: "USD", date: 1704067200 });
  assert.equal(refund, null);
  const payment = mapChargebeePayment({
    id: "txn_p1",
    customer_id: "c1",
    type: "payment",
    amount: 3132,
    currency_code: "USD",
    date: 1704067200,
    payment_method: "card",
    linked_invoices: [{ invoice_id: "inv_1001", applied_amount: 3132 }],
  });
  assert.equal(payment?.amountMajor, "31.3200");
  assert.deepEqual(payment?.applications, [{ invoiceExternalId: "inv_1001", amountMajor: "31.3200" }]);
});

test("chargebee credit notes net adjustments and refunds from the open balance", () => {
  const note = mapChargebeeCreditNote({
    id: "cn_1001",
    customer_id: "c1",
    invoice_id: "inv_1001",
    credit_note_number: "CN-1001",
    date: 1711929600,
    currency_code: "USD",
    total: 2000,
    amount_adjusted: 500,
    amount_refunded: 700,
    reason_code: "goodwill",
  });
  assert.equal(note.totalMajor, "20.0000");
  assert.equal(note.balanceMajor, "8.0000");
  assert.equal(note.invoiceExternalId, "inv_1001");
});

test("chargebee percent coupons stay percents, never minor units", () => {
  const percent = mapChargebeeCoupon({ id: "SAVE10", name: "Save ten", discount_type: "percentage", discount_percentage: 10, duration_type: "limited_period", duration_month: 3, status: "active" });
  assert.equal(percent.kind, "percent");
  assert.equal(percent.percentValue, "10");
  assert.equal(percent.durationMonths, 3);
  const fixed = mapChargebeeCoupon({ id: "FIVE", discount_type: "fixed", discount_amount: 500, currency_code: "USD", status: "active" });
  assert.equal(fixed.kind, "amount");
  assert.equal(fixed.amountMajor, "5.0000");
});

test("chargebee subscription without currency refuses by name", () => {
  assert.throws(
    () => mapChargebeeSubscription({ id: "sub_x", customer_id: "c1", plan_id: "p1" }),
    (error: unknown) => error instanceof BillingHistoryError
      && /subscription sub_x names no currency/.test(error.message)
      && /Set a currency on the subscription in Chargebee/.test(error.remedy),
  );
});

// --- Recurly ----------------------------------------------------------------------

test("recurly subscription maps pending change and pause state", () => {
  const sub = mapRecurlySubscription({
    uuid: "sub_recurly_1",
    account: { id: "acc_1", code: "ACME" },
    plan: { code: "starter" },
    quantity: 2,
    unit_amount: "29.00",
    currency: "USD",
    state: "active",
    current_term_started_at: "2024-01-01",
    current_term_ends_at: "2024-02-01",
    pending_change: { plan: { code: "growth" }, quantity: 3, activates_at: "2024-02-01" },
    updated_at: "2024-01-15",
  });
  assert.equal(sub.status, "active");
  assert.equal(sub.changes.length, 1);
  assert.equal(sub.changes[0]?.kind, "plan_change");
  assert.equal(sub.changes[0]?.planExternalId, "growth");
  const paused = mapRecurlySubscription({
    uuid: "sub_recurly_2",
    account: { id: "acc_1" },
    plan: { code: "starter" },
    state: "active",
    paused_at: "2024-03-01",
    current_term_started_at: "2024-01-01",
  });
  assert.equal(paused.status, "paused");
});

test("recurly accounts, plans and invoices map in major units", () => {
  const customer = mapRecurlyCustomer({
    id: "acc_1",
    code: "ACME",
    email: "billing@acme.example",
    first_name: "Ada",
    last_name: "L",
    company: "Acme",
    updated_at: "2024-01-15",
  });
  assert.equal(customer.name, "Ada L");
  assert.equal(customer.email, "billing@acme.example");
  const plan = mapRecurlyPlan({
    code: "starter",
    name: "Starter",
    currencies: [{ currency: "USD", unit_amount: "29.00" }],
    interval_unit: "months",
    interval_length: 1,
  });
  assert.equal(plan.amountMajor, "29.0000");
  assert.equal(plan.intervalCount, 1);
  const invoice = mapRecurlyInvoice({
    id: "inv_r1",
    number: "101",
    account: { id: "acc_1" },
    subscription_ids: ["sub_recurly_1"],
    currency: "USD",
    line_items: [{ description: "Starter", quantity: "1", unit_amount: "29.00", subtotal: "29.00", product_code: "starter" }],
    tax: "2.32",
    total: "31.32",
    balance: "31.32",
    status: "pending",
    created_at: "2024-01-01",
  });
  assert.equal(invoice.totalMajor, "31.3200");
  assert.equal(invoice.balanceMajor, "31.3200");
  assert.equal(invoice.subscriptionExternalId, "sub_recurly_1");
  assert.equal(invoice.lines[0]?.planExternalId, "starter");
});

test("recurly failed transactions never become receipts", () => {
  const failed = mapRecurlyPayment({ id: "txn_f", account: { id: "acc_1" }, status: "failed", type: "purchase", amount: "29.00", currency: "USD", created_at: "2024-01-01" });
  assert.equal(failed, null);
  const ok = mapRecurlyPayment({ id: "txn_ok", account: { id: "acc_1" }, status: "successful", type: "purchase", amount: "29.00", currency: "USD", invoice_id: "inv_9", created_at: "2024-01-01" });
  assert.deepEqual(ok?.applications, [{ invoiceExternalId: "inv_9", amountMajor: "29.0000" }]);
});

test("invoice-derived changes mark upgrades as estimates at the new invoice date", () => {
  const line = (plan: string | null, date: string): CanonicalInvoice => ({
    externalId: `inv_${date}`,
    number: null,
    customerExternalId: "acc_1",
    subscriptionExternalId: "sub_recurly_1",
    date,
    dueDate: null,
    currency: "USD",
    lines: [{ description: "plan", quantity: "1", unitPriceMajor: "29.0000", amountMajor: "29.0000", taxAmountMajor: "0.0000", planExternalId: plan }],
    taxTotalMajor: "0.0000",
    totalMajor: "29.0000",
    balanceMajor: "0.0000",
    status: "paid",
    updatedAt: null,
  });
  const changes = deriveChangesFromInvoices("sub_recurly_1", [line("starter", "2024-01-01"), line("growth", "2024-02-01"), line("growth", "2024-03-01")]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, "plan_change");
  assert.equal(changes[0]?.planExternalId, "growth");
  assert.equal(changes[0]?.effectiveOn, "2024-02-01");
  assert.equal(changes[0]?.derived, true);
});

test("recurly usage quantities stay quantities, never money", () => {
  const usage = mapRecurlyUsage({ id: "u_1", quantity: 1500, usage_timestamp: "2024-01-15", measured_unit_id: "seats" }, "sub_recurly_1");
  assert.equal(usage.quantityMajor, "1500");
  assert.equal(usage.meterKey, "seats");
});

test("recurly coupon without a priced currency refuses by name", () => {
  assert.throws(
    () => mapRecurlyCoupon({ id: "c1", code: "BAD", name: "Bad", discount: { type: "fixed", currencies: [] }, state: "redeemable" }),
    (error: unknown) => error instanceof BillingHistoryError
      && /coupon BAD names no priced currency/.test(error.message)
      && /Price the coupon in a currency in Recurly/.test(error.remedy),
  );
});

test("recurly credit maps balance and origin", () => {
  const credit = mapRecurlyCredit({ id: "cr_1", number: "CR-1", account: { id: "acc_1" }, total: "15.00", balance: "15.00", currency: "USD", origin: "proration", created_at: "2024-02-01" });
  assert.equal(credit.totalMajor, "15.0000");
  assert.equal(credit.reason, "proration");
});

// --- Maxio ------------------------------------------------------------------------

test("maxio wrapped rows unwrap one envelope level", () => {
  assert.deepEqual(unwrapMaxio({ subscription: { id: "s1" } }), { id: "s1" });
  assert.deepEqual(unwrapMaxio({ id: "s1" }), { id: "s1" });
});

test("maxio subscription keys plans by product and price point", () => {
  const sub = mapMaxioSubscription({
    subscription: {
      id: 101,
      customer_id: 202,
      product_handle: "starter",
      product_price_point_id: 303,
      quantity: 1,
      currency: "USD",
      state: "active",
      activated_at: "2024-01-01",
    },
  });
  assert.equal(sub.planExternalId, "starter:303");
  assert.equal(sub.startOn, "2024-01-01");
  const customer = mapMaxioCustomer({ customer: { id: 202, first_name: "Ada", last_name: "L", email: "ada@example.com" } });
  assert.equal(customer.name, "Ada L");
});

test("maxio invoice balances paid and credited cents exactly", () => {
  const invoice = mapMaxioInvoice({
    invoice: {
      uid: "inv_m1",
      customer_id: 202,
      subscription_id: 101,
      number: "1024",
      issue_date: "2024-01-01",
      currency: "USD",
      line_items: [{ title: "Starter", quantity: 1, unit_price_in_cents: 2900, total_in_cents: 2900, tax_amount_in_cents: 0, product_handle: "starter" }],
      tax_amount_in_cents: 0,
      total_amount_in_cents: 2900,
      paid_amount_in_cents: 2900,
      credited_amount_in_cents: 0,
      status: "paid",
    },
  });
  assert.equal(invoice.totalMajor, "29.0000");
  assert.equal(invoice.balanceMajor, "0.0000");
  assert.equal(invoice.status, "paid");
});

test("maxio non-payment rows do not import as receipts", () => {
  const adjustment = mapMaxioPayment({ payment: { id: 1, customer_id: 202, type: "credit", amount_in_cents: 100, created_at: "2024-01-01" } });
  assert.equal(adjustment, null);
});

test("maxio price point without currency refuses by name", () => {
  assert.throws(
    () => mapMaxioPlan({ price_point: { id: 303, name: "Monthly", unit_price_in_cents: 2900 } }),
    (error: unknown) => error instanceof BillingHistoryError
      && /names no currency/.test(error.message)
      && /Set a currency on the price point in Maxio/.test(error.remedy),
  );
});

test("maxio component usage maps to meter quantities", () => {
  const usage = mapMaxioUsage({ usage: { id: 55, quantity: 250, component_handle: "seats", recorded_at: "2024-01-15" } }, "101");
  assert.equal(usage.quantityMajor, "250");
  assert.equal(usage.meterKey, "seats");
});

test("maxio expiring coupons deactivate", () => {
  const coupon = mapMaxioCoupon({ coupon: { id: 7, code: "OLD", name: "Old", percentage: "10", state: "expired" } });
  assert.equal(coupon.kind, "percent");
  assert.equal(coupon.active, false);
});

// --- Zuora --------------------------------------------------------------------------

test("zuora stated amendments map each type to a canonical change", () => {
  const upgrade = mapZuoraAmendment({ type: "UpdateProduct", effectiveDate: "2024-02-01", productRatePlanChargeId: "charge_growth", sequence: 2 });
  assert.equal(upgrade?.kind, "plan_change");
  assert.equal(upgrade?.derived, false);
  const remove = mapZuoraAmendment({ type: "RemoveProduct", effectiveDate: "2024-03-01", sequence: 3 });
  assert.equal(remove?.kind, "quantity_change");
  assert.equal(remove?.quantity, "0");
  const owner = mapZuoraAmendment({ type: "OwnerTransfer", effectiveDate: "2024-03-01", sequence: 4 });
  assert.equal(owner, null);
  const renew = mapZuoraAmendment({ type: "Renewal", effectiveDate: "2025-01-01", sequence: 5 });
  assert.equal(renew?.kind, "renew");
});

test("zuora posted invoice with zero balance reads paid", () => {
  const paid = mapZuoraInvoice({
    id: "inv_z1",
    accountId: "acc_z1",
    invoiceNumber: "INV-Z1",
    amount: "29.00",
    balance: "0.00",
    taxAmount: "0.00",
    currency: "USD",
    status: "Posted",
    invoiceDate: "2024-01-01",
    invoiceItems: [{ chargeName: "Starter", quantity: "1", unitPrice: "29.00", amount: "29.00", taxAmount: "0.00", chargeId: "charge_starter", subscriptionId: "sub_z1" }],
  });
  assert.equal(paid.status, "paid");
  assert.equal(paid.subscriptionExternalId, "sub_z1");
  const open = mapZuoraInvoice({ id: "inv_z2", accountId: "acc_z1", amount: "29.00", balance: "29.00", currency: "USD", status: "Posted", invoiceDate: "2024-02-01", invoiceItems: [] });
  assert.equal(open.status, "open");
});

test("zuora unprocessed payments never become receipts", () => {
  const pending = mapZuoraPayment({ id: "pay_z1", accountId: "acc_z1", amount: "29.00", currency: "USD", status: "Pending", effectiveDate: "2024-01-02" });
  assert.equal(pending, null);
  const ok = mapZuoraPayment({
    id: "pay_z2",
    accountId: "acc_z1",
    amount: "29.00",
    currency: "USD",
    status: "Processed",
    effectiveDate: "2024-01-02",
    paymentMethodType: "CreditCard",
    appliedInvoices: [{ invoiceId: "inv_z1", appliedPaymentAmount: "29.00" }],
  });
  assert.deepEqual(ok?.applications, [{ invoiceExternalId: "inv_z1", amountMajor: "29.0000" }]);
});

test("zuora revenue schedule maps recognition state", () => {
  const open = mapZuoraRevenueSchedule({ id: "rs1", invoiceId: "inv_z1", subscriptionId: "sub_z1", revenueScheduleDate: "2024-02-01", amount: "29.00", currency: "USD", status: "Open" });
  assert.equal(open.recognized, false);
  assert.equal(open.amountMajor, "29.0000");
  assert.equal(open.periodStart, "2024-02-01");
  const done = mapZuoraRevenueSchedule({ revenueScheduleNumber: "RS-2", amount: "10.00", currency: "USD", status: "Distributed", revenueScheduleDate: "2024-01-01" });
  assert.equal(done.recognized, true);
});

test("zuora revenue schedules separate recognized from deferred", () => {
  const history = {
    customers: [],
    plans: [],
    subscriptions: [],
    invoices: [],
    creditNotes: [],
    payments: [],
    usage: [],
    coupons: [],
    revenueSchedules: [
      { externalId: "rs1", invoiceExternalId: "inv_z1", subscriptionExternalId: "sub_z1", periodStart: "2024-01-01", periodEnd: "2024-01-31", amountMajor: "29.0000", currency: "USD", recognized: true, updatedAt: null },
      { externalId: "rs2", invoiceExternalId: "inv_z1", subscriptionExternalId: "sub_z1", periodStart: "2024-02-01", periodEnd: "2024-02-29", amountMajor: "29.0000", currency: "USD", recognized: false, updatedAt: null },
    ],
  };
  assert.equal(sourceDeferredRevenue(history), "29.0000");
});

test("zuora subscription without a rate plan refuses by name", () => {
  assert.throws(
    () => mapZuoraSubscription({ id: "sub_z9", accountId: "acc_z1", subscribeToRatePlans: [], contractEffectiveDate: "2024-01-01" }),
    (error: unknown) => error instanceof BillingHistoryError
      && /subscription sub_z9 names no rate plan/.test(error.message)
      && /Correct the subscription rate plans in Zuora/.test(error.remedy),
  );
});

test("zuora records map contacts, plans, credits and usage", () => {
  const customer = mapZuoraCustomer({ id: "acc_z1", name: "Acme", currency: "USD", billToContact: { firstName: "Ada", lastName: "L", workEmail: "ada@example.com" } });
  assert.equal(customer.email, "ada@example.com");
  const plan = mapZuoraPlan({ id: "charge_starter", name: "Starter", pricing: [{ currency: "USD", price: "29.00" }], billingPeriod: "Month" });
  assert.equal(plan.amountMajor, "29.0000");
  assert.equal(plan.interval, "monthly");
  const credit = mapZuoraCreditMemo({ id: "cm_z1", accountId: "acc_z1", amount: "5.00", balance: "5.00", currency: "USD", creditMemoDate: "2024-02-01", reasonCode: "Goodwill" });
  assert.equal(credit.totalMajor, "5.0000");
  const usage = mapZuoraUsage({ id: "u_z1", subscriptionId: "sub_z1", quantity: "42.5", unitOfMeasure: "licenses", startDateTime: "2024-01-15" });
  assert.equal(usage.quantityMajor, "42.5");
});

// --- Preflight, MRR and reconciliation --------------------------------------------------

test("preflight names every unmapped plan, currency and tax code with a remedy", () => {
  const preflight = planBillingPreflight(
    {
      customers: [{ externalId: "c1", name: "Acme", email: null, currency: "USD", updatedAt: null }],
      plans: [{ externalId: "growth", name: "Growth", amountMajor: "99.0000", currency: "USD", interval: "monthly", intervalCount: 1, updatedAt: null }],
      subscriptions: [{
        externalId: "s1",
        customerExternalId: "c_missing",
        planExternalId: "growth",
        quantity: "1",
        unitAmountMajor: null,
        currency: "EUR",
        status: "active",
        startOn: "2024-01-01",
        canceledOn: null,
        trialEndOn: null,
        currentTermEndOn: null,
        updatedAt: null,
        changes: [],
      }],
      invoices: [{
        externalId: "i1",
        number: null,
        customerExternalId: "c1",
        subscriptionExternalId: "s1",
        date: "2024-01-01",
        dueDate: null,
        currency: "EUR",
        lines: [],
        taxTotalMajor: "1.9000",
        totalMajor: "100.9000",
        balanceMajor: "100.9000",
        status: "open",
        updatedAt: null,
      }],
      creditNotes: [],
      payments: [],
      usage: [],
      coupons: [],
      revenueSchedules: [],
    },
    { plans: [], baseCurrency: "USD", multiCurrency: false, defaultTaxCode: null },
  );
  assert.equal(preflight.ready, false);
  const kinds = preflight.attention.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ["currency", "customer", "plan", "tax_code"].sort());
  for (const item of preflight.attention) {
    assert.ok(item.remedy.length > 10, `attention ${item.kind} names no remedy`);
  }
  assert.equal(preflight.counts.subscriptions, 1);
});

test("preflight suggests the native plan matching price, currency and cadence", () => {
  const preflight = planBillingPreflight(
    {
      customers: [],
      plans: [{ externalId: "growth", name: "Growth Plan", amountMajor: "99.0000", currency: "USD", interval: "monthly", intervalCount: 1, updatedAt: null }],
      subscriptions: [],
      invoices: [],
      creditNotes: [],
      payments: [],
      usage: [],
      coupons: [],
      revenueSchedules: [],
    },
    {
      plans: [{ id: "native_1", name: "Growth Plan", amountMajor: "99.0000", currency: "USD", interval: "monthly" }],
      baseCurrency: "USD",
      multiCurrency: true,
      defaultTaxCode: { id: "tax_1", name: "Sales tax" },
    },
  );
  assert.equal(preflight.ready, true);
});

test("mrr folds an upgrade then a downgrade into three monthly readings", () => {
  const plans = new Map([
    ["starter", { amountMajor: "29.0000", interval: "monthly" as const, intervalCount: 1 }],
    ["growth", { amountMajor: "99.0000", interval: "monthly" as const, intervalCount: 1 }],
  ]);
  const sub = {
    externalId: "s1",
    customerExternalId: "c1",
    planExternalId: "starter",
    quantity: "1",
    unitAmountMajor: null,
    currency: "USD",
    status: "active" as const,
    startOn: "2024-01-15",
    canceledOn: null,
    trialEndOn: null,
    currentTermEndOn: null,
    updatedAt: null,
    changes: [
      { seq: 0, effectiveOn: "2024-03-10", kind: "plan_change" as const, planExternalId: "growth", quantity: null, unitAmountMajor: null, derived: false },
      { seq: 1, effectiveOn: "2024-05-20", kind: "plan_change" as const, planExternalId: "starter", quantity: null, unitAmountMajor: null, derived: false },
    ],
  };
  const months = mrrByMonth([sub], plans, ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05", "2024-06"], normalize);
  assert.deepEqual(months.map((row) => row.mrrMajor), ["29.0000", "29.0000", "99.0000", "99.0000", "29.0000", "29.0000"]);
  const january = subscriptionStateAtEndOfMonth({ ...sub, startOn: "2024-02-01" }, plans, "2024-01");
  assert.equal(january.plan, null);
});

test("mrr prices months before a later cancel at the contracted plan, not the current status", () => {
  const plans = new Map([
    ["starter", { amountMajor: "29.0000", interval: "monthly" as const, intervalCount: 1 }],
  ]);
  const sub = {
    externalId: "s1",
    customerExternalId: "c1",
    planExternalId: "starter",
    quantity: "1",
    unitAmountMajor: null,
    currency: "USD",
    status: "canceled" as const,
    startOn: "2024-01-15",
    canceledOn: "2024-07-01",
    trialEndOn: null,
    currentTermEndOn: null,
    updatedAt: null,
    changes: [],
  };
  const months = mrrByMonth([sub], plans, ["2024-01", "2024-06", "2024-07"], normalize);
  assert.deepEqual(months.map((row) => row.mrrMajor), ["29.0000", "29.0000", "0.0000"]);
});

test("reconciliation ties when both sides match and names the cause when they do not", () => {
  const plans = new Map([["starter", { amountMajor: "29.0000", interval: "monthly" as const, intervalCount: 1 }]]);
  const sub = {
    externalId: "s1",
    customerExternalId: "c1",
    planExternalId: "starter",
    quantity: "1",
    unitAmountMajor: null,
    currency: "USD",
    status: "active" as const,
    startOn: "2024-01-01",
    canceledOn: null,
    trialEndOn: null,
    currentTermEndOn: null,
    updatedAt: null,
    changes: [],
  };
  const source = {
    customers: [{ externalId: "c1", name: "Acme", email: null, currency: "USD", updatedAt: null }],
    plans: [{ externalId: "starter", name: "Starter", amountMajor: "29.0000", currency: "USD", interval: "monthly" as const, intervalCount: 1, updatedAt: null }],
    subscriptions: [sub],
    invoices: [{
      externalId: "i1",
      number: null,
      customerExternalId: "c1",
      subscriptionExternalId: "s1",
      date: "2024-01-01",
      dueDate: null,
      currency: "USD",
      lines: [],
      taxTotalMajor: "0.0000",
      totalMajor: "29.0000",
      balanceMajor: "29.0000",
      status: "open" as const,
      updatedAt: null,
    }],
    creditNotes: [],
    payments: [],
    usage: [],
    coupons: [],
    revenueSchedules: [],
  };
  const tied = reconcileBillingHistory(
    source,
    { subscriptions: [sub], plans, openArByCustomer: new Map([["c1", "29.0000"]]), deferredMajor: "0.0000" },
    ["2024-01"],
    normalize,
  );
  assert.equal(tied.ties, true);
  assert.deepEqual(tied.differences, []);
  const broken = reconcileBillingHistory(
    source,
    { subscriptions: [], plans, openArByCustomer: new Map(), deferredMajor: "0.0000" },
    ["2024-01"],
    normalize,
  );
  assert.equal(broken.ties, false);
  assert.ok(broken.differences.some((difference) => difference.kind === "mrr" && /s1/.test(difference.explanation)));
  assert.ok(broken.differences.some((difference) => difference.kind === "open_ar" && difference.ref === "c1"));
});

test("source open ar nets invoice balances against open credits", () => {
  const open = sourceOpenArByCustomer({
    customers: [],
    plans: [],
    subscriptions: [],
    invoices: [
      { externalId: "i1", number: null, customerExternalId: "c1", subscriptionExternalId: null, date: "2024-01-01", dueDate: null, currency: "USD", lines: [], taxTotalMajor: "0.0000", totalMajor: "100.0000", balanceMajor: "100.0000", status: "open", updatedAt: null },
      { externalId: "i2", number: null, customerExternalId: "c1", subscriptionExternalId: null, date: "2024-01-01", dueDate: null, currency: "USD", lines: [], taxTotalMajor: "0.0000", totalMajor: "50.0000", balanceMajor: "0.0000", status: "paid", updatedAt: null },
      { externalId: "i3", number: null, customerExternalId: "c1", subscriptionExternalId: null, date: "2024-01-01", dueDate: null, currency: "USD", lines: [], taxTotalMajor: "0.0000", totalMajor: "20.0000", balanceMajor: "20.0000", status: "void", updatedAt: null },
    ],
    creditNotes: [
      { externalId: "cn1", number: null, customerExternalId: "c1", invoiceExternalId: null, date: "2024-01-02", currency: "USD", totalMajor: "10.0000", balanceMajor: "10.0000", reason: null, updatedAt: null },
    ],
    payments: [],
    usage: [],
    coupons: [],
    revenueSchedules: [],
  });
  assert.equal(open.get("c1"), "90.0000");
});
