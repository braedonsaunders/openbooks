/**
 * Reactivate accounts that carry live ledger balances but are flagged inactive.
 *
 * The native cutover posts real documents through the kernel, which refuses to
 * post to inactive accounts (jl_check_account). These 37 accounts hold genuine
 * balances in the NetSuite ledger we are reproducing, so on a live openbooks
 * COA they must be active/postable. Marking them active is the correct,
 * reversible master-data change (we tag each with custom.reactivatedForCutover
 * so it can be identified/rolled back).
 *
 * Idempotent. Run: node_modules/.bin/tsx engine/reactivate-posting-accounts.mts
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "./src/db.ts";

// Definitive set of accounts the native cutover will touch: every account nsId
// on any transaction line in the extraction (plus any already carrying GL).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extraction");
const usedNs = new Set<string>();
{
  const rl = createInterface({ input: createReadStream(join(root, "transactions", "lines.ndjson")), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    const l = JSON.parse(s) as { account?: string; expenseaccount?: string };
    const ns = l.expenseaccount ?? l.account;
    if (ns) usedNs.add(ns);
  }
}
console.log(`distinct account nsIds referenced by native lines: ${usedNs.size}`);

// all inactive accounts + whether they carry GL; filter to native-referenced in JS
const inactive = (await db.execute(sql`
  select a.id, a.number, a.name, a.is_summary, a.custom->>'nsId' ns,
         exists (select 1 from journal_lines l where l.account_id = a.id) as has_gl
    from accounts a
   where not a.is_active`)).rows as any[];
const targets = inactive.filter((a) => (a.ns && usedNs.has(a.ns)) || a.has_gl);

const summaries = targets.filter((t) => t.is_summary);
if (summaries.length) {
  console.log("WARNING: summary accounts among targets (NOT reactivating — kernel forbids posting):");
  for (const s of summaries) console.log(`  ${s.number} ${s.name}`);
}
const flip = targets.filter((t) => !t.is_summary);
console.log(`reactivating ${flip.length} non-summary accounts…`);

for (const a of flip) {
  await db.execute(sql`
    update accounts
       set is_active = true,
           custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object('reactivatedForCutover', true)
     where id = ${a.id}`);
}

const after = (await db.execute(sql`select count(*) filter (where not is_active)::int inactive from accounts`)).rows[0];
console.log(`done. inactive accounts remaining: ${(after as any).inactive}`);
await pool.end();
