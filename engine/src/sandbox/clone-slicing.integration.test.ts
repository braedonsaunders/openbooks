import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { loadCatalog } from "./catalog.ts";
import { copyIsSliceable, STATEMENT_GROUP_SLICE_KEYS } from "./clone.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "every sliced clone table with a statement-level insert check slices by its group key",
  { skip: !DB },
  async () => {
    const statementChecked = await db.execute<{ table: string }>(
      sql`
      select distinct c.relname as table
        from pg_trigger tg
        join pg_class c on c.oid = tg.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not tg.tgisinternal
         and (tg.tgtype & 1) = 0 and (tg.tgtype & 4) <> 0
       order by c.relname`,
      "objects",
    );
    const catalog = await loadCatalog();
    const byName = new Map(catalog.tables.map((t) => [t.name, t]));
    const unsafe = statementChecked
      .map((row) => row.table)
      .filter((name) => {
        const t = byName.get(name);
        return t !== undefined && copyIsSliceable(t) && !(name in STATEMENT_GROUP_SLICE_KEYS);
      });
    assert.deepEqual(unsafe, []);
    assert.ok(statementChecked.some((row) => row.table === "journal_lines"));
  },
);

test(
  "a clone copied in small slices reproduces every balanced journal entry",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const previous = {
      chunk: process.env.OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS,
      duty: process.env.OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE,
    };
    process.env.OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS = "2";
    process.env.OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE = "1";
    let sandboxId: string | null = null;
    try {
      const userId = await createScratchUser(org.orgId, "Slice poster", "accountant");
      for (let n = 1; n <= 4; n += 1) {
        const invoiceId = randomUUID();
        await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`SLICE-${n}`},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                'CAD', '1', '100', '0', '100', ${userId})`);
        await db.execute(sql`insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '60', '60', '0', '0'),
               (${org.orgId}, ${invoiceId}, 2, ${org.accounts.revenue}, '1', '40', '40', '0', '0')`);
        await db.execute(
          sql`update documents set status='approved' where id=${invoiceId} and org_id=${org.orgId}`,
        );
        await postDocument(invoiceId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
      }
      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: `Slices ${randomUUID()}`,
        tier: "full",
        masked: false,
      });
      sandboxId = created.sandboxId;
      const counts = (
        await db.execute<{ source: number; clone: number; unbalanced: number }>(
          sql`
        select (select count(*)::int from journal_lines where org_id = ${org.orgId}) as source,
               (select count(*)::int from journal_lines where org_id = ${created.sandboxOrgId}) as clone,
               (select count(*)::int from (
                  select entry_id from journal_lines where org_id = ${created.sandboxOrgId}
                   group by entry_id having sum(amount) <> 0) e) as unbalanced`,
          "objects",
        )
      )[0]!;
      assert.ok(counts.source > 4, "the source must span more than one slice");
      assert.equal(counts.clone, counts.source);
      assert.equal(counts.unbalanced, 0);
    } finally {
      if (previous.chunk === undefined) delete process.env.OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS;
      else process.env.OPENBOOKS_SANDBOX_CLONE_CHUNK_ROWS = previous.chunk;
      if (previous.duty === undefined) delete process.env.OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE;
      else process.env.OPENBOOKS_SANDBOX_CLONE_DUTY_CYCLE = previous.duty;
      if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);
