import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { reverseProjectGlEntry } from "../journal/origin-entry.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { installEngineSeams } from "../composition/install.ts";
import { toUnits } from "../money/money.ts";
import { createFund } from "./funds.ts";
import { provisionFundAccounting } from "./provision.ts";
import { bookPledge, cancelPledge, collectPledgeInstallments, createPledge, getPledgeSchedule, topUpPledgeAllowance, writeOffPledge } from "./pledges.ts";
import { createGift, receiptGift } from "./gifts.ts";
import { NonprofitError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function addAccount(
  orgId: string,
  actorId: string,
  name: string,
  type: "asset_current_other" | "liability_current_other",
): Promise<string> {
  const number = "G" + randomUUID().replaceAll("-", "").slice(0, 12);
  const inserted = await db.execute<{ id: string }>(sql`
    insert into accounts
      (org_id, number, name, type, is_summary, is_active, required_dimensions, created_by, updated_by)
    values (${orgId}, ${number}, ${name}, ${type}, false, true, '[]'::jsonb, ${actorId}, ${actorId})
    returning id`);
  assert.equal(inserted.rows.length, 1);
  return inserted.rows[0]!.id;
}

test("pledges book and reverse through the ledger while gifts receive engine numbers", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Contribution Controller", "admin"));
    await withOrgContext(org.orgId, async () => {
      const changed = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) ||
            '{"nonprofit":true,"fundAccounting":true,"pledges":false}'::jsonb,
          true)
         where id = ${org.orgId}
        returning id`);
      assert.equal(changed.rows.length, 1);
    });
    await provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "OPERATING", name: "Operating Fund" },
      classifications: {
        OPERATING: { kind: "operating", restrictionClass: "without_donor_restrictions" },
      },
      actorId,
    });
    const fund = await createFund({
      orgId: org.orgId,
      code: "PLEDGES",
      name: "Pledges Fund",
      kind: "operating",
      restrictionClass: "without_donor_restrictions",
      actorId,
    });
    const accounts = await withOrgContext(org.orgId, async () => ({
      receivable: await addAccount(org.orgId, actorId, "Contributions receivable", "asset_current_other"),
      discount: await addAccount(org.orgId, actorId, "Discount on contributions receivable", "asset_current_other"),
      allowance: await addAccount(org.orgId, actorId, "Allowance for uncollectible contributions", "asset_current_other"),
    }));
    installEngineSeams();

    const pledgeInput = {
      orgId: org.orgId,
      subsidiaryId: org.subsidiaryId,
      donorPartyId: org.customerId,
      fundId: fund.id,
      totalAmount: "5000.0000",
      discountRate: "5",
      reason: "Record the signed promise",
      installments: Array.from({ length: 5 }, (_, index) => ({
        dueOn: String(2027 + index) + "-07-15",
        amount: "1000.0000",
      })),
      actorId,
    };
    await assert.rejects(
      createPledge(pledgeInput),
      (error) => error instanceof NonprofitError &&
        error.code === "feature_off" && error.message.includes("pledges") &&
        error.remedy.includes("Company Settings → Features"),
    );
    await withOrgContext(org.orgId, async () => {
      const changed = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          settings, '{features}', settings->'features' || '{"pledges":true}'::jsonb, true)
         where id = ${org.orgId}
        returning id`);
      assert.equal(changed.rows.length, 1);
    });

    const pledge = await createPledge(pledgeInput);
    const booking = await bookPledge({
      orgId: org.orgId,
      pledgeId: pledge.id,
      postingDate: org.date,
      receivableAccountId: accounts.receivable,
      discountAccountId: accounts.discount,
      contributionsAccountId: org.accounts.revenue,
      reason: "Recognize the unconditional pledge",
      actorId,
    });
    const stored = await withOrgContext(org.orgId, () =>
      db.execute<{ present_value: string; status: string }>(sql`
        select present_value::text as present_value, status
          from pledges where org_id = ${org.orgId} and id = ${pledge.id}`),
    );
    assert.equal(stored.rows[0]?.present_value, booking.presentValue);
    assert.equal(stored.rows[0]?.status, "booked");
    const bookingLines = await withOrgContext(org.orgId, () =>
      db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount::text as amount from journal_lines
         where org_id = ${org.orgId} and entry_id = ${booking.entryId}
         order by line_number`),
    );
    const bookedByAccount = new Map(bookingLines.rows.map((row) => [row.account_id, row.amount]));
    assert.equal(bookedByAccount.get(accounts.receivable), "5000.0000");
    assert.equal(bookedByAccount.get(accounts.discount), "-" + booking.discount);
    assert.equal(bookedByAccount.get(org.accounts.revenue), "-" + booking.presentValue);
    assert.equal(
      bookingLines.rows.reduce((sum, row) => sum + toUnits(row.amount), 0n),
      0n,
    );

    await assert.rejects(
      writeOffPledge({
        orgId: org.orgId,
        pledgeId: pledge.id,
        amount: "1.0000",
        postingDate: org.date,
        receivableAccountId: accounts.receivable,
        discountAccountId: accounts.discount,
        allowanceAccountId: accounts.allowance,
        contributionsAccountId: org.accounts.revenue,
        reason: "Write off an uncollectible pledge",
        actorId,
      }),
      (error) => error instanceof NonprofitError &&
        error.code === "pledge_writeoff_exceeds_allowance" &&
        error.message.includes("allowance balance of 0.0000") &&
        error.remedy.includes("allowance top-up"),
    );

    const activityPledge = await createPledge({ ...pledgeInput, totalAmount: "1000.0000", installments: [{ dueOn: "2027-07-15", amount: "1000.0000" }] });
    await bookPledge({ orgId: org.orgId, pledgeId: activityPledge.id, postingDate: org.date,
      receivableAccountId: accounts.receivable, discountAccountId: accounts.discount,
      contributionsAccountId: org.accounts.revenue, reason: "Recognize the collection test promise", actorId });
    const scheduleBeforeCollection = await getPledgeSchedule({
      orgId: org.orgId, pledgeId: activityPledge.id, asOfDate: org.date,
    });
    const firstInstallment = scheduleBeforeCollection.installments[0]!;
    const betweenCollectionAndReversal = addCalendarDays(org.date, 2);
    const reversalDate = addCalendarDays(org.date, 3);
    assert.equal(firstInstallment.collectedAmount, "0.0000");
    const collection = await collectPledgeInstallments({
      orgId: org.orgId, pledgeId: activityPledge.id,
      allocations: [{ installmentId: firstInstallment.id, amount: "100.0000" }],
      postingDate: org.date, bankAccountId: org.accounts.bank,
      receivableAccountId: accounts.receivable, idempotencyKey: randomUUID(),
      reason: "Record the donor receipt", actorId,
    });
    const scheduleAfterCollection = await getPledgeSchedule({
      orgId: org.orgId, pledgeId: activityPledge.id, asOfDate: org.date,
    });
    assert.equal(scheduleAfterCollection.installments[0]!.collectedAmount, "100.0000");
    const reversalId = await withOrgTransaction(org.orgId, () => reverseProjectGlEntry(
      org.orgId, actorId, collection.entryId, "Correct the recorded receipt", reversalDate,
    ));
    assert.ok(reversalId);
    const scheduleBetween = await getPledgeSchedule({
      orgId: org.orgId, pledgeId: activityPledge.id, asOfDate: betweenCollectionAndReversal,
    });
    assert.equal(scheduleBetween.installments[0]!.collectedAmount, "100.0000");
    const scheduleOnReversal = await getPledgeSchedule({
      orgId: org.orgId, pledgeId: activityPledge.id, asOfDate: reversalDate,
    });
    assert.equal(scheduleOnReversal.installments[0]!.collectedAmount, "0.0000");
    await topUpPledgeAllowance({ orgId: org.orgId, pledgeId: activityPledge.id, amount: "1000.0000",
      postingDate: reversalDate, contributionsAccountId: org.accounts.revenue, allowanceAccountId: accounts.allowance,
      reason: "Reserve the doubtful promise", actorId });
    const writeOff = await writeOffPledge({ orgId: org.orgId, pledgeId: activityPledge.id, amount: "1000.0000",
      postingDate: reversalDate, receivableAccountId: accounts.receivable, discountAccountId: accounts.discount,
      allowanceAccountId: accounts.allowance, contributionsAccountId: org.accounts.revenue,
      reason: "The donor cannot pay", actorId });
    assert.ok(toUnits(writeOff.discountWrittenOff) > 0n);
    assert.deepEqual([writeOff.status, writeOff.allowanceBalance, writeOff.allowanceReleased],
      ["written_off", "0.0000", writeOff.discountWrittenOff],
      "a closing write-off charges the allowance its net carrying amount and releases the rest");
    const pledgeBalances = await withOrgContext(org.orgId, () => db.execute<{ account_id: string; amount: string }>(sql`
      select jl.account_id, sum(jl.amount)::text as amount from journal_lines jl
        join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
       where jl.org_id = ${org.orgId} and je.status in ('posted', 'reversed')
         and (je.id = (select booking_entry_id from pledges where org_id = ${org.orgId} and id = ${activityPledge.id})
           or je.custom #>> '{nonprofitPledge,pledgeId}' = ${activityPledge.id})
         and jl.account_id in (${accounts.receivable}, ${accounts.discount}, ${accounts.allowance})
       group by jl.account_id`));
    assert.deepEqual(pledgeBalances.rows.map((row) => row.amount), ["0.0000", "0.0000", "0.0000"],
      "a written-off pledge leaves no receivable, discount or allowance balance standing");

    const cancelled = await cancelPledge({
      orgId: org.orgId,
      pledgeId: pledge.id,
      reversalDate: org.date,
      reason: "Donor withdrew the pledge",
      actorId,
    });
    const lifecycle = await withOrgContext(org.orgId, () =>
      db.execute<{ pledge_status: string; original_status: string; reversal_status: string }>(sql`
        select p.status as pledge_status, original.status as original_status, reversal.status as reversal_status
          from pledges p
          join journal_entries original on original.org_id = p.org_id and original.id = p.booking_entry_id
          join journal_entries reversal on reversal.org_id = p.org_id and reversal.id = ${cancelled.reversalEntryId}
         where p.org_id = ${org.orgId} and p.id = ${pledge.id}`),
    );
    assert.deepEqual(lifecycle.rows[0], {
      pledge_status: "cancelled",
      original_status: "reversed",
      reversal_status: "posted",
    });

    await assert.rejects(
      createGift({
        orgId: org.orgId,
        subsidiaryId: org.subsidiaryId,
        donorPartyId: org.customerId,
        fundId: fund.id,
        amount: "125.5000",
        kind: "in_kind_goods",
        receivedOn: org.date,
        reason: "Record donated equipment",
        actorId,
      }),
      (error) => error instanceof NonprofitError &&
        error.code === "gift_fair_value_basis_required" &&
        error.remedy.includes("fair-value basis"),
    );
    const gift = await createGift({
      orgId: org.orgId,
      subsidiaryId: org.subsidiaryId,
      donorPartyId: org.customerId,
      fundId: fund.id,
      amount: "125.5000",
      kind: "cash",
      receivedOn: org.date,
      reason: "Record the cash contribution",
      actorId,
    });
    const receipt = await receiptGift({
      orgId: org.orgId,
      giftId: gift.id,
      reason: "Issue the donor's contribution receipt",
      actorId,
    });
    assert.equal(receipt.status, "receipted");
    assert.equal(receipt.receiptNumber, "RCPT-00001");
    const storedGift = await withOrgContext(org.orgId, () =>
      db.execute<{ receipt_number: string; status: string }>(sql`
        select receipt_number, status from gifts where org_id = ${org.orgId} and id = ${gift.id}`),
    );
    assert.deepEqual(storedGift.rows[0], { receipt_number: receipt.receiptNumber, status: "receipted" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
