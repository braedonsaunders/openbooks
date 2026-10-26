import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

/**
 * AP aging with applied payments: a settled bill must drop out together with
 * the payment that relieved it, and a payment's UNAPPLIED remainder must age
 * as its own negative document — in the summary, the detail, and the vendor
 * statement header alike — so every view ties to the control account.
 *
 * Real case (vendor "Kevin Dumont", as of 2026-04-30): PAY-00008 (900,
 * Apr 22) applied in full to BILL-00011 (Dec, 900). The summary read
 * Current −600 + 900 + 900 + 1,800 = 3,000 — the applied payment survived
 * only as a −900 Current lump through the control residual while the
 * relieved bill dropped out — and the statement header read bills gross
 * 300 + 900 + 900 + 1,800 = 3,900 against its own −3,000 closing. Those
 * figures imply 1,800 paid against 900 applied: the fixture seeds PAY-00008
 * (900, applied in full to BILL-00011) plus an unapplied PAY-00009 (900).
 * Before the fix the summary showed the −600 Current bucket and the header
 * read 3,900; after it the remainder ages as its own −900 payment line and
 * every view reads 3,000.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const { db, withBypassContext, withOrgContext } =
  (await import("@openbooks/engine/platform/db")) as typeof import("@openbooks/engine/platform/db");
const { sql } = await import(root + "node_modules/drizzle-orm/index.js");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  (await import("@openbooks/engine/testing/fixtures")) as typeof import("@openbooks/engine/testing/fixtures");
const { requestDocumentVoid } =
  (await import("@openbooks/engine/ledger/document-void")) as typeof import("@openbooks/engine/ledger/document-void");
type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;
const { agingByParty, agingDetail } = (await import(
  root + "web/lib/reports/aging.ts"
)) as typeof import("./aging");
const { partyRegister, partnerStatement } = (await import(
  root + "web/lib/reports/registers.ts"
)) as typeof import("./registers");
const { postDocument } =
  (await import("@openbooks/engine/ledger/posting-document")) as typeof import("@openbooks/engine/ledger/posting-document");

const AS_OF = "2026-04-30";

async function addPeriod(
  org: ScratchOrg,
  year: number,
  month: number,
  first: string,
  last: string,
): Promise<void> {
  const cal = (
    await db.execute<{ id: string }>(
      sql`select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`,
      "objects",
    )
  )[0]!.id;
  await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
    values (${randomUUID()}, ${org.orgId}, ${cal}, ${year}, ${month}, ${first.slice(0, 7)}, ${first}, ${last}, false)
    on conflict do nothing`);
}

/** Native path: draft → approve → post through the posting kernel. */
async function postBill(
  org: ScratchOrg,
  number: string,
  date: string,
  due: string,
  amount: string,
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, due_date, currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${docId}, ${org.orgId}, 'vendor_bill', ${number}, ${org.vendorId}, ${org.subsidiaryId}, ${date}, ${date}, ${due}, 'CAD', 1, 'draft', ${amount}, '0', ${amount}, false, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed, custom, tax_overridden, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${docId}, 1, ${org.items.service}, ${org.accounts.cogs}, '1', ${amount}, ${amount}, '0', false, '0', '0', '{}'::jsonb, false, '{}'::jsonb)`);
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${docId} and org_id = ${org.orgId}`,
  );
  await postDocument(docId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return docId;
}

/** Native path: a vendor payment posts an open-item debit against AP control. */
async function postPayment(
  org: ScratchOrg,
  number: string,
  date: string,
  amount: string,
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${docId}, ${org.orgId}, 'vendor_payment', ${number}, ${org.vendorId}, ${org.subsidiaryId}, ${date}, ${date}, 'CAD', 1, 'draft', ${amount}, '0', ${amount}, false, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed, custom, tax_overridden, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${docId}, 1, ${org.items.service}, ${org.accounts.bank}, '1', ${amount}, ${amount}, '0', false, '0', '0', '{}'::jsonb, false, '{}'::jsonb)`);
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${docId} and org_id = ${org.orgId}`,
  );
  await postDocument(docId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return docId;
}

async function controlLegId(entryId: string, accountId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    sql`select id from journal_lines where entry_id = ${entryId} and account_id = ${accountId}`,
    "objects",
  );
  assert.ok(r[0], "expected the control leg to exist");
  return r[0]!.id;
}

/** Settlement link between the payment's and the bill's AP control legs. */
async function applyPayment(
  org: ScratchOrg,
  paymentDocId: string,
  billDocId: string,
  amount: string,
  appliedOn: string,
): Promise<void> {
  const pay = (
    await db.execute<{ posted_entry_id: string }>(
      sql`select posted_entry_id from documents where id = ${paymentDocId}`,
      "objects",
    )
  )[0]!;
  const bill = (
    await db.execute<{ posted_entry_id: string }>(
      sql`select posted_entry_id from documents where id = ${billDocId}`,
      "objects",
    )
  )[0]!;
  await db.execute(sql`insert into applications (org_id, from_line_id, to_line_id, amount, source_amount, applied_on,
      source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
      settlement_rate, settlement_rate_source, settlement_rate_reference)
    values (${org.orgId}, ${await controlLegId(pay.posted_entry_id, org.accounts.ap)}, ${await controlLegId(bill.posted_entry_id, org.accounts.ap)},
      ${amount}, ${amount}, ${appliedOn}, ${amount}, 'CAD', ${amount}, 'CAD', 1, 'same_currency', 'SETTLEMENT-PROBE')`);
}

async function glControl(org: ScratchOrg, asOf: string = AS_OF): Promise<string> {
  const r = await db.execute<{ bal: string }>(
    sql`select coalesce(sum(l.amount), 0)::text as bal from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed') and e.posting_date <= ${asOf} and e.book_id = ${org.bookId}
    where l.org_id = ${org.orgId} and l.account_id = ${org.accounts.ap}`,
    "objects",
  );
  return r[0]!.bal;
}

test(
  "AP aging nets a fully applied payment: no negative bucket, both views tie the control",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        await db.execute(
          sql`update parties set display_name = 'Kevin Dumont' where id = ${org.vendorId} and org_id = ${org.orgId}`,
        );
        for (const [y, m, first, last] of [
          [2025, 12, "2025-12-01", "2025-12-31"],
          [2026, 2, "2026-02-01", "2026-02-28"],
          [2026, 3, "2026-03-01", "2026-03-31"],
          [2026, 4, "2026-04-01", "2026-04-30"],
        ] as const) {
          await addPeriod(org, y, m, first, last);
        }
        const dec = await postBill(org, "BILL-00011", "2025-12-10", "2025-12-10", "900");
        await postBill(org, "BILL-CUR", "2026-04-10", "2026-05-10", "300");
        await postBill(org, "BILL-B1", "2026-04-01", "2026-04-10", "900");
        await postBill(org, "BILL-B2", "2026-03-01", "2026-03-15", "900");
        await postBill(org, "BILL-B3", "2026-02-01", "2026-02-15", "1800");
        const pay = await postPayment(org, "PAY-00008", "2026-04-22", "900");
        await applyPayment(org, pay, dec, "900.0000", "2026-04-22");
        await postPayment(org, "PAY-00009", "2026-04-25", "900");
      });
      await withOrgContext(org.orgId, async () => {
        assert.equal(
          await glControl(org),
          "-3000.0000",
          "control carries bills gross minus both payments",
        );
        const summary = await agingByParty("ap", AS_OF, undefined, org.orgId);
        assert.equal(summary.rows.length, 1);
        const row = summary.rows[0]!;
        assert.deepEqual(
          [row.current, row.b1, row.b2, row.b3, row.b4, row.total],
          ["300.0000", "0.0000", "900.0000", "1800.0000", "0.0000", "3000.0000"],
          "the unapplied remainder nets inside its own bucket; no bucket goes negative",
        );
        const detail = await agingDetail("ap", AS_OF, undefined, org.orgId);
        assert.deepEqual(detail.totals, summary.totals, "detail ties the summary");
        const refs = detail.rows.map((r) => [r.reference, r.docKind, r.bucket, r.open]);
        assert.ok(
          refs.some(
            (r) => r[0] === "PAY-00009" && r[1] === "vendor_payment" && r[3] === "-900.0000",
          ),
          `unapplied payment reads as its own negative line, got ${JSON.stringify(refs)}`,
        );
        assert.ok(
          !refs.some((r) => r[0] === "PAY-00008"),
          "fully applied payment drops out with the bill it relieved",
        );
        assert.ok(!refs.some((r) => r[0] === "BILL-00011"), "relieved bill drops out");
        const reg = await partyRegister("ap", { from: "2026-01-01", to: AS_OF, orgId: org.orgId });
        assert.equal(reg.parties.length, 1);
        assert.equal(reg.parties[0]!.closing, "-3000.0000", "register closing ties the control");
        const st = await partnerStatement(org.vendorId, org.orgId, {
          from: "2026-01-01",
          to: AS_OF,
          side: "ap",
        });
        assert.deepEqual(
          st.aging,
          detail.totals,
          "statement header ties the detail, not bills gross",
        );
        assert.equal(st.closing, "-3000.0000", "statement closing ties the control");
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "AP aging shows a partial application on both legs",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        for (const [y, m, first, last] of [
          [2026, 3, "2026-03-01", "2026-03-31"],
          [2026, 4, "2026-04-01", "2026-04-30"],
        ] as const) {
          await addPeriod(org, y, m, first, last);
        }
        const bill = await postBill(org, "BILL-PART", "2026-03-01", "2026-03-15", "900");
        const pay = await postPayment(org, "PAY-PART", "2026-04-22", "900");
        await applyPayment(org, pay, bill, "400.0000", "2026-04-22");
      });
      await withOrgContext(org.orgId, async () => {
        assert.equal(
          await glControl(org),
          "0.0000",
          "bill credit and payment debit net on the control",
        );
        const summary = await agingByParty("ap", AS_OF, undefined, org.orgId);
        assert.deepEqual(
          [
            summary.totals.current,
            summary.totals.b1,
            summary.totals.b2,
            summary.totals.b3,
            summary.totals.b4,
            summary.totals.total,
          ],
          ["0.0000", "-500.0000", "500.0000", "0.0000", "0.0000", "0.0000"],
          "bill keeps 500 open in its bucket, payment keeps its 500 remainder in its own",
        );
        const detail = await agingDetail("ap", AS_OF, undefined, org.orgId);
        assert.deepEqual(detail.totals, summary.totals);
        assert.deepEqual(detail.rows.map((r) => [r.reference, r.open]).sort(), [
          ["BILL-PART", "500.0000"],
          ["PAY-PART", "-500.0000"],
        ]);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "AP aging ignores an application dated after the as-of date",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        for (const [y, m, first, last] of [
          [2026, 3, "2026-03-01", "2026-03-31"],
          [2026, 4, "2026-04-01", "2026-04-30"],
          [2026, 5, "2026-05-01", "2026-05-31"],
        ] as const) {
          await addPeriod(org, y, m, first, last);
        }
        const bill = await postBill(org, "BILL-LATE", "2026-04-01", "2026-04-10", "900");
        const pay = await postPayment(org, "PAY-LATE", "2026-04-22", "900");
        await applyPayment(org, pay, bill, "900.0000", "2026-05-05");
      });
      await withOrgContext(org.orgId, async () => {
        // Control as of the date carries both the bill and the posted (but
        // unapplied) payment, which net to zero.
        assert.equal(await glControl(org), "0.0000");
        const summary = await agingByParty("ap", AS_OF, undefined, org.orgId);
        assert.deepEqual(
          [
            summary.totals.current,
            summary.totals.b1,
            summary.totals.b2,
            summary.totals.b3,
            summary.totals.b4,
            summary.totals.total,
          ],
          ["0.0000", "0.0000", "0.0000", "0.0000", "0.0000", "0.0000"],
          "bill fully open and payment fully unapplied net to zero as of the date",
        );
        const detail = await agingDetail("ap", AS_OF, undefined, org.orgId);
        assert.deepEqual(
          detail.rows.map((r) => [r.reference, r.bucket, r.open]).sort(),
          [
            ["BILL-LATE", "b1", "900.0000"],
            ["PAY-LATE", "b1", "-900.0000"],
          ],
          "bill still fully open as of the date, payment shown as unapplied credit",
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "AP aging clears a bill settled by a payment posted months later, as of the settlement date",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        await addPeriod(org, 2026, 1, "2026-01-01", "2026-01-31");
        await addPeriod(org, 2026, 5, "2026-05-01", "2026-05-31");
        const bill = await postBill(org, "BILL-SETTLED-LATE", "2026-01-25", "2026-02-24", "900");
        const pay = await postPayment(org, "PAY-SETTLED-LATE", "2026-05-25", "900");
        await applyPayment(org, pay, bill, "900.0000", "2026-05-25");
      });
      await withOrgContext(org.orgId, async () => {
        // The application and both AP legs settle on the payment date, so every
        // view as of 2026-05-31 reads the vendor at zero in every bucket.
        assert.equal(
          await glControl(org, "2026-05-31"),
          "0.0000",
          "control nets the bill and the payment",
        );
        const summary = await agingByParty("ap", "2026-05-31", undefined, org.orgId);
        assert.deepEqual(summary.rows, [], "a settled bill and its payment leave no vendor row");
        assert.deepEqual(
          [
            summary.totals.current,
            summary.totals.b1,
            summary.totals.b2,
            summary.totals.b3,
            summary.totals.b4,
            summary.totals.total,
          ],
          ["0.0000", "0.0000", "0.0000", "0.0000", "0.0000", "0.0000"],
        );
        const detail = await agingDetail("ap", "2026-05-31", undefined, org.orgId);
        assert.deepEqual(
          detail.rows,
          [],
          "neither the bill nor the payment appears as an open item",
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "AP aging drops a bill voided with a reversal dated back to its posting, and ties the control",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "AP aging void tester", "admin"),
      );
      const voidedId = await withBypassContext(async () => {
        await addPeriod(org, 2026, 1, "2026-01-01", "2026-01-31");
        await addPeriod(org, 2026, 2, "2026-02-01", "2026-02-28");
        const voided = await postBill(
          org,
          "BILL-VOIDED-BACKDATED",
          "2026-01-25",
          "2026-02-24",
          "900",
        );
        await postBill(org, "BILL-STILL-OPEN", "2026-02-01", "2026-02-15", "300");
        return voided;
      });
      // The void is recorded now (after the as-of date) but its reversal is
      // dated to the bill's posting. The ledger therefore carries the bill as
      // reversed as of 2026-05-31, and the aging must agree with that control.
      const voidResult = await withBypassContext(() =>
        requestDocumentVoid({
          documentId: voidedId,
          orgId: org.orgId,
          actorId,
          reason: "Duplicate bill entered in error",
          reversalDate: "2026-01-25",
          source: "api",
        }),
      );
      assert.equal(voidResult.status, "voided");
      await withOrgContext(org.orgId, async () => {
        assert.equal(
          await glControl(org, "2026-05-31"),
          "-300.0000",
          "control carries only the open bill",
        );
        const summary = await agingByParty("ap", "2026-05-31", undefined, org.orgId);
        assert.equal(summary.rows.length, 1);
        const row = summary.rows[0]!;
        assert.deepEqual(
          [row.current, row.b1, row.b2, row.b3, row.b4, row.total],
          ["0.0000", "0.0000", "0.0000", "0.0000", "300.0000", "300.0000"],
          "the voided bill ages nowhere; the summary carries no residual against the control",
        );
        const detail = await agingDetail("ap", "2026-05-31", undefined, org.orgId);
        assert.deepEqual(detail.totals, summary.totals, "detail ties the summary");
        assert.deepEqual(
          detail.rows.map((r) => r.reference),
          ["BILL-STILL-OPEN"],
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
