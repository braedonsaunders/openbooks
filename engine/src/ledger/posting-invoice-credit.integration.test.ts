import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { PostingError } from "./posting-contracts.ts";
import { postDocument } from "./posting-document.ts";
import {
  measureCustomerExposure,
} from "../receivables/credit-policy.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedCustomerRole(
  org: Org,
  actorId: string,
  partyId: string,
  input: { creditLimit: string | null; currency?: string | null },
): Promise<void> {
  await withBypass(async () => {
    await db.execute(sql`
      insert into customer_roles
        (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
      values (${org.orgId}, ${partyId}, ${org.accounts.ar}, ${input.creditLimit},
              ${input.currency === undefined ? "CAD" : input.currency}, false, ${actorId}, ${actorId})`);
  });
}

async function seedOpenOrder(
  org: Org,
  actorId: string,
  number: string,
  total: string,
  currency = "CAD",
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, fx_rate, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId},
              ${org.subsidiaryId}, ${org.date}, ${currency}, '1', 'approved',
              ${total}, '0', ${total}, ${actorId}, ${actorId})`);
  });
  return id;
}

/** Draft invoice converted from an order: the 'bills' edge conversion writes. */
async function seedConvertedInvoice(
  org: Org,
  actorId: string,
  orderId: string,
  number: string,
  total: string,
  currency = "CAD",
): Promise<string> {
  const id = await seedDirectInvoice(org, actorId, number, total, currency);
  await withBypass(async () => {
    await db.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${org.orgId}, ${orderId}, ${id}, 'bills', ${actorId})`);
  });
  return id;
}

async function seedDirectInvoice(
  org: Org,
  actorId: string,
  number: string,
  total: string,
  currency = "CAD",
  partyId?: string,
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, fx_rate, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (${id}, ${org.orgId}, 'customer_invoice', ${number}, ${partyId ?? org.customerId},
              ${org.subsidiaryId}, ${org.date}, ${currency}, '1', 'draft',
              ${total}, '0', ${total}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
         tax_input_amount, tax_amount, created_by, updated_by)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', ${total},
              ${total}, ${total}, '0', ${actorId}, ${actorId})`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
       where id = ${id} and org_id = ${org.orgId}`);
  });
  return id;
}

async function post(org: Org, invoiceId: string): Promise<string> {
  return withBypass(() =>
    postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
}

async function invoiceState(org: Org, id: string) {
  return withBypass(async () => {
    const row = (
      await db.execute<{ status: string; balance: string | null; entries: number }>(sql`
        select status, open_balance::text as balance,
               (select count(*)::int from journal_entries where source_document_id = ${id}) as entries
          from documents where id = ${id} and org_id = ${org.orgId}`)
    ).rows[0]!;
    return row;
  });
}

async function expectPostingRefusal(promise: Promise<unknown>, ...patterns: RegExp[]) {
  let captured: PostingError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof PostingError)) return false;
    captured = error;
    return patterns.every((pattern) => pattern.test(error.message));
  });
  return captured!;
}

test(
  "a direct invoice that breaches the credit limit refuses at posting with the figures",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting credit clerk", "posting_credit_clerk"),
      );
      await seedCustomerRole(org, actorId, org.customerId, { creditLimit: "10000" });
      const invoiceId = await seedDirectInvoice(org, actorId, "INV-POST-OVER-1", "12000");

      // Nothing else is owed: the refusal must name the invoice, the limit,
      // and the resulting exposure, not just "over limit".
      await expectPostingRefusal(
        post(org, invoiceId),
        /INV-POST-OVER-1/,
        /12000/,
        /10000/,
      );

      // The refused post commits nothing: still approved, no journal entries.
      assert.deepEqual(await invoiceState(org, invoiceId), {
        status: "approved",
        balance: null,
        entries: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "posting a converted invoice relieves the linked order instead of double counting",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting relief clerk", "posting_relief_clerk"),
      );
      await seedCustomerRole(org, actorId, org.customerId, { creditLimit: "15000" });
      const orderId = await seedOpenOrder(org, actorId, "SO-POST-RELIEF-1", "10000");
      const invoiceId = await seedConvertedInvoice(org, actorId, orderId, "INV-POST-RELIEF-1", "10000");

      // Without relief this would read as 10000 open + 10000 new = 20000 and
      // refuse; the swap lands exactly at 10000 and posts.
      await post(org, invoiceId);
      assert.deepEqual(await invoiceState(org, invoiceId), {
        status: "posted",
        balance: "10000.0000",
        entries: 1,
      });

      // The order remainder is now billed cover, not exposure: 10000 unpaid
      // plus a 6000 direct invoice reaches 16000 and refuses naming it.
      const extraId = await seedDirectInvoice(org, actorId, "INV-POST-OVER-2", "6000");
      await expectPostingRefusal(
        post(org, extraId),
        /16000/,
        /15000/,
        /unpaid invoices 10000/,
      );
      assert.deepEqual(await invoiceState(org, extraId), {
        status: "approved",
        balance: null,
        entries: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "partial billing relieves only what it bills",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting partial clerk", "posting_partial_clerk"),
      );
      await seedCustomerRole(org, actorId, org.customerId, { creditLimit: "15000" });
      const orderId = await seedOpenOrder(org, actorId, "SO-POST-PARTIAL-1", "10000");

      // First partial billing: 10000 open + 3000 new − 3000 relief = 10000.
      const firstId = await seedConvertedInvoice(org, actorId, orderId, "INV-POST-PART-1", "3000");
      await post(org, firstId);

      // Second billing for the rest: 7000 remainder + 3000 unpaid + 7000 new
      // − 7000 relief = 10000. Counting either invoice twice would refuse.
      const secondId = await seedConvertedInvoice(org, actorId, orderId, "INV-POST-PART-2", "7000");
      await post(org, secondId);

      const exposure = await withBypass(() =>
        measureCustomerExposure(db, org.orgId, org.customerId, "CAD"),
      );
      assert.deepEqual(exposure, {
        openOrderExposure: "0.0000",
        unpaidInvoiceExposure: "10000.0000",
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "billing relabelled to another party does not relieve the source order",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting stray clerk", "posting_stray_clerk"),
      );
      const otherParty = randomUUID();
      await withBypass(async () => {
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${otherParty}, ${org.orgId}, 'customer', 'Stray Customer', true, '{}'::jsonb)`);
      });
      await seedCustomerRole(org, actorId, org.customerId, { creditLimit: "10000" });
      await seedCustomerRole(org, actorId, otherParty, { creditLimit: "20000" });

      const orderId = await seedOpenOrder(org, actorId, "SO-POST-STRAY-1", "10000");
      // Legacy shape: the conversion child carries the other party, so its
      // totals must never release the source commitment.
      const strayId = await seedConvertedInvoice(org, actorId, orderId, "INV-POST-STRAY-1", "10000");
      await withBypass(async () => {
        await db.execute(sql`
          update documents set party_id = ${otherParty}, updated_at = now(), updated_by = ${actorId}
           where id = ${strayId} and org_id = ${org.orgId}`);
      });

      // Posts against the other customer's own headroom ...
      await post(org, strayId);
      assert.equal((await invoiceState(org, strayId)).status, "posted");

      // ... while the source order keeps its full remainder here.
      const exposure = await withBypass(() =>
        measureCustomerExposure(db, org.orgId, org.customerId, "CAD"),
      );
      assert.deepEqual(exposure, {
        openOrderExposure: "10000.0000",
        unpaidInvoiceExposure: "0",
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an invoice in a foreign currency posts without a credit decision",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting foreign clerk", "posting_foreign_clerk"),
      );
      await seedCustomerRole(org, actorId, org.customerId, { creditLimit: "10000", currency: "USD" });

      // The limit is managed in USD; a CAD invoice cannot be evaluated
      // without FX, so the gate leaves it alone — the order-side
      // mixed-currency probe stays the backstop for the exposure itself.
      const invoiceId = await seedDirectInvoice(org, actorId, "INV-POST-FX-1", "50000", "CAD");
      await post(org, invoiceId);
      assert.equal((await invoiceState(org, invoiceId)).status, "posted");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "posting without a role or without a limit stays ungated",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting unconfigured clerk", "posting_unconfigured_clerk"),
      );
      // No customer_roles row at all: nothing to evaluate.
      const bareId = await seedDirectInvoice(org, actorId, "INV-POST-BARE-1", "25000");
      await post(org, bareId);
      assert.equal((await invoiceState(org, bareId)).status, "posted");

      // Explicitly unlimited: the gate measures nothing against null.
      const otherParty = randomUUID();
      await withBypass(async () => {
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${otherParty}, ${org.orgId}, 'customer', 'Unlimited Customer', true, '{}'::jsonb)`);
      });
      await seedCustomerRole(org, actorId, otherParty, { creditLimit: null });
      const freeId = await seedDirectInvoice(org, actorId, "INV-POST-FREE-1", "25000", "CAD", otherParty);
      await post(org, freeId);
      assert.equal((await invoiceState(org, freeId)).status, "posted");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "misconfigured roles refuse posting by name",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Posting config clerk", "posting_config_clerk"),
      );
      const negativeParty = randomUUID();
      const currencylessParty = randomUUID();
      await withBypass(async () => {
        for (const [party, name] of [
          [negativeParty, "Negative Customer"],
          [currencylessParty, "Currencyless Customer"],
        ] as const) {
          await db.execute(sql`
            insert into parties (id, org_id, kind, display_name, is_active, custom)
            values (${party}, ${org.orgId}, 'customer', ${name}, true, '{}'::jsonb)`);
        }
      });
      await seedCustomerRole(org, actorId, negativeParty, { creditLimit: "-500" });
      await seedCustomerRole(org, actorId, currencylessParty, { creditLimit: "10000", currency: null });

      const negativeId = await seedDirectInvoice(org, actorId, "INV-POST-NEG-1", "100", "CAD", negativeParty);
      await expectPostingRefusal(post(org, negativeId), /cannot be negative/);
      assert.deepEqual(await invoiceState(org, negativeId), {
        status: "approved",
        balance: null,
        entries: 0,
      });

      const currencylessId = await seedDirectInvoice(
        org, actorId, "INV-POST-NOCUR-1", "100", "CAD", currencylessParty,
      );
      await expectPostingRefusal(post(org, currencylessId), /has no currency/);
      assert.deepEqual(await invoiceState(org, currencylessId), {
        status: "approved",
        balance: null,
        entries: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
