import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { importStatement, listAccountStatements } from "./banking.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "listing returns every statement of a date as its own row, page by page",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`
        update accounts
           set reconcilable = true, currency_restriction = 'CAD'
         where id = ${org.accounts.bank} and org_id = ${org.orgId}
      `);
      const ctx = { orgId: org.orgId, userId: actor, allowedSubsidiaryIds: null };

      // Three separate imports dated the same day, each with distinct content.
      const importedIds: string[] = [];
      for (const description of ["Late deposit", "Late fee", "Late transfer"]) {
        const imported = await importStatement(
          {
            accountId: org.accounts.bank,
            source: "manual" as const,
            statementDate: org.date,
            currency: "CAD",
            lines: [{ postedOn: org.date, amount: "10.0000", description }],
          },
          ctx,
        );
        importedIds.push(imported.statementId!);
      }

      // Paging one row at a time reaches every same-date statement exactly once.
      const pagedIds: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const result = await listAccountStatements(
          org.accounts.bank,
          { sort: "date", dir: "desc", page, perPage: 1 },
          ctx,
        );
        assert.equal(result.total, 3, "the total counts every same-date statement");
        pagedIds.push(...result.rows.map((row) => row.id));
      }
      assert.deepEqual([...pagedIds].sort(), [...importedIds].sort());

      // Each row carries its own line counts and import timestamp; same-date
      // rows tie-break on import order, newest import first in descending order.
      const full = await listAccountStatements(
        org.accounts.bank,
        { sort: "date", dir: "desc", page: 1, perPage: 10 },
        ctx,
      );
      assert.deepEqual(
        full.rows.map((row) => row.id),
        [...importedIds].reverse(),
      );
      for (const row of full.rows) {
        assert.equal(row.statement_date, org.date);
        assert.equal(
          row.currency,
          "CAD",
          "the row derives currency from its imported statement lines",
        );
        assert.equal(row.line_count, 1);
        assert.equal(row.unmatched_count, 1);
        assert.ok(row.imported_at, "each statement carries its import timestamp");
      }

      // A source filter that matches none of them lists none.
      const csvOnly = await listAccountStatements(
        org.accounts.bank,
        { source: "csv", sort: "date", dir: "desc", page: 1, perPage: 10 },
        ctx,
      );
      assert.equal(csvOnly.total, 0);
      assert.deepEqual(csvOnly.rows, []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
