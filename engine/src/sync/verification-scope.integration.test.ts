import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";
import type { MigrationSource } from "./source.ts";
import { verifyCurrentLedgerState } from "./sync.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "connector verification isolates source-owned projection from native ledger activity",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "Projection Boundary Controller",
      "admin",
    );
    const sourceDocumentId = randomUUID();
    const sourceEntryId = randomUUID();
    const nativeEntryId = randomUUID();
    const trueUpEntryId = randomUUID();
    try {
      await db.execute(sql`
        update accounts
           set custom = jsonb_set(custom, '{projectionRef}', '"A"'::jsonb)
         where id = ${org.accounts.adjustment}
      `);
      await db.execute(sql`
        update accounts
           set custom = jsonb_set(custom, '{projectionRef}', '"B"'::jsonb)
         where id = ${org.accounts.clearing}
      `);
      await db.execute(sql`
        update accounting_periods
           set custom = jsonb_set(custom, '{projectionRef}', '"PERIOD-1"'::jsonb)
         where id = ${org.periodId}
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, posting_period_id, currency, fx_rate,
           status, subtotal, tax_total, total, custom, created_by, updated_by)
        values (
          ${sourceDocumentId}, ${org.orgId}, 'vendor_bill', 'SOURCE-OWNED-1',
          ${org.vendorId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
          ${org.periodId}, 'CAD', 1, 'approved', 100, 0, 100,
          '{"projectionRef":"transaction-1"}'::jsonb, ${actorId}, ${actorId}
        )
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, status, origin, source_document_id, created_by, updated_by)
        values
          (${sourceEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'SOURCE-OWNED-1', ${org.date}, ${org.periodId}, 'draft', 'migration',
           ${sourceDocumentId}, ${actorId}, ${actorId}),
          (${nativeEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'NATIVE-1', ${org.date}, ${org.periodId}, 'draft', 'document',
           null, ${actorId}, ${actorId}),
          (${trueUpEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'TRUEUP-1', ${org.date}, ${org.periodId}, 'draft', 'migration', null,
           ${actorId}, ${actorId})
      `);
      await db.execute(sql`
        update journal_entries
           set custom = ${JSON.stringify({
             sourceProjection: {
               kind: "connector_trueup",
               sourceName: "projection-source",
               refKey: "projectionRef",
               syncRunId: "run-1",
             },
           })}::jsonb
         where id = ${trueUpEntryId}
      `);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${sourceEntryId}, 1, ${org.accounts.adjustment},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, false),
          (${org.orgId}, ${sourceEntryId}, 2, ${org.accounts.clearing},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, false),
          (${org.orgId}, ${nativeEntryId}, 1, ${org.accounts.adjustment},
           ${org.subsidiaryId}, 30, 'CAD', 30, 1, false),
          (${org.orgId}, ${nativeEntryId}, 2, ${org.accounts.clearing},
           ${org.subsidiaryId}, -30, 'CAD', -30, 1, false),
          (${org.orgId}, ${trueUpEntryId}, 1, ${org.accounts.adjustment},
           ${org.subsidiaryId}, 5, 'CAD', 5, 1, false),
          (${org.orgId}, ${trueUpEntryId}, 2, ${org.accounts.clearing},
           ${org.subsidiaryId}, -5, 'CAD', -5, 1, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where id in (${sourceEntryId}, ${nativeEntryId}, ${trueUpEntryId})
      `);
      await db.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${sourceEntryId}
         where id = ${sourceDocumentId}
      `);

      const source = {
        name: "projection-source",
        refKey: "projectionRef",
        baseCurrency: "CAD",
        trialBalance: async () => [
          { accountRef: "A", balance: "105.0000" },
          { accountRef: "B", balance: "-105.0000" },
        ],
        monthlyActivity: async () => [
          {
            accountRef: "A",
            periodRef: "PERIOD-1",
            month: "2026-07",
            amount: "105.0000",
          },
          {
            accountRef: "B",
            periodRef: "PERIOD-1",
            month: "2026-07",
            amount: "-105.0000",
          },
        ],
      } as unknown as MigrationSource;

      const result = await verifyCurrentLedgerState(source, org.orgId);
      assert.deepEqual(result.tb, {
        accounts: 2,
        matches: 2,
        mismatches: [],
      });
      assert.deepEqual(result.periods, {
        checked: 2,
        matches: 2,
        mismatches: [],
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
