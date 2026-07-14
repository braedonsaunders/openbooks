import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";

/**
 * THE PROOF: per-account trial balance, openbooks kernel vs NetSuite's own
 * GL aggregate (SUM(debit)-SUM(credit) per account from
 * transactionaccountingline). If every account matches to the cent, the
 * extraction, mapping, and kernel are faithful end-to-end.
 */

const dumpDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extraction", "gl-dump");

async function main() {
  // reference 1: NetSuite's own server-side aggregate (SUM per account)
  const ns = JSON.parse(readFileSync(join(dumpDir, "tb-netsuite.json"), "utf8")) as {
    acct?: string; d: string; c: string;
  }[];
  const nsTb = new Map<string, bigint>();
  for (const r of ns) {
    if (!r.acct) continue; // the null-account ItemShip group
    nsTb.set(String(r.acct), toUnits(r.d) - toUnits(r.c));
  }

  // reference 2: ground truth summed row-by-row from the raw dump
  const gt = JSON.parse(readFileSync(join(dumpDir, "tb-ground-truth.json"), "utf8")) as Record<string, string>;
  let gtAgree = 0, gtDisagree = 0;
  for (const [acct, bal] of Object.entries(gt)) {
    if ((nsTb.get(acct) ?? 0n) === toUnits(bal)) gtAgree++;
    else gtDisagree++;
  }
  console.log(`reference cross-check (dump vs NetSuite aggregate): ${gtAgree} agree, ${gtDisagree} disagree`);

  const ours = await db.execute(sql`
    select a.custom->>'nsId' as ns, a.number, a.name, sum(l.amount) as balance
      from journal_lines l join accounts a on a.id = l.account_id
     where a.custom->>'nsId' is not null
     group by 1, 2, 3
  `);

  let matched = 0;
  const mismatches: { ns: string; name: string; ours: bigint; theirs: bigint }[] = [];
  const oursByNs = new Map<string, { name: string; bal: bigint }>();
  for (const r of (ours as any).rows) {
    oursByNs.set(r.ns, { name: `${r.number ?? ""} ${r.name}`.trim(), bal: toUnits(r.balance) });
  }

  const allNs = new Set([...nsTb.keys(), ...oursByNs.keys()]);
  for (const nsId of allNs) {
    const theirs = nsTb.get(nsId) ?? 0n;
    const mine = oursByNs.get(nsId)?.bal ?? 0n;
    if (theirs === mine) matched++;
    else mismatches.push({ ns: nsId, name: oursByNs.get(nsId)?.name ?? `ns:${nsId}`, ours: mine, theirs });
  }

  // grand totals must both be zero (double entry) — plus rounding-plug total
  const grand = await db.execute(sql`select coalesce(sum(amount),0) as s, count(*) as n from journal_lines`);
  const plug = await db.execute(sql`
    select coalesce(sum(l.amount),0) as s, count(*) as n
      from journal_lines l join accounts a on a.id = l.account_id
     where a.number = 'OB-ROUNDING'`);

  console.log(`accounts compared:   ${allNs.size}`);
  console.log(`exact matches:       ${matched}`);
  console.log(`mismatches:          ${mismatches.length}`);
  console.log(`journal lines total: ${(grand as any).rows[0].n} (sum = ${(grand as any).rows[0].s})`);
  console.log(`rounding plug:       ${(plug as any).rows[0].n} lines (sum = ${(plug as any).rows[0].s})`);
  for (const m of mismatches.slice(0, 25)) {
    console.log(`  MISMATCH ${m.name}: ours=${fromUnits(m.ours)} netsuite=${fromUnits(m.theirs)} diff=${fromUnits(m.ours - m.theirs)}`);
  }
  process.exit(mismatches.length === 0 ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
