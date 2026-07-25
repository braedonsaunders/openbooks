/**
 * Chronological job replay — the real lifecycle, not a bulk rebuild.
 *
 * A job doesn't get costed and billed in one shot: cost accrues, an invoice is
 * cut for that period, more cost accrues, another invoice goes out. This harness
 * walks a job's ACTUAL invoice dates in order and, at each one, bills only the
 * work up to that cutoff — then checks, at every stage:
 *   • cost-to-date on the project (what the ledger says the job has consumed)
 *   • the invoice just produced vs the golden invoice for that period
 *   • cumulative billed vs cumulative golden
 * so a divergence is caught at the stage it appears rather than washed out in a
 * job total.
 *
 * Golden source is the legacy system's own invoices (cached to
 * /tmp/golden-invoices.json, pre-tax net per invoice). Runs against the sandbox
 * clone only — never production.
 *
 * Usage: npx tsx --conditions=react-server src/validation/legacy-timeline-replay.ts --job=118116 [--apply]
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { deleteDocument } from "../document-delete.ts";
import { generateInvoiceFromBillingRequest } from "../../../web/lib/billing.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const GOLDEN = "/tmp/golden-invoices.json";
const RUN = randomUUID().slice(0, 6);
const APPLY = process.argv.includes("--apply");
const JOB = process.argv.find((a) => a.startsWith("--job="))?.split("=")[1] ?? "118116";

async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}
const num = (v: unknown) => Number(v ?? 0);
const m2 = (v: number) => v.toFixed(2);
/** The source system returns dates as MM/DD/YYYY. */
const iso = (d: string) => {
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(d));
  return us ? `${us[3]}-${us[1]}-${us[2]}` : String(d).slice(0, 10);
};

/** Posted, project-tagged cost as of a date (what the job has consumed so far). */
async function costToDate(projectId: string, asOf: string): Promise<number> {
  const r = (await retry(() => db.execute(sql`
    select coalesce(sum(l.amount), 0)::text as c
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where l.org_id = ${ORG} and l.project_id = ${projectId}
       and a.type in ('cogs','expense','expense_other') and e.posting_date <= ${asOf}`))) as any;
  return num(r.rows[0]?.c);
}

async function resolveProject(job: string): Promise<string | null> {
  const r = (await retry(() => db.execute(sql`
    select p.id, (select count(*) from time_entries te where te.project_id = p.id)
                + (select count(*) from document_lines dl where dl.project_id = p.id) rows
      from projects p
     where p.org_id = ${ORG}
       and (p.code = ${job} or p.custom->>'nsId' = ${job}
            or p.name = (select name from projects where org_id = ${ORG} and code = ${job} limit 1))
     order by rows desc limit 1`))) as any;
  return r.rows[0]?.id ?? null;
}

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind, name from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");
  if (!existsSync(GOLDEN)) throw new Error(`missing ${GOLDEN}`);

  const golden = (JSON.parse(readFileSync(GOLDEN, "utf8")) as any[])
    .filter((g) => String(g.job) === JOB)
    .map((g) => ({ id: String(g.id), date: iso(g.trandate), gross: num(g.foreigntotal), net: num(g.net) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!golden.length) throw new Error(`no golden invoices cached for job ${JOB}`);

  const projectId = await resolveProject(JOB);
  if (!projectId) throw new Error(`no project for job ${JOB}`);
  const actor = ((await retry(() => db.execute(sql`select id from users where org_id = ${ORG} order by created_at limit 1`))) as any).rows[0]?.id;

  console.log(`job ${JOB} — ${golden.length} invoices, ${golden[0].date} → ${golden[golden.length - 1].date}`);
  console.log(`${APPLY ? "REPLAY (destructive)" : "PLAN (read-only)"}\n`);
  console.log("stage  cutoff      costToDate   goldenNet    replayNet       delta   cumGolden    cumReplay");

  if (APPLY) {
    // Start from a clean slate for this job: remove its migrated invoices so the
    // engine rebuilds the sequence from the underlying cost.
    const existing = (await retry(() => db.execute(sql`
      select distinct d.id from documents d left join document_lines dl on dl.document_id = d.id
       where d.org_id = ${ORG} and d.kind = 'customer_invoice'
         and (d.project_id = ${projectId} or dl.project_id = ${projectId})`))) as any;
    for (const inv of existing.rows) {
      await retry(() => db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('openbooks.sandbox_wipe','on',true)`);
        await tx.execute(sql`select set_config('openbooks.amend','on',true)`);
        await tx.execute(sql`
          delete from applications a where a.org_id = ${ORG} and exists (
            select 1 from documents d join journal_lines jl on jl.entry_id = d.posted_entry_id
             where d.id = ${inv.id} and (jl.id = a.to_line_id or jl.id = a.from_line_id))`);
      }));
      await retry(() => deleteDocument(inv.id, actor, { source: "timeline-replay", reason: "chronological replay" }));
    }
  }

  const rows: any[] = [];
  let cumGolden = 0, cumReplay = 0, prevCutoff: string | null = null;
  for (let i = 0; i < golden.length; i++) {
    const g = golden[i];
    cumGolden += g.net;
    const cost = await costToDate(projectId, g.date);
    let replayNet: number | null = null, note = "";

    if (APPLY) {
      try {
        const rid = randomUUID();
        await retry(() => db.execute(sql`
          insert into billing_requests (id, org_id, project_id, request_number, invoice_type, basis,
                                        start_date, cutoff_date, status, invoice_description, created_by)
          values (${rid}, ${ORG}, ${projectId}, ${`TL-${RUN}-${JOB}-${i + 1}`},
                  ${i === golden.length - 1 ? "final" : "progress"}, 'date_range',
                  ${prevCutoff}, ${g.date}, 'open', ${`Stage ${i + 1} through ${g.date}`}, ${actor})`));
        const out = await retry(() => generateInvoiceFromBillingRequest(ORG, actor, rid));
        const t = (await retry(() => db.execute(sql`select subtotal::numeric s from documents where id = ${out.id}`))) as any;
        replayNet = num(t.rows[0]?.s);
        cumReplay += replayNet;
      } catch (e) {
        const chain: string[] = [];
        for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " "));
        note = (chain.pop() ?? "error").slice(0, 90);
      }
    }
    const delta = replayNet === null ? null : replayNet - g.net;
    rows.push({ stage: i + 1, cutoff: g.date, costToDate: cost, goldenNet: g.net, replayNet, delta, cumGolden, cumReplay });
    console.log(
      `${String(i + 1).padStart(4)}   ${g.date}  ${m2(cost).padStart(11)} ${m2(g.net).padStart(11)}` +
      ` ${(replayNet === null ? "-" : m2(replayNet)).padStart(12)} ${(delta === null ? "-" : m2(delta)).padStart(11)}` +
      ` ${m2(cumGolden).padStart(11)} ${m2(cumReplay).padStart(12)}` + (note ? `  ${note}` : ""),
    );
    prevCutoff = g.date;
  }
  writeFileSync("/tmp/timeline-replay.json", JSON.stringify({ job: JOB, projectId, rows }, null, 1));
  console.log(`\ncumulative golden ${m2(cumGolden)} | replay ${m2(cumReplay)} | delta ${m2(cumReplay - cumGolden)}`);
  console.log("results -> /tmp/timeline-replay.json");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
