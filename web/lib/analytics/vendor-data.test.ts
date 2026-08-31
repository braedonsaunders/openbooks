import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {}", format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { vendorData } = await import("./vendor-data.ts");
hooks.deregister();

const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { postDocument } = await import("@openbooks/engine/src/posting.ts");
const {
  createPaymentDocument,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
} = await import("@openbooks/engine/src/payments.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("vendor payment analytics counts an installment bill once and uses final settlement", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const billId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, subsidiary_id,
           document_date, posting_date, due_date, currency, fx_rate, subtotal,
           tax_total, total, custom)
        values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', 'ANALYTICS-INSTALLMENT-1',
                ${org.vendorId}, ${org.subsidiaryId}, '2026-07-15', '2026-07-15',
                '2026-07-20', 'CAD', '1', '100', '0', '100', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount)
        values (${randomUUID()}, ${org.orgId}, ${billId}, 1, ${org.accounts.cogs},
                '1', '100', '100', '0')`);
      await db.execute(sql`
        update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    });

    const billEntryId = await withBypass(() => postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }, { deferEffects: true, suppressAutomation: true }));
    const targetLineId = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from journal_lines
       where org_id = ${org.orgId} and entry_id = ${billEntryId}
         and account_id = ${org.accounts.ap} and is_open_item
    `))).rows[0]?.id;
    assert.ok(targetLineId, "posted bill must have an AP open-item line");
    const payableLineId: string = targetLineId;

    const postInstallment = async (documentDate: string, amount: string): Promise<void> => {
      const payment = await withBypass(() => createPaymentDocument({
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: null,
        partyId: org.vendorId,
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        documentDate,
        currency: "CAD",
      }));
      await withBypass(() => updateDraftPayment(
        payment.id,
        {
          allocations: [sameCurrencyAllocation(payableLineId, amount)],
          bankAccountId: org.accounts.bank,
        },
        null,
        org.orgId,
      ));
      await withBypass(() => db.execute(sql`
        update documents set status = 'approved' where id = ${payment.id} and org_id = ${org.orgId}`));
      await withBypass(() => postPaymentWithApplications(payment.id, undefined, undefined));
    };

    await postInstallment("2026-07-19", "40");
    await postInstallment("2026-07-25", "60");

    const data = await withOrgContext(org.orgId, () => vendorData(
      { from: "2026-07-01", to: "2026-07-31", label: "July 2026" },
      org.orgId,
    ));
    const row = data.rows.find((candidate) => candidate.id === org.vendorId);
    assert.ok(row, "vendor payment row should be present in the spend window");
    assert.equal(row.paidBills, 1, "two installments must count as one paid bill");
    assert.equal(row.avgDaysToPay, 5, "average days must use the final payment date (July 25 − July 20)");
    assert.equal(row.onTimePct, 0, "a bill whose final installment is late is not on time");
    assert.equal(row.lateSpend, 60, "late spend must retain the late installment amount");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
interface SqlQuery {
  text: string;
  values: unknown[];
}

interface VendorFixture {
  partyId: string;
  postingDate: string;
  status: "posted" | "draft";
}

interface VendorDataTestState {
  bills: VendorFixture[];
  queries: SqlQuery[];
}

const periodStateKey = Symbol.for("openbooks.vendor-data-test");
const periodState: VendorDataTestState = { bills: [], queries: [] };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[periodStateKey] = periodState;

const periodMockSources = new Map<string, string>([
  [
    "mock:drizzle-orm",
    `
      export function sql(strings, ...values) {
        return { text: strings.join('?'), values }
      }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday() {
        return '2024-03-31'
      }
    `,
  ],
  [
    "mock:db",
    `
      const periodState = globalThis[Symbol.for('openbooks.vendor-data-test')]

      function billRows(query) {
        const values = query.values
        const from = query.text.includes('posting_date >= ?') ? values[1] : null
        const ref = values[2] ?? values[1]
        const selected = periodState.bills.filter((bill) =>
          bill.status === 'posted' &&
          (from === null || bill.postingDate >= from) &&
          bill.postingDate <= ref,
        )
        const byParty = new Map()
        for (const bill of selected) {
          const row = byParty.get(bill.partyId) ?? { id: bill.partyId, bills: 0, last_bill: null }
          row.bills += 1
          if (row.last_bill === null || bill.postingDate > row.last_bill) row.last_bill = bill.postingDate
          byParty.set(bill.partyId, row)
        }
        return [...byParty.values()]
      }

      export const db = {
        async execute(query) {
          periodState.queries.push(query)
          if (query.text.includes('from documents')) return { rows: billRows(query) }
          if (query.text.includes('from ew e')) {
            if (query.text.includes('to_char(e.posting_date')) return { rows: [] }
            return {
              rows: [
                { id: 'vendor-with-bills', name: 'Vendor With Bills', spend: '300', prior_spend: '0' },
                { id: 'vendor-without-bills', name: 'Vendor Without Bills', spend: '120', prior_spend: '0' },
              ],
            }
          }
          if (query.text.includes('from applications')) return { rows: [] }
          throw new Error('unexpected vendor data query: ' + query.text)
        },
      }
    `,
  ],
]);

const periodHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {}", format: "module", shortCircuit: true };
    }
    const mockUrl = new Map([
      ["drizzle-orm", "mock:drizzle-orm"],
      ["@openbooks/engine/src/business-date.ts", "mock:business-date"],
      ["@openbooks/engine/src/db.ts", "mock:db"],
    ]).get(specifier);
    if (mockUrl) return { url: mockUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = periodMockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { vendorData: periodVendorData } = await import("./vendor-data.ts") as typeof import("./vendor-data.ts");
periodHooks.deregister();

test("vendor performance counts only bills inside the selected period", async () => {
  periodState.bills = [
    { partyId: "vendor-with-bills", postingDate: "2023-12-31", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-01-15", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-03-20", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-04-01", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-02-01", status: "draft" },
  ];
  periodState.queries = [];

  const result = await periodVendorData(
    { from: "2024-01-01", to: "2024-03-31", label: "Q1 2024" },
    "org-1",
  );

  const withBills = result.rows.find((row) => row.id === "vendor-with-bills");
  const withoutBills = result.rows.find((row) => row.id === "vendor-without-bills");
  assert.ok(withBills);
  assert.ok(withoutBills);
  assert.equal(withBills.bills, 2);
  assert.equal(withBills.avgBill, 150);
  assert.equal(withBills.lastBill, "2024-03-20");
  assert.equal(withoutBills.bills, 0);
  assert.equal(withoutBills.avgBill, 0);
  assert.equal(withoutBills.lastBill, null);
  assert.equal(result.totals.bills, 2);
  assert.equal(result.totals.avgBill, 210);

  const billQuery = periodState.queries.find((query) => query.text.includes("from documents"));
  assert.ok(billQuery);
  assert.match(billQuery.text, /posting_date >= \?/);
  assert.match(billQuery.text, /posting_date <= \?/);
});
