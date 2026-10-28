import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";

stubModules({ intl: true, navigation: false, authz: false, features: false });

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { withReadMemo } = await import("@openbooks/engine/platform/database");
const { postDocument } = await import("@openbooks/engine/documents");
const { createScratchOrg, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
const { globalSearch } = await import("./search.ts");

type Reader = Parameters<typeof globalSearch>[0];

function reader(orgId: string, allowedSubsidiaryIds: Set<string> | null): Reader {
  return {
    user: {
      id: randomUUID(),
      orgId,
      name: "Search reader",
      email: "search@scratch.test",
      roles: [],
      isSuperAdmin: false,
      envKind: "production",
      productionOrgId: orgId,
      homeOrgId: orgId,
      homeUserId: randomUUID(),
    },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds,
  } as unknown as Reader;
}

test(
  "search reads numbers, amounts, words, scopes, statuses and dates through the index, inside the fence",
  { skip: !process.env.OPENBOOKS_DB_URL, timeout: 240_000 },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const other = randomUUID();
      const posted = randomUUID();
      const draft = randomUUID();
      const bill = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"multiSubsidiary":true}'::jsonb) where id = ${org.orgId}`);
        await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
          values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`);
        await db.execute(sql`update parties set display_name = 'Acme Hauling Ltd', subsidiary_id = null
          where org_id = ${org.orgId} and id = ${org.customerId}`);
        const insert = async (
          id: string,
          kind: string,
          number: string,
          subsidiary: string,
          party: string,
          total: string,
          lines: [string, string][],
        ) => {
          await db.execute(sql`insert into documents
            (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, due_date,
             currency, fx_rate, subtotal, tax_total, total)
            values (${id}, ${org.orgId}, ${kind}, 'draft', ${number}, ${subsidiary}, ${party}, ${org.date}, ${org.date},
              'CAD', 1, ${total}, 0, ${total})`);
          for (const [index, [description, amount]] of lines.entries()) {
            await db.execute(sql`insert into document_lines
              (org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount, tax_input_amount)
              values (${org.orgId}, ${id}, ${index + 1}, ${kind === "vendor_bill" ? org.accounts.adjustment : org.accounts.revenue},
                ${description}, 1, ${amount}, ${amount}, 0, ${amount})`);
          }
        };
        await insert(
          posted,
          "customer_invoice",
          "INV-0003668",
          org.subsidiaryId,
          org.customerId,
          "7298.08",
          [
            ["Forklift rental", "7000.00"],
            ["Fuel surcharge", "298.08"],
          ],
        );
        await insert(draft, "customer_invoice", "INV-0003669", other, org.customerId, "1500.00", [
          ["Crane rental", "1500.00"],
        ]);
        await insert(bill, "vendor_bill", "B-77", org.subsidiaryId, org.vendorId, "50.00", [
          ["Gravel", "50.00"],
        ]);
        await db.execute(
          sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${posted}`,
        );
        await postDocument(posted, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
      });

      const search = async (q: string, scope: Set<string> | null = null) =>
        withOrgContext(org.orgId, () =>
          withReadMemo(() => globalSearch(reader(org.orgId, scope), q)),
        );
      const transactions = async (q: string, scope: Set<string> | null = null) =>
        (await search(q, scope)).groups.find((group) => group.type === "transaction")?.hits ?? [];
      const ids = async (q: string, scope: Set<string> | null = null) =>
        (await transactions(q, scope)).map((hit) => hit.id);

      assert.equal((await ids("INV 3668"))[0], posted, "a number typed with a space resolves");
      assert.equal((await ids("inv3668"))[0], posted, "and without its punctuation");
      assert.ok((await ids("3668")).includes(posted), "and by its digits alone");

      const total = (await transactions("7,298.08"))[0];
      assert.equal(total?.id, posted, "a document total finds its document");
      assert.deepEqual(total?.match, { kind: "total", amount: "7,298.08" });
      const line = (await transactions("$7,000.00"))[0];
      assert.equal(line?.id, posted, "a line amount finds its document");
      assert.deepEqual(line?.match, { kind: "lineAmount", amount: "7,000.00" });

      const forklift = (await transactions("forklift"))[0];
      assert.equal(forklift?.id, posted);
      assert.deepEqual(
        forklift?.match,
        { kind: "line", text: "Forklift rental" },
        "the matching line says why",
      );

      assert.deepEqual(
        (await ids("acme rental")).sort(),
        [posted, draft].sort(),
        "a party word and a line word combine",
      );
      assert.deepEqual(
        await ids("invoices over 7000"),
        [posted],
        "a scope and an amount bound combine",
      );
      assert.deepEqual(await ids("bills gravel"), [bill], "a scope keeps its own kinds");
      assert.deepEqual(await ids("open invoices"), [posted], "a status reads the lifecycle");
      assert.deepEqual(
        (await ids(org.date)).sort(),
        [posted, draft, bill].sort(),
        "a date reads the document date",
      );

      const parsed = await search("invoices over 7000");
      assert.deepEqual(
        parsed.chips?.map((chip) => chip.kind),
        ["scope", "amount"],
        "the response says how the query was read",
      );
      assert.ok(
        !parsed.groups.some((group) =>
          ["customer", "vendor", "employee", "contact"].includes(group.type),
        ),
        "an amount bound describes transactions only",
      );

      assert.deepEqual(
        await ids("rental", new Set([org.subsidiaryId])),
        [posted],
        "a restricted reader never sees another entity's document",
      );
      assert.deepEqual(await ids("crane", new Set([org.subsidiaryId])), []);
      assert.deepEqual(
        await ids("1500", new Set([org.subsidiaryId])),
        [],
        "nor finds it by amount",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
