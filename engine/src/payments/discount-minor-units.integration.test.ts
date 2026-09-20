import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting.ts";
import { createPaymentRun } from "./payments.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * WAVE 6 — the payment-run early-payment discount rounded to whole CENTS no
 * matter the bill currency: a JPY bill could post a sub-yen discount leg and
 * a KWD bill a sub-fils leg, dust no settlement rail can express. The discount
 * must round to the bill currency's own minor units (whole yen, whole fils),
 * like project billing already does through roundCurrencyMoney.
 */
async function discountFixture(
  org: ScratchOrg,
  actor: string,
  opts: { currency: string; fxRate: string; billTotal: string; discountPercent: string },
): Promise<{ runId: string; billId: string }> {
  const termsId = randomUUID();
  await db.execute(sql`insert into payment_terms (id, org_id, name, net_days, discount_days, discount_percent, is_active)
    values (${termsId}, ${org.orgId}, 'W6 2/10', 30, 10, ${opts.discountPercent}, true)`);
  await db.execute(sql`insert into vendor_roles (org_id, party_id, ap_account_id, payment_terms_id, is_active)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${termsId}, true)`);

  const billId = randomUUID();
  await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-W6-${opts.currency}`},
            ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, ${opts.currency}, ${opts.fxRate},
            ${opts.billTotal}, '0', ${opts.billTotal}, ${actor})`);
  await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', ${opts.billTotal}, ${opts.billTotal}, '0')`);
  await db.execute(sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
  await postDocument(billId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });

  const formatId = randomUUID();
  await db.execute(sql`insert into payment_formats (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
    values (${formatId}, ${org.orgId}, ${`WIRE-W6-${opts.currency}`}, 'W6 wire', 'wire', 'credit', 'CA', ${opts.currency}, ${actor}, ${actor})`);
  const profileId = randomUUID();
  await db.execute(sql`insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id, currency, country, settings, created_by, updated_by)
    values (${profileId}, ${org.orgId}, ${`W6 profile ${opts.currency}`}, ${org.accounts.bank},
            ${org.subsidiaryId}, ${formatId}, ${opts.currency}, 'CA',
            ${JSON.stringify({ discountAccountId: org.accounts.cogs })}::jsonb, ${actor}, ${actor})`);

  const run = await createPaymentRun({
    orgId: org.orgId,
    createdBy: actor,
    paymentBankProfileId: profileId,
    billDocumentIds: [billId],
    scheduledFor: org.date,
  });
  return { runId: run.id, billId };
}

async function runDiscounts(orgId: string, runId: string): Promise<{ discount: string; payment: string }[]> {
  const rows = (await db.execute<{ discount: string; payment: string }>(sql`
    select i.discount_amount::text as discount, i.payment_amount::text as payment
      from payment_run_items i where i.org_id = ${orgId} and i.payment_run_id = ${runId}`)).rows;
  return rows;
}

for (const [currency, fxRate, billTotal, discountPercent, wantDiscount, wantPayment] of [
  ["JPY", "0.0091", "10501", "2", "210.0000", "10291.0000"],
  ["KWD", "3.6000", "1000.005", "2", "20.0000", "980.0050"],
] as const) {
  test(`payment-run early discount rounds to ${currency} minor units, not cents`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "W6 discounts", "admin");
      if (currency === "KWD") {
        // Tenant data, like an admin-added currency: the chain must honour
        // its scale wherever the row exists.
        await db.execute(sql`insert into currencies (code, name, minor_units)
          values ('KWD', 'Kuwaiti Dinar', 3) on conflict (code) do update set minor_units = 3`);
      }
      const { runId } = await discountFixture(org, actor, { currency, fxRate, billTotal, discountPercent });
      const before = await runDiscounts(org.orgId, runId);
      assert.deepEqual(
        before.map((r) => [r.discount, r.payment]),
        [[wantDiscount, wantPayment]],
        `${currency} discount carries the currency's scale`,
      );
      // The run still balances: discount + payment == the open bill, so the
      // legs built verbatim from this composition cannot carry dust either.
      const { add, cmp } = await import("../money/money.ts");
      for (const r of before) {
        assert.equal(cmp(add(r.discount, r.payment), billTotal), 0, "run balances without dust");
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
