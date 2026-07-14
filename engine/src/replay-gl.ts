import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";

/**
 * Replay every posted NetSuite GL transaction through the openbooks kernel
 * as origin='migration' journal entries. The kernel's deferred balance
 * trigger validates EVERY entry — 46k entries of real accounting data
 * passing means the kernel and NetSuite agree on what "balanced" means.
 *
 * NetSuite rounding reality: a handful of multi-line transactions carry
 * sub-cent imbalance in TAL (their GL presents 2dp but stores more). Any
 * entry with |sum| <= $0.02 gets an explicit rounding plug line to the
 * configured rounding account; bigger imbalances are reported and skipped.
 */

const glPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extraction", "gl-dump", "gl.ndjson");

interface NsRow {
  tid: string; ttype: string; trandate: string; tranid?: string;
  entity?: string; dept?: string; tline: string; acct: string;
  debit?: string; credit?: string;
}

function parseDate(us: string): string {
  const m = us.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`bad date ${us}`);
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

async function main() {
  const orgRow = (await db.select().from(schema.orgs)).at(0)!;
  const book = (await db.select().from(schema.accountingBooks)).at(0)!;
  const orgId = orgRow.id;

  // mapping tables: NS id -> openbooks uuid
  const accounts = await db.execute(sql`select id, custom->>'nsId' as ns, type, is_summary from accounts`);
  const acctByNs = new Map<string, { id: string; type: string }>();
  for (const r of (accounts as any).rows) if (r.ns) acctByNs.set(r.ns, { id: r.id, type: r.type });

  const depts = await db.execute(sql`select id, custom->>'nsId' as ns from departments`);
  const deptByNs = new Map<string, string>();
  for (const r of (depts as any).rows) if (r.ns) deptByNs.set(r.ns, r.id);

  const parties = await db.execute(sql`select id, custom->>'nsId' as ns from parties`);
  const partyByNs = new Map<string, string>();
  for (const r of (parties as any).rows) if (r.ns) partyByNs.set(r.ns, r.id);

  const periods = await db.execute(
    sql`select id, starts_on, ends_on from accounting_periods where org_id = ${orgId} order by starts_on`,
  );
  const periodList = (periods as any).rows as { id: string; starts_on: string; ends_on: string }[];
  const periodFor = (d: string) => periodList.find((p) => p.starts_on <= d && p.ends_on >= d)?.id;

  // rounding plug account: prefer an existing NS "Rounding" account, else create
  let rounding = (accounts as any).rows.find((r: any) => /round/i.test(r.ns ?? "") )?.id as string | undefined;
  const named = await db.execute(sql`select id from accounts where name ilike '%rounding%' limit 1`);
  rounding = (named as any).rows[0]?.id ?? rounding;
  if (!rounding) {
    const [r] = await db
      .insert(schema.accounts)
      .values({ orgId, number: "OB-ROUNDING", name: "Rounding (migration)", type: "expense_other" })
      .returning({ id: schema.accounts.id });
    rounding = r.id;
  }

  // group GL rows by transaction
  const byTxn = new Map<string, NsRow[]>();
  const rl = createInterface({ input: createReadStream(glPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as NsRow;
    const arr = byTxn.get(row.tid);
    if (arr) arr.push(row);
    else byTxn.set(row.tid, [row]);
  }
  console.log(`transactions: ${byTxn.size}`);

  const problems: string[] = [];
  let entries = 0, lines = 0, plugs = 0;
  const client = await pool.connect();
  try {
    let batchOpen = false;
    let inBatch = 0;
    const BATCH = 250;

    for (const [tid, rows] of byTxn) {
      const first = rows[0];
      let date: string;
      try { date = parseDate(first.trandate); } catch { problems.push(`${tid}: bad date ${first.trandate}`); continue; }
      const periodId = periodFor(date);
      if (!periodId) { problems.push(`${tid}: no period for ${date}`); continue; }

      const kernelLines: any[] = [];
      let bad = false;
      let total = 0n;
      for (const r of rows) {
        const acct = acctByNs.get(String(r.acct));
        if (!acct) { problems.push(`${tid}: unknown account ns=${r.acct}`); bad = true; break; }
        const amount = toUnits(r.debit ?? "0") - toUnits(r.credit ?? "0");
        if (amount === 0n) continue;
        total += amount;
        kernelLines.push({
          accountId: acct.id,
          amount: fromUnits(amount),
          departmentId: r.dept ? deptByNs.get(String(r.dept)) ?? null : null,
          partyId: first.entity ? partyByNs.get(String(first.entity)) ?? null : null,
          isOpenItem: acct.type === "asset_receivable" || acct.type === "liability_payable",
        });
      }
      if (bad) continue;
      if (kernelLines.length === 0) continue;
      if (total !== 0n) {
        if (total > -200n && total < 200n) { // ≤ $0.02 → explicit plug
          kernelLines.push({ accountId: rounding, amount: fromUnits(-total), departmentId: null, partyId: null, isOpenItem: false });
          plugs++;
        } else {
          problems.push(`${tid}: imbalance ${fromUnits(total)}`);
          continue;
        }
      }

      if (!batchOpen) {
        await client.query("begin");
        await client.query("set local openbooks.migration = on");
        batchOpen = true; inBatch = 0;
      }

      // kernel discipline even during migration: draft → lines → posted
      const entryRes = await client.query(
        `insert into journal_entries (org_id, book_id, entry_number, posting_date, period_id, memo, status, origin)
         values ($1,$2,$3,$4,$5,$6,'draft','migration') returning id`,
        [orgId, book.id, `NS-${first.ttype}-${first.tranid ?? tid}-${tid}`, date, periodId, `NetSuite ${first.ttype} ${first.tranid ?? ""}`.trim()],
      );
      const entryId = entryRes.rows[0].id;

      const values: string[] = [];
      const params: any[] = [orgId, entryId];
      kernelLines.forEach((l, i) => {
        const base = params.length;
        params.push(l.accountId, l.amount, l.departmentId, l.partyId, l.isOpenItem);
        values.push(`($1, $2, ${i + 1}, $${base + 1}, $${base + 2}, 'CAD', $${base + 2}, 1, $${base + 3}, $${base + 4}, $${base + 5})`);
      });
      await client.query(
        `insert into journal_lines (org_id, entry_id, line_number, account_id, amount, currency, txn_amount, fx_rate, department_id, party_id, is_open_item)
         values ${values.join(",")}`,
        params,
      );
      await client.query(`update journal_entries set status='posted' where id = $1`, [entryId]);

      entries++; lines += kernelLines.length; inBatch++;
      if (inBatch >= BATCH) { await client.query("commit"); batchOpen = false; }
      if (entries % 5000 === 0) console.log(`  ${entries} entries, ${lines} lines...`);
    }
    if (batchOpen) await client.query("commit");
  } finally {
    client.release();
  }

  console.log(`DONE: ${entries} entries, ${lines} lines, ${plugs} rounding plugs, ${problems.length} problems`);
  for (const p of problems.slice(0, 20)) console.log(`  problem: ${p}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
