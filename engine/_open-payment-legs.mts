/**
 * Flag the AP/AR control leg of already-posted PAYMENT entries as is_open_item,
 * so the applications replay can use them as settlement sources (from_line).
 *
 * The vendor_payment/customer_payment rules now set isOpenItem on the AP/AR leg,
 * but the 4673 payments already in the ledger were posted before that fix, and
 * NetSuite "Journal" payments post via the journal pass-through rule (which can't
 * know which line is the settling leg). We backfill both here in place, under the
 * engine-sanctioned 'openbooks.amend' flag (the only field changed is
 * is_open_item — a metadata flag; balances/accounts are untouched).
 *
 * Reversible: re-run with --unset to clear the flags again.
 * Run:  tsx engine/_open-payment-legs.mts [--unset]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "./src/db.ts";

const UNSET = process.argv.includes("--unset");
const target = UNSET ? sql`false` : sql`true`;
const glDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extraction", "gl-dump");

// NetSuite tids that are the PAYING side of an application (payment_tid).
const links = JSON.parse(readFileSync(join(glDir, "applications.json"), "utf8")) as { payment_tid: string }[];
const payTids = [...new Set(links.map((l) => l.payment_tid))];
console.log(`payment tids from applications.json: ${payTids.length}`);

const inPay = sql.join(payTids.map((t) => sql`${t}`), sql`, `);

const res = await db.transaction(async (tx) => {
  await tx.execute(sql`set local openbooks.amend = 'on'`);
  // AP/AR-typed lines on vendor_payment / customer_payment docs, OR on journal
  // docs whose nsId is a NetSuite payment tid (journal-classified payments).
  const r = await tx.execute(sql`
    update journal_lines l
       set is_open_item = ${target}
      from journal_entries e, documents d, accounts a
     where l.entry_id = e.id
       and e.source_document_id = d.id
       and a.id = l.account_id
       and e.origin = 'document'
       and a.type in ('liability_payable', 'asset_receivable')
       and l.is_open_item = ${UNSET ? sql`true` : sql`false`}
       and (
         d.kind in ('vendor_payment', 'customer_payment')
         or (d.kind = 'journal' and d.custom->>'nsId' in (${inPay}))
       )`);
  return r;
});
console.log(`updated is_open_item=${UNSET ? "false" : "true"} on ${(res as any).rowCount ?? "?"} payment control lines`);
await pool.end();
process.exit(0);
