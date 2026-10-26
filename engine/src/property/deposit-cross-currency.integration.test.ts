import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import {
  PropertyManagementError,
  billDueLeaseCharges,
  recordSecurityDeposit,
  reverseSecurityDepositTransaction,
} from "./management.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * B-PRP-004: a CAD security deposit applied against a foreign-currency tenant
 * invoice must refuse by name — never stamp same_currency/rate 1 across
 * currencies. The USD invoice below is a genuine posted tenant invoice (same
 * documents + postDocument path every manual invoice uses), so the target
 * lookup finds it; the defect is that the application ignores its currency.
 */
test("cross-currency deposit application refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Deposit FX operator", "admin");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`);
    const propertyId = randomUUID();
    await db.execute(sql`insert into managed_properties
      (id,org_id,subsidiary_id,code,name,property_type,status,currency,rent_income_account_id,deposit_liability_account_id,default_bank_account_id)
      values(${propertyId},${org.orgId},${org.subsidiaryId},'DEP-FX','Deposit FX','commercial','active','CAD',
        ${org.accounts.revenue},${org.accounts.deferred},${org.accounts.bank})`);
    const leaseId = randomUUID(),
      chargeId = randomUUID(),
      scheduleId = randomUUID();
    await db.execute(sql`insert into property_leases
      (id,org_id,property_id,tenant_id,lease_number,status,starts_on,billing_day,payment_terms_days,auto_invoice,auto_post)
      values(${leaseId},${org.orgId},${propertyId},${org.customerId},'DEP-FX','active','2026-07-01',1,0,true,true)`);
    await db.execute(sql`insert into lease_charges
      (id,org_id,lease_id,charge_type,description,amount,frequency,effective_from,income_account_id)
      values(${chargeId},${org.orgId},${leaseId},'base_rent','Monthly rent','1000','monthly','2026-07-01',${org.accounts.revenue})`);
    await db.execute(sql`insert into lease_schedule_lines
      (id,org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,status)
      values(${scheduleId},${org.orgId},${leaseId},${chargeId},'2026-07-01','2026-07-31','2026-07-01','1000','scheduled')`);

    // Tenant holds a CAD 100 deposit.
    await recordSecurityDeposit({
      orgId: org.orgId,
      actorId: actor,
      allowedSubsidiaryIds: null,
      leaseId,
      kind: "received",
      occurredOn: org.date,
      amount: "100",
    });

    // A genuine posted USD tenant invoice with open balance, cut the same way
    // every manual foreign invoice is cut (documents + postDocument).
    const usdInvoiceId = randomUUID();
    await db.execute(sql`insert into documents
      (id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values(${usdInvoiceId},${org.orgId},'customer_invoice','draft','INV-DEP-FX-USD',${org.subsidiaryId},
        ${org.customerId},${org.date},'USD','1.35','100','0','100',${actor})`);
    await db.execute(sql`insert into document_lines
      (org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
      values(${org.orgId},${usdInvoiceId},1,${org.accounts.revenue},'1','100','100','0')`);
    await db.execute(
      sql`update documents set status='approved',updated_at=now() where id=${usdInvoiceId} and org_id=${org.orgId}`,
    );
    await postDocument(usdInvoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    const before = (
      await db.execute<{ journals: number; deposits: number; applications: number }>(
        sql`
      select (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
        (select count(*)::int from security_deposit_transactions where org_id=${org.orgId}) as deposits,
        (select count(*)::int from applications where org_id=${org.orgId}) as applications`,
        "objects",
      )
    )[0]!;

    await assert.rejects(
      recordSecurityDeposit({
        orgId: org.orgId,
        actorId: actor,
        allowedSubsidiaryIds: null,
        leaseId,
        kind: "applied",
        occurredOn: org.date,
        amount: "50",
        appliedDocumentId: usdInvoiceId,
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof PropertyManagementError,
          `expected PropertyManagementError, got ${error}`,
        );
        assert.match(error.message, /USD/, "refusal names the invoice currency");
        assert.match(error.message, /CAD/, "refusal names the deposit currency");
        assert.match(error.message, /customer payment/i, "refusal names the supported remedy");
        return true;
      },
      "a CAD deposit applied to a USD invoice must refuse by name",
    );

    // The refusal lands before any journal, subledger, or application write.
    const after = (
      await db.execute<{ journals: number; deposits: number; applications: number }>(
        sql`
      select (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
        (select count(*)::int from security_deposit_transactions where org_id=${org.orgId}) as deposits,
        (select count(*)::int from applications where org_id=${org.orgId}) as applications`,
        "objects",
      )
    )[0]!;
    assert.deepEqual(after, before);

    // Same-currency control: billing the lease cuts a posted CAD invoice and
    // the deposit applies exactly as before (same_currency, rate 1, CAD legs).
    const billed = await billDueLeaseCharges(org.orgId, actor, null, "2026-07-31", leaseId);
    assert.equal(billed.billed, 1);
    const applied = await recordSecurityDeposit({
      orgId: org.orgId,
      actorId: actor,
      allowedSubsidiaryIds: null,
      leaseId,
      kind: "applied",
      occurredOn: org.date,
      amount: "50",
      appliedDocumentId: billed.invoices[0]!,
    });
    assert.equal(applied.balance, "50.0000");
    const legs = await db.execute<{
      source: string;
      target: string;
      rate: string;
      sourceRef: string;
    }>(
      sql`select a.source_transaction_currency as source, a.target_transaction_currency as target,
        a.settlement_rate as rate, a.settlement_rate_source as "sourceRef"
      from applications a join journal_lines jl on jl.id=a.from_line_id and jl.org_id=a.org_id
      where a.org_id=${org.orgId} and jl.entry_id=${applied.entryId}`,
      "objects",
    );
    assert.equal(legs.length, 1);
    assert.deepEqual(legs[0], {
      source: "CAD",
      target: "CAD",
      rate: "1.0000000000",
      sourceRef: "same_currency",
    });

    const applicationId = (
      await db.execute<{ id: string }>(
        sql`
      select a.id from applications a join journal_lines l on l.org_id=a.org_id and l.id=a.from_line_id
       where a.org_id=${org.orgId} and l.entry_id=${applied.entryId} and a.unapplied_at is null`,
        "objects",
      )
    )[0]!.id;
    await db.execute(sql`update applications set unapplied_at=now(),updated_at=now(),updated_by=${actor}
      where org_id=${org.orgId} and id=${applicationId} and unapplied_at is null`);
    const reversed = await reverseSecurityDepositTransaction({
      orgId: org.orgId,
      actorId: actor,
      allowedSubsidiaryIds: null,
      transactionId: applied.id,
      occurredOn: org.date,
      reason: "Correct the applied deposit",
    });
    assert.equal(reversed.balance, "100.0000");
    const journalState = (
      await db.execute<{ status: string }>(
        sql`
      select status from journal_entries where org_id=${org.orgId} and id=${applied.entryId}`,
        "objects",
      )
    )[0]!.status;
    assert.equal(
      journalState,
      "reversed",
      "the source journal and its book copies leave live history",
    );
    const selfSettlement = await db.execute<{ amount: string; unapplied_at: string | null }>(
      sql`
      select a.amount::text as amount,a.unapplied_at::text as unapplied_at
        from applications a
        join journal_lines source on source.org_id=a.org_id and source.id=a.from_line_id
        join journal_lines mirror on mirror.org_id=a.org_id and mirror.id=a.to_line_id
       where a.org_id=${org.orgId} and source.entry_id=${applied.entryId} and mirror.entry_id=${reversed.entryId}
    `,
      "objects",
    );
    assert.deepEqual(
      selfSettlement,
      [{ amount: "50.0000", unapplied_at: null }],
      "the original open AR line is settled against its mirror even after its invoice application was released",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
