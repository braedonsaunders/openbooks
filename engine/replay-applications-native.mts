/**
 * STEP 3.4 — replay NetSuite payment applications onto the NATIVE ledger.
 *
 * Mirrors engine/src/replay-applications.ts, but resolves each transaction's
 * open AP/AR control line from the NATIVE import (origin='document', joined to
 * documents via source_document_id → documents.custom->>'nsId' = NS tid)
 * instead of the origin='migration' shortcut entries.
 *
 * Each NetSuite link ties a payment/credit transaction to a bill/invoice it
 * settled. We map both sides to their posted entry's open control line and
 * insert one application per (payment, applied) pair, capped in-memory so the
 * kernel's app_check_open trigger just agrees. Genuine NetSuite
 * over-applications (the FY2025 rounding anomalies) are reported, not forced.
 *
 * Idempotent-ish: run once on a freshly reset+imported ledger. Run:
 *   node_modules/.bin/tsx engine/replay-applications-native.mts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./src/db.ts";
import { fromUnits, toUnits } from "./src/money.ts";

const dumpDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extraction", "gl-dump");

interface Link { payment_tid: string; applied_tid: string; amount: string }

const links = JSON.parse(readFileSync(join(dumpDir, "applications.json"), "utf8")) as Link[];

// aggregate by (payment, applied)
const byPair = new Map<string, bigint>();
for (const l of links) {
  const key = `${l.payment_tid}|${l.applied_tid}`;
  byPair.set(key, (byPair.get(key) ?? 0n) + toUnits(l.amount));
}
console.log(`links: ${links.length}, aggregated pairs: ${byPair.size}`);

// tid -> its open control lines (AP/AR) with capacity, from the NATIVE ledger.
const rows = (await db.execute(sql`
  select d.custom->>'nsId' as tid, l.id as open_line_id, e.posting_date, l.line_number, abs(l.amount) as amt
    from journal_entries e
    join documents d on d.id = e.source_document_id
    join journal_lines l on l.entry_id = e.id and l.is_open_item
    join accounts a on a.id = l.account_id
   where e.origin = 'document'
     and a.type in ('liability_payable', 'asset_receivable')
     and d.custom->>'nsId' is not null`)).rows as any[];

interface OpenLine { lineId: string; remaining: bigint; date: string; lineNo: number }
const linesByTid = new Map<string, OpenLine[]>();
for (const r of rows) {
  const arr = linesByTid.get(r.tid) ?? [];
  arr.push({ lineId: r.open_line_id, remaining: toUnits(r.amt), date: r.posting_date, lineNo: r.line_number });
  linesByTid.set(r.tid, arr);
}
for (const arr of linesByTid.values()) arr.sort((a, b) => a.lineNo - b.lineNo);
console.log(`native open control lines across ${linesByTid.size} transactions`);

const [org] = await db.select().from(schema.orgs);
const orgId = org.id;

const toInsert: [string, string, bigint, string][] = []; // from, to, amount, date
let skippedNoLine = 0;
let unallocated = 0n;

for (const [key, amountUnits] of byPair) {
  if (amountUnits <= 0n) continue;
  const [paymentTid, appliedTid] = key.split("|");
  const payLines = linesByTid.get(paymentTid!);
  const appLines = linesByTid.get(appliedTid!);
  if (!payLines || !appLines) { skippedNoLine++; continue; }
  let remaining = amountUnits, pi = 0, ai = 0;
  while (remaining > 0n && pi < payLines.length && ai < appLines.length) {
    const alloc = [remaining, payLines[pi]!.remaining, appLines[ai]!.remaining].reduce((a, b) => (b < a ? b : a));
    if (alloc <= 0n) { if (payLines[pi]!.remaining <= 0n) pi++; else ai++; continue; }
    toInsert.push([payLines[pi]!.lineId, appLines[ai]!.lineId, alloc, payLines[pi]!.date]);
    payLines[pi]!.remaining -= alloc;
    appLines[ai]!.remaining -= alloc;
    remaining -= alloc;
    if (payLines[pi]!.remaining <= 0n) pi++;
    if (appLines[ai]!.remaining <= 0n) ai++;
  }
  unallocated += remaining;
}

const client = await pool.connect();
let inserted = 0;
try {
  await client.query("begin");
  for (let i = 0; i < toInsert.length; i += 1000) {
    const chunk = toInsert.slice(i, i + 1000);
    const values: string[] = [];
    const params: unknown[] = [orgId];
    chunk.forEach((row) => {
      const b = params.length;
      params.push(row[0], row[1], fromUnits(row[2]), row[3]);
      values.push(`($1, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    });
    await client.query(
      `insert into applications (org_id, from_line_id, to_line_id, amount, applied_on) values ${values.join(",")}`,
      params,
    );
    inserted += chunk.length;
  }
  await client.query("commit");
} catch (e) {
  await client.query("rollback");
  throw e;
} finally {
  client.release();
}

console.log(
  `DONE: ${inserted} applications inserted across ${byPair.size} txn pairs; ` +
    `${skippedNoLine} pairs skipped (no mapped native line); ` +
    `${fromUnits(unallocated)} of applied amount unallocated (exceeds reconstructed line capacity).`,
);
await pool.end();
