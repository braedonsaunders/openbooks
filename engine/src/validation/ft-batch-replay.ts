/**
 * Batch field-ticket replay — the real billing unit, at scale.
 *
 * For every invoice whose source records the exact field tickets behind it,
 * rebuild that invoice through the real project-billing engine from those same
 * tickets and compare to the golden pre-tax total. Each invoice is replayed in
 * isolation: the job's provenance is released first, so one invoice's result
 * can't be contaminated by another's.
 *
 * Reads /tmp/ft-invoices.json  [{ id, tranid, job, date, net, tickets: [...] }]
 * Writes /tmp/ft-batch-results.json
 *
 * Usage: npx tsx --conditions=react-server src/validation/ft-batch-replay.ts [INV#### ...] [--limit=N] [--apply|--score-existing]
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import { sourceClient } from "../sync/source-client.ts";
import { generateInvoiceFromBillingRequest } from "../../../web/lib/billing.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");
const SCORE_EXISTING = process.argv.includes("--score-existing");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0");
const NAMED = process.argv.slice(2).filter((arg) => /^INV\d+$/i.test(arg));

async function retry<T>(fn: () => Promise<T>, n = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const c: string[] = [];
      for (let x: any = e; x; x = x.cause) c.push(String(x?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|Connection/i.test(c.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}
const cause = (e: unknown) => {
  const c: string[] = [];
  for (let x: any = e; x; x = x.cause) if (x?.message) c.push(String(x.message).replace(/\s+/g, " "));
  return (c.pop() ?? "error").slice(0, 90);
};

interface Inv { id: string; tranid: string; job: string; date: string; net: number; tickets: string[] }

/**
 * The source connector's `netamount` can be zero for real customer-facing charge lines
 * even though `foreignamount` carries the amount included in the invoice.
 * Recompute every golden subtotal from signed transaction-currency detail
 * instead of trusting a stale export that can silently omit those lines.
 */
async function sourceSubtotals(invoices: Inv[]): Promise<Map<string, number>> {
  const client = sourceClient();
  const totals = new Map<string, number>();
  for (let i = 0; i < invoices.length; i += 60) {
    const chunk = invoices.slice(i, i + 60);
    const ids = chunk.map((invoice) => String(invoice.id));
    if (ids.some((id) => !/^\d+$/.test(id))) throw new Error("source invoice id is not numeric");
    const rows = await retry(() => client.query<{ txn: string; subtotal: string }>(`
      select tl.transaction txn, sum(tl.foreignamount) subtotal
        from transactionline tl
       where tl.transaction in (${ids.join(",")})
         and tl.mainline = 'F' and tl.taxline = 'F'
       group by tl.transaction`));
    for (const row of rows) {
      const units = toUnits(String(row.subtotal ?? "0"));
      totals.set(String(row.txn), Number(fromUnits(units < 0n ? -units : units)));
    }
  }
  const missing = invoices.filter((invoice) => !totals.has(String(invoice.id)));
  if (missing.length) {
    throw new Error(`source subtotal missing for ${missing.slice(0, 5).map((invoice) => invoice.tranid).join(", ")}`);
  }
  return totals;
}

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

  const all = JSON.parse(readFileSync("/tmp/ft-invoices.json", "utf8")) as Inv[];
  // The cost documents the original invoice was raised FROM. Which bills and
  // expense reports belong to an invoice is a decision someone made, not a date
  // range, so the replay names them the same way it names the field tickets.
  const ordersByInvoice = new Map<string, string[]>();
  const addRefs = (key: string, refs: string[]) =>
    ordersByInvoice.set(key, [...new Set([...(ordersByInvoice.get(key) ?? []), ...refs])]);
  if (existsSync("/tmp/inv-orders.json")) {
    for (const row of JSON.parse(readFileSync("/tmp/inv-orders.json", "utf8")) as any[]) {
      addRefs(String(row.inv), [String(row.ord)]);
    }
  }
  // The original also records the sales orders it billed, as a list on the
  // invoice itself. Those carry the equipment and consumables, which is a
  // decision no date range can reconstruct.
  const finalInvoices = new Set<string>();
  if (existsSync("/tmp/inv-so.json")) {
    for (const row of JSON.parse(readFileSync("/tmp/inv-so.json", "utf8")) as any[]) {
      if (String(row.fin ?? "").toUpperCase() === "T") finalInvoices.add(String(row.id));
      try {
        const parsed = JSON.parse(String(row.sojson ?? "null"));
        const refs = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
        addRefs(String(row.id), refs.map((x) => String(x)).filter((x) => /^\d+$/.test(x)));
      } catch { /* a malformed list on one invoice must not stop the batch */ }
    }
  }
  const selected = NAMED.length
    ? all.filter((invoice) => NAMED.includes(invoice.tranid))
    : all;
  const missingNames = NAMED.filter((tranid) => !selected.some((invoice) => invoice.tranid === tranid));
  if (missingNames.length) throw new Error(`invoice not in replay set: ${missingNames.join(", ")}`);
  const list = LIMIT > 0 ? selected.slice(0, LIMIT) : selected;
  const goldenByInvoice = await sourceSubtotals(list);
  const actor = ((await retry(() => db.execute(sql`select id from users where org_id = ${ORG} order by created_at limit 1`))) as any).rows[0]?.id;
  console.log(`${APPLY ? "REPLAY" : SCORE_EXISTING ? "SCORE" : "PLAN"}: ${list.length} invoices with explicit field tickets\n`);

  const existingReplays = new Map<string, number>();
  if (SCORE_EXISTING) {
    const rows = (await retry(() => db.execute(sql`
      select distinct on (memo) memo, subtotal::text as subtotal
        from documents
       where org_id = ${ORG} and kind = 'customer_invoice'
         and status = 'draft' and memo like 'Replay of INV%'
       order by memo, created_at desc
    `))) as unknown as { rows: { memo: string; subtotal: string }[] };
    for (const row of rows.rows) existingReplays.set(row.memo, Number(row.subtotal));
  }

  const results: any[] = [];
  let exact = 0, near = 0, off = 0, err = 0;
  for (const cached of list) {
    const inv = { ...cached, net: goldenByInvoice.get(String(cached.id))! };
    const r: any = {
      ...inv,
      ...(Math.abs(cached.net - inv.net) > 0.005 ? { cachedNet: cached.net } : {}),
      replay: null,
      delta: null,
      status: "skipped",
    };
    try {
      const t = (await retry(() => db.execute(sql`
        select id, project_id from documents where org_id = ${ORG} and kind = 'field_ticket'
         and document_number = any(${`{${inv.tickets.join(",")}}`}::text[])`))) as any;
      if (!t.rows.length) { r.note = "no tickets in OpenBooks"; results.push(r); continue; }
      const ids = t.rows.map((x: any) => x.id);
      const pid = t.rows[0].project_id;
      r.ticketsFound = ids.length;

      const orderRefs = ordersByInvoice.get(String(inv.id)) ?? [];
      const orderIds = orderRefs.length
        ? ((await retry(() => db.execute(sql`
            select id from documents where org_id = ${ORG}
              and custom->>'nsId' = any(${`{${orderRefs.join(",")}}`}::text[])`))) as any).rows.map((x: any) => String(x.id))
        : [];
      r.orders = orderIds.length;

      let replay: number | null = null;
      if (SCORE_EXISTING) {
        replay = existingReplays.get(`Replay of ${inv.tranid}`) ?? null;
        if (replay === null) r.note = "no existing replay";
      } else if (APPLY) {
        // Release provenance BEFORE clearing earlier replays: those rows still
        // point at the lines about to be deleted, and the foreign key is what
        // stops a billed row from losing the invoice that billed it.
        await retry(() => db.execute(sql`update time_entries set invoiced_by_line_id = null where org_id = ${ORG} and project_id = ${pid}`));
        await retry(() => db.execute(sql`update document_lines set billed_by_line_id = null where org_id = ${ORG} and project_id = ${pid}`));

        // Then clear this invoice's earlier replays. Re-running otherwise piles
        // up a draft per attempt, and thousands of them make the tenant unusable
        // for anyone looking at real work.
        await retry(() => db.execute(sql`
          delete from document_lines where document_id in (
            select id from documents where org_id = ${ORG} and kind = 'customer_invoice'
              and status = 'draft' and memo = ${"Replay of " + inv.tranid})`));
        await retry(() => db.execute(sql`
          delete from documents where org_id = ${ORG} and kind = 'customer_invoice'
            and status = 'draft' and memo = ${"Replay of " + inv.tranid}`));
        const rid = randomUUID();
        await retry(() => db.execute(sql`
          insert into billing_requests (id, org_id, project_id, request_number, invoice_type, basis, status, invoice_description, custom, created_by)
          values (${rid}, ${ORG}, ${pid}, ${"FTB-" + randomUUID().slice(0, 8)},
                  ${finalInvoices.has(String(inv.id)) ? "final" : "progress"}, 'field_ticket', 'open',
                  ${"Replay of " + inv.tranid}, ${JSON.stringify({ fieldTicketIds: ids, sourceDocumentIds: orderIds })}::jsonb, ${actor})`));
        const out = await retry(() => generateInvoiceFromBillingRequest(ORG, actor, rid));
        const d = (await retry(() => db.execute(sql`select subtotal::numeric s from documents where id = ${out.id}`))) as any;
        replay = Number(d.rows[0]?.s ?? 0);
      }
      if (replay !== null) {
        r.replay = replay;
        r.delta = r.replay - inv.net;
        const pct = inv.net ? Math.abs(r.delta) / inv.net : 1;
        r.status = Math.abs(r.delta) <= 0.005 ? "exact" : pct <= 0.01 ? "near" : "off";
        if (r.status === "exact") exact++; else if (r.status === "near") near++; else off++;
      }
    } catch (e) { r.status = "error"; r.note = cause(e); err++; }
    results.push(r);
    writeFileSync("/tmp/ft-batch-results.json", JSON.stringify(results));
    if ((APPLY || SCORE_EXISTING) && results.length % 25 === 0) {
      console.log(`  …${results.length} — exact ${exact} near ${near} off ${off} err ${err}`);
    }
  }

  const scored = results.filter((x) => x.replay !== null);
  const sum = (f: (x: any) => number) => scored.reduce((t, x) => t + f(x), 0);
  console.log(`\n--- ${results.length} invoices ---`);
  if (APPLY || SCORE_EXISTING) {
    console.log(`exact ${exact} | within 1% ${near} | off ${off} | error ${err}`);
    console.log(`golden $${sum((x) => x.net).toFixed(2)} | replay $${sum((x) => x.replay).toFixed(2)} | delta $${(sum((x) => x.replay) - sum((x) => x.net)).toFixed(2)}`);
    if (scored.length) console.log(`penny-exact rate: ${(100 * exact / scored.length).toFixed(1)}%`);
  }
  console.log("results -> /tmp/ft-batch-results.json");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", cause(e)); process.exit(1); });
