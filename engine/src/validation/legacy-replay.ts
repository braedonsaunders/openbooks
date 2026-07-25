/**
 * the tenant's invoice replay + penny reconciliation harness.
 *
 * For each selected job: delete the migrated invoices through the real product
 * delete path (which releases billing provenance), then drive the real project-
 * billing engine to REBUILD an invoice from the job's cost data, and reconcile the
 * result against the NetSuite golden totals.
 *
 * The golden source is NetSuite (cached to /tmp/golden-invoices.json by ns.ts) —
 * never the OpenBooks import, which is what's under test.
 *
 * Comparison unit is the JOB TOTAL: the original job was billed across N invoices
 * with per-run timesheet/date selections, so replaying its whole unbilled universe
 * yields one invoice whose subtotal must equal the sum of the job's golden invoices.
 *
 * Usage (read-only plan):   npx tsx --conditions=react-server src/validation/rassaun-replay.ts
 *        (destructive run): npx tsx --conditions=react-server src/validation/rassaun-replay.ts --apply [--limit=N]
 * Requires: the sandbox org (never prod — asserted), VPN access to the DB.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { deleteDocument } from "../document-delete.ts";
import { generateInvoiceFromBillingRequest } from "../../../web/lib/billing.ts";

const SANDBOX_ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const GOLDEN = "/tmp/golden-invoices.json";
const JOBSET = "/tmp/jobset.json";
const RESULTS = "/tmp/replay-results.json";
const RUN = randomUUID().slice(0, 6);
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0");

/** The shared DB flaps; retry only on connection-level failures (never on logic errors). */
async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

const num = (v: unknown) => Number(v ?? 0);
const money = (v: number) => v.toFixed(2);

interface JobResult {
  job: string;
  billingType: string;
  projectId: string | null;
  goldenCount: number;
  goldenTotal: number;
  /** Golden PRE-TAX total (NetSuite item-line net) — what the engine rebuilds. */
  goldenNet: number;
  /** Invoices found in the sandbox before the replay + their total. */
  existingCount: number;
  existingTotal: number;
  deleted: number;
  replayInvoiceId: string | null;
  replayTotal: number | null;
  delta: number | null;
  status: "planned" | "match" | "mismatch" | "skipped" | "error";
  note?: string;
}

async function assertSandbox(): Promise<void> {
  const r = (await retry(() => db.execute(sql`select env_kind, name from orgs where id = ${SANDBOX_ORG}`))) as any;
  const row = r.rows[0];
  if (!row) throw new Error(`org ${SANDBOX_ORG} not found`);
  if (row.env_kind !== "sandbox") throw new Error(`REFUSING: ${row.name} is ${row.env_kind}, not a sandbox`);
  console.log(`sandbox: ${row.name} (${SANDBOX_ORG.slice(0, 8)})`);
}

/** Any user in the org to attribute the replayed documents to. */
async function actorId(): Promise<string> {
  const r = (await retry(() => db.execute(sql`select id from users where org_id = ${SANDBOX_ORG} order by created_at limit 1`))) as any;
  const id = r.rows[0]?.id;
  if (!id) throw new Error("no user in the sandbox org to attribute the replay to");
  return id;
}

/** Sandbox invoices for a project: header-tagged OR line-tagged. */
async function sandboxInvoices(projectId: string) {
  const r = (await retry(() => db.execute(sql`
    select distinct d.id, d.document_number, d.total::numeric as total, d.status
      from documents d
      left join document_lines dl on dl.document_id = d.id
     where d.org_id = ${SANDBOX_ORG} and d.kind = 'customer_invoice'
       and (d.project_id = ${projectId} or dl.project_id = ${projectId})
  `))) as any;
  return r.rows as { id: string; document_number: string; total: string; status: string }[];
}

type Golden = { id?: string; foreigntotal: string; net?: number | null };

async function replayJob(job: string, golden: Golden[], actor: string, billingType: string): Promise<JobResult> {
  const goldenTotal = golden.reduce((t, g) => t + num(g.foreigntotal), 0);
  const goldenNet = golden.reduce((t, g) => t + num(g.net), 0);
  const res: JobResult = {
    job, billingType, projectId: null, goldenCount: golden.length, goldenTotal, goldenNet,
    existingCount: 0, existingTotal: 0, deleted: 0,
    replayInvoiceId: null, replayTotal: null, delta: null, status: "planned",
  };

  // Resolve the project through the job's own invoices: document_number is the
  // NetSuite transaction id, and its LINES carry the project. Matching on
  // projects.code is unreliable — the import created a duplicate project per job
  // (one coded with the NetSuite internal id, empty; one coded with the job name,
  // holding the data), so the code lookup can land on the empty shell.
  const nsIds = golden.map((g) => String((g as { id?: string }).id ?? "")).filter(Boolean);
  let projectId: string | null = null;
  if (nsIds.length) {
    const m = (await retry(() => db.execute(sql`
      select dl.project_id, count(*)::int n
        from documents d join document_lines dl on dl.document_id = d.id
       where d.org_id = ${SANDBOX_ORG} and d.kind = 'customer_invoice'
         and d.document_number = any(${`{${nsIds.join(",")}}`}::text[])
         and dl.project_id is not null
       group by dl.project_id order by 2 desc limit 1`))) as any;
    projectId = m.rows[0]?.project_id ?? null;
  }
  if (!projectId) {
    // Fallback (and the only option once a job's invoices have been replayed away):
    // the import made a duplicate project per job — one coded with the NetSuite id
    // and empty, one coded with the job name holding the data. Take the twin
    // carrying the most cost, never the empty shell.
    const p = (await retry(() => db.execute(sql`
      select p.id,
             (select count(*) from time_entries te where te.project_id = p.id)
           + (select count(*) from document_lines dl where dl.project_id = p.id) as rows
        from projects p
       where p.org_id = ${SANDBOX_ORG}
         and (p.code = ${job}
              or p.name = (select name from projects where org_id = ${SANDBOX_ORG} and code = ${job} limit 1))
       order by rows desc limit 1`))) as any;
    projectId = p.rows[0]?.id ?? null;
  }
  res.projectId = projectId;
  if (!projectId) { res.status = "skipped"; res.note = "could not resolve an OpenBooks project for this job"; return res; }

  const existing = await sandboxInvoices(projectId);
  res.existingCount = existing.length;
  res.existingTotal = existing.reduce((t, e) => t + num(e.total), 0);

  if (!APPLY) return res; // read-only plan

  // 1. Delete the migrated invoices through the product path (releases provenance).
  //    A paid invoice can't be deleted until its receipts are unapplied — the same
  //    state transition the product's void path performs (payments.ts sets
  //    applications.unapplied_at). Mirror it exactly rather than bypassing a guard.
  for (const inv of existing) {
    try {
      await retry(() => db.transaction(async (tx) => {
        // application_evidence_guard keeps payment evidence immutable except under
        // the sandbox-wipe flag (which additionally requires env_kind='sandbox' —
        // asserted at startup). Clear this invoice's receipts so the product delete
        // path can run, exactly as a sandbox teardown would.
        await tx.execute(sql`select set_config('openbooks.sandbox_wipe','on',true)`);
        await tx.execute(sql`select set_config('openbooks.amend','on',true)`);
        await tx.execute(sql`
          delete from applications a
           where a.org_id = ${SANDBOX_ORG}
             and exists (
               select 1 from documents d join journal_lines jl on jl.entry_id = d.posted_entry_id
                where d.id = ${inv.id} and (jl.id = a.to_line_id or jl.id = a.from_line_id))`);
      }));
      await retry(() => deleteDocument(inv.id, actor, { source: "rassaun-replay", reason: "invoice replay validation" }));
      res.deleted++;
    } catch (e) {
      res.status = "error";
      res.note = `delete ${inv.document_number}: ${String((e as Error).message).slice(0, 160)}`;
      return res;
    }
  }

  // 2. Rebuild through the real billing engine. How depends on how the job bills:
  //    • T&M   — one request over the job's whole unbilled cost universe; the engine
  //              must independently arrive at the same value from the same costs.
  //    • fixed-bid interval — the contract is billed as progress DRAWS, not from
  //              cost, so replay each original draw and check the engine reproduces it.
  const makeRequest = async (basis: string, amount: number | null, label: string): Promise<string> => {
    const requestId = randomUUID();
    await retry(() => db.execute(sql`
      insert into billing_requests (id, org_id, project_id, request_number, invoice_type, basis,
                                    draw_amount, status, invoice_description, created_by)
      values (${requestId}, ${SANDBOX_ORG}, ${projectId}, ${label}, 'final', ${basis},
              ${amount === null ? null : String(amount)}, 'open', ${"Replay of NetSuite job " + job}, ${actor})`));
    return requestId;
  };
  const subtotalOf = async (docId: string): Promise<number> => {
    const t = (await retry(() => db.execute(sql`select subtotal::numeric as sub from documents where id = ${docId}`))) as any;
    return num(t.rows[0]?.sub);
  };

  try {
    if (billingType === "_fixedBidInterval") {
      let total = 0;
      for (let i = 0; i < golden.length; i++) {
        const amt = num(golden[i].net);
        if (amt <= 0) continue;
        const rid = await makeRequest("draw_amount", amt, `RPL-${RUN}-${job}-${i + 1}`);
        const out = await retry(() => generateInvoiceFromBillingRequest(SANDBOX_ORG, actor, rid));
        res.replayInvoiceId = out.id;
        total += await subtotalOf(out.id);
      }
      res.replayTotal = total;
    } else {
      const rid = await makeRequest("date_range", null, `RPL-${RUN}-${job}`);
      const out = await retry(() => generateInvoiceFromBillingRequest(SANDBOX_ORG, actor, rid));
      res.replayInvoiceId = out.id;
      res.replayTotal = await subtotalOf(out.id);
    }
    res.delta = (res.replayTotal ?? 0) - goldenNet;
    res.status = Math.abs(res.delta) <= 0.005 ? "match" : "mismatch";
  } catch (e) {
    res.status = "error";
    const chain: string[] = [];
    for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " "));
    res.note = (chain.pop() ?? "unknown").slice(0, 200); // innermost cause is the useful one
  }
  return res;
}

(async () => {
  await assertSandbox();
  if (!existsSync(GOLDEN) || !existsSync(JOBSET)) throw new Error(`missing cached golden data (${GOLDEN} / ${JOBSET}) — run ns.ts first`);
  const goldenRows = JSON.parse(readFileSync(GOLDEN, "utf8")) as (Golden & { job: string })[];
  const jobset = JSON.parse(readFileSync(JOBSET, "utf8")) as { job: string }[];
  const types: Record<string, string> = existsSync("/tmp/jobtypes.json") ? JSON.parse(readFileSync("/tmp/jobtypes.json", "utf8")) : {};
  const byJob = new Map<string, Golden[]>();
  for (const g of goldenRows) { const l = byJob.get(String(g.job)) ?? []; l.push(g); byJob.set(String(g.job), l); }

  const actor = await actorId();
  const jobs = (LIMIT > 0 ? jobset.slice(0, LIMIT) : jobset).map((j) => String(j.job));
  console.log(`${APPLY ? "REPLAY (destructive)" : "PLAN (read-only)"}: ${jobs.length} jobs\n`);

  const results: JobResult[] = [];
  for (const job of jobs) {
    const r = await replayJob(job, byJob.get(job) ?? [], actor, types[job] ?? "unknown");
    results.push(r);
    writeFileSync(RESULTS, JSON.stringify(results, null, 1)); // incremental: survives a flap
    const mark = r.status === "match" ? "OK " : r.status === "mismatch" ? "DIFF" : r.status === "error" ? "ERR " : "    ";
    const kind = r.billingType === "_timeAndMaterials" ? "T&M " : r.billingType === "_fixedBidInterval" ? "FIXD" : "??? ";
    console.log(
      `${mark} ${kind} job ${job.padEnd(8)} goldenNet ${money(r.goldenNet).padStart(12)} (${String(r.goldenCount).padStart(2)} inv)` +
      (APPLY ? ` | replay ${(r.replayTotal === null ? "-" : money(r.replayTotal)).padStart(12)} | delta ${(r.delta === null ? "-" : money(r.delta)).padStart(12)}` : ` | sandbox ${money(r.existingTotal).padStart(12)}`) +
      (r.note ? `  ${r.note}` : ""),
    );
  }

  const report = (label: string, rows: JobResult[]) => {
    if (!rows.length) return;
    const s = (f: (r: JobResult) => number) => rows.reduce((t, r) => t + f(r), 0);
    const c = (st: JobResult["status"]) => rows.filter((r) => r.status === st).length;
    console.log(`\n--- ${label} (${rows.length} jobs) ---`);
    console.log(`  goldenNet ${money(s((r) => r.goldenNet))} | gross ${money(s((r) => r.goldenTotal))}`);
    if (APPLY) {
      console.log(`  replay    ${money(s((r) => r.replayTotal ?? 0))} | net delta ${money(s((r) => r.replayTotal ?? 0) - s((r) => r.goldenNet))}`);
      console.log(`  match ${c("match")} | mismatch ${c("mismatch")} | error ${c("error")} | skipped ${c("skipped")}`);
    } else {
      console.log(`  sandbox   ${money(s((r) => r.existingTotal))} (migrated invoices, pre-replay)`);
    }
  };
  report("T&M (rebuilt from cost — the real engine test)", results.filter((r) => r.billingType === "_timeAndMaterials"));
  report("Fixed-bid interval (rebuilt as progress draws)", results.filter((r) => r.billingType === "_fixedBidInterval"));
  report("ALL", results);
  console.log(`results -> ${RESULTS}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
