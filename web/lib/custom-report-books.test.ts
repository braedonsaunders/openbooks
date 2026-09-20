import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ReportCustomQuery, ReportRuleGroup } from "@openbooks/reports";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export function redirect(){throw new Error(\"redirect\")};export function useRouter(){throw new Error(\"no router\")}",
      };
    }
    if (specifier === "next/headers") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function headers(){throw new Error(\"no headers\")};export async function cookies(){throw new Error(\"no cookies\")}",
      };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function getTranslations(){return (key)=>key};export async function getLocale(){return 'en'}",
      };
    }
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, env, pool, withBypass, withOrg, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { REPORT_ENTITY_MAP } = await import("@openbooks/reports");
const { runCustomQuery } = await import("@openbooks/reports");
const { resolveCustomReportBookScope } = await import("./custom-reports.ts");

const postedRevenueFilter = (extra: ReportRuleGroup["rules"] = []): ReportRuleGroup => ({
  combinator: "and",
  rules: [
    { field: "entry_status", op: "eq", value: "posted" },
    { field: "entry_number", op: "contains", value: "BOOKTEST-GL" },
    ...extra,
  ],
});

test("custom ledger reports default to the primary book and keep explicit cross-book analysis", { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg());
  const taxBookId = randomUUID();
  try {
    // No first-row fallback: zero or several active primaries throw. Runs on
    // the pristine org (before postings) because the ledger itself refuses
    // primary reassignment once journal history exists. Writes and reads
    // alternate as separate top-level contexts so every read observes
    // committed state.
    const unscopedPlan: ReportCustomQuery = { entity: "ledger_lines", mode: "rows", columns: ["amount"] };
    const resolveDefault = () =>
      withOrg(scratch.orgId, () => resolveCustomReportBookScope(scratch.orgId, unscopedPlan));
    assert.deepEqual(await resolveDefault(), [scratch.bookId]);
    const extraPrimary = randomUUID();
    await withBypass(() => db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${extraPrimary}, ${scratch.orgId}, 'ALT', 'Alternate', true, true, true)`));
    await assert.rejects(resolveDefault(), /exactly one active primary/);
    await withBypass(() => db.execute(sql`delete from accounting_books where id = ${extraPrimary}`));
    await withBypass(() => db.execute(sql`
      update accounting_books set is_primary = false where org_id = ${scratch.orgId}`));
    await assert.rejects(resolveDefault(), /exactly one active primary/);
    await withBypass(() => db.execute(sql`
      update accounting_books set is_primary = true where id = ${scratch.bookId}`));
    assert.deepEqual(await resolveDefault(), [scratch.bookId]);

    await withBypass(async () => {
      await db.execute(sql`
        insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${taxBookId}, ${scratch.orgId}, 'TAX', 'Tax book', false, true, true)`);
      const postRevenue = async (bookId: string, amount: string, tag: string) => {
        const entryId = randomUUID();
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin, posted_at)
          values
            (${entryId}, ${scratch.orgId}, ${bookId}, ${scratch.subsidiaryId},
             ${"BOOKTEST-GL-" + tag}, ${scratch.date}, ${scratch.periodId},
             ${tag}, 'draft', 'manual', null)`);
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank},
             ${scratch.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
            (${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.revenue},
             ${scratch.subsidiaryId}, ${"-" + amount}, 'CAD', ${"-" + amount}, '1')`);
        await db.execute(sql`
          update journal_entries set status = 'posted', posted_at = now()
           where id = ${entryId}`);
      };
      await postRevenue(scratch.bookId, "100.0000", "PRIMARY");
      await postRevenue(taxBookId, "250.0000", "TAX");

      const postInvoice = async (currency: string, total: string) => {
        const docId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, document_date, currency, status,
             subtotal, tax_total, total, subsidiary_id)
          values
            (${docId}, ${scratch.orgId}, 'customer_invoice', ${"BOOKTEST-FX-" + currency},
             ${scratch.date}, ${currency}, 'draft', ${total}, '0', ${total}, ${scratch.subsidiaryId})`);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity, unit_price, amount)
          values
            (${scratch.orgId}, ${docId}, 1, ${scratch.accounts.revenue}, '1', ${total}, ${total})`);
      };
      await postInvoice("USD", "100.0000");
      await postInvoice("EUR", "200.0000");
    });

    await withOrgContext(scratch.orgId, async () => {
      const books = await db.execute<{ id: string; name: string }>(sql`
        select id, name from accounting_books where org_id = ${scratch.orgId} and is_active`);
      const primaryName = books.rows.find((b) => b.id === scratch.bookId)!.name;

      const defaultPlan: ReportCustomQuery = {
        entity: "ledger_lines",
        mode: "summarize",
        columns: [],
        breakouts: [{ column: "account_number" }],
        measures: [{ fn: "sum", column: "amount" }],
        filters: postedRevenueFilter(),
        limit: 1000,
      };

      // Default resolves the authoritative primary — exactly one row, no fallback.
      assert.deepEqual(await resolveCustomReportBookScope(scratch.orgId, defaultPlan), [scratch.bookId]);

      // Explicit book scoping (filter or breakout) runs unclamped instead.
      const taxPlan: ReportCustomQuery = {
        ...defaultPlan,
        filters: postedRevenueFilter([{ field: "book_id", op: "eq", value: taxBookId }]),
      };
      assert.equal(await resolveCustomReportBookScope(scratch.orgId, taxPlan), null);
      const groupedPlan: ReportCustomQuery = {
        ...defaultPlan,
        breakouts: [{ column: "book" }],
        measures: [{ fn: "sum", column: "debit" }],
      };
      assert.equal(await resolveCustomReportBookScope(scratch.orgId, groupedPlan), null);
      // Book-independent sources are never clamped.
      const documentsPlan: ReportCustomQuery = { entity: "documents", mode: "rows", columns: ["total"] };
      assert.equal(
        await resolveCustomReportBookScope(scratch.orgId, documentsPlan),
        undefined,
      );

      // Default run reads the primary book only (not the fused -350).
      const runDefault = await runCustomQuery(pool, defaultPlan, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
        allowedBookIds: await resolveCustomReportBookScope(scratch.orgId, defaultPlan),
      });
      assert.deepEqual(
        runDefault.groups[0]!.rows.map((r) => r[1]).sort(),
        ["-100.0000", "100.0000"],
      );

      // Explicit TAX filter reads the tax book only; the saved filter is kept verbatim.
      const runTax = await runCustomQuery(pool, taxPlan, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
        allowedBookIds: await resolveCustomReportBookScope(scratch.orgId, taxPlan),
      });
      assert.deepEqual(
        runTax.groups[0]!.rows.map((r) => r[1]).sort(),
        ["-250.0000", "250.0000"],
      );

      // Intentional cross-book grouping labels every book.
      const runGrouped = await runCustomQuery(pool, groupedPlan, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
        allowedBookIds: await resolveCustomReportBookScope(scratch.orgId, groupedPlan),
      });
      assert.deepEqual(
        new Map(runGrouped.groups[0]!.rows.map((r) => [r[0], r[1]])),
        new Map([[primaryName, "100.0000"], ["Tax book", "250.0000"]]),
      );

      // Display names are not unique: a shared label cannot combine books.
      await db.execute(sql`update accounting_books set name = ${primaryName} where id = ${taxBookId}`);
      await assert.rejects(runCustomQuery(pool, groupedPlan, {
        orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP, allowedBookIds: null,
      }), /mix accounting books/);
      const byCode = await runCustomQuery(pool, { ...groupedPlan, breakouts: [{ column: "book_code" }] }, {
        orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP, allowedBookIds: null,
      });
      assert.equal(byCode.rowCount, 2);
      await db.execute(sql`update accounting_books set name = 'Tax book' where id = ${taxBookId}`);

      // A foreign book id matches nothing — empty, never another org's data, never an error.
      const runForeign = await runCustomQuery(pool, {
        ...defaultPlan,
        filters: postedRevenueFilter([{ field: "book_id", op: "eq", value: randomUUID() }]),
      }, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
        allowedBookIds: null,
      });
      assert.equal(runForeign.rowCount, 0);

      // Mixed-currency line sums group honestly per currency with no mixed Total card.
      const fxGrouped: ReportCustomQuery = {
        entity: "transaction_lines",
        mode: "summarize",
        columns: [],
        breakouts: [{ column: "currency" }],
        measures: [{ fn: "sum", column: "amount" }],
        filters: {
          combinator: "and",
          rules: [{ field: "document_number", op: "contains", value: "BOOKTEST-FX" }],
        },
        limit: 1000,
      };
      const runFx = await runCustomQuery(pool, fxGrouped, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
      });
      assert.deepEqual(
        new Map(runFx.groups[0]!.rows.map((r) => [r[0], r[1]])),
        new Map([["EUR", "200.0000"], ["USD", "100.0000"]]),
      );
      assert.deepEqual(runFx.summary.map((s) => s.label), ["Groups"]);
      // Ungrouped, the same sum fails closed instead of adding USD + EUR.
      await assert.rejects(
        runCustomQuery(pool, { ...fxGrouped, breakouts: [{ column: "kind" }] }, {
          orgId: scratch.orgId,
          entityMap: REPORT_ENTITY_MAP,
        }),
        /mix transaction currencies/,
      );
      // Pinned to one currency, the total is honest again.
      const runFxPinned = await runCustomQuery(pool, {
        ...fxGrouped,
        filters: {
          combinator: "and",
          rules: [
            { field: "document_number", op: "contains", value: "BOOKTEST-FX" },
            { field: "currency", op: "eq", value: "USD" },
          ],
        },
      }, {
        orgId: scratch.orgId,
        entityMap: REPORT_ENTITY_MAP,
      });
      assert.deepEqual(
        runFxPinned.groups[0]!.rows.map((r) => r[1]),
        ["100.0000"],
      );
      assert.ok(runFxPinned.summary.some((s) => s.label.startsWith("Total")));

      // One book can still contain different subsidiary functional currencies.
      const childId = randomUUID();
      await db.execute(sql`insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country)
        values (${childId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'USD subsidiary', 'USD', 'US')`);
      const entryId = randomUUID();
      await db.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryId}, ${scratch.orgId}, ${scratch.bookId}, ${childId},
          'BOOKTEST-GL-USD', ${scratch.date}, ${scratch.periodId}, 'draft', 'manual')`);
      await db.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${scratch.orgId}, ${entryId}, 1, ${scratch.accounts.bank}, ${childId}, '100', 'USD', '100', '1'),
          (${scratch.orgId}, ${entryId}, 2, ${scratch.accounts.revenue}, ${childId}, '-100', 'USD', '-100', '1')`);
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
      const primaryScope = { orgId: scratch.orgId, entityMap: REPORT_ENTITY_MAP, allowedBookIds: [scratch.bookId] };
      await assert.rejects(runCustomQuery(pool, defaultPlan, primaryScope), /functional currencies/);
      let statements = 0;
      const sameSnapshot = { query: async (text: string, values?: unknown[]) => {
        statements++;
        assert.match(text, /^WITH __denom AS/);
        return pool.query(text, values);
      } };
      const bases = await runCustomQuery(sameSnapshot, { ...defaultPlan,
        breakouts: [{ column: 'base_currency' }], measures: [{ fn: 'sum', column: 'debit' }],
      }, primaryScope);
      assert.equal(statements, 1, 'census and financial result use one PostgreSQL snapshot');
      assert.deepEqual(new Map(bases.groups[0]!.rows.map((row) => [row[0], row[1]])),
        new Map([['CAD', '100.0000'], ['USD', '100.0000']]));
      assert.deepEqual(bases.summary.map((item) => item.label), ['Groups']);
      const singleEntity = await runCustomQuery(pool, defaultPlan, {
        ...primaryScope, allowedSubsidiaryIds: [scratch.subsidiaryId],
      });
      assert.deepEqual(singleEntity.groups[0]!.rows.map((row) => row[1]).sort(), ['-100.0000', '100.0000']);

    });
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});
