import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { postDocument } from "./posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { sameCurrencyAllocation } from "../payments/settlement-policy.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function account(
  org: Org,
  number: string,
  name: string,
  type: string,
  options: { active?: boolean; subsidiaryId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                          required_dimensions, custom, subsidiary_include_children, subsidiary_id)
    values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, ${options.active ?? true}, false, false,
            '[]'::jsonb, '{}'::jsonb, true, ${options.subsidiaryId ?? null})`);
  return id;
}

async function customerDefault(org: Org, actorId: string, arAccountId: string | null): Promise<void> {
  await db.execute(sql`
    insert into customer_roles (org_id, party_id, ar_account_id, currency, is_on_hold, created_by, updated_by)
    values (${org.orgId}, ${org.customerId}, ${arAccountId}, 'CAD', false, ${actorId}, ${actorId})
    on conflict (party_id) do update set ar_account_id = excluded.ar_account_id`);
}

async function vendorDefault(org: Org, actorId: string, apAccountId: string | null): Promise<void> {
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, is_active, created_by)
    values (${org.orgId}, ${org.vendorId}, ${apAccountId}, true, ${actorId})
    on conflict (party_id) do update set ap_account_id = excluded.ap_account_id`);
}

async function approvedDocument(
  org: Org,
  actorId: string,
  input: {
    kind: "customer_invoice" | "customer_credit" | "vendor_bill" | "vendor_credit";
    number: string;
    total: string;
    lineAccountId: string;
    custom?: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  const partyId = input.kind.startsWith("customer") ? org.customerId : org.vendorId;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, due_date,
       currency, fx_rate, status, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${id}, ${org.orgId}, ${input.kind}, ${input.number}, ${partyId}, ${org.subsidiaryId},
            ${org.date}, ${org.date}, 'CAD', '1', 'draft', ${input.total}, '0', ${input.total},
            ${JSON.stringify(input.custom ?? {})}::jsonb, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
       tax_input_amount, tax_amount, created_by, updated_by)
    values (${org.orgId}, ${id}, 1, ${input.lineAccountId}, '1', ${input.total},
            ${input.total}, ${input.total}, '0', ${actorId}, ${actorId})`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${id} and org_id = ${org.orgId}`);
  return id;
}

function post(org: Org, documentId: string): Promise<string> {
  return postDocument(documentId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
}

async function controlLegs(entryId: string) {
  return (await db.execute<{ id: string; account_id: string; amount: string; is_open_item: boolean; party_id: string | null }>(sql`
    select id, account_id, amount::text as amount, is_open_item, party_id
      from journal_lines where entry_id = ${entryId} and is_open_item
     order by id`)).rows;
}

async function storedChoice(documentId: string): Promise<string | null> {
  return (await db.execute<{ choice: string | null }>(sql`
    select custom->>'controlAccountId' as choice from documents where id = ${documentId}`)).rows[0]!.choice;
}

async function accountBalance(org: Org, accountId: string): Promise<string> {
  return (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(jl.amount), 0)::text as balance
      from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${org.orgId} and jl.account_id = ${accountId} and je.status in ('posted', 'reversed')`)).rows[0]!.balance;
}

async function unposted(documentId: string) {
  return (await db.execute<{ status: string; entries: number }>(sql`
    select status, (select count(*)::int from journal_entries where source_document_id = ${documentId}) as entries
      from documents where id = ${documentId}`)).rows[0]!;
}

async function expectRefusal(promise: Promise<unknown>, ...patterns: RegExp[]): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof PostingError && patterns.every((pattern) => pattern.test(error.message)));
}

test(
  "an invoice posts to the customer's receivable default, a payment settles it there, and the posted account survives a later default change",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        const actorId = await createScratchUser(org.orgId, "Receivable clerk", "admin");
        const retainage = await account(org, "1110", "Retainage Receivable", "asset_receivable");
        await customerDefault(org, actorId, retainage);

        const invoiceId = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-1", total: "1000", lineAccountId: org.accounts.revenue,
        });
        const entryId = await post(org, invoiceId);
        const legs = await controlLegs(entryId);
        assert.equal(legs.length, 1);
        assert.deepEqual(
          { account: legs[0]!.account_id, amount: legs[0]!.amount, party: legs[0]!.party_id },
          { account: retainage, amount: "1000.0000", party: org.customerId },
        );
        assert.equal(await storedChoice(invoiceId), retainage);
        assert.equal(await accountBalance(org, org.accounts.ar), "0");

        // Receive payment: the receipt's credit lands on the invoice's own
        // receivable account, so the open item and the GL clear together.
        const payment = await createPaymentDocument({
          allowedSubsidiaryIds: null, orgId: org.orgId, kind: "customer_payment", createdBy: actorId,
          partyId: org.customerId, bankAccountId: org.accounts.bank, subsidiaryId: org.subsidiaryId,
          documentDate: org.date, currency: "CAD", fxRate: "1",
        });
        await updateDraftPayment(payment.id, {
          allocations: [sameCurrencyAllocation(legs[0]!.id, "1000")],
          bankAccountId: org.accounts.bank,
        }, actorId, org.orgId, { allowedSubsidiaryIds: null });
        await db.execute(sql`
          update documents set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
           where id = ${payment.id}`);
        const { entryId: paymentEntryId } = await postPaymentWithApplications(payment.id, undefined, actorId);
        const paymentLegs = await controlLegs(paymentEntryId);
        assert.deepEqual(paymentLegs.map((leg) => [leg.account_id, leg.amount]), [[retainage, "-1000.0000"]]);
        assert.equal(await accountBalance(org, retainage), "0.0000");
        assert.equal(await accountBalance(org, org.accounts.ar), "0");
        const applied = (await db.execute<{ applied: string }>(sql`
          select coalesce(sum(amount), 0)::text as applied from applications
           where to_line_id = ${legs[0]!.id} and unapplied_at is null`)).rows[0]!;
        assert.equal(applied.applied, "1000.0000");

        // Changing the customer's default never reinterprets posted history.
        await customerDefault(org, actorId, org.accounts.ar);
        assert.equal(await storedChoice(invoiceId), retainage);
        assert.deepEqual((await controlLegs(entryId)).map((leg) => leg.account_id), [retainage]);
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a document's own receivable choice wins over the customer default, and no default falls back to the organization control",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        const actorId = await createScratchUser(org.orgId, "Receivable chooser", "admin");
        const retainage = await account(org, "1110", "Retainage Receivable", "asset_receivable");
        const progress = await account(org, "1120", "Progress Receivable", "asset_receivable");
        await customerDefault(org, actorId, progress);

        const chosen = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-DOC", total: "250", lineAccountId: org.accounts.revenue,
          custom: { controlAccountId: retainage },
        });
        assert.deepEqual((await controlLegs(await post(org, chosen))).map((leg) => leg.account_id), [retainage]);

        await customerDefault(org, actorId, null);
        const fallback = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-ORG", total: "300", lineAccountId: org.accounts.revenue,
        });
        assert.deepEqual((await controlLegs(await post(org, fallback))).map((leg) => leg.account_id), [org.accounts.ar]);
        // The organization fallback is stamped too: the document names the
        // account its open item carries even if the org control later moves.
        assert.equal(await storedChoice(fallback), org.accounts.ar);
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an unusable receivable account refuses the post with the source's remedy and commits nothing",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        const actorId = await createScratchUser(org.orgId, "Receivable guard", "admin");
        const inactive = await account(org, "1190", "Closed Receivable", "asset_receivable", { active: false });
        await customerDefault(org, actorId, inactive);
        const fromDefault = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-INACTIVE", total: "100", lineAccountId: org.accounts.revenue,
        });
        await expectRefusal(post(org, fromDefault), /customer's Receivable account/, /1190/, /inactive/, /customer record/);
        assert.deepEqual(await unposted(fromDefault), { status: "approved", entries: 0 });
        assert.equal(await storedChoice(fromDefault), null);

        await customerDefault(org, actorId, null);
        const wrongType = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-TYPE", total: "100", lineAccountId: org.accounts.revenue,
          custom: { controlAccountId: org.accounts.revenue },
        });
        await expectRefusal(post(org, wrongType), /document's receivable account/, /not a receivable account/);
        assert.deepEqual(await unposted(wrongType), { status: "approved", entries: 0 });

        const otherSubsidiary = randomUUID();
        await db.execute(sql`
          insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
          values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Other Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
        const foreign = await account(org, "1130", "Other Co Receivable", "asset_receivable", { subsidiaryId: otherSubsidiary });
        const crossEntity = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-ENTITY", total: "100", lineAccountId: org.accounts.revenue,
          custom: { controlAccountId: foreign },
        });
        await expectRefusal(post(org, crossEntity), /different subsidiary/);
        assert.deepEqual(await unposted(crossEntity), { status: "approved", entries: 0 });

        // No receivable configured anywhere fails closed instead of guessing.
        await db.execute(sql`
          update orgs set settings = settings #- '{controlAccounts,ar}' where id = ${org.orgId}`);
        const unconfigured = await approvedDocument(org, actorId, {
          kind: "customer_invoice", number: "INV-CTL-NONE", total: "100", lineAccountId: org.accounts.revenue,
        });
        await expectRefusal(
          postDocument(unconfigured, { control: { ar: "", ap: org.accounts.ap, bank: org.accounts.bank } }),
          /no receivable account is configured/,
          /Control accounts/,
        );
        assert.deepEqual(await unposted(unconfigured), { status: "approved", entries: 0 });
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "vendor bills and vendor credits post to the vendor's payable default",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        const actorId = await createScratchUser(org.orgId, "Payable clerk", "admin");
        const holdback = await account(org, "2010", "Holdback Payable", "liability_payable");
        await vendorDefault(org, actorId, holdback);

        const billId = await approvedDocument(org, actorId, {
          kind: "vendor_bill", number: "BILL-CTL-1", total: "400", lineAccountId: org.accounts.cogs,
        });
        const billLegs = await controlLegs(await post(org, billId));
        assert.deepEqual(billLegs.map((leg) => [leg.account_id, leg.amount]), [[holdback, "-400.0000"]]);
        assert.equal(await storedChoice(billId), holdback);

        const creditId = await approvedDocument(org, actorId, {
          kind: "vendor_credit", number: "VCRED-CTL-1", total: "40", lineAccountId: org.accounts.cogs,
        });
        const creditLegs = await controlLegs(await post(org, creditId));
        assert.deepEqual(creditLegs.map((leg) => [leg.account_id, leg.amount]), [[holdback, "40.0000"]]);
        assert.equal(await accountBalance(org, holdback), "-360.0000");
        assert.equal(await accountBalance(org, org.accounts.ap), "0");
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
