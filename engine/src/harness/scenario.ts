import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { abs, cmp, fromUnits, toUnits } from "../money.ts";

/**
 * Scenario / close harness — turns a migrated company into a verifiable golden
 * fixture. This module holds the NON-DESTRUCTIVE checks: double-entry integrity,
 * subledger↔GL tie-out, open-balance freshness, and a report-latency benchmark,
 * plus a checkpoint the caller can persist and diff across runs. Closing every
 * period and asserting closed-period posts are rejected is destructive (it locks
 * periods) and belongs on a sandbox clone — see close-scenario.ts.
 *
 * Every figure is a signed decimal string in base currency, debit-positive, so
 * checkpoints are stable and diffable.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReportTiming {
  report: string;
  ms: number;
  rows: number;
}

export interface Checkpoint {
  orgId: string;
  orgName: string;
  /** Caller-supplied ISO timestamp (engine has Date; keep it explicit anyway). */
  at: string;
  gitSha: string | null;
  /** Balance-mode checks are AS-OF this date (last closed period end). */
  cutoff: string;
  cutoffSource: string;
  counts: Record<string, number>;
  /** Trial-balance total debits/credits and per-account balances (hashable). */
  trialBalance: { debits: string; credits: string; accounts: number };
  controlTieOut: { account: string; number: string | null; kind: string; gl: string; subledger: string; direct: string; diff: string }[];
  checks: Check[];
  timings: ReportTiming[];
  pass: boolean;
}

async function one<T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  const r = (await db.execute(q)) as unknown as { rows: T[] };
  return r.rows[0]!;
}
async function all<T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await db.execute(q)) as unknown as { rows: T[] };
  return r.rows;
}

/** Run the non-destructive fixture verification for one org. */
export async function runScenario(orgId: string, opts: { at: string; gitSha?: string | null } = { at: "" }): Promise<Checkpoint> {
  const org = await one<{ name: string }>(sql`select name from orgs where id = ${orgId}`);
  const checks: Check[] = [];
  const timings: ReportTiming[] = [];

  // -- counts -----------------------------------------------------------------
  const docCount = await one<{ n: string }>(sql`select count(*) n from documents where org_id = ${orgId}`);
  const postedDocs = await one<{ n: string }>(sql`select count(*) n from documents where org_id = ${orgId} and status = 'posted'`);
  const entryCount = await one<{ n: string }>(sql`select count(*) n from journal_entries where org_id = ${orgId} and status in ('posted','reversed')`);
  const lineCount = await one<{ n: string }>(sql`select count(*) n from journal_lines l join journal_entries e on e.id = l.entry_id where l.org_id = ${orgId} and e.status in ('posted','reversed')`);
  const counts = {
    documents: Number(docCount.n), postedDocuments: Number(postedDocs.n),
    postedEntries: Number(entryCount.n), postedLines: Number(lineCount.n),
  };

  // -- cutoff: verify AS-OF the last CLOSED period, not the live current month.
  // The current (open) month always carries in-flight activity and mirror-lag
  // drift; a golden fixture is only meaningful over stable, reconciled periods.
  // Prefer the latest period whose GL module is locked 'closed'; if none is
  // closed yet, fall back to the end of the month before the latest posting
  // (never the live month). Balance-mode checks and the report benchmark run
  // as-of this date; open-item figures are reconstructed point-in-time to it.
  const cut = await one<{ cutoff: string | null; src: string }>(sql`
    select
      coalesce(
        (select max(p.ends_on)::text from accounting_periods p
           join period_locks pl on pl.period_id = p.id and pl.module = 'gl' and pl.state = 'closed'
          where p.org_id = ${orgId}),
        (select (date_trunc('month', max(e.posting_date)) - interval '1 day')::text
           from journal_entries e where e.org_id = ${orgId} and e.status in ('posted','reversed'))
      ) as cutoff,
      case when exists (
        select 1 from accounting_periods p
          join period_locks pl on pl.period_id = p.id and pl.module = 'gl' and pl.state = 'closed'
         where p.org_id = ${orgId}
      ) then 'last-closed-gl-period' else 'prior-month-end (no closed GL period)' end as src`);
  const cutoff = cut.cutoff ?? new Date().toISOString().slice(0, 10);
  const cutoffSource = cut.src;
  const fyStart = `${cutoff.slice(0, 4)}-01-01`;

  // -- CHECK 1: global double-entry balance (sum of all posted lines = 0) ------
  const gb = await one<{ s: string }>(sql`
    select coalesce(sum(l.amount), 0) s from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and e.status in ('posted','reversed')`);
  checks.push({ name: "global-balance", ok: toUnits(gb.s) === 0n, detail: `sum(all posted lines) = ${gb.s} (want 0)` });

  // -- CHECK 2: every posted entry individually balances -----------------------
  const unbal = await one<{ n: string }>(sql`
    select count(*) n from (
      select e.id from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${orgId} and e.status in ('posted','reversed')
       group by e.id having abs(sum(l.amount)) >= 0.005) x`);
  checks.push({ name: "per-entry-balance", ok: Number(unbal.n) === 0, detail: `${unbal.n} posted entries do not balance (want 0)` });

  // -- CHECK 3: open_balance is fresh (stored == recomputed) -------------------
  const drift = await one<{ n: string }>(sql`
    with calc as (
      select d.id, d.open_balance as stored,
             (select case when count(jl.id)=0 then null
                else sum(abs(jl.amount)) - coalesce(sum(ap.applied),0) end
               from journal_lines jl
               left join lateral (
                 select sum(a.amount) as applied from applications a
                  where (a.to_line_id=jl.id or a.from_line_id=jl.id) and a.unapplied_at is null
               ) ap on true
              where jl.entry_id=d.posted_entry_id and jl.is_open_item) as recomputed
        from documents d
       where d.org_id=${orgId} and d.status='posted' and d.posted_entry_id is not null and d.open_balance is not null
         and exists (select 1 from journal_entries e2 where e2.id = d.posted_entry_id and e2.posting_date <= ${cutoff}))
    select count(*) n from calc where stored is distinct from recomputed`);
  checks.push({ name: "open-balance-fresh", ok: Number(drift.n) === 0, detail: `${drift.n} closed-period documents have stale open_balance (want 0)` });

  // -- CHECK 4: overhead net-zero pairs never move any account -----------------
  // The application mechanism (DR overhead acct [project] / CR same acct
  // untagged) must net to zero PER ACCOUNT, not just per entry — the doctrine
  // is that overhead never changes the company P&L.
  const ovh = await one<{ n: string }>(sql`
    select count(*) n from (
      select l.account_id from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${orgId} and e.origin = 'overhead_applied' and e.status in ('posted','reversed')
       group by l.account_id having abs(sum(l.amount)) >= 0.005) x`);
  checks.push({ name: "overhead-pair-zero", ok: Number(ovh.n) === 0, detail: `${ovh.n} accounts moved by overhead_applied entries (want 0 — pairs must net to zero)` });

  // Netting to zero is necessary but NOT sufficient: a pair can net to zero and
  // still be applied backwards, putting a CREDIT on every job. The P&L looks
  // right while job cost is understated by the whole overhead amount — invisible
  // to a trial balance, visible only in job costing. Assert the direction too:
  // the project-tagged legs must be DEBITS.
  const ovhDir = await one<{ tagged: string }>(sql`
    select coalesce(sum(l.amount), 0) tagged from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and e.origin = 'overhead_applied'
       and e.status in ('posted','reversed') and l.project_id is not null`);
  const taggedTotal = Number(ovhDir.tagged);
  checks.push({
    name: "overhead-burdens-jobs",
    ok: taggedTotal >= -0.005,
    detail: `project-tagged overhead totals ${taggedTotal.toFixed(2)} (want >= 0 — burden must DEBIT jobs, not credit them)`,
  });

  // -- Labor clearing balance (informational): standards in, payroll out — the
  // residual is in-flight work + unposted variance, so it is reported, not gated.
  const clr = await one<{ b: string | null }>(sql`
    select (select coalesce(sum(l.amount), 0) from journal_lines l
             join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed')
            where l.org_id = ${orgId}
              and l.account_id = (select (settings->'controlAccounts'->>'laborClearing')::uuid from orgs where id = ${orgId})) b
     where exists (select 1 from orgs where id = ${orgId} and settings->'controlAccounts'->>'laborClearing' is not null)`);
  checks.push({ name: "labor-clearing", ok: true, detail: clr?.b != null ? `clearing balance = ${clr.b} (standards − payroll − variance; informational)` : "labor clearing not configured (inert)" });

  // -- Subledger ↔ GL tie-out for AR/AP control accounts, POINT-IN-TIME as-of
  // the cutoff. GL balance and open-item remaining are BOTH reconstructed to the
  // cutoff (payments applied after it don't reduce the balance, and their GL is
  // excluded too) so the volatile current month can't create a phantom mismatch.
  const tie = await all<{ account: string; number: string | null; kind: string; gl: string; subledger: string; direct: string }>(sql`
    with gl as (
      select a.id, a.name as account, a.number, a.type as kind, sum(l.amount) as gl
        from accounts a
        join journal_lines l on l.account_id = a.id
        join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
       where a.org_id = ${orgId} and a.type in ('asset_receivable','liability_payable')
       group by a.id, a.name, a.number, a.type),
    sub as (
      -- Signed point-in-time open balance per control account: each open-item
      -- line keeps its sign (invoices +, payments/credits −), reduced toward
      -- zero by the applications settled on/before the cutoff.
      select acc.id as id, sum(
          l.amount - sign(l.amount) * coalesce((
            select sum(ap.amount) from applications ap
              join journal_lines ol on ol.id = case when ap.to_line_id = l.id then ap.from_line_id else ap.to_line_id end
              join journal_entries oe on oe.id = ol.entry_id
             where (ap.to_line_id = l.id or ap.from_line_id = l.id)
               and ap.unapplied_at is null and ap.applied_on <= ${cutoff}
               and oe.posting_date <= ${cutoff}
          ), 0)) as subledger
        from documents d
        join journal_entries e on e.id = d.posted_entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
        join journal_lines l on l.entry_id = d.posted_entry_id and l.is_open_item
        join accounts acc on acc.id = l.account_id and acc.type in ('asset_receivable','liability_payable')
       where d.org_id = ${orgId} and d.status = 'posted'
       group by acc.id),
    direct as (
      -- Non-open-item postings straight to a control account (manual JEs,
      -- opening balances): legitimate activity outside the subledger.
      select a.id, sum(l.amount) as direct
        from accounts a
        join journal_lines l on l.account_id = a.id and not l.is_open_item
        join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
       where a.org_id = ${orgId} and a.type in ('asset_receivable','liability_payable')
       group by a.id)
    select gl.account, gl.number, gl.kind, gl.gl::text as gl,
           coalesce(sub.subledger,0)::text as subledger, coalesce(direct.direct,0)::text as direct
      from gl left join sub on sub.id = gl.id left join direct on direct.id = gl.id
     order by gl.number`);
  // GL = subledger (open-item aging) + direct (JEs to control). The residual
  // isolates application-graph anomalies (settlements that don't net between the
  // two open-item lines they link) — a real bug — from legitimate direct JEs.
  const controlTieOut = tie.map((r) => {
    const diff = toUnits(r.gl) - toUnits(r.subledger) - toUnits(r.direct);
    return { account: r.account, number: r.number, kind: r.kind, gl: r.gl, subledger: r.subledger, direct: r.direct, diff: fromUnits(diff) };
  });
  const worstTie = controlTieOut.reduce(
    (worst, row) => cmp(abs(row.diff), worst) > 0 ? abs(row.diff) : worst,
    "0.0000",
  );
  checks.push({
    name: "subledger-gl-tieout",
    ok: cmp(worstTie, "0.0100") < 0,
    detail: `${controlTieOut.length} control accounts; worst |GL − subledger − directJE| = ${worstTie}`,
  });

  // -- Report-latency benchmark (the inception-to-cutoff aggregation hot path) -
  const bench = async (name: string, q: ReturnType<typeof sql>) => {
    const t0 = performance.now();
    const rows = await all(q);
    timings.push({ report: name, ms: Math.round(performance.now() - t0), rows: rows.length });
  };
  // Trial balance (balance-mode: scans inception..cutoff).
  await bench("trial_balance", sql`
    select a.id, sum(l.amount) as bal from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
     where a.org_id = ${orgId} group by a.id having abs(sum(l.amount)) >= 0.005`);
  // Balance sheet aggregate (same inception scan).
  await bench("balance_sheet", sql`
    select a.type, sum(l.amount) as bal from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
     where a.org_id = ${orgId} group by a.type`);
  // P&L for the fiscal year up to the cutoff.
  await bench("profit_and_loss", sql`
    select a.id, sum(l.amount) as bal from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed') and e.posting_date between ${fyStart} and ${cutoff}
     where a.org_id = ${orgId} and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred') group by a.id`);
  // AR aging (open items by party, signed point-in-time as-of cutoff).
  await bench("ar_aging", sql`
    select d.party_id,
           sum(l.amount - sign(l.amount) * coalesce((
             select sum(ap.amount) from applications ap
               join journal_lines ol on ol.id = case when ap.to_line_id = l.id then ap.from_line_id else ap.to_line_id end
               join journal_entries oe on oe.id = ol.entry_id
              where (ap.to_line_id = l.id or ap.from_line_id = l.id)
                and ap.unapplied_at is null and ap.applied_on <= ${cutoff}
                and oe.posting_date <= ${cutoff}), 0)) ob
      from documents d
      join journal_entries e on e.id = d.posted_entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
      join journal_lines l on l.entry_id = d.posted_entry_id and l.is_open_item
     where d.org_id=${orgId} and d.status='posted' and d.kind in ('customer_invoice','customer_credit')
     group by d.party_id`);

  // -- trial-balance totals (for the checkpoint), as-of cutoff ----------------
  const tb = await one<{ debits: string; credits: string; accounts: string }>(sql`
    select coalesce(sum(case when l.amount>0 then l.amount else 0 end),0)::text debits,
           coalesce(sum(case when l.amount<0 then -l.amount else 0 end),0)::text credits,
           count(distinct a.id)::text accounts
      from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed') and e.posting_date <= ${cutoff}
     where a.org_id = ${orgId}`);

  const pass = checks.every((c) => c.ok);
  return {
    orgId, orgName: org.name, at: opts.at, gitSha: opts.gitSha ?? null,
    cutoff, cutoffSource,
    counts,
    trialBalance: { debits: tb.debits, credits: tb.credits, accounts: Number(tb.accounts) },
    controlTieOut, checks, timings, pass,
  };
}
