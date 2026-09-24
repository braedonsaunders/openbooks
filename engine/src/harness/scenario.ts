import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { businessToday } from "../platform/business-date.ts";
import { db, env, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
import { abs, cmp, fromUnits, toUnits } from "../money/money.ts";
import { runUserSql } from "../platform/sqlapi.ts";
import { isUuid } from "../platform/uuid.ts";

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
  /** CI run that produced this checkpoint, for cross-artifact traceability. */
  runId: string | null;
  /** Balance-mode checks are AS-OF this date (last closed period end). */
  cutoff: string;
  cutoffSource: string;
  counts: Record<string, number>;
  /** Trial-balance total debits/credits and per-account balances (hashable). */
  trialBalance: { debits: string; credits: string; accounts: number };
  controlTieOut: { account: string; number: string | null; kind: string; gl: string; subledger: string; direct: string; diff: string }[];
  inventoryTieOut: { subsidiary: string; account: string; number: string | null; methods: string; gl: string; subledger: string; diff: string }[];
  checks: Check[];
  timings: ReportTiming[];
  pass: boolean;
}

async function one<T extends Record<string, unknown> = Record<string, unknown>>(q: ReturnType<typeof sql>) {
  const r = (await db.execute<T>(q));
  return r.rows[0]!;
}
async function all<T extends Record<string, unknown> = Record<string, unknown>>(q: ReturnType<typeof sql>) {
  const r = (await db.execute<T>(q));
  return r.rows;
}

/** Run the non-destructive fixture verification for one org. */
/**
 * The runtime role the probe assumes when the harness login bypasses RLS.
 * Parsed from OPENBOOKS_RUNTIME_DB_URL the same way bootstrap parses it
 * (invalid role names are refused, never interpolated).
 */
function runtimeProbeRole(): string {
  const raw = env.OPENBOOKS_RUNTIME_DB_URL?.trim();
  if (!raw) throw new Error("rls probe refused: OPENBOOKS_RUNTIME_DB_URL is not set, so no RLS-subject role can be assumed");
  let username: string;
  try {
    username = decodeURIComponent(new URL(raw).username);
  } catch {
    throw new Error("rls probe refused: OPENBOOKS_RUNTIME_DB_URL is not a valid URL");
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(username)) {
    throw new Error("rls probe refused: OPENBOOKS_RUNTIME_DB_URL carries no usable runtime role name");
  }
  return username;
}

export interface TableIsolationProbe {
  /** A non-bypassing role read the table (false when none could be assumed). */
  established: boolean;
  /** The foreign id was invisible through the base table. */
  tableHidden: boolean;
  /** Own-org documents visible in the same scope (non-vacuity witness). */
  ownDocs: number;
  /** Empty on success; the named reason otherwise (and on role switch). */
  detail: string;
}

/**
 * The base-table half of the rls-org-isolation probe, on ONE pool client in
 * this org's scope inside a READ ONLY transaction. PostgreSQL does not apply
 * RLS (FORCE included) to a superuser or BYPASSRLS login — the CI and
 * rehearsal harness logins — so reading through the pool as-is sees every
 * row and the probe would fail for the wrong reason (or, worse, a policy
 * regression could hide behind the bypass). When the login bypasses, assume
 * the runtime role first with SET LOCAL ROLE and re-check; when no
 * non-bypassing role can be established the probe reports unestablished
 * rather than passing vacuously or false-positiving.
 */
export async function probeTableIsolation(orgId: string, foreignId: string): Promise<TableIsolationProbe> {
  const refused = (detail: string): TableIsolationProbe => ({
    established: false,
    tableHidden: false,
    ownDocs: 0,
    detail,
  });
  return withOrgContext(orgId, async () => {
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("begin read only");
      await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)", [
        orgId,
      ]);
      const login = (
        await client.query(
          "select current_user as login, coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), true) as bypass",
        )
      ).rows[0] as { login: string; bypass: boolean };
      let switchNote = "";
      if (login.bypass) {
        let role: string;
        try {
          role = runtimeProbeRole();
        } catch (error) {
          await client.query("rollback");
          return refused(
            `probe connection bypasses RLS as ${login.login} and ${(error instanceof Error ? error.message : String(error)).toLowerCase()}`,
          );
        }
        try {
          await client.query(`set local role "${role}"`);
        } catch (error) {
          await client.query("rollback");
          return refused(
            `probe connection bypasses RLS as ${login.login} and could not assume runtime role ${role}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const after = (
          await client.query(
            "select current_user as login, coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), true) as bypass",
          )
        ).rows[0] as { login: string; bypass: boolean };
        if (after.bypass) {
          await client.query("rollback");
          return refused(
            `probe connection bypasses RLS and no runtime role could be assumed (still bypassing as ${after.login} after assuming ${role})`,
          );
        }
        switchNote = ` [table half assumed runtime role ${role}; harness login ${login.login} bypasses RLS]`;
      }
      const seen = await client.query("select id from documents where id = $1", [foreignId]);
      const own = await client.query("select count(*)::int as n from documents where org_id = $1", [orgId]);
      await client.query("commit");
      return {
        established: true,
        tableHidden: (seen.rowCount ?? 0) === 0,
        ownDocs: (own.rows[0] as { n: number }).n,
        detail: switchNote,
      };
    } catch (error) {
      try {
        await client?.query("rollback");
      } catch {
        // The connection is already broken; release discards it.
      }
      throw error;
    } finally {
      client?.release();
    }
  });
}

export async function runScenario(
  orgId: string,
  opts: { at: string; gitSha?: string | null; runId?: string | null } = { at: "" },
): Promise<Checkpoint> {
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
  // With no closed period and no postings to anchor on, the checks run as of
  // the org's business day, never the UTC day.
  const cutoff = cut.cutoff ?? (await businessToday(orgId));
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

  // -- CHECK 2b: every book balances (functional amount grouped by book) -----
  // Lines carry no book of their own — the book lives on the entry — so this
  // is implied by per-entry balance today. It is asserted anyway, explicitly,
  // because the invariant is per-book ("in every book"): the day a line can
  // carry a different book than its entry, the global sum can still net to
  // zero across books while one book drifts. One grouped scan.
  const bookBal = await all<{ code: string; s: string }>(sql`
    select b.code, coalesce(sum(l.amount), 0)::text as s
      from accounting_books b
      left join journal_entries e on e.book_id = b.id and e.status in ('posted','reversed')
      left join journal_lines l on l.entry_id = e.id
     where b.org_id = ${orgId}
     group by b.code`);
  const worstBook = bookBal.reduce(
    (worst, row) => cmp(abs(row.s), abs(worst.s)) > 0 ? row : worst,
    { code: "", s: "0" },
  );
  checks.push({
    name: "per-book-balance",
    ok: bookBal.every((row) => cmp(abs(row.s), "0.0050") < 0),
    detail: `${bookBal.length} books; worst |Σ| = ${worstBook.s} on ${worstBook.code || "(none)"} (want < 0.005)`,
  });

  // -- CHECK 2c: every posted entry balances in transaction currency --------
  // The storage trigger pins the functional amount; the txn_amount side is
  // only pinned per line (jl_fx_consistent: amount = round(txn × fx)). Every
  // entry on every cluster today is single-currency AND single-rate, so the
  // txn sums are all exactly zero — this check pins that second dimension so
  // a future mixed-rate line cannot silently move value between currencies
  // while the functional sum still nets to zero.
  const tunbal = await one<{ n: string }>(sql`
    select count(*) n from (
      select e.id from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${orgId} and e.status in ('posted','reversed')
       group by e.id having abs(sum(l.txn_amount)) >= 0.005) x`);
  checks.push({ name: "per-entry-txn-balance", ok: Number(tunbal.n) === 0, detail: `${tunbal.n} posted entries do not balance in txn currency (want 0)` });

  // -- CHECK 3: open_balance is fresh (stored == recomputed) -------------------
  // Cached balances are denominated in the DOCUMENT currency (migration
  // 0100): open-item txn amounts minus the applied transaction amounts
  // (source-side for from-lines, target-side for to-lines). This mirrors
  // 0100's formula line for line instead of calling
  // document_open_balance_amount, so the harness stays an independent
  // backstop rather than a tautology. The pre-0100 functional formula
  // (abs(amount) minus a.amount) reads every foreign-currency document as
  // stale; do not regress to it.
  const drift = await one<{ n: string; m: string; worst: string | null }>(sql`
    with scoped as (
      select d.id, d.document_number, d.currency, d.open_balance as stored, d.posted_entry_id
        from documents d
       where d.org_id=${orgId} and d.status='posted' and d.posted_entry_id is not null and d.open_balance is not null
         and exists (select 1 from journal_entries e2 where e2.id = d.posted_entry_id and e2.posting_date <= ${cutoff})),
    calc as (
      select s.id,
             (select case when count(jl.id)=0 then null
                else sum(abs(jl.txn_amount)) - coalesce(sum(ap.applied),0) end
               from journal_lines jl
               left join lateral (
                 select sum(case when a.from_line_id=jl.id then a.source_transaction_amount
                                 else a.target_transaction_amount end) as applied
                   from applications a
                  where (a.to_line_id=jl.id or a.from_line_id=jl.id) and a.unapplied_at is null
                    and a.org_id=${orgId}
               ) ap on true
              where jl.entry_id=s.posted_entry_id and jl.org_id=${orgId} and jl.is_open_item) as recomputed
        from scoped s),
    stale as (
      select s.document_number from scoped s join calc c on c.id = s.id
       where s.stored is distinct from c.recomputed),
    mixed as (
      select distinct s.document_number
        from scoped s
        join journal_lines jl on jl.entry_id=s.posted_entry_id and jl.org_id=${orgId} and jl.is_open_item
       where jl.currency is distinct from s.currency)
    select (select count(*) from stale) as n,
           (select count(*) from mixed) as m,
           (select string_agg(x.document_number, ', ')
              from ((select document_number from stale union select document_number from mixed)
                    order by 1 limit 3) x) as worst`);
  checks.push({
    name: "open-balance-fresh",
    ok: Number(drift.n) === 0 && Number(drift.m) === 0,
    detail: `${drift.n} closed-period documents have stale open_balance (want 0)` +
      (Number(drift.m) > 0 ? `; ${drift.m} have open-item lines in another currency than the document (want 0)` : "") +
      (drift.worst ? ` — worst: ${drift.worst}` : ""),
  });

  // -- CHECK 3b: header arithmetic — total == subtotal + tax_total ----------
  // Holds for every document of every kind and status on every cluster: the
  // header is a pure function of its two components (migration 0017 pins the
  // line tie; this pins the header sum). Half-cent tolerance for per-line
  // rounding carried into the header.
  const hdrArith = await one<{ n: string; worst: string | null }>(sql`
    select count(*) n, max(abs(total - (subtotal + tax_total)))::text as worst
      from documents
     where org_id = ${orgId} and abs(total - (subtotal + tax_total)) > 0.005`);
  checks.push({
    name: "document-header-arithmetic",
    ok: Number(hdrArith.n) === 0,
    detail: `${hdrArith.n} documents with total ≠ subtotal + tax_total (want 0; worst ${hdrArith.worst ?? "—"})`,
  });

  // -- CHECK 3c: header↔lines — the 0017 storage tie, over state ------------
  // Mirrors assert_document_totals_match_lines EXACTLY (same formulas, same
  // exact numeric equality, same line-org scoping, same journal-shaped kinds,
  // same lineless vacuity) so storage and state can never disagree about what
  // the invariant IS:
  // - commercial kinds: subtotal = Σ amounts, tax_total = Σ tax_amounts,
  //   total = subtotal + tax_total.
  // - journal-shaped kinds ('journal', 'pay_run'): lines are signed legs
  //   balancing to zero; total = Σ positive amounts (the debit-side view),
  //   tax_total = Σ tax_amounts, subtotal = total − tax_total.
  // - documents with no lines are vacuously conforming (counted, not gated):
  //   payments and manual journals carry header-only amounts, and empty
  //   drafts exist before their first line.
  // No tolerance: numeric(19,4) arithmetic is exact. The refresh trigger
  // maintains the header after every line mutation and the assert trigger
  // rejects any contradiction at commit — both unconditional since 0078, so
  // a mismatch is unplantable through any writer and this check is entailed
  // rather than independent. It stays as the state-side mirror so storage
  // and state can never disagree about what the invariant IS.
  const lineTie = await one<{ n: string; skipped: string }>(sql`
    with t as (
      select d.id, d.kind, d.subtotal, d.tax_total, d.total,
             count(dl.id) as nlines,
             coalesce(sum(dl.amount), 0) as asum,
             coalesce(sum(dl.tax_amount), 0) as tsum,
             coalesce(sum(dl.amount) filter (where dl.amount > 0), 0) as dsum
        from documents d
        left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
       where d.org_id = ${orgId}
       group by d.id
    )
    select count(*) filter (
             where nlines > 0 and (
               case when kind in ('journal', 'pay_run')
                 then tax_total <> tsum or total <> dsum or subtotal <> dsum - tsum
                 else subtotal <> asum or tax_total <> tsum or total <> asum + tsum
               end))::text as n,
           count(*) filter (where nlines = 0)::text as skipped
      from t`);
  let lineTieDetail = `${lineTie.n} documents with headers ≠ own lines (want 0; ${lineTie.skipped} lineless docs skipped)`;
  if (Number(lineTie.n) > 0) {
    const worstLines = await all<{ document_number: string; kind: string }>(sql`
      with t as (
        select d.id, d.document_number, d.kind
          from documents d
          left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
         where d.org_id = ${orgId}
         group by d.id
        having count(dl.id) > 0 and (
          case when d.kind in ('journal', 'pay_run')
            then d.tax_total <> coalesce(sum(dl.tax_amount), 0)
              or d.total <> coalesce(sum(dl.amount) filter (where dl.amount > 0), 0)
              or d.subtotal <> coalesce(sum(dl.amount) filter (where dl.amount > 0), 0) - coalesce(sum(dl.tax_amount), 0)
            else d.subtotal <> coalesce(sum(dl.amount), 0)
              or d.tax_total <> coalesce(sum(dl.tax_amount), 0)
              or d.total <> coalesce(sum(dl.amount), 0) + coalesce(sum(dl.tax_amount), 0)
          end)
      )
      select document_number, kind from t order by document_number limit 5`);
    lineTieDetail += ` — e.g. ${worstLines.map((w) => `${w.document_number}(${w.kind})`).join(", ")}`;
  }
  checks.push({ name: "document-lines-tieout", ok: Number(lineTie.n) === 0, detail: lineTieDetail });

  // -- CHECK 3d: header↔journal — the header amount must be traceable -------
  // "Header total equals the debit sum" is the loose slogan; the ledger is
  // subtler. A retainage invoice's gross debit sum EXCEEDS its total (the
  // holdback leg inflates both sides while the AR leg equals the total); a
  // check paying down cards nets adjustments INSIDE the entry so neither side
  // equals the total while the bank leg does; a pay run splits the money side
  // across five liability accounts so no single leg equals the total while
  // the side sums do. Each granularity below is a real posting shape, and the
  // header must appear at one of them — as the open-item (claim) total, as a
  // whole journal side, as one account's net, or as a single settlement leg:
  // - docs WITH open-item legs (invoices, bills, payments, credits): the
  //   claim legs are the header, converted at the doc fx rate.
  // - cash docs with NO open-item legs (checks, transfers, journals,
  //   pay runs, deposits): min over debit side / credit side / best single
  //   account net / largest single leg.
  // What this deliberately does NOT assert: leg completeness (a netted
  // adjustment pair inside a legacy import entry is invisible here — balance
  // and the subledger ties still cover the money). Tolerance is half a cent
  // per document line: rounding only. Zero-total cash docs with no open legs
  // claim nothing and are counted, not gated.
  const docTie = await one<{ bad: string; skipped: string }>(sql`
    with docs as (
      select d.id, abs(d.total * d.fx_rate) as ht,
             (select count(*) from document_lines dl where dl.document_id = d.id) as nlines
        from documents d
       where d.org_id = ${orgId} and d.status = 'posted' and d.posted_entry_id is not null
    ),
    legs as (
      select l.entry_id,
             count(*) filter (where l.is_open_item) as nopen,
             coalesce(sum(case when l.is_open_item then l.amount else 0 end), 0) as osum,
             coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as dside,
             coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0) as cside,
             coalesce(max(abs(l.amount)), 0) as bigleg
        from journal_lines l
       where l.org_id = ${orgId}
       group by l.entry_id
    ),
    acct_nets as (
      select d.id, abs(d.ht - abs(sum(l.amount))) as acct_gap
        from docs d
        join journal_lines l on l.entry_id = (select posted_entry_id from documents where id = d.id)
       group by d.id, d.ht, l.account_id
    ),
    acct_min as (
      select id, min(acct_gap) as g from acct_nets group by id
    ),
    gap as (
      select d.id,
             case when legs.nopen > 0 then abs(d.ht - abs(legs.osum)) end as g_open,
             abs(d.ht - legs.dside) as g_debit,
             abs(d.ht - legs.cside) as g_credit,
             abs(d.ht - legs.bigleg) as g_leg,
             acct_min.g as g_acct,
             d.ht, d.nlines, legs.nopen
        from docs d
        join legs on legs.entry_id = (select posted_entry_id from documents where id = d.id)
        left join acct_min on acct_min.id = d.id
    )
    select count(*) filter (
             where not (ht < 0.005 and nopen = 0)
               and least(coalesce(g_open, 1e18), g_debit, g_credit, g_leg, coalesce(g_acct, 1e18))
                   > 0.005 * greatest(nlines, 1))::text as bad,
           count(*) filter (where ht < 0.005 and nopen = 0)::text as skipped
      from gap`);
  let docTieDetail = `${docTie.bad} posted documents with untraceable header totals (want 0; ${docTie.skipped} zero-total cash docs skipped)`;
  if (Number(docTie.bad) > 0) {
    const worstDocs = await all<{ document_number: string; kind: string }>(sql`
      with docs as (
        select d.id, d.document_number, d.kind, abs(d.total * d.fx_rate) as ht,
               (select count(*) from document_lines dl where dl.document_id = d.id) as nlines
          from documents d
         where d.org_id = ${orgId} and d.status = 'posted' and d.posted_entry_id is not null
      ),
      legs as (
        select l.entry_id,
               count(*) filter (where l.is_open_item) as nopen,
               coalesce(sum(case when l.is_open_item then l.amount else 0 end), 0) as osum,
               coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as dside,
               coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0) as cside,
               coalesce(max(abs(l.amount)), 0) as bigleg
          from journal_lines l
         where l.org_id = ${orgId}
         group by l.entry_id
      ),
      acct_nets as (
        select d.id, abs(d.ht - abs(sum(l.amount))) as acct_gap
          from docs d
          join journal_lines l on l.entry_id = (select posted_entry_id from documents where id = d.id)
         group by d.id, d.ht, l.account_id
      ),
      acct_min as (
        select id, min(acct_gap) as g from acct_nets group by id
      )
      select d.document_number, d.kind
        from docs d
        join legs on legs.entry_id = (select posted_entry_id from documents where id = d.id)
        left join acct_min on acct_min.id = d.id
       where not (d.ht < 0.005 and legs.nopen = 0)
         and least(coalesce(case when legs.nopen > 0 then abs(d.ht - abs(legs.osum)) end, 1e18),
                   abs(d.ht - legs.dside), abs(d.ht - legs.cside), abs(d.ht - legs.bigleg),
                   coalesce(acct_min.g, 1e18)) > 0.005 * greatest(d.nlines, 1)
       order by d.ht desc limit 5`);
    docTieDetail += ` — worst: ${worstDocs.map((w) => `${w.document_number}(${w.kind})`).join(", ")}`;
  }
  checks.push({ name: "document-journal-tieout", ok: Number(docTie.bad) === 0, detail: docTieDetail });

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

  // -- Inventory subledger ↔ GL tie-out per legal entity and control account.
  // The inventory control accounts are the asset accounts on item costing
  // profiles; every open cost layer they own must be ON the GL. This is the
  // gate the AR/AP tie-out has but inventory never had: five separate
  // variance-routing sites (revaluation without a variance account, receipt
  // PPV, assembly build variance, landed cost under standard) can rewrite the
  // layers while the asset account nets to zero or absorbs the difference,
  // and only an exact per-entity tie-out notices. Valuation follows the same
  // formula the product itself reports (Σ round(remaining × unit_cost) minus
  // provisional-cost issues), so the check can only fail when the LEDGER is
  // wrong, never when the arithmetic presentation differs. Rows are exact:
  // ANY nonzero diff fails. GL legs are grouped by their stamped subsidiary
  // (root-subsidiary rows whose line stamp was left null count as the root),
  // and the costing methods sharing an account are listed in the row — an org
  // that gives each method its own account gets one row per method/account.
  const invTie = await all<{ subsidiary_id: string; subsidiary: string; number: string | null; account: string; methods: string; gl: string; subledger: string }>(sql`
    with prof as materialized (
      select p.item_id, p.asset_account_id
        from item_inventory_profiles p
       where p.org_id = ${orgId}),
    layer_val as (
      select ln.subsidiary_id, prof.asset_account_id,
             sum(round(ln.remaining_quantity * ln.unit_cost, 4)) as value
        from cost_layers ln
        join prof on prof.item_id = ln.item_id
       where ln.org_id = ${orgId}
       group by ln.subsidiary_id, prof.asset_account_id),
    prov_val as (
      select mv.subsidiary_id, prof.asset_account_id,
             sum(round(pc.remaining_quantity * pc.provisional_unit_cost, 4)) as value
        from inventory_provisional_costs pc
        join inventory_movements mv on mv.id = pc.issue_movement_id and mv.org_id = pc.org_id
        join prof on prof.item_id = pc.item_id
       where pc.org_id = ${orgId}
       group by mv.subsidiary_id, prof.asset_account_id),
    value_rows as (
      select coalesce(l.subsidiary_id, p.subsidiary_id) as subsidiary_id,
             coalesce(l.asset_account_id, p.asset_account_id) as account_id,
             coalesce(l.value, 0) - coalesce(p.value, 0) as value
        from layer_val l
        full outer join prov_val p
          on p.subsidiary_id = l.subsidiary_id and p.asset_account_id = l.asset_account_id),
    gl as (
      select coalesce(l.subsidiary_id, (select s.id from subsidiaries s where s.org_id = ${orgId} and s.parent_id is null order by s.created_at limit 1)) as subsidiary_id,
             a.id as account_id, sum(l.amount) as bal
        from accounts a
        join journal_lines l on l.account_id = a.id and l.org_id = a.org_id
        join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed')
       where a.org_id = ${orgId}
         and exists (select 1 from prof where prof.asset_account_id = a.id)
       group by 1, 2),
    pairs as (
      select subsidiary_id, account_id from value_rows
      union
      select subsidiary_id, account_id from gl)
    select pr.subsidiary_id, s.name as subsidiary, a.number, a.name as account,
           (select string_agg(distinct p.costing_method, ',' order by p.costing_method)
              from item_inventory_profiles p
             where p.org_id = ${orgId} and p.asset_account_id = pr.account_id) as methods,
           coalesce(v.value, 0)::text as subledger, coalesce(g.bal, 0)::text as gl
      from pairs pr
      join subsidiaries s on s.id = pr.subsidiary_id
      join accounts a on a.id = pr.account_id
      left join value_rows v on v.subsidiary_id = pr.subsidiary_id and v.account_id = pr.account_id
      left join gl g on g.subsidiary_id = pr.subsidiary_id and g.account_id = pr.account_id
     order by s.name, a.number`);
  const inventoryTieOut = invTie.map((r) => {
    const diff = toUnits(r.gl) - toUnits(r.subledger);
    return { subsidiary: r.subsidiary, account: r.account, number: r.number, methods: r.methods ?? "", gl: r.gl, subledger: r.subledger, diff: fromUnits(diff) };
  });
  const worstInvTie = inventoryTieOut.reduce(
    (worst, row) => cmp(abs(row.diff), worst) > 0 ? abs(row.diff) : worst,
    "0.0000",
  );
  checks.push({
    name: "inventory-subledger-gl-tieout",
    ok: cmp(worstInvTie, "0.0000") === 0,
    detail: `${inventoryTieOut.length} control-account/entity ties across ${new Set(inventoryTieOut.map((r) => r.methods)).size} method sets; worst |GL − Σ open layers| = ${worstInvTie}`,
  });

  // -- CHECK 5: gl_month_activity == direct sum over journal lines -----------
  // Dashboards and the cash tile read the maintained aggregate, not the
  // lines. The triggers keep it exact (verified: zero drift on every org on
  // the shared cluster, including 8,101 aggregate rows on production), so ANY
  // nonzero diff is a real maintenance bug — a skipped trigger, a
  // sandbox_wipe that never rebuilt, a bulk path that bypassed the line
  // trigger. Compared per (account, month, subsidiary), the aggregate's own
  // grain: debit_total, credit_total exact to half a cent, line_count exact.
  const monthAgg = await one<{ rows_: string; bad: string }>(sql`
    with direct as (
      select l.org_id, l.account_id, date_trunc('month', e.posting_date)::date as month, l.subsidiary_id,
             sum(case when l.amount > 0 then l.amount else 0 end) as d,
             sum(case when l.amount < 0 then -l.amount else 0 end) as c,
             count(*) as n
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${orgId} and e.status in ('posted', 'reversed')
       group by 1, 2, 3, 4
    )
    select count(*)::text as rows_,
           count(*) filter (
             where abs(coalesce(g.debit_total, 0) - coalesce(x.d, 0)) > 0.005
                or abs(coalesce(g.credit_total, 0) - coalesce(x.c, 0)) > 0.005
                or coalesce(g.line_count, 0) <> coalesce(x.n, 0))::text as bad
      from gl_month_activity g
      full outer join direct x
        on x.account_id = g.account_id and x.month = g.month
       and x.subsidiary_id is not distinct from g.subsidiary_id
     where coalesce(g.org_id, x.org_id) = ${orgId}`);
  checks.push({
    name: "gl-month-activity-tieout",
    ok: Number(monthAgg.bad) === 0,
    detail: `${monthAgg.rows_} aggregate rows; ${monthAgg.bad} drifted from a direct sum over journal lines (want 0)`,
  });

  // -- CHECK 6: org isolation (RLS), catalog + live probe --------------------
  // "An org's data is never readable from another org, by any reader." Two
  // layers, both non-destructive:
  // (a) catalog: every public table carrying org_id must have RLS enabled +
  //     FORCED (so table owners are gated too) + at least one policy. A new
  //     org-scoped table without all three is the defect class this pins.
  // (b) live: from inside THIS org's read scope, another org's document must
  //     be invisible through the base table AND through the openbooks_query
  //     view web readers use. The probe also reads its own documents in the
  //     same scope so a silently-failed-closed scope cannot pass vacuously —
  //     except on an org with no documents yet, which the detail says aloud
  //     (the committed RLS red-test covers that case with two scratch orgs).
  const rlsCatalog = await all<{ tbl: string; rls: boolean; force: boolean; npol: string }>(sql`
    with t as (
      select c.relname as tbl, c.relrowsecurity as rls, c.relforcerowsecurity as force,
             count(pol.polname) as npol
        from pg_class c
        join pg_namespace nsp on nsp.oid = c.relnamespace
        left join pg_policy pol on pol.polrelid = c.oid
       where nsp.nspname = 'public' and c.relkind = 'r'
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id')
       group by 1, 2, 3
    )
    select * from t where not (rls and force and npol > 0)`);
  let rlsOk = rlsCatalog.length === 0;
  let rlsDetail = rlsCatalog.length === 0
    ? "catalog clean"
    : `catalog gaps: ${rlsCatalog.map((r) => r.tbl).join(", ")}`;
  if (rlsOk) {
    const foreign = await withBypassContext(async () => {
      const r = await db.execute<{ id: string }>(sql`
        select id from documents where org_id <> ${orgId} limit 1`);
      return r.rows[0] ?? null;
    });
    if (!foreign) {
      rlsDetail += "; no foreign-org rows anywhere on this cluster — live probe vacuous, catalog-only";
    } else {
      const tableProbe = await probeTableIsolation(orgId, foreign.id);
      // The governed view scopes by its own temp-table tenant context, which
      // the app-pool scope above does not establish — reading the view there
      // returns empty with or without isolation, a vacuous proof. Read it the
      // way web readers do: runUserSql establishes the temp context and the
      // tenant GUCs and executes as the SELECT-only role, so the view
      // predicate and the base-table policies must genuinely agree. (The
      // committed RLS red-test pins both this mechanism and the table half
      // with scratch orgs; this probe reuses them against live foreign rows.)
      if (!isUuid(foreign.id)) {
        throw new Error("rls probe refused: foreign document id is not a UUID");
      }
      const seenView = await runUserSql(
        `select id from documents where id = '${foreign.id}'`,
        { orgId },
      );
      rlsOk = tableProbe.established && tableProbe.tableHidden && seenView.rowCount === 0;
      rlsDetail += tableProbe.established
        ? `; foreign doc invisible via table=${tableProbe.tableHidden} view=${seenView.rowCount === 0}, own docs visible=${tableProbe.ownDocs}${tableProbe.detail}`
        : `; ${tableProbe.detail}`;
      if (tableProbe.established && tableProbe.ownDocs === 0) {
        rlsDetail += " (empty org — own-visibility half of the probe not provable here; see the committed RLS red-test)";
      }
    }
  }
  checks.push({ name: "rls-org-isolation", ok: rlsOk, detail: rlsDetail });

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
    orgId, orgName: org.name, at: opts.at, gitSha: opts.gitSha ?? null, runId: opts.runId ?? null,
    cutoff, cutoffSource,
    counts,
    trialBalance: { debits: tb.debits, credits: tb.credits, accounts: Number(tb.accounts) },
    controlTieOut, inventoryTieOut, checks, timings, pass,
  };
}
