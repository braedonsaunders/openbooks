import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "./db.ts";
import { postDocument, PostingError, type PostingDeps } from "./posting.ts";
import { ensureReadRole, runUserSql } from "./sqlapi.ts";

/**
 * End-to-end demo on top of the replayed Rassaun data:
 *   1. install a user script (real JS) that vetoes big unexplained bills
 *      and auto-schedules payment 2 business days before due
 *   2. create a vendor bill → posting VETOED by the script
 *   3. add a memo → posting succeeds; script mutation applied; GL balanced
 *   4. query it all back through the SQL API (real SQL, read-only role)
 */

async function main() {
  const [org] = await db.select().from(schema.orgs);
  const orgId = org.id;

  const acct = async (like: string) => {
    const r = await db.execute(sql`select id, number, name from accounts
      where org_id=${orgId} and (name ilike ${"%" + like + "%"}) and is_summary=false and is_active order by number limit 1`);
    const row = (r as any).rows[0];
    if (!row) throw new Error(`no account like "${like}"`);
    return row as { id: string; number: string; name: string };
  };

  const ap = await acct("accounts payable");
  const expense = await acct("consumable");
  const vendor = (await db.execute(sql`select id, display_name from parties where custom->>'nsKind'='vendor' limit 1`) as any).rows[0];

  const deps: PostingDeps = { control: { ap: ap.id, ar: ap.id, bank: ap.id } };

  // -- 1. the user script --------------------------------------------------
  await db.delete(schema.scriptRuns).where(eq(schema.scriptRuns.orgId, orgId));
  await db.delete(schema.userScripts).where(eq(schema.userScripts.orgId, orgId));
  await db.insert(schema.userScripts).values({
    orgId,
    name: "AP policy: big bills need a memo; schedule payment",
    triggerPoint: "before_post",
    documentKind: "vendor_bill",
    source: `
      function main(ctx) {
        const total = Number(ctx.document.total);
        ob.log("checking bill", ctx.document.documentNumber, "total", total);
        if (total > 10000 && !ctx.document.memo) {
          ob.abort("bills over $10,000 require a memo explaining the purchase");
        }
        // schedule payment 2 days before due
        if (ctx.document.dueDate) {
          const d = new Date(ctx.document.dueDate + "T00:00:00Z");
          d.setUTCDate(d.getUTCDate() - 2);
          return { set: { expectedPayDate: d.toISOString().slice(0, 10) } };
        }
      }
    `,
  });

  // -- 2. a big bill with no memo ------------------------------------------
  const demoNumber = `OB-DEMO-${Date.now()}`;
  const [doc] = await db.insert(schema.documents).values({
    orgId,
    kind: "vendor_bill",
    documentNumber: demoNumber,
    partyId: vendor.id,
    documentDate: "2026-07-13",
    dueDate: "2026-08-12",
    currency: "CAD",
    subtotal: "25000.00",
    taxTotal: "0",
    total: "25000.00",
  }).returning();
  await db.insert(schema.documentLines).values({
    orgId, documentId: doc.id, lineNumber: 1,
    accountId: expense.id, description: "Demo: shop consumables bulk buy",
    quantity: "1", unitPrice: "25000.00", amount: "25000.00", taxAmount: "0",
  });

  console.log("== attempt 1: post $25k bill with no memo");
  try {
    await postDocument(doc.id, deps);
    console.log("  !! posted (should have been vetoed)");
  } catch (e) {
    if (e instanceof PostingError) console.log(`  VETOED as designed -> ${e.message}`);
    else throw e;
  }

  // -- 3. add the memo, post ------------------------------------------------
  await db.update(schema.documents).set({ memo: "Annual consumables stock-up, PO-4471, approved by KL" })
    .where(eq(schema.documents.id, doc.id));
  console.log("== attempt 2: post with memo");
  const entryId = await postDocument(doc.id, deps);
  const [posted] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
  console.log(`  POSTED -> journal entry ${entryId}`);
  console.log(`  script mutation applied: expectedPayDate=${posted.expectedPayDate} (due ${posted.dueDate})`);

  // -- 4. read it back through the SQL API ----------------------------------
  await ensureReadRole();
  console.log("== SQL API (real SQL, read-only role):");
  const q1 = await runUserSql(`
    select a.number, a.name, l.amount, l.is_open_item
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
     where e.entry_number = '${demoNumber}'
     order by l.line_number
  `);
  console.table(q1.rows);

  const q2 = await runUserSql(`
    select a.number, a.name, sum(l.amount) as balance
      from journal_lines l join accounts a on a.id = l.account_id
     group by 1, 2 order by abs(sum(l.amount)) desc limit 8
  `);
  console.log(`-- top balances across the replayed ledger (${q2.durationMs}ms):`);
  console.table(q2.rows);

  console.log("== write attempts through the SQL API are refused:");
  for (const evil of [
    "update documents set memo = 'pwned'",
    "select 1; drop table journal_lines",
  ]) {
    try {
      await runUserSql(evil);
      console.log(`  !! allowed: ${evil}`);
    } catch (e) {
      console.log(`  refused (${(e as Error).message}): ${evil.slice(0, 40)}`);
    }
  }
  // and even a SELECT that sneaks DML via CTE is stopped by the read-only txn+role
  try {
    await runUserSql("with x as (update documents set memo='h4x' returning 1) select * from x");
    console.log("  !! CTE write allowed");
  } catch (e) {
    console.log(`  refused by Postgres itself: CTE write -> ${(e as Error).message.slice(0, 60)}`);
  }

  const runs = await db.execute(sql`select status, error_message, logs from script_runs order by at desc limit 3`);
  console.log("== script_runs audit:");
  for (const r of (runs as any).rows) console.log(` ${r.status} ${r.error_message ?? ""} logs=${JSON.stringify(r.logs)}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
