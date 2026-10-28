/// <reference types="node" />

/**
 * Order-line progress quantities (fulfilled and billed) are stored to eight
 * decimal places, default to zero, and are exposed exactly and tenant-scoped
 * through the governed openbooks_query.document_lines view, so partial
 * fulfilment of fractional quantities never rounds away remaining work.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { runUserSql } from "@openbooks/engine/platform/sqlapi";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function insertOrderLine(
  org: ScratchOrg,
  lineNumber: number,
  progress: { fulfilled: string; billed: string } | null,
  documentId = randomUUID(),
): Promise<{ documentId: string; lineId: string }> {
  if (lineNumber === 1) {
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency)
      values (${documentId}, ${org.orgId}, 'sales_order', 'draft', ${`QTY-${documentId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${org.date}, 'CAD')`);
  }
  const lineId = randomUUID();
  if (progress) {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount,
         quantity_fulfilled, quantity_billed)
      values (${lineId}, ${org.orgId}, ${documentId}, ${lineNumber}, ${org.accounts.revenue},
              '2.00000001', '10', '20', ${progress.fulfilled}, ${progress.billed})`);
  } else {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount)
      values (${lineId}, ${org.orgId}, ${documentId}, ${lineNumber}, ${org.accounts.revenue},
              '3', '10', '30')`);
  }
  return { documentId, lineId };
}

test(
  "order-line progress quantities keep eight decimals in storage and the governed view",
  { skip: !DB, timeout: 60_000 },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const columns = await db.execute<{
        name: string;
        precision: number;
        scale: number;
        nullable: string;
        fallback: string | null;
      }>(
        sql`
      select column_name as name, numeric_precision as precision, numeric_scale as scale,
             is_nullable as nullable, column_default as fallback
        from information_schema.columns
       where table_schema = 'public' and table_name = 'document_lines'
         and column_name in ('quantity_fulfilled', 'quantity_billed')
       order by column_name`,
        "objects",
      );
      assert.deepEqual(
        columns.map(({ name, precision, scale, nullable }) => ({
          name,
          precision,
          scale,
          nullable,
        })),
        [
          { name: "quantity_billed", precision: 28, scale: 8, nullable: "NO" },
          { name: "quantity_fulfilled", precision: 28, scale: 8, nullable: "NO" },
        ],
      );
      for (const column of columns)
        assert.match(
          column.fallback ?? "",
          /^'?0'?(::numeric)?$/,
          `${column.name} defaults to zero`,
        );

      const exact = await insertOrderLine(org, 1, {
        fulfilled: "1.23456789",
        billed: "0.00000001",
      });
      const defaulted = await insertOrderLine(org, 2, null, exact.documentId);
      await insertOrderLine(otherOrg, 1, { fulfilled: "0.5", billed: "0.5" });

      const stored = await db.execute<{ id: string; fulfilled: string; billed: string }>(
        sql`
      select id, quantity_fulfilled::text as fulfilled, quantity_billed::text as billed
        from document_lines
       where org_id = ${org.orgId} and document_id = ${exact.documentId}
       order by line_number`,
        "objects",
      );
      assert.deepEqual(stored, [
        { id: exact.lineId, fulfilled: "1.23456789", billed: "0.00000001" },
        { id: defaulted.lineId, fulfilled: "0.00000000", billed: "0.00000000" },
      ]);

      const view = await db.execute<{ definition: string }>(
        sql`
      select pg_get_viewdef('openbooks_query.document_lines'::regclass, true) as definition`,
        "objects",
      );
      assert.match(
        view[0]!.definition,
        /openbooks_query_org_id\(\)/,
        "the governed view filters by the query tenant",
      );

      // Scoped to this test's order: a pooled organization may already hold other lines.
      const query = `select id::text as id, quantity_fulfilled::text as fulfilled, quantity_billed::text as billed
         from document_lines where document_id = '${exact.documentId}' order by line_number`;
      await assert.rejects(
        runUserSql(query, { orgId: org.orgId }),
        /payroll\.read/,
        "raw document lines retain their payroll permission requirement",
      );
      const governed = await runUserSql(query, {
        orgId: org.orgId,
        payrollRead: true,
        expenseRead: true,
      });
      assert.deepEqual(
        governed.rows,
        [
          { id: exact.lineId, fulfilled: "1.23456789", billed: "0.00000001" },
          { id: defaulted.lineId, fulfilled: "0.00000000", billed: "0.00000000" },
        ],
        "the governed view returns only the tenant's lines at full precision",
      );
    } finally {
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
