/**
 * Restore what the import dropped on job lines: billability, ticket link,
 * markup, and line identity — resumably.
 *
 * A full re-sync is the product-faithful correction, but it is one long
 * transaction-heavy run and this database is reached over a link that drops
 * every few minutes, so a monolithic migration never finishes. This walks the
 * cached source lines document by document, commits each batch, and records the
 * source line id on every line it touches — so a re-run resumes where it stopped
 * and later audits can match exactly rather than by amount.
 *
 * Lines are matched within their document by absolute amount, which is
 * unambiguous for the overwhelming majority; a document whose amounts repeat is
 * matched positionally in source-line order and reported.
 *
 * Reads /tmp/ns-job-lines.json (written by job-line-audit.ts)
 * Usage: npx tsx --conditions=react-server src/validation/backfill-job-lines.ts [--apply] [--limit=N]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0");

interface SrcLine {
  txn: string; line: string; type: string; amount: string | null;
  billable: boolean; ticket: string | null; markup: string | null; mult: string | null;
}

async function retry<T>(fn: () => Promise<T>, n = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection|socket/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1500 * (i + 1))));
    }
  }
  throw last;
}

const money = (v: string | null) => (v == null ? null : Math.abs(Number(v)).toFixed(4));

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

  const src = JSON.parse(readFileSync("/tmp/ns-job-lines.json", "utf8")) as SrcLine[];
  const byTxn = new Map<string, SrcLine[]>();
  for (const l of src) byTxn.set(l.txn, [...(byTxn.get(l.txn) ?? []), l]);
  console.log(`${src.length} source job lines across ${byTxn.size} transactions`);

  // Ticket number -> field_ticket document, so a cost line can travel with the
  // ticket it was worked under, the same way its labor does.
  const tickets = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select document_number n, id from documents where org_id = ${ORG} and kind = 'field_ticket'`))) as any).rows as any[])
      .map((r) => [String(r.n), String(r.id)]),
  );

  const txns = [...byTxn.keys()];
  const todo = LIMIT > 0 ? txns.slice(0, LIMIT) : txns;
  let done = 0, touched = 0, billableSet = 0, ticketSet = 0, ambiguous = 0, noDoc = 0, unmatched = 0;

  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    const docs = (await retry(() => db.execute(sql`
      select d.id, d.custom->>'nsId' ns,
             coalesce(jsonb_agg(jsonb_build_object('id', dl.id, 'amt', dl.amount::text, 'ln', dl.line_number)
               order by dl.line_number) filter (where dl.id is not null), '[]'::jsonb) lines
        from documents d left join document_lines dl on dl.document_id = d.id
       where d.org_id = ${ORG} and d.custom->>'nsId' = any(${`{${batch.join(",")}}`}::text[])
       group by d.id, d.custom->>'nsId'`))) as any;
    const docByNs = new Map<string, any>((docs.rows as any[]).map((r) => [String(r.ns), r]));

    const updates: { id: string; billable: boolean; ticket: string | null; mult: string | null; ref: string }[] = [];
    for (const txn of batch) {
      const doc = docByNs.get(txn);
      if (!doc) { noDoc++; continue; }
      const obLines = (doc.lines as any[]).map((l) => ({ id: String(l.id), amt: money(l.amt), used: false }));
      const srcLines = byTxn.get(txn)!;
      const dupes = new Set<string>();
      const seen = new Set<string>();
      for (const l of obLines) { if (l.amt && seen.has(l.amt)) dupes.add(l.amt); else if (l.amt) seen.add(l.amt); }
      if (dupes.size) ambiguous++;

      srcLines.forEach((s, idx) => {
        const want = money(s.amount);
        let hit = obLines.find((l) => !l.used && want != null && l.amt === want);
        if (!hit) hit = obLines[idx] && !obLines[idx]!.used ? obLines[idx] : undefined;
        if (!hit) { unmatched++; return; }
        hit.used = true;
        updates.push({
          id: hit.id, billable: s.billable,
          ticket: s.ticket ? (tickets.get(s.ticket) ?? null) : null,
          mult: s.mult ?? s.markup ?? null,
          ref: s.line,
        });
      });
    }

    if (APPLY && updates.length) {
      // One statement per batch: unnest the tuples and join on them.
      await retry(() => db.execute(sql`
        update document_lines dl
           set is_billable = v.billable,
               field_ticket_id = coalesce(v.ticket::uuid, dl.field_ticket_id),
               cost_multiplier = coalesce(v.mult::numeric, dl.cost_multiplier),
               custom = coalesce(dl.custom, '{}'::jsonb) || jsonb_build_object('sourceLineRef', v.ref),
               updated_at = now()
          from (select unnest(${`{${updates.map((u) => u.id).join(",")}}`}::uuid[]) id,
                       unnest(${`{${updates.map((u) => u.billable).join(",")}}`}::boolean[]) billable,
                       unnest(${`{${updates.map((u) => u.ticket ?? "NULL").join(",")}}`}::text[]) ticket,
                       unnest(${`{${updates.map((u) => u.mult ?? "NULL").join(",")}}`}::text[]) mult,
                       unnest(${`{${updates.map((u) => u.ref).join(",")}}`}::text[]) ref) v
         where dl.id = v.id and dl.org_id = ${ORG}`));
    }
    // Counted whether or not we write, so a dry run reports exactly what an
    // --apply would do.
    touched += updates.length;
    billableSet += updates.filter((u) => u.billable).length;
    ticketSet += updates.filter((u) => u.ticket).length;
    done += batch.length;
    if (done % 2000 < 100) console.log(`  …${done}/${todo.length} transactions — lines touched ${touched}`);
  }

  console.log(`\n${APPLY ? "APPLIED" : "PLAN"}: ${done} transactions`);
  console.log(`  lines matched      ${touched}`);
  console.log(`  marked billable    ${billableSet}`);
  console.log(`  linked to a ticket ${ticketSet}`);
  console.log(`  source line unmatched ${unmatched}, documents absent ${noDoc}, documents with repeated amounts ${ambiguous}`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
