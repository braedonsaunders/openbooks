import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  resolveDocumentLineDefaults,
  resolvePartyLineDefault,
  resolveRecentPartyDocument,
  resolveTermsDueDate,
} from "./document-defaults.ts";
import { createDocument } from "./document-write.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Seeded {
  org: ScratchOrg;
  hstOn: string;
  zeroRated: string;
  services: string;
  officeExpense: string;
  vendorDefaultExpense: string;
  consulting: string;
  supplies: string;
  net15: string;
}

/** A customer on Net 15 taxed HST-ON, a vendor on "Due on receipt" with a
 *  default expense account, a service item coded to 4100 and zero-rated, and a
 *  supplies item with an expense account but no income account. */
async function seed(): Promise<Seeded> {
  const org = await createScratchOrg();
  return withBypass(async () => {
    const services = await seedPostingAccount(org.orgId, "4100", "Services", "income");
    const officeExpense = await seedPostingAccount(org.orgId, "6100", "Office supplies", "expense");
    const vendorDefaultExpense = await seedPostingAccount(
      org.orgId,
      "6900",
      "General expense",
      "expense",
    );
    const [hstOn, zeroRated] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into tax_codes (id, org_id, code, name)
      values (${hstOn}, ${org.orgId}, 'HST-ON', 'Ontario HST'), (${zeroRated}, ${org.orgId}, 'ZR', 'Zero-rated')`);
    const [net15, dueOnReceipt] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into payment_terms (id, org_id, name, net_days)
      values (${net15}, ${org.orgId}, 'Net 15', 15), (${dueOnReceipt}, ${org.orgId}, 'Due on receipt', 0)`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, payment_terms_id, tax_code_id)
      values (${org.orgId}, ${org.customerId}, ${net15}, ${hstOn})`);
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, payment_terms_id, default_expense_account_id)
      values (${org.orgId}, ${org.vendorId}, ${dueOnReceipt}, ${vendorDefaultExpense})`);
    const [consulting, supplies] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into items (id, org_id, kind, name, is_active, income_account_id, tax_code_id)
      values (${consulting}, ${org.orgId}, 'service', 'Consulting', true, ${services}, ${zeroRated})`);
    await db.execute(sql`
      insert into items (id, org_id, kind, name, is_active, expense_account_id)
      values (${supplies}, ${org.orgId}, 'non_inventory', 'Supplies', true, ${officeExpense})`);
    return {
      org,
      hstOn,
      zeroRated,
      services,
      officeExpense,
      vendorDefaultExpense,
      consulting,
      supplies,
      net15,
    };
  });
}

test(
  "sales lines take the item income account and the customer's tax code over the item's",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const lines = await withBypass(() =>
        resolveDocumentLineDefaults(db, s.org.orgId, {
          kind: "customer_invoice",
          partyId: s.org.customerId,
          itemIds: [s.consulting, s.supplies],
        }),
      );
      assert.deepEqual(lines, [
        {
          itemId: s.consulting,
          accountId: s.services,
          accountSource: "item_income",
          taxCodeId: s.hstOn,
          taxSource: "party",
        },
        // No income account on the item: nothing is guessed.
        {
          itemId: s.supplies,
          accountId: null,
          accountSource: null,
          taxCodeId: s.hstOn,
          taxSource: "party",
        },
      ]);

      // Without a customer the item's own tax code applies.
      const anonymous = await withBypass(() =>
        resolveDocumentLineDefaults(db, s.org.orgId, {
          kind: "customer_invoice",
          partyId: null,
          itemIds: [s.consulting],
        }),
      );
      assert.equal(anonymous[0]!.taxCodeId, s.zeroRated);
      assert.equal(anonymous[0]!.taxSource, "item");

      // An inactive tax code or account is never proposed.
      await withBypass(() =>
        db.execute(sql`update tax_codes set is_active = false where id = ${s.hstOn}`),
      );
      await withBypass(() =>
        db.execute(sql`update accounts set is_active = false where id = ${s.services}`),
      );
      const retired = await withBypass(() =>
        resolveDocumentLineDefaults(db, s.org.orgId, {
          kind: "customer_invoice",
          partyId: s.org.customerId,
          itemIds: [s.consulting],
        }),
      );
      assert.equal(retired[0]!.accountId, null);
      assert.equal(retired[0]!.taxCodeId, s.zeroRated);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "purchase lines take the item cost account, then the vendor default, and stocked items their posting account",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      await withBypass(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,inventory}', 'true'::jsonb, true) where id = ${s.org.orgId}`),
      );
      const lines = await withBypass(() =>
        resolveDocumentLineDefaults(db, s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          itemIds: [s.supplies, s.consulting, s.org.items.fifo],
        }),
      );
      const byItem = new Map(lines.map((line) => [line.itemId, line]));
      assert.equal(byItem.get(s.supplies)!.accountId, s.officeExpense);
      assert.equal(byItem.get(s.supplies)!.accountSource, "item_expense");
      assert.equal(byItem.get(s.consulting)!.accountId, s.vendorDefaultExpense);
      assert.equal(byItem.get(s.consulting)!.accountSource, "vendor_expense");
      // The bill debits received-not-billed for a stocked line, so that is the default shown.
      assert.equal(byItem.get(s.org.items.fifo)!.accountId, s.org.accounts.clearing);
      assert.equal(byItem.get(s.org.items.fifo)!.accountSource, "inventory_clearing");
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "payment terms set the due date: Net 15 adds fifteen days and Due on receipt is the document date",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const invoice = await withBypass(() =>
        resolveTermsDueDate(db, s.org.orgId, {
          kind: "customer_invoice",
          partyId: s.org.customerId,
          documentDate: "2026-07-20",
        }),
      );
      assert.deepEqual(invoice, {
        termsId: s.net15,
        termsName: "Net 15",
        netDays: 15,
        dueDayOfMonth: null,
        dueDate: "2026-08-04",
        source: "party",
      });
      const bill = await withBypass(() =>
        resolveTermsDueDate(db, s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          documentDate: "2026-07-20",
        }),
      );
      assert.equal(bill?.dueDate, "2026-07-20");
      // Credits carry no terms-derived due date.
      assert.equal(
        await withBypass(() =>
          resolveTermsDueDate(db, s.org.orgId, {
            kind: "customer_credit",
            partyId: s.org.customerId,
            documentDate: "2026-07-20",
          }),
        ),
        null,
      );
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "a party without terms falls back to the company default; a retired default resolves nothing",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const net30 = randomUUID();
      await withBypass(() =>
        db.execute(sql`
      insert into payment_terms (id, org_id, name, net_days) values (${net30}, ${s.org.orgId}, 'Net 30', 30)`),
      );
      await withBypass(() =>
        db.execute(sql`
      update customer_roles set payment_terms_id = null
       where org_id = ${s.org.orgId} and party_id = ${s.org.customerId}`),
      );
      const resolve = () =>
        withBypass(() =>
          resolveTermsDueDate(db, s.org.orgId, {
            kind: "customer_invoice",
            partyId: s.org.customerId,
            documentDate: "2026-07-20",
          }),
        );
      // No company default configured: nothing derives.
      assert.equal(await resolve(), null);
      await withBypass(() =>
        db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('billing', jsonb_build_object('defaultPaymentTermsId', ${net30}::text))
       where id = ${s.org.orgId}`),
      );
      assert.deepEqual(await resolve(), {
        termsId: net30,
        termsName: "Net 30",
        netDays: 30,
        dueDayOfMonth: null,
        dueDate: "2026-08-19",
        source: "company",
      });
      // The party's own terms win over the company default.
      await withBypass(() =>
        db.execute(sql`
      update customer_roles set payment_terms_id = ${s.net15}
       where org_id = ${s.org.orgId} and party_id = ${s.org.customerId}`),
      );
      assert.deepEqual((await resolve())?.source, "party");
      // A default pointing at retired terms is ignored, never refused.
      await withBypass(() =>
        db.execute(sql`
      update customer_roles set payment_terms_id = null
       where org_id = ${s.org.orgId} and party_id = ${s.org.customerId}`),
      );
      await withBypass(() =>
        db.execute(sql`update payment_terms set is_active = false where id = ${net30}`),
      );
      assert.equal(await resolve(), null);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "creating an invoice without a due date derives it from terms; an explicit null stays empty",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const userId = await withBypass(() =>
        createScratchUser(s.org.orgId, "Billing Clerk", "admin"),
      );
      const create = (dueDate: string | null | undefined) =>
        withBypass(() =>
          createDocument({
            orgId: s.org.orgId,
            userId: String(userId),
            kind: "customer_invoice",
            key: randomUUID(),
            subsidiaryId: s.org.subsidiaryId,
            body: {
              partyId: s.org.customerId,
              documentDate: s.org.date,
              ...(dueDate === undefined ? {} : { dueDate }),
              lines: [{ accountId: s.services, amount: "100.0000" }],
            },
            requestBody: {},
          }),
        );
      const dueOf = async (id: string) =>
        (
          await withBypass(() =>
            db.execute<{ due_date: string | null }>(
              sql`
      select due_date::text as due_date from documents where id = ${id} and org_id = ${s.org.orgId}`,
              "objects",
            ),
          )
        )[0]?.due_date ?? null;

      const derived = await create(undefined);
      assert.equal(derived.status, "created");
      const expected = await withBypass(() =>
        resolveTermsDueDate(db, s.org.orgId, {
          kind: "customer_invoice",
          partyId: s.org.customerId,
          documentDate: s.org.date,
        }),
      );
      assert.equal(await dueOf(derived.id), expected!.dueDate);

      const cleared = await create(null);
      assert.equal(await dueOf(cleared.id), null);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "an omitted document currency uses the selected legal entity's functional currency",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      await withBypass(() =>
        db.execute(sql`
      insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2)
      on conflict (code) do nothing`),
      );
      await withBypass(() =>
        db.execute(sql`
      update orgs set base_currency = 'CAD' where id = ${s.org.orgId}`),
      );
      await withBypass(() =>
        db.execute(sql`
      update subsidiaries set base_currency = 'USD'
       where org_id = ${s.org.orgId} and id = ${s.org.subsidiaryId}`),
      );
      const userId = await withBypass(() =>
        createScratchUser(s.org.orgId, "Entity Billing Clerk", "admin"),
      );
      const body = {
        partyId: s.org.vendorId,
        documentDate: s.org.date,
        lines: [{ accountId: s.officeExpense, amount: "100.0000" }],
      };
      const created = await withBypass(() =>
        createDocument({
          orgId: s.org.orgId,
          userId: String(userId),
          kind: "vendor_bill",
          key: randomUUID(),
          subsidiaryId: s.org.subsidiaryId,
          body,
          requestBody: body,
        }),
      );
      const currency = (
        await withBypass(() =>
          db.execute<{ currency: string }>(
            sql`
      select currency from documents where org_id = ${s.org.orgId} and id = ${created.id}`,
            "objects",
          ),
        )
      )[0]?.currency;
      assert.equal(currency, "USD");
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "purchase lines propose the company clearing account when the profile names none",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      await withBypass(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,inventory}', 'true'::jsonb, true) where id = ${s.org.orgId}`),
      );
      await withBypass(() =>
        db.execute(sql`
      update item_inventory_profiles set received_not_billed_account_id = null
       where org_id = ${s.org.orgId} and item_id = ${s.org.items.fifo}`),
      );
      const companyGrni = await withBypass(() =>
        seedPostingAccount(s.org.orgId, "2160", "Company GRNI", "liability_current_other"),
      );
      await withBypass(() =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,receivedNotBilled}', to_jsonb(${companyGrni}::text), true)
       where id = ${s.org.orgId}`),
      );
      const lines = await withBypass(() =>
        resolveDocumentLineDefaults(db, s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          itemIds: [s.org.items.fifo],
        }),
      );
      assert.equal(lines[0]!.accountId, companyGrni);
      assert.equal(lines[0]!.accountSource, "inventory_clearing");
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

interface SeedLine {
  accountId?: string | null;
  itemId?: string | null;
  amount: string;
  description?: string;
  quantity?: string;
  unitPrice?: string;
  departmentId?: string | null;
  taxCodeId?: string | null;
  taxGroupId?: string | null;
}

/** A draft document with direct lines, written straight to storage so its date
 *  can sit anywhere in the party's history. */
async function seedPartyDocument(
  orgId: string,
  row: {
    kind: string;
    partyId: string;
    date: string;
    number: string;
    reference?: string;
    memo?: string;
    lines: SeedLine[];
  },
): Promise<string> {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, party_id, currency, reference_number, memo)
      values (${id}, ${orgId}, ${row.kind}, 'draft', ${row.number}, ${row.date}, ${row.partyId}, 'USD',
              ${row.reference ?? null}, ${row.memo ?? null})`);
    for (const [index, line] of row.lines.entries()) {
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, item_id, description, quantity, unit_price, amount, department_id, tax_code_id, tax_group_id)
        values (${orgId}, ${id}, ${index + 1}, ${line.accountId ?? null}, ${line.itemId ?? null}, ${line.description ?? null},
                ${line.quantity ?? "1"}, ${line.unitPrice ?? line.amount}, ${line.amount}, ${line.departmentId ?? null}, ${line.taxCodeId ?? null},
                ${line.taxGroupId ?? null})`);
    }
  });
  return id;
}

const AS_OF = "2026-09-30";

test(
  "a vendor's default expense account wins over the vendor's own history",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      for (const [index, date] of ["2026-07-01", "2026-08-01", "2026-09-01"].entries()) {
        await seedPartyDocument(s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          date,
          number: `B-${index}`,
          lines: [{ accountId: s.officeExpense, amount: "40.0000" }],
        });
      }
      await withBypass(() =>
        db.execute(sql`
      update vendor_roles set tax_code_id = ${s.hstOn} where org_id = ${s.org.orgId} and party_id = ${s.org.vendorId}`),
      );
      const resolved = await withBypass(() =>
        resolvePartyLineDefault(db, s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          asOfDate: AS_OF,
          allowedSubsidiaryIds: null,
        }),
      );
      assert.deepEqual(resolved, {
        accountId: s.vendorDefaultExpense,
        accountSource: "party_default",
        taxCodeId: s.hstOn,
        taxGroupId: null,
        taxSource: "party",
      });
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "without a usable default, the most-used recent account is proposed and ties go to the latest use",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const utilities = await withBypass(() =>
        seedPostingAccount(s.org.orgId, "6300", "Utilities", "expense"),
      );
      const repairs = await withBypass(() =>
        seedPostingAccount(s.org.orgId, "6400", "Repairs", "expense"),
      );
      // Retiring the vendor default makes it unusable: it is skipped, never proposed.
      await withBypass(() =>
        db.execute(sql`update accounts set is_active = false where id = ${s.vendorDefaultExpense}`),
      );
      const bill = (date: string, number: string, lines: SeedLine[]) =>
        seedPartyDocument(s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          date,
          number,
          lines,
        });
      // Office supplies on two bills (two lines on one of them still count once).
      await bill("2026-03-01", "B-1", [
        { accountId: s.officeExpense, amount: "10.0000" },
        { accountId: s.officeExpense, amount: "5.0000" },
      ]);
      await bill("2026-04-01", "B-2", [{ accountId: s.officeExpense, amount: "10.0000" }]);
      await bill("2026-05-01", "B-3", [{ accountId: utilities, amount: "80.0000" }]);
      // Outside the 365-day window: three older bills never outvote recent coding.
      for (const number of ["B-OLD-1", "B-OLD-2", "B-OLD-3"]) {
        await bill("2025-06-01", number, [{ accountId: repairs, amount: "99.0000" }]);
      }
      // An item line's account is the item's posting account, not the vendor's coding.
      await bill("2026-06-01", "B-ITEM", [
        { accountId: repairs, itemId: s.supplies, amount: "1.0000" },
      ]);
      await bill("2026-06-02", "B-ITEM-2", [
        { accountId: repairs, itemId: s.supplies, amount: "1.0000" },
      ]);
      await bill("2026-06-03", "B-ITEM-3", [
        { accountId: repairs, itemId: s.supplies, amount: "1.0000" },
      ]);

      const resolve = () =>
        withBypass(() =>
          resolvePartyLineDefault(db, s.org.orgId, {
            kind: "vendor_bill",
            partyId: s.org.vendorId,
            asOfDate: AS_OF,
            allowedSubsidiaryIds: null,
          }),
        );
      assert.deepEqual(await resolve(), {
        accountId: s.officeExpense,
        accountSource: "party_history",
        taxCodeId: null,
        taxGroupId: null,
        taxSource: null,
        historyCount: 2,
      });

      // A second utilities bill ties the count; utilities was used more recently.
      await bill("2026-09-15", "B-4", [{ accountId: utilities, amount: "80.0000" }]);
      const tied = await resolve();
      assert.equal(tied.accountId, utilities);
      assert.equal(tied.historyCount, 2);

      // An inactive account is never proposed from history either.
      await withBypass(() =>
        db.execute(sql`update accounts set is_active = false where id = ${utilities}`),
      );
      assert.equal((await resolve()).accountId, s.officeExpense);

      // A different kind keeps its own history.
      const credit = await withBypass(() =>
        resolvePartyLineDefault(db, s.org.orgId, {
          kind: "vendor_credit",
          partyId: s.org.vendorId,
          asOfDate: AS_OF,
          allowedSubsidiaryIds: null,
        }),
      );
      assert.deepEqual(credit, {
        accountId: null,
        accountSource: null,
        taxCodeId: null,
        taxGroupId: null,
        taxSource: null,
      });
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "without a vendor tax code, new lines take the tax the vendor's history uses on the proposed account",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const [gst, qst, quebec] = [randomUUID(), randomUUID(), randomUUID()];
      await withBypass(async () => {
        await db.execute(sql`
        insert into tax_codes (id, org_id, code, name) values (${gst}, ${s.org.orgId}, 'GST', 'GST'), (${qst}, ${s.org.orgId}, 'QST', 'QST')`);
        await db.execute(sql`
        insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from)
        values (${s.org.orgId}, ${s.hstOn}, '13', '2010-07-01'), (${s.org.orgId}, ${gst}, '5', '2008-01-01'),
               (${s.org.orgId}, ${qst}, '9.975', '2013-01-01')`);
        await db.execute(
          sql`insert into tax_groups (id, org_id, code, name) values (${quebec}, ${s.org.orgId}, 'GST+QST', 'Quebec')`,
        );
        await db.execute(sql`
        insert into tax_group_members (tax_group_id, tax_code_id, sequence) values (${quebec}, ${gst}, 1), (${quebec}, ${qst}, 2)`);
      });
      const bill = (date: string, number: string, lines: SeedLine[]) =>
        seedPartyDocument(s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          date,
          number,
          lines,
        });
      // On the vendor's default account: HST on three bills, untaxed on one.
      for (const [index, date] of ["2026-06-01", "2026-07-01", "2026-08-01"].entries()) {
        await bill(date, `B-HST-${index}`, [
          { accountId: s.vendorDefaultExpense, amount: "100.0000", taxCodeId: s.hstOn },
        ]);
      }
      await bill("2026-09-01", "B-NONE", [
        { accountId: s.vendorDefaultExpense, amount: "100.0000" },
      ]);
      // On another account the vendor is mostly billed under the Quebec group.
      for (const [index, date] of [
        "2026-05-01",
        "2026-05-02",
        "2026-05-03",
        "2026-05-04",
      ].entries()) {
        await bill(date, `B-QC-${index}`, [
          { accountId: s.officeExpense, amount: "10.0000", taxGroupId: quebec },
        ]);
      }
      const resolve = () =>
        withBypass(() =>
          resolvePartyLineDefault(db, s.org.orgId, {
            kind: "vendor_bill",
            partyId: s.org.vendorId,
            asOfDate: AS_OF,
            allowedSubsidiaryIds: null,
          }),
        );

      // The tax follows the proposed account's own history, not the vendor's overall habit.
      assert.deepEqual(await resolve(), {
        accountId: s.vendorDefaultExpense,
        accountSource: "party_default",
        taxCodeId: s.hstOn,
        taxGroupId: null,
        taxSource: "party_history",
        taxHistoryCount: 3,
      });

      // An explicit vendor tax code always wins over history.
      await withBypass(() =>
        db.execute(sql`
      update vendor_roles set tax_code_id = ${s.zeroRated} where org_id = ${s.org.orgId} and party_id = ${s.org.vendorId}`),
      );
      const explicit = await resolve();
      assert.equal(explicit.taxCodeId, s.zeroRated);
      assert.equal(explicit.taxSource, "party");
      await withBypass(() =>
        db.execute(sql`
      update vendor_roles set tax_code_id = null where org_id = ${s.org.orgId} and party_id = ${s.org.vendorId}`),
      );

      // A code the bill cannot be taxed with never competes: retired, sales-only,
      // or without a rate in force on the date. The untaxed bill then leads.
      const unusable = [
        sql`update tax_codes set is_active = false where id = ${s.hstOn}`,
        sql`update tax_codes set applies_to = 'sales' where id = ${s.hstOn}`,
        sql`update tax_rates set effective_to = '2026-06-30' where tax_code_id = ${s.hstOn}`,
      ];
      const restore = [
        sql`update tax_codes set is_active = true where id = ${s.hstOn}`,
        sql`update tax_codes set applies_to = 'both' where id = ${s.hstOn}`,
        sql`update tax_rates set effective_to = null where tax_code_id = ${s.hstOn}`,
      ];
      for (const [index, change] of unusable.entries()) {
        await withBypass(() => db.execute(change));
        const resolved = await resolve();
        assert.deepEqual(
          [resolved.taxCodeId, resolved.taxGroupId, resolved.taxSource],
          [null, null, null],
          `case ${index}`,
        );
        await withBypass(() => db.execute(restore[index]!));
      }

      // An account with no history with the vendor learns from all of its lines.
      const freshDefault = await withBypass(() =>
        seedPostingAccount(s.org.orgId, "6950", "Unused expense", "expense"),
      );
      await withBypass(() =>
        db.execute(sql`
      update vendor_roles set default_expense_account_id = ${freshDefault} where org_id = ${s.org.orgId} and party_id = ${s.org.vendorId}`),
      );
      assert.deepEqual(await resolve(), {
        accountId: freshDefault,
        accountSource: "party_default",
        taxCodeId: null,
        taxGroupId: quebec,
        taxSource: "party_history",
        taxHistoryCount: 4,
      });

      // A group with a retired member is not a usable tax, so it is never proposed.
      await withBypass(() =>
        db.execute(sql`update tax_codes set is_active = false where id = ${qst}`),
      );
      const withoutGroup = await resolve();
      assert.equal(withoutGroup.taxGroupId, null);
      assert.equal(withoutGroup.taxCodeId, s.hstOn);
      assert.equal(withoutGroup.taxHistoryCount, 3);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "sales history proposes only income accounts and stays inside the reader's subsidiaries",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      await seedPartyDocument(s.org.orgId, {
        kind: "customer_invoice",
        partyId: s.org.customerId,
        date: "2026-09-01",
        number: "INV-1",
        lines: [{ accountId: s.services, amount: "100.0000" }],
      });
      // Expense coding on invoices is not an account an invoice line may take.
      for (const number of ["INV-2", "INV-3"]) {
        await seedPartyDocument(s.org.orgId, {
          kind: "customer_invoice",
          partyId: s.org.customerId,
          date: "2026-09-10",
          number,
          lines: [{ accountId: s.officeExpense, amount: "10.0000" }],
        });
      }
      const resolve = (allowedSubsidiaryIds: ReadonlySet<string> | null) =>
        withBypass(() =>
          resolvePartyLineDefault(db, s.org.orgId, {
            kind: "customer_invoice",
            partyId: s.org.customerId,
            asOfDate: AS_OF,
            allowedSubsidiaryIds,
          }),
        );
      const open = await resolve(null);
      assert.equal(open.accountId, s.services);
      assert.equal(open.accountSource, "party_history");
      assert.equal(open.historyCount, 1);
      assert.equal(open.taxCodeId, s.hstOn);
      // A reader scoped to no subsidiary of that invoice learns nothing from it.
      const scoped = await resolve(new Set([randomUUID()]));
      assert.equal(scoped.accountId, null);
      assert.equal(scoped.taxCodeId, s.hstOn);
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);

test(
  "recall returns the latest non-voided document with references the pickers can still offer",
  { skip: !DB },
  async () => {
    const s = await seed();
    try {
      const shop = randomUUID();
      await withBypass(() =>
        db.execute(sql`
      insert into departments (id, org_id, name) values (${shop}, ${s.org.orgId}, 'Shop')`),
      );
      await seedPartyDocument(s.org.orgId, {
        kind: "vendor_bill",
        partyId: s.org.vendorId,
        date: "2026-08-01",
        number: "B-OLDER",
        lines: [{ accountId: s.vendorDefaultExpense, amount: "1.0000" }],
      });
      const latest = await seedPartyDocument(s.org.orgId, {
        kind: "vendor_bill",
        partyId: s.org.vendorId,
        date: "2026-09-01",
        number: "B-LATEST",
        reference: "INV-7781",
        memo: "September service",
        lines: [
          {
            accountId: s.officeExpense,
            amount: "120.5000",
            quantity: "2",
            unitPrice: "60.25",
            description: "Toner",
            departmentId: shop,
            taxCodeId: s.hstOn,
          },
          { accountId: s.vendorDefaultExpense, amount: "15.0000", description: "Delivery" },
        ],
      });
      // A newer voided bill is never recalled.
      await withBypass(() =>
        db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, party_id, currency, voided_at, voided_by, void_reason)
      values (${randomUUID()}, ${s.org.orgId}, 'vendor_bill', 'voided', 'B-VOID', '2026-09-20', ${s.org.vendorId}, 'USD',
              now(), ${s.org.vendorId}, 'entered twice by mistake')`),
      );
      await withBypass(() =>
        db.execute(sql`update departments set is_active = false where id = ${shop}`),
      );
      await withBypass(() =>
        db.execute(sql`update accounts set is_active = false where id = ${s.vendorDefaultExpense}`),
      );

      const recalled = await withBypass(() =>
        resolveRecentPartyDocument(db, s.org.orgId, {
          kind: "vendor_bill",
          partyId: s.org.vendorId,
          allowedSubsidiaryIds: null,
        }),
      );
      assert.equal(recalled?.id, latest);
      assert.equal(recalled?.documentNumber, "B-LATEST");
      assert.equal(recalled?.referenceNumber, "INV-7781");
      assert.equal(recalled?.memo, "September service");
      assert.equal(recalled?.lines.length, 2);
      const [toner, delivery] = recalled!.lines;
      // The retired department is blanked on its own; the rest of the line is kept exactly.
      assert.equal(toner!.accountId, s.officeExpense);
      assert.equal(toner!.departmentId, null);
      assert.equal(toner!.taxCodeId, s.hstOn);
      assert.equal(toner!.description, "Toner");
      assert.equal(Number(toner!.quantity), 2);
      assert.match(toner!.amount, /^120\.50*$/);
      assert.match(toner!.unitPrice, /^60\.250*$/);
      // The retired account is blanked; the description still recalls what the line was.
      assert.equal(delivery!.accountId, null);
      assert.equal(delivery!.description, "Delivery");

      // A reader scoped away from the bill's subsidiary recalls nothing.
      assert.equal(
        await withBypass(() =>
          resolveRecentPartyDocument(db, s.org.orgId, {
            kind: "vendor_bill",
            partyId: s.org.vendorId,
            allowedSubsidiaryIds: new Set([randomUUID()]),
          }),
        ),
        null,
      );
    } finally {
      await dropScratchOrg(s.org.orgId);
    }
  },
);
