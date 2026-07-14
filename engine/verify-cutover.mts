/**
 * STEP 4 — verify the native cutover.
 *
 *  1. Live trial balance from the NEW native postings (sum(amount) by account,
 *     status='posted', origin='document') diffed vs gl-dump/tb-netsuite.json
 *     per account → accounts reconciling (of 262) + total abs delta.
 *  2. Every posted entry balances (sum=0) → count of unbalanced entries.
 *  3. Overall ledger Σ(amount)=0.
 *
 * Writes extraction/cutover-verification.json + prints a summary.
 * Run: node_modules/.bin/tsx engine/verify-cutover.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "./src/db.ts";
import { fromUnits, toUnits } from "./src/money.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extraction");
const glDir = join(root, "gl-dump");

// -- account nsId map ---------------------------------------------------------
const acctInfoById = new Map<string, { number: string; name: string; ns: string }>();
for (const r of (await db.execute(sql`
  select id, number, name, custom->>'nsId' ns from accounts where custom->>'nsId' is not null`)).rows as any[])
  acctInfoById.set(r.id, { number: r.number, name: r.name, ns: r.ns });

// -- 1. live TB from native postings -----------------------------------------
const tbRows = (await db.execute(sql`
  select l.account_id, sum(l.amount)::text bal
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
   where e.status = 'posted' and e.origin = 'document'
   group by l.account_id`)).rows as any[];
const ourByNs = new Map<string, bigint>();
for (const r of tbRows) {
  const info = acctInfoById.get(r.account_id);
  if (!info) continue;
  ourByNs.set(info.ns, (ourByNs.get(info.ns) ?? 0n) + toUnits(r.bal));
}

// -- NetSuite TB ground truth -------------------------------------------------
const nsRaw = JSON.parse(readFileSync(join(glDir, "tb-netsuite.json"), "utf8")) as { acct?: string; d: string; c: string }[];
const nsTb = new Map<string, bigint>();
for (const r of nsRaw) { if (!r.acct) continue; nsTb.set(String(r.acct), toUnits(r.d) - toUnits(r.c)); }

const allNs = new Set<string>([...nsTb.keys(), ...ourByNs.keys()]);
let matched = 0;
let totalAbsDelta = 0n;
const mismatches: { ns: string; number: string; name: string; ours: string; ns_bal: string; delta: string }[] = [];
for (const ns of allNs) {
  const ours = ourByNs.get(ns) ?? 0n;
  const theirs = nsTb.get(ns) ?? 0n;
  const delta = ours - theirs;
  const absd = delta < 0n ? -delta : delta;
  if (absd <= 100n) matched++;
  else {
    // resolve name
    let number = "?", name = `ns:${ns}`;
    for (const info of acctInfoById.values()) if (info.ns === ns) { number = info.number; name = info.name; break; }
    mismatches.push({ ns, number, name, ours: fromUnits(ours), ns_bal: fromUnits(theirs), delta: fromUnits(delta) });
    totalAbsDelta += absd;
  }
}
mismatches.sort((a, b) => {
  const da = toUnits(a.delta) < 0n ? -toUnits(a.delta) : toUnits(a.delta);
  const db_ = toUnits(b.delta) < 0n ? -toUnits(b.delta) : toUnits(b.delta);
  return db_ > da ? 1 : db_ < da ? -1 : 0;
});

// -- 2. per-entry balance -----------------------------------------------------
const unbalanced = (await db.execute(sql`
  select e.id, e.entry_number, sum(l.amount)::text s
    from journal_entries e join journal_lines l on l.entry_id = e.id
   where e.status='posted' and e.origin='document'
   group by e.id, e.entry_number
  having sum(l.amount) <> 0
   limit 25`)).rows as any[];

// -- 3. overall Σ -------------------------------------------------------------
const [{ total }] = (await db.execute(sql`
  select coalesce(sum(l.amount),0)::text total from journal_lines l
    join journal_entries e on e.id=l.entry_id where e.status='posted' and e.origin='document'`)).rows as any[];

// -- counts -------------------------------------------------------------------
const [{ entries }] = (await db.execute(sql`select count(*)::int entries from journal_entries where origin='document' and status='posted'`)).rows as any[];
const [{ jlines }] = (await db.execute(sql`select count(*)::int jlines from journal_lines l join journal_entries e on e.id=l.entry_id where e.origin='document'`)).rows as any[];
const docCounts = (await db.execute(sql`select kind, count(*)::int n from documents where custom->>'nsId' is not null group by kind order by n desc`)).rows as any[];
const [{ dlines }] = (await db.execute(sql`select count(*)::int dlines from document_lines`)).rows as any[];
const [{ apps }] = (await db.execute(sql`select count(*)::int apps from applications`)).rows as any[];
const [{ overr }] = (await db.execute(sql`select count(*)::int overr from document_lines where tax_overridden`)).rows as any[];
const [{ overdocs }] = (await db.execute(sql`select count(distinct document_id)::int overdocs from document_lines where tax_overridden`)).rows as any[];

const report = {
  generatedAt: new Date().toISOString(),
  ledger: {
    postedNativeEntries: entries,
    journalLines: jlines,
    documentsByKind: Object.fromEntries(docCounts.map((r) => [r.kind, r.n])),
    documentLines: dlines,
    applications: apps,
    taxOverriddenLines: overr,
    taxOverriddenDocuments: overdocs,
  },
  balance: {
    overallSum: total,
    unbalancedEntries: unbalanced.length,
    unbalancedSample: unbalanced.map((u) => ({ entry: u.entry_number, sum: u.s })),
  },
  trialBalance: {
    accountsCompared: allNs.size,
    matchedWithin1Cent: matched,
    mismatched: mismatches.length,
    totalAbsoluteDelta: fromUnits(totalAbsDelta),
    mismatches: mismatches.slice(0, 30),
  },
};
writeFileSync(join(root, "cutover-verification.json"), JSON.stringify(report, null, 2));

console.log("\n============ CUTOVER VERIFICATION ============");
console.log(`native posted entries: ${entries}   journal lines: ${jlines}   applications: ${apps}`);
console.log(`document lines: ${dlines}   tax-overridden lines: ${overr} (in ${overdocs} docs)`);
console.log(`\noverall Σ(amount) = ${total}   unbalanced entries: ${unbalanced.length}`);
console.log(`\ntrial balance: ${matched}/${allNs.size} accounts reconcile (±$0.01)`);
console.log(`               ${mismatches.length} mismatched, total abs delta $${fromUnits(totalAbsDelta)}`);
if (mismatches.length) {
  console.log("\nMISMATCHES:");
  for (const m of mismatches.slice(0, 30))
    console.log(`   ${(m.number + " " + m.name).padEnd(34).slice(0, 34)} ours=${m.ours.padStart(16)} ns=${m.ns_bal.padStart(16)} Δ=${m.delta}`);
}
console.log("\nwrote extraction/cutover-verification.json");
await pool.end();
