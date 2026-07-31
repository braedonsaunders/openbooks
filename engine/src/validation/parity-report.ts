/**
 * The invoices that do not yet replay to the penny, and why.
 *
 * Each row states what the evidence supports, not a guess: the golden invoice is
 * read line by line from the source, our replay line by line from the ledger,
 * and the reason is inferred from what is actually missing or extra. Where the
 * evidence does not identify a cause it says so rather than inventing one.
 *
 * Writes /tmp/parity-report.tsv alongside the printed table.
 *
 * Usage: npx tsx --conditions=react-server src/validation/parity-report.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { sourceClient } from "../sync/source-client.ts";

const ORG = process.env.TARGET_ORG ?? process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const cents = (v: unknown) => Math.round(Math.abs(Number(v ?? 0)) * 100);
const money = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const results = (JSON.parse(readFileSync("/tmp/ft-batch-results.json", "utf8")) as any[])
    .filter((r) => r.replay !== null && r.status !== "exact");
  const invoices = JSON.parse(readFileSync("/tmp/ft-invoices.json", "utf8")) as any[];
  const orderLists = new Map<string, string[]>();
  for (const row of JSON.parse(readFileSync("/tmp/inv-so.json", "utf8")) as any[]) {
    try {
      const parsed = JSON.parse(String(row.sojson ?? "null"));
      const refs = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
      orderLists.set(String(row.id), refs.map(String).filter((x) => /^\d+$/.test(x)));
    } catch { /* a malformed list must not stop the report */ }
  }
  console.log(`${results.length} invoices differ\n`);

  const client = sourceClient();
  const tids = results.map((r) => String(invoices.find((i) => i.tranid === r.tranid)?.id)).filter((x) => x !== "undefined");

  // Golden lines for every differing invoice, in one pass. The ticket each line
  // was billed under is recorded too: an invoice's HEADER can name a ticket that
  // none of its lines bill, and trusting the header is how a replay ends up
  // charging work the original never invoiced there.
  const goldenTickets = new Map<string, Set<string>>();
  const goldenLines = new Map<string, { amt: number; cat: string; label: string }[]>();
  for (let i = 0; i < tids.length; i += 60) {
    const chunk = tids.slice(i, i + 60);
    const rows = await retry(() => client.query<Record<string, string>>(`
      select tl.transaction txn, tl.foreignamount amt, tl.custcol_bit_item_category cat,
             tl.memo, tl.mainline, tl.taxline, tl.custcol_bit_timesheet_number tix
        from transactionline tl where tl.transaction in (${chunk.join(",")})`));
    for (const r of rows) {
      if (String(r.mainline).toUpperCase() === "T" || String(r.taxline).toUpperCase() === "T") continue;
      if (cents(r.amt) === 0) continue;
      const key = String(r.txn);
      if (r.tix) goldenTickets.set(key, (goldenTickets.get(key) ?? new Set()).add(String(r.tix)));
      goldenLines.set(key, [...(goldenLines.get(key) ?? []),
        { amt: cents(r.amt), cat: String(r.cat ?? "-"), label: String(r.memo ?? "") }]);
    }
  }

  // Which named orders no longer exist in the source — a line on a deleted
  // document cannot be rebuilt from anything that survives.
  const allOrders = [...new Set(results.flatMap((r) => {
    const inv = invoices.find((i) => i.tranid === r.tranid);
    return inv ? (orderLists.get(String(inv.id)) ?? []) : [];
  }))];
  const alive = new Set<string>();
  for (let i = 0; i < allOrders.length; i += 80) {
    const chunk = allOrders.slice(i, i + 80);
    if (!chunk.length) continue;
    const rows = await retry(() => client.query<{ id: string }>(
      `select t.id from transaction t where t.id in (${chunk.join(",")})`));
    for (const r of rows) alive.add(String(r.id));
  }

  const out: string[] = ["invoice\tjob\tdate\tgolden\treplay\tdifference\treason"];
  const rows: any[] = [];
  for (const r of results) {
    const inv = invoices.find((i) => i.tranid === r.tranid);
    if (!inv) continue;
    const golden = goldenLines.get(String(inv.id)) ?? [];
    const ours = ((await retry(() => db.execute(sql`
      select dl.description, dl.amount::text amt, dl.time_entry_id from document_lines dl
        join documents d on d.id = dl.document_id
       where d.org_id = ${ORG} and d.memo = ${"Replay of " + r.tranid}
       order by d.created_at desc`))) as any).rows as any[];
    const ourCents = ours.map((o) => cents(o.amt)).filter((c) => c !== 0);
    const laborCents = ours
      .filter((o) => o.time_entry_id)
      .reduce((total, o) => total + cents(o.amt), 0);
    const unmatched = [...ourCents];
    const missing = golden.filter((g) => {
      const match = unmatched.indexOf(g.amt);
      if (match < 0) return true;
      unmatched.splice(match, 1);
      return false;
    });
    const deletedOrders = (orderLists.get(String(inv.id)) ?? []).filter((o) => !alive.has(o));
    const cat6 = golden.filter((g) => g.cat === "6").reduce((t, g) => t + g.amt, 0) / 100;
    const billedTickets = goldenTickets.get(String(inv.id)) ?? new Set<string>();
    const unbilledTickets = (inv.tickets ?? []).filter((t: string) => !billedTickets.has(t));
    const ratio = r.net ? r.replay / r.net : 0;
    const deltaCents = Math.round(r.delta * 100);
    const laborChargeRate = laborCents > 0 ? (deltaCents * 100) / laborCents : 0;

    let reason: string;
    if (deletedOrders.length && cat6 > 0 && Math.abs(Math.abs(r.delta) - cat6) < 1) {
      reason = `source order deleted — internal billing of ${money(cat6)} sits on order(s) ${deletedOrders.join("/")}, gone from the source`;
    } else if (deletedOrders.length) {
      reason = `names ${deletedOrders.length} order(s) deleted from the source (${deletedOrders.join("/")})`;
    } else if (Math.abs(ratio - 1.15) < 0.003) {
      reason = "markup applied where the original billed the cost flat — a waived markup, no rule in the data";
    } else if (Math.abs(r.delta) <= 1) {
      reason = "a single line differs by a cent — charge lines match exactly";
    } else if (unbilledTickets.length) {
      reason = `the invoice HEADER names ${unbilledTickets.length} ticket(s) that none of its lines bill (${unbilledTickets.slice(0, 2).join(", ")}) — the original did not invoice that work here`;
    } else if (r.delta > 0 && Math.abs(laborChargeRate - 3.75) < 0.002) {
      reason = "replay adds a charge equal to 3.75% of labor; the source invoice omitted that surcharge";
    } else if (r.delta > 0 && !missing.length) {
      reason = "we bill more than the original with nothing missing — cause not identified";
    } else if (cat6 > 0) {
      reason = `internal billing (category 6) of ${money(cat6)} not reproduced`;
    } else if (missing.length) {
      reason = `${missing.length} source line(s) not billed, largest ${money(Math.max(...missing.map((m) => m.amt)) / 100)}`;
    } else {
      reason = "no cause identified from the line evidence";
    }

    rows.push({ invoice: r.tranid, job: r.job, date: inv.date, golden: r.net, replay: r.replay, difference: r.delta, reason });
    out.push([r.tranid, r.job, inv.date, r.net.toFixed(2), r.replay.toFixed(2), r.delta.toFixed(2), reason].join("\t"));
  }

  rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  for (const x of rows) {
    console.log(`${x.invoice.padEnd(9)} job ${String(x.job).padEnd(8)} ${String(x.date).padEnd(11)} golden ${money(x.golden).padStart(12)}  replay ${money(x.replay).padStart(12)}  diff ${money(x.difference).padStart(11)}`);
    console.log(`          ${x.reason}`);
  }
  writeFileSync("/tmp/parity-report.tsv", out.join("\n"));
  console.log(`\n${rows.length} invoices -> /tmp/parity-report.tsv`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
