/**
 * Rassaun invoice replay + penny reconciliation harness.
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
  projectId: string | null;
  goldenCount: number;
  goldenTotal: number;
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

async function replayJob(job: string, golden: { foreigntotal: string }[], actor: string): Promise<JobResult> {
  const goldenTotal = golden.reduce((t, g) => t + num(g.foreigntotal), 0);
  const res: JobResult = {
    job, projectId: null, goldenCount: golden.length, goldenTotal,
    existingCount: 0, existingTotal: 0, deleted: 0,
    replayInvoiceId: null, replayTotal: null, delta: null, status: "planned",
  };

  const p = (await retry(() => db.execute(sql`
    select id from projects where org_id = ${SANDBOX_ORG} and code = ${job} limit 1`))) as any;
  const projectId = p.rows[0]?.id ?? null;
  res.projectId = projectId;
  if (!projectId) { res.status = "skipped"; res.note = "no project with this NetSuite job code"; return res; }

  const existing = await sandboxInvoices(projectId);
  res.existingCount = existing.length;
  res.existingTotal = existing.reduce((t, e) => t + num(e.total), 0);

  if (!APPLY) return res; // read-only plan

  // 1. Delete the migrated invoices through the product path (releases provenance).
  for (const inv of existing) {
    try {
      await retry(() => deleteDocument(inv.id, actor, { source: "rassaun-replay", reason: "invoice replay validation" }));
      res.deleted++;
    } catch (e) {
      res.status = "error";
      res.note = `delete ${inv.document_number}: ${String((e as Error).message).slice(0, 160)}`;
      return res;
    }
  }

  // 2. Ask the real billing engine to rebuild from the job's whole unbilled universe.
  const requestId = randomUUID();
  try {
    await retry(() => db.execute(sql`
      insert into billing_requests (id, org_id, project_id, request_number, invoice_type, basis,
                                    status, invoice_description, created_by)
      values (${requestId}, ${SANDBOX_ORG}, ${projectId}, ${"REPLAY-" + job}, 'final', 'date_range',
              'open', ${"Replay of NetSuite job " + job}, ${actor})`));
    const out = await retry(() => generateInvoiceFromBillingRequest(SANDBOX_ORG, actor, requestId));
    res.replayInvoiceId = out.id;
    const t = (await retry(() => db.execute(sql`select subtotal::numeric as sub from documents where id = ${out.id}`))) as any;
    res.replayTotal = num(t.rows[0]?.sub);
    res.delta = res.replayTotal - goldenTotal;
    res.status = Math.abs(res.delta) <= 0.005 ? "match" : "mismatch";
  } catch (e) {
    res.status = "error";
    res.note = String((e as Error).message).slice(0, 200);
  }
  return res;
}

(async () => {
  await assertSandbox();
  if (!existsSync(GOLDEN) || !existsSync(JOBSET)) throw new Error(`missing cached golden data (${GOLDEN} / ${JOBSET}) — run ns.ts first`);
  const goldenRows = JSON.parse(readFileSync(GOLDEN, "utf8")) as { job: string; foreigntotal: string }[];
  const jobset = JSON.parse(readFileSync(JOBSET, "utf8")) as { job: string }[];
  const byJob = new Map<string, { foreigntotal: string }[]>();
  for (const g of goldenRows) { const l = byJob.get(String(g.job)) ?? []; l.push(g); byJob.set(String(g.job), l); }

  const actor = await actorId();
  const jobs = (LIMIT > 0 ? jobset.slice(0, LIMIT) : jobset).map((j) => String(j.job));
  console.log(`${APPLY ? "REPLAY (destructive)" : "PLAN (read-only)"}: ${jobs.length} jobs\n`);

  const results: JobResult[] = [];
  for (const job of jobs) {
    const r = await replayJob(job, byJob.get(job) ?? [], actor);
    results.push(r);
    writeFileSync(RESULTS, JSON.stringify(results, null, 1)); // incremental: survives a flap
    const mark = r.status === "match" ? "OK " : r.status === "mismatch" ? "DIFF" : r.status === "error" ? "ERR " : "    ";
    console.log(
      `${mark} job ${job.padEnd(8)} golden ${money(r.goldenTotal).padStart(12)} (${String(r.goldenCount).padStart(2)} inv)` +
      ` | sandbox ${money(r.existingTotal).padStart(12)}` +
      (APPLY ? ` | replay ${(r.replayTotal === null ? "-" : money(r.replayTotal)).padStart(12)} | delta ${(r.delta === null ? "-" : money(r.delta)).padStart(10)}` : "") +
      (r.note ? `  ${r.note}` : ""),
    );
  }

  const sum = (f: (r: JobResult) => number) => results.reduce((t, r) => t + f(r), 0);
  console.log(`\n--- summary (${results.length} jobs) ---`);
  console.log(`golden total   ${money(sum((r) => r.goldenTotal))}`);
  console.log(`sandbox total  ${money(sum((r) => r.existingTotal))}  (pre-replay migrated invoices)`);
  if (APPLY) {
    console.log(`replay total   ${money(sum((r) => r.replayTotal ?? 0))}`);
    const c = (s: JobResult["status"]) => results.filter((r) => r.status === s).length;
    console.log(`match ${c("match")} | mismatch ${c("mismatch")} | error ${c("error")} | skipped ${c("skipped")}`);
  }
  console.log(`results -> ${RESULTS}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
