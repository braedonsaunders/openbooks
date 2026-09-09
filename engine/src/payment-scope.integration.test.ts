import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";
import {
  createPaymentDocument,
  createPaymentRun,
  openItemsForParty,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
} from "./payments.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
async function line(
  org: ScratchOrg,
  overrides: {
    book?: string;
    subsidiary?: string;
    party?: string;
    account?: string;
    amount?: string;
    posted?: boolean;
    open?: boolean;
  } = {},
) {
  const document = randomUUID();
  const entry = randomUUID();
  const id = randomUUID();
  const amount = overrides.amount ?? "100";
  const subsidiary = overrides.subsidiary ?? org.subsidiaryId;
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total)
    values(${document},${org.orgId},${amount.startsWith("-") ? "customer_credit" : "customer_invoice"},'draft',${document},${subsidiary},${overrides.party ?? org.customerId},${org.date},'CAD','1',abs(${amount}::numeric),0,abs(${amount}::numeric))`);
  await db.execute(sql`insert into journal_entries(id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status,source_document_id)
    values (${entry},${org.orgId},${overrides.book ?? org.bookId},${subsidiary},${entry},${org.date},${org.periodId},'draft',${document})`);
  await db.execute(sql`insert into journal_lines(id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
    values (${id},${org.orgId},${entry},1,${overrides.account ?? org.accounts.ar},${subsidiary},${amount},'CAD',${amount},'1',${overrides.party ?? org.customerId},${overrides.open ?? true}),
    (${randomUUID()},${org.orgId},${entry},2,${org.accounts.revenue},${subsidiary},-${amount}::numeric,'CAD',-${amount}::numeric,'1',null,false)`);
  if (overrides.posted !== false) {
    await db.execute(
      sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`,
    );
    await db.execute(
      sql`update documents set status='approved' where id=${document}`,
    );
    await db.execute(
      sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document}`,
    );
  }
  return id;
}
async function sourceDocument(lineId: string): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`select je.source_document_id as id from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id where jl.id=${lineId}`,
    )
  ).rows[0]!.id;
}
async function postedCredit(
  org: ScratchOrg,
  actor: string,
  vendor = false,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
    values(${id},${org.orgId},${vendor ? "vendor_credit" : "customer_credit"},'draft',${id},${org.subsidiaryId},${vendor ? org.vendorId : org.customerId},${org.date},'CAD','1','30','0','30',${actor})`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
    values(${org.orgId},${id},1,${vendor ? org.accounts.cogs : org.accounts.revenue},'1','30','30','0','30')`);
  await db.execute(sql`update documents set status='approved' where id=${id}`);
  const entry = await postDocument(id, {
    control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
  });
  return (
    await db.execute<{ id: string }>(
      sql`select id from journal_lines where entry_id=${entry} and account_id=${vendor ? org.accounts.ap : org.accounts.ar}`,
    )
  ).rows[0]!.id;
}
async function fixture() {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Scope audit", "admin");
  const target = await line(org);
  const payment = await createPaymentDocument({
    orgId: org.orgId,
    kind: "customer_payment",
    createdBy: actor,
    partyId: org.customerId,
    bankAccountId: org.accounts.bank,
    subsidiaryId: org.subsidiaryId,
    documentDate: org.date,
    currency: "CAD",
  });
  return { org, actor, target, payment };
}
async function snapshot(org: ScratchOrg, payment: string) {
  return (
    await db.execute(sql`select status, custom, total, posted_entry_id,
    (select count(*) from applications where org_id=${org.orgId}) as applications,
    (select count(*) from journal_entries where source_document_id=${payment}) as entries
    from documents where id=${payment}`)
  ).rows[0];
}
test(
  "payment selection excludes parallel books and refuses their draft and approved allocations",
  { skip: !DB },
  async () => {
    const { org, actor, target, payment } = await fixture();
    try {
      const book = randomUUID();
      await db.execute(
        sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${book},${org.orgId},'TAX','Tax',false,true,true)`,
      );
      const duplicate = await line(org, { book });
      assert.deepEqual(
        (await openItemsForParty(org.customerId, "ar", org.orgId)).map(
          (i) => i.lineId,
        ),
        [target],
      );
      const before = await snapshot(org, payment.id);
      await assert.rejects(
        updateDraftPayment(
          payment.id,
          { allocations: [sameCurrencyAllocation(duplicate, "25")] },
          actor,
          org.orgId,
        ),
        /open item|book/i,
      );
      assert.deepEqual(await snapshot(org, payment.id), before);
      await updateDraftPayment(
        payment.id,
        { allocations: [sameCurrencyAllocation(target, "25")] },
        actor,
        org.orgId,
      );
      await db.execute(
        sql`update documents set status='approved',custom=jsonb_set(custom,'{allocations}',${JSON.stringify([sameCurrencyAllocation(duplicate, "25")])}::jsonb) where id=${payment.id}`,
      );
      const approved = await snapshot(org, payment.id);
      await assert.rejects(
        postPaymentWithApplications(payment.id, undefined, actor),
        /open|book/i,
      );
      assert.deepEqual(await snapshot(org, payment.id), approved);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
for (const variant of [
  "subsidiary",
  "party",
  "account",
  "book",
  "draft",
  "not-open",
  "wrong-sign",
  "missing",
  "over-credit",
  "combined-cap",
  "source-document",
  "foreign-source-document",
  "valid",
] as const) {
  test(
    `credit applications enforce payment scope and capacity: ${variant}`,
    { skip: !DB },
    async () => {
      const { org, actor, target, payment } = await fixture();
      let foreign: ScratchOrg | undefined;
      try {
        const overrides: Parameters<typeof line>[1] = { amount: "-30" };
        if (variant === "subsidiary") {
          const sub = randomUUID();
          await db.execute(
            sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id) values(${sub},${org.orgId},'Other','CAD','CA',${org.subsidiaryId})`,
          );
          overrides.subsidiary = sub;
        }
        if (variant === "party") overrides.party = org.vendorId;
        if (variant === "account") overrides.account = org.accounts.ap;
        if (variant === "book") {
          const book = randomUUID();
          await db.execute(
            sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${book},${org.orgId},'TAX','Tax',false,true,true)`,
          );
          overrides.book = book;
        }
        if (variant === "draft") overrides.posted = false;
        if (variant === "not-open") overrides.open = false;
        if (variant === "wrong-sign") overrides.amount = "30";
        const from =
          variant === "missing"
            ? randomUUID()
            : variant === "valid"
              ? await postedCredit(org, actor)
              : await line(org, overrides);
        const to = ["subsidiary", "party", "account", "book"].includes(variant)
          ? await line(org, { ...overrides, amount: "100" })
          : target;
        let claimedSource =
          variant === "missing" ? randomUUID() : await sourceDocument(from);
        if (variant === "source-document")
          claimedSource = await sourceDocument(target);
        if (variant === "foreign-source-document") {
          foreign = await createScratchOrg();
          claimedSource = await sourceDocument(await line(foreign));
        }
        const credits = [
          {
            fromLineId: from,
            toLineId: to,
            sourceDocumentId: claimedSource,
            amount: variant === "over-credit" ? "35" : "30",
          },
        ];
        const allocations = [
          sameCurrencyAllocation(
            target,
            variant === "combined-cap" ? "80" : "25",
          ),
        ];
        const before = await snapshot(org, payment.id);
        if (variant === "valid") {
          await updateDraftPayment(
            payment.id,
            { allocations, creditAllocations: credits },
            actor,
            org.orgId,
          );
          await db.execute(
            sql`update documents set status='approved' where id=${payment.id}`,
          );
          await postPaymentWithApplications(payment.id, undefined, actor);
          assert.equal((await snapshot(org, payment.id))!.applications, "2");
        } else {
          const expected = [
            "source-document",
            "foreign-source-document",
            "missing",
          ].includes(variant)
            ? /credit source document must match/
            : variant === "wrong-sign"
              ? /wrong payment side or sign/
              : ["over-credit", "combined-cap"].includes(variant)
                ? /exceed an endpoint's open balance/
                : /posted open items in the payment's party, control account, subsidiary, and book/;
          await assert.rejects(
            updateDraftPayment(
              payment.id,
              { allocations, creditAllocations: credits },
              actor,
              org.orgId,
            ),
            expected,
          );
          assert.deepEqual(await snapshot(org, payment.id), before);
          await updateDraftPayment(
            payment.id,
            { allocations },
            actor,
            org.orgId,
          );
          await db.execute(
            sql`update documents set status='approved',custom=jsonb_set(custom,'{creditAllocations}',${JSON.stringify(credits)}::jsonb) where id=${payment.id}`,
          );
          const approved = await snapshot(org, payment.id);
          await assert.rejects(
            postPaymentWithApplications(payment.id, undefined, actor),
            expected,
          );
          assert.deepEqual(await snapshot(org, payment.id), approved);
        }
      } finally {
        await dropScratchOrg(org.orgId);
        if (foreign) await dropScratchOrg(foreign.orgId);
      }
    },
  );
}

for (const mode of ["inactive", "non-posting", "missing"] as const) {
  test(
    `payment book configuration fails closed: ${mode}`,
    { skip: !DB },
    async () => {
      const { org, actor, target, payment } = await fixture();
      try {
        await db.execute(sql`update accounting_books set
        is_active=${mode !== "inactive"},posts_gl=${mode !== "non-posting"},is_primary=${mode !== "missing"}
        where id=${org.bookId}`);
        await assert.rejects(
          openItemsForParty(org.customerId, "ar", org.orgId),
          /active primary posting book/,
        );
        const before = await snapshot(org, payment.id);
        await assert.rejects(
          updateDraftPayment(
            payment.id,
            { allocations: [sameCurrencyAllocation(target, "25")] },
            actor,
            org.orgId,
          ),
          /active primary posting book/,
        );
        assert.deepEqual(await snapshot(org, payment.id), before);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
}

test(
  "vendor credits preserve legitimate payable settlement",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Scope audit", "admin");
      const target = await line(org, {
        party: org.vendorId,
        account: org.accounts.ap,
        amount: "-100",
      });
      const credit = await postedCredit(org, actor, true);
      const payment = await createPaymentDocument({
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: actor,
        partyId: org.vendorId,
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        documentDate: org.date,
        currency: "CAD",
      });
      await updateDraftPayment(
        payment.id,
        {
          allocations: [sameCurrencyAllocation(target, "70")],
          creditAllocations: [
            {
              fromLineId: credit,
              toLineId: target,
              amount: "30",
              sourceDocumentId: await sourceDocument(credit),
            },
          ],
        },
        actor,
        org.orgId,
      );
      await db.execute(
        sql`update documents set status='approved' where id=${payment.id}`,
      );
      await postPaymentWithApplications(payment.id, undefined, actor);
      assert.equal((await snapshot(org, payment.id))!.applications, "2");
      assert.deepEqual(
        await openItemsForParty(org.vendorId, "ap", org.orgId),
        [],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "competing payments cannot consume the same credit twice",
  { skip: !DB },
  async () => {
    const { org, actor, target, payment } = await fixture();
    try {
      const credit = await postedCredit(org, actor);
      const other = await createPaymentDocument({
        orgId: org.orgId,
        kind: "customer_payment",
        createdBy: actor,
        partyId: org.customerId,
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        documentDate: org.date,
        currency: "CAD",
      });
      for (const candidate of [payment, other]) {
        await updateDraftPayment(
          candidate.id,
          {
            allocations: [sameCurrencyAllocation(target, "25")],
            creditAllocations: [
              {
                fromLineId: credit,
                toLineId: target,
                amount: "20",
                sourceDocumentId: await sourceDocument(credit),
              },
            ],
          },
          actor,
          org.orgId,
        );
        await db.execute(
          sql`update documents set status='approved' where id=${candidate.id}`,
        );
      }
      const results = await Promise.allSettled(
        [payment, other].map((p) =>
          postPaymentWithApplications(p.id, undefined, actor),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const failure = results.find((r) => r.status === "rejected");
      assert.match(String(failure?.reason), /open balance/);
      assert.equal((await snapshot(org, payment.id))!.applications, "2");
      const loser = results[0]!.status === "rejected" ? payment : other;
      assert.equal((await snapshot(org, loser.id))!.status, "approved");
      assert.equal((await snapshot(org, loser.id))!.entries, "0");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "payment runs consume credit source carrying amounts after an FX application",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Scope audit", "admin");
      const credit = await postedCredit(org, actor, true);
      const bills: string[] = [];
      const lines: string[] = [];
      for (const currency of ["CAD", "USD"]) {
        const id = randomUUID();
        bills.push(id);
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
        values(${id},${org.orgId},'vendor_bill','draft',${id},${org.subsidiaryId},${org.vendorId},${org.date},${currency},${currency === "CAD" ? "1" : "1.2"},'100','0','100',${actor})`);
        await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
        values(${org.orgId},${id},1,${org.accounts.cogs},1,100,100,0,100)`);
        await db.execute(
          sql`update documents set status='approved' where id=${id}`,
        );
        const entry = await postDocument(id, {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        });
        lines.push(
          (
            await db.execute<{ id: string }>(
              sql`select id from journal_lines where entry_id=${entry} and account_id=${org.accounts.ap}`,
            )
          ).rows[0]!.id,
        );
      }
      await db.execute(sql`insert into applications(org_id,from_line_id,to_line_id,amount,source_amount,source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
      values(${org.orgId},${credit},${lines[1]!},12,10,10,'CAD',10,'USD',1,'manual','Prior credit settlement',${org.date},${actor})`);
      const format = randomUUID();
      const profile = randomUUID();
      await db.execute(sql`insert into payment_formats(id,org_id,code,name,rail,direction,country,currency,created_by,updated_by)
      values(${format},${org.orgId},'SCOPE','Scope','cpa005_credit','credit','CA','CAD',${actor},${actor})`);
      await db.execute(sql`insert into payment_bank_profiles(id,org_id,name,bank_account_id,subsidiary_id,payment_format_id,currency,country,created_by,updated_by)
      values(${profile},${org.orgId},'Scope',${org.accounts.bank},${org.subsidiaryId},${format},'CAD','CA',${actor},${actor})`);
      const run = await createPaymentRun({
        orgId: org.orgId,
        createdBy: actor,
        paymentBankProfileId: profile,
        billDocumentIds: [bills[0]!],
        scheduledFor: org.date,
      });
      const evidence = (
        await db.execute<{
          amount: string;
          credits: string;
        }>(sql`select pi.amount,
      d.custom->'creditAllocations'->0->>'amount' as credits from payment_instructions pi join documents d on d.id=pi.payment_document_id and d.org_id=pi.org_id where pi.payment_run_id=${run.id}`)
      ).rows[0];
      assert.deepEqual(evidence, { amount: "80.0000", credits: "20.0000" });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "payment runs preserve transaction residuals after fractional FX settlement",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Scope audit", "admin");
      const bill = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values(${bill},${org.orgId},'vendor_bill','draft',${bill},${org.subsidiaryId},${org.vendorId},${org.date},'USD','0.1','1','0','1',${actor})`);
      await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
      values(${org.orgId},${bill},1,${org.accounts.cogs},1,1,1,0,1)`);
      await db.execute(
        sql`update documents set status='approved' where id=${bill}`,
      );
      const entry = await postDocument(bill, {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      });
      const target = (
        await db.execute<{ id: string }>(
          sql`select id from journal_lines where entry_id=${entry} and account_id=${org.accounts.ap}`,
        )
      ).rows[0]!.id;
      const payment = await createPaymentDocument({
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: actor,
        partyId: org.vendorId,
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        documentDate: org.date,
        currency: "USD",
        fxRate: "0.1",
      });
      await updateDraftPayment(
        payment.id,
        { allocations: [sameCurrencyAllocation(target, "0.3333")] },
        actor,
        org.orgId,
      );
      await db.execute(
        sql`update documents set status='approved' where id=${payment.id}`,
      );
      await postPaymentWithApplications(payment.id, undefined, actor);
      assert.equal(
        (await openItemsForParty(org.vendorId, "ap", org.orgId))[0]!
          .transactionOpen,
        "0.6667",
      );
      const format = randomUUID();
      const profile = randomUUID();
      await db.execute(sql`insert into payment_formats(id,org_id,code,name,rail,direction,country,currency,created_by,updated_by)
      values(${format},${org.orgId},'SCOPE','Scope','wire','credit','CA','USD',${actor},${actor})`);
      await db.execute(sql`insert into payment_bank_profiles(id,org_id,name,bank_account_id,subsidiary_id,payment_format_id,currency,country,created_by,updated_by)
      values(${profile},${org.orgId},'Scope',${org.accounts.bank},${org.subsidiaryId},${format},'USD','CA',${actor},${actor})`);
      const run = await createPaymentRun({
        orgId: org.orgId,
        createdBy: actor,
        paymentBankProfileId: profile,
        billDocumentIds: [bill],
        scheduledFor: org.date,
      });
      const generated = (
        await db.execute<{ id: string; total: string; document_date: string }>(
          sql`select d.id,d.total,d.document_date from payment_instructions pi join documents d on d.id=pi.payment_document_id and d.org_id=pi.org_id where pi.payment_run_id=${run.id}`,
        )
      ).rows[0]!;
      assert.equal(generated.total, "0.6667");
      assert.equal(generated.document_date, org.date);
      await db.execute(
        sql`update documents set status='approved' where id=${generated.id}`,
      );
      await postPaymentWithApplications(generated.id, undefined, actor);
      assert.deepEqual(
        await openItemsForParty(org.vendorId, "ap", org.orgId),
        [],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
