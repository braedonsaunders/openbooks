import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { endOfMonth } from "../platform/civil-date.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  enrollAutopay,
  getRecoveryMetrics,
  recordCardUpdaterEvent,
  runAutopayCollectionForOrg,
  type ChargeFn,
} from "./autopay.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

interface RecoveryFixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  userId: string;
}

/** Scratch org with autopay + onlinePayments on, receipts postable today. */
async function seedRecoveryOrg(): Promise<RecoveryFixture> {
  const org = await createScratchOrg();
  const userId = await createScratchUser(org.orgId, "Recovery Tester", "admin");
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"onlinePayments":true,"autopay":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const today = new Date().toISOString().slice(0, 10);
  if (today < "2026-07-01" || today > "2026-07-31") {
    const [year, month] = today.split("-").map(Number) as [number, number, number];
    const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
    const endsOn = endOfMonth(startsOn);
    await db.execute(sql`
      insert into accounting_periods
        (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment)
      select ${org.orgId}, fiscal_calendar_id, ${year}, ${month}, ${today.slice(0, 7)},
             ${startsOn}, ${endsOn}, false
        from accounting_periods
       where id = ${org.periodId}
      on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
    `);
  }
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
    values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
            ${sealJson({ apiKey: "sk_test_recovery", webhookSecret: "whsec_recovery" }, { orgId: org.orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
  return { org, userId };
}

async function seedPolicy(orgId: string, userId: string, retryOffsets: number[], finalAction: string): Promise<void> {
  await db.execute(sql`
    insert into dunning_policies
      (org_id, name, applies_to_kind, is_active, autopay_retry_offsets_days, autopay_final_action, created_by, updated_by)
    values (${orgId}, 'Collections', 'customer_invoice', true,
            ${`{${retryOffsets.join(",")}}`}::integer[], ${finalAction}, ${userId}, ${userId})
  `);
}

/** Posted customer invoice for the scratch customer, due on the given date. */
async function seedInvoice(fixture: RecoveryFixture, memo: string, total: string, dueDate: string): Promise<string> {
  const { org, userId } = fixture;
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${memo},
            ${org.subsidiaryId}, ${org.customerId}, ${dueDate}, ${dueDate}, 'CAD', '1',
            ${total}, '0', ${total}, ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${total}, ${total}, '0', '0')`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${invoiceId} and org_id = ${org.orgId}`);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return invoiceId;
}

/** Stored stripe method on file: the default unless told otherwise. */
async function seedMethod(
  fixture: RecoveryFixture,
  opts?: { providerMethodId?: string; isDefault?: boolean; priority?: number; last4?: string },
): Promise<string> {
  const { org, userId } = fixture;
  const rows = (await db.execute<{ id: string }>(sql`
    insert into customer_payment_methods
      (org_id, party_id, provider, provider_customer_id, provider_method_id,
       brand, last4, exp_month, exp_year, is_default, fallback_priority, status, created_by, updated_by)
    values (${org.orgId}, ${org.customerId}, 'stripe', 'cus_test', ${opts?.providerMethodId ?? "pm_test"},
            'visa', ${opts?.last4 ?? "4242"}, 12, 2030, ${opts?.isDefault ?? true}, ${opts?.priority ?? 0},
            'active', ${userId}, ${userId})
    returning id
  `)).rows;
  return rows[0]!.id;
}

async function openBalance(orgId: string, invoiceId: string): Promise<string> {
  return (await db.execute<{ open_balance: string }>(sql`
    select open_balance from documents where id = ${invoiceId} and org_id = ${orgId}
  `)).rows[0]!.open_balance;
}

test("an insufficient-funds decline retries on the payday ladder, not the generic cadence", { skip: !DB }, async () => {
  const fixture = await seedRecoveryOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const invoiceId = await seedInvoice(fixture, "INV-REC-NSF", "80", "2026-07-15");

    const charge: ChargeFn = async () => ({ status: "failed", providerRef: "ch_nsf", declineCode: "insufficient_funds" });
    const run = await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-15", charge });
    assert.equal(run.retried, 1);
    const attempt = (await db.execute<{ decline_kind: string | null; next_retry_on: string | null }>(sql`
      select decline_kind, next_retry_on::text as "next_retry_on" from collection_attempts
       where org_id = ${org.orgId} and invoice_id = ${invoiceId} and retry_position = 0
    `)).rows[0]!;
    assert.equal(attempt.decline_kind, "insufficient_funds");
    // The default payday ladder is [3, 7, 14]: position 0 lands 2026-07-18,
    // while the generic [1, 3] ladder would have landed 2026-07-16.
    assert.equal(attempt.next_retry_on, "2026-07-18");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a hard decline on the primary charges the ordered backup method", { skip: !DB }, async () => {
  const fixture = await seedRecoveryOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    const primaryId = await seedMethod(fixture, { providerMethodId: "pm_old", isDefault: true, last4: "1111" });
    const backupId = await seedMethod(fixture, { providerMethodId: "pm_new", isDefault: false, priority: 0, last4: "2222" });
    await enrollAutopay(org.orgId, { partyId: org.customerId, paymentMethodId: primaryId, actorId: userId });
    const invoiceId = await seedInvoice(fixture, "INV-REC-FALLBACK", "90", "2026-07-15");

    const charge: ChargeFn = async (_provider, req) => {
      if (req.providerMethodId === "pm_old") {
        return { status: "failed", providerRef: "ch_hard", declineCode: "stolen_card" };
      }
      return { status: "succeeded", providerRef: "ch_backup_ok" };
    };
    const run = await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-15", charge });
    assert.equal(run.succeeded, 1);
    assert.equal(await openBalance(org.orgId, invoiceId), "0.0000");

    const attempts = (await db.execute<{
      retry_position: number;
      status: string;
      decline_kind: string | null;
      payment_method_id: string;
      fallback_method_id: string | null;
    }>(sql`
      select retry_position, status, decline_kind, payment_method_id, fallback_method_id
        from collection_attempts
       where org_id = ${org.orgId} and invoice_id = ${invoiceId}
       order by retry_position
    `)).rows;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.status, "failed");
    assert.equal(attempts[0]!.decline_kind, "hard");
    assert.equal(attempts[0]!.payment_method_id, primaryId);
    assert.equal(attempts[1]!.status, "succeeded");
    assert.equal(attempts[1]!.payment_method_id, backupId);
    assert.equal(attempts[1]!.fallback_method_id, primaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an authentication-required charge keeps the link and waits for the customer", { skip: !DB }, async () => {
  const fixture = await seedRecoveryOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const invoiceId = await seedInvoice(fixture, "INV-REC-3DS", "70", "2026-07-15");

    const charge: ChargeFn = async () => ({
      status: "requires_action",
      providerRef: "pi_3ds",
      authUrl: "https://pay.example/verify/pi_3ds",
      declineCode: "authentication_required",
    });
    const run = await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-15", charge });
    assert.equal(run.failed, 1);
    assert.equal(run.retried, 0);
    const attempt = (await db.execute<{
      status: string;
      decline_kind: string | null;
      auth_url: string | null;
      next_retry_on: string | null;
    }>(sql`
      select status, decline_kind, auth_url, next_retry_on::text as "next_retry_on" from collection_attempts
       where org_id = ${org.orgId} and invoice_id = ${invoiceId} and retry_position = 0
    `)).rows[0]!;
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.decline_kind, "needs_authentication");
    assert.equal(attempt.auth_url, "https://pay.example/verify/pi_3ds");
    assert.equal(attempt.next_retry_on, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a card updater event refreshes the stored method", { skip: !DB }, async () => {
  const fixture = await seedRecoveryOrg();
  const { org, userId } = fixture;
  try {
    const methodId = await seedMethod(fixture, { providerMethodId: "pm_upd", last4: "1111" });
    const refreshed = await recordCardUpdaterEvent(org.orgId, "stripe", {
      providerMethodId: "pm_upd",
      brand: "mastercard",
      last4: "9999",
      expMonth: 5,
      expYear: 2031,
    });
    assert.equal(refreshed, "card_refreshed");
    const row = (await db.execute<{
      brand: string | null;
      last4: string | null;
      exp_month: number | null;
      exp_year: number | null;
      refreshed_at: string | null;
    }>(sql`
      select brand, last4, exp_month, exp_year,
             last_updater_refresh_at::text as "refreshed_at"
        from customer_payment_methods where id = ${methodId} and org_id = ${org.orgId}
    `)).rows[0]!;
    assert.equal(row.brand, "mastercard");
    assert.equal(row.last4, "9999");
    assert.equal(row.exp_month, 5);
    assert.equal(row.exp_year, 2031);
    assert.ok(row.refreshed_at);

    const unchanged = await recordCardUpdaterEvent(org.orgId, "stripe", {
      providerMethodId: "pm_upd",
      brand: "mastercard",
      last4: "9999",
      expMonth: 5,
      expYear: 2031,
    });
    assert.equal(unchanged, "card_unchanged");

    const unknown = await recordCardUpdaterEvent(org.orgId, "stripe", {
      providerMethodId: "pm_nobody",
      brand: "visa",
      last4: "0000",
      expMonth: 1,
      expYear: 2030,
    });
    assert.equal(unknown, "unknown_method");
    void userId;
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("recovery metrics come from stored attempts", { skip: !DB }, async () => {
  const fixture = await seedRecoveryOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    const primaryId = await seedMethod(fixture, { providerMethodId: "pm_old", isDefault: true });
    await seedMethod(fixture, { providerMethodId: "pm_new", isDefault: false });
    await enrollAutopay(org.orgId, { partyId: org.customerId, paymentMethodId: primaryId, actorId: userId });
    await seedInvoice(fixture, "INV-REC-M1", "90", "2026-07-15");
    await seedInvoice(fixture, "INV-REC-M2", "60", "2026-07-15");
    await seedInvoice(fixture, "INV-REC-M3", "70", "2026-07-15");

    // Routed by amount so each invoice walks a different recovery path: the
    // 90 recovers through the backup method, the 60 through a scheduled
    // retry, and the 70 waits on the customer for authentication.
    const callsByAmount = new Map<string, number>();
    const charge: ChargeFn = async (_provider, req) => {
      const n = (callsByAmount.get(req.amount) ?? 0) + 1;
      callsByAmount.set(req.amount, n);
      if (req.amount === "90.0000") {
        if (req.providerMethodId === "pm_old") {
          return { status: "failed", providerRef: "ch_hard", declineCode: "stolen_card" };
        }
        return { status: "succeeded", providerRef: "ch_backup_ok" };
      }
      if (req.amount === "60.0000") {
        return n === 1
          ? { status: "failed", providerRef: "ch_soft", declineCode: "do_not_honor" }
          : { status: "succeeded", providerRef: "ch_retry_ok" };
      }
      return {
        status: "requires_action",
        providerRef: "pi_3ds",
        authUrl: "https://pay.example/verify/pi_3ds",
        declineCode: "authentication_required",
      };
    };
    await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-15", charge });
    await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-16", charge });

    // Attempts are stamped with the real clock while the collection schedule
    // runs on business dates, so the window spans the schedule into today.
    const metrics = await getRecoveryMetrics(org.orgId, { from: "2026-07-01", to: "2026-12-31" });
    assert.equal(metrics.attempts, 5);
    assert.equal(metrics.invoicesWithFailures, 3);
    assert.equal(metrics.recoveredInvoices, 2);
    assert.equal(metrics.recoveredAmount, "150.0000");
    assert.deepEqual(metrics.recoveredByCurrency, [{ currency: "CAD", amount: "150.0000" }]);
    assert.ok(Math.abs(metrics.recoveryRate! - 2 / 3) < 1e-12);
    const byClass = new Map(metrics.byDeclineClass.map((row) => [row.declineClass, row]));
    assert.equal(byClass.get("hard")!.failedAttempts, 1);
    assert.equal(byClass.get("hard")!.recoveredInvoices, 1);
    assert.equal(byClass.get("hard")!.recoveredAmount, "90.0000");
    assert.equal(byClass.get("soft")!.failedAttempts, 1);
    assert.equal(byClass.get("soft")!.recoveredInvoices, 1);
    assert.equal(byClass.get("needs_authentication")!.failedAttempts, 1);
    assert.equal(byClass.get("needs_authentication")!.recoveredInvoices, 0);
    assert.equal(metrics.byProvider.length, 1);
    assert.equal(metrics.byProvider[0]!.provider, "stripe");
    assert.equal(metrics.byProvider[0]!.recoveredInvoices, 2);
    assert.equal(metrics.awaitingAuthentication, 1);
    assert.equal(metrics.churnPrevented, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
