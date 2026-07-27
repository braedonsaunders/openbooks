/**
 * Compare a replayed invoice to its original LINE BY LINE.
 *
 * A matching total proves very little: two invoices can agree to the penny and
 * disagree on every line, and a wrong line can hide behind a compensating one.
 * This pairs each source line with a replayed line of the same amount and
 * reports what is left over on each side, which is where the defects actually
 * are.
 *
 * Usage: npx tsx --conditions=react-server src/validation/line-diff.ts INV0437 [INV0170 ...]
 *        npx tsx --conditions=react-server src/validation/line-diff.ts --worst=10
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { sourceClient } from "../sync/source-client.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const WORST = Number(process.argv.find((a) => a.startsWith("--worst="))?.split("=")[1] ?? "0");
const NAMED = process.argv.slice(2).filter((a) => !a.startsWith("--"));

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

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

  const invoices = JSON.parse(readFileSync("/tmp/ft-invoices.json", "utf8")) as any[];
  let want = NAMED;
  if (WORST > 0) {
    const res = JSON.parse(readFileSync("/tmp/ft-batch-results.json", "utf8"))
      .filter((r: any) => r.replay !== null && r.status !== "exact")
      .sort((a: any, b: any) => Math.abs(b.delta) - Math.abs(a.delta));
    want = res.slice(0, WORST).map((r: any) => r.tranid);
  }

  const client = sourceClient();
  for (const tranid of want) {
    const inv = invoices.find((i) => i.tranid === tranid);
    if (!inv) { console.log(`${tranid}: not in the replay set`); continue; }

    // Source side: drop the mainline (the AR total) and tax lines; what remains
    // is what the customer was actually charged for.
    const src = await retry(() => client.query<Record<string, string>>(`
      select tl.netamount amt, tl.custcol_bit_item_category cat, tl.item,
             tl.quantity qty, tl.memo, tl.mainline, tl.taxline
        from transactionline tl where tl.transaction = ${inv.id} order by tl.id`));
    const srcLines = src
      .filter((r) => String(r.mainline).toUpperCase() !== "T" && String(r.taxline).toUpperCase() !== "T")
      .filter((r) => cents(r.amt) !== 0)
      .filter((r) => !/^(PST|GST|HST|VAT)$/i.test(String(r.memo ?? "").trim()))
      .map((r) => ({ amt: cents(r.amt), cat: r.cat ?? "-", label: String(r.memo ?? r.item ?? "").slice(0, 28), used: false }));

    const doc = (await retry(() => db.execute(sql`
      select id, subtotal::text st from documents
       where org_id = ${ORG} and memo = ${"Replay of " + tranid} order by created_at desc limit 1`))) as any;
    if (!doc.rows[0]) { console.log(`${tranid}: never replayed`); continue; }
    const ours = (await retry(() => db.execute(sql`
      select description, amount::text amt from document_lines where document_id = ${doc.rows[0].id}`))) as any;
    const ourLines = (ours.rows as any[])
      .filter((r) => cents(r.amt) !== 0)
      .map((r) => ({ amt: cents(r.amt), label: String(r.description ?? "").slice(0, 28), used: false }));

    for (const s of srcLines) {
      const hit = ourLines.find((o) => !o.used && o.amt === s.amt);
      if (hit) { hit.used = true; s.used = true; }
    }
    const missing = srcLines.filter((s) => !s.used);
    const extra = ourLines.filter((o) => !o.used);
    const sum = (xs: { amt: number }[]) => xs.reduce((t, x) => t + x.amt, 0) / 100;

    console.log(`\n=== ${tranid}  golden ${inv.net}  replay ${doc.rows[0].st} ===`);
    console.log(`  ${srcLines.length} source lines, ${ourLines.length} replayed, ${srcLines.length - missing.length} matched`);
    if (missing.length) {
      console.log(`  MISSING from the replay (${missing.length}, ${sum(missing).toFixed(2)}):`);
      const byCat: Record<string, { n: number; amt: number }> = {};
      for (const m of missing) { const c = String(m.cat); (byCat[c] ??= { n: 0, amt: 0 }).n++; byCat[c]!.amt += m.amt; }
      for (const [c, v] of Object.entries(byCat)) console.log(`      category ${c}: ${v.n} lines, ${(v.amt / 100).toFixed(2)}`);
      for (const m of missing.slice(0, 6)) console.log(`      ${(m.amt / 100).toFixed(2).padStart(11)}  cat=${m.cat}  ${m.label}`);
    }
    if (extra.length) {
      console.log(`  EXTRA in the replay (${extra.length}, ${sum(extra).toFixed(2)}):`);
      for (const e of extra.slice(0, 6)) console.log(`      ${(e.amt / 100).toFixed(2).padStart(11)}  ${e.label}`);
    }
    if (!missing.length && !extra.length) console.log("  every line matched");
  }
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
