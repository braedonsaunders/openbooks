import { NON_POSTING_DOCUMENT_KINDS } from "../periods/period-policy.ts";
import {
  projectLossPolicyMode,
  unassessedLossContracts,
  unownedContractProjects,
} from "../projects/loss-contracts.ts";
import { incompletePostingEffectsCount } from "../periods/period-locks.ts";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { revaluationReadiness } from "./fx-revaluation.ts";
import { loadCloseRunContext } from "./readiness-context.ts";
import { resolveFxRateAgeLimit } from "../fx/rate-age-policy.ts";
import { commerceCloseChecks, type CommerceCloseCheck } from "./commerce-close.ts";
import { sourceEvidencePolicyActive } from "../banking/banking.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { unbilledAccrualReadiness } from "../projects/unbilled-accrual.ts";
import { unreconciledIntercompanyCount } from "../intercompany/reconciliation.ts";
import { periodEndJournalCloseCheck, type PeriodEndCloseCheck } from "./period-end-journals.ts";
import { excludePeriodEndJournals } from "../records/period-end-origins.ts";
import { bookReplicationReadiness } from "../journal/book-replication.ts";
import { dueUnpostedAmortization } from "../amortization/reconciliation.ts";
import { closeEquityPostings } from "../equity/period-postings.ts";
import { closeBankStatementScope, closeEntityScope } from "./close-scope.ts";
const nonPostingKindList = () =>
  sql.join(
    NON_POSTING_DOCUMENT_KINDS.map((k) => sql`${k}`),
    sql`, `,
  );

type ReadinessCheck = {
  code: string;
  taskKey: string;
  category: string;
  severity: "warning" | "error" | "critical";
  title: string;
  message: string;
  count: number;
  details?: Record<string, unknown>;
};

export async function readinessChecks(orgId: string, runId: string): Promise<ReadinessCheck[]> {
  const ctx = await loadCloseRunContext(orgId, runId);
  const subsidiaryIds = ctx.scope?.subsidiaryIds ?? [];
  const scoped = subsidiaryIds.length > 0;
  const inScope = (entity: SQL) => closeEntityScope(subsidiaryIds, entity);
  // Unattributed revenue lines fall back to the shared unscoped-posting
  // default (the hierarchy root) — the same fallback runRevenueRecognition
  // posts them under — never the oldest subsidiary.
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  // Documents without an assigned entity still require accountant attention;
  // never hide an unresolved posting assignment from an entity close.
  const documentScope = sql`(d.subsidiary_id is null or ${inScope(sql`d.subsidiary_id`)})`;
  const statementScope = closeBankStatementScope(orgId, subsidiaryIds);

  // Source-evidenced sign-offs satisfy bank readiness exactly like statement
  // sign-offs while the policy is on; off returns readiness to statements.
  // Absent on pre-seed orgs reads as on (see sourceEvidencePolicyActive).
  const sourceEvidenceOn = await sourceEvidencePolicyActive(orgId);
  // A spot rate older than the closing-rate age limit is not usable at
  // period end: revaluation and consolidation refuse it, so coverage does too.
  const closingRateLimit = await resolveFxRateAgeLimit(db, orgId, "closing", ctx.ends_on);

  const [
    postingEffects,
    drafts,
    missingPeriod,
    bank,
    depreciation,
    recognition,
    fx,
    fxReval,
    intercompany,
    variancePolicy,
  ] = await Promise.all([
    incompletePostingEffectsCount(db, {
      orgId,
      periodId: ctx.period_id,
      bookId: ctx.book_id,
      subsidiaryIds,
    }),
    db.execute(
      sql`
      select
        (select count(*) from journal_entries e where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status = 'draft'
          and (exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id and ${inScope(sql`l.subsidiary_id`)})
            or (not exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id) and ${inScope(sql`e.subsidiary_id`)})))
        +
        (select count(*) from documents d
          where d.org_id = ${orgId} and d.status in ('draft','pending_approval','approved')
            and d.kind not in (${nonPostingKindList()})
            -- Drafts and pending approvals without a period need approval
            -- before they can ever take one, so they stay open-draft work
            -- here instead of vanishing from the gate.
            and (d.posting_period_id = ${ctx.period_id}
              or (d.posting_period_id is null and d.status in ('draft','pending_approval')
                and coalesce(d.posting_date, d.document_date) between ${ctx.starts_on} and ${ctx.ends_on}))
            and ${documentScope}) as count`,
      "objects",
    ),
    db.execute(
      sql`
      select count(*) as count
        from documents d
       where d.org_id = ${orgId}
         -- Live entries only: a voided document dated in the period needs no posting period assigned.
         -- Approved only, matching the assignment preview row set exactly:
         -- drafts and pending approvals cannot take a period yet (they stay
         -- in drafts-open above), and posted documents derived theirs at
         -- post time, so counting them here names a backlog the assignment
         -- page can never clear.
         and d.status = 'approved'
         and d.kind not in (${nonPostingKindList()})
         and d.posting_period_id is null
         and coalesce(d.posting_date, d.document_date) between ${ctx.starts_on} and ${ctx.ends_on}
         and ${documentScope}`,
      "objects",
    ),
    // Bank-unreconciled returns the open accounts themselves (not just a
    // count) with per-account source-evidence coverage, so the close
    // detail names each account with cleared/uncleared line counts.
    db.execute(
      sql`
      with open_accounts as (
        select a.id, a.number, a.name
          from accounts a
         where a.org_id = ${orgId} and a.reconcilable and a.is_active and not a.is_summary
           and (
             exists (
               select 1 from bank_statement_lines bsl
                where bsl.org_id=${orgId} and bsl.account_id=a.id and ${statementScope}
                  and bsl.posted_on between ${ctx.starts_on} and ${ctx.ends_on}
             )
             or exists (
               select 1 from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
                where jl.org_id=${orgId} and jl.account_id=a.id and coalesce(jl.period_id,je.period_id)=${ctx.period_id}
                  and je.book_id=${ctx.book_id} and je.status in ('posted','reversed') and ${inScope(sql`jl.subsidiary_id`)}
                  and ${excludePeriodEndJournals(sql`je.origin`)}
             )
             or exists (
               select 1 from journal_lines jl
               join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
               join accounting_periods jp on jp.id=coalesce(jl.period_id,je.period_id) and jp.org_id=je.org_id
                where jl.org_id=${orgId} and jl.account_id=a.id and je.book_id=${ctx.book_id}
                  and je.status in ('posted','reversed') and jp.ends_on <= ${ctx.ends_on}
                  and ${excludePeriodEndJournals(sql`je.origin`)}
                  and ${inScope(sql`jl.subsidiary_id`)}
                group by jl.subsidiary_id having sum(jl.amount) <> 0
             )
           )
           and not exists (
             select 1 from reconciliations r
              where r.org_id = ${orgId} and r.account_id = a.id and r.status = 'signed_off'
                and r.through_date >= ${ctx.ends_on}
                and (${sourceEvidenceOn} or r.evidence_kind = 'statement')
           )
      )
      select o.id as account_id, o.number, o.name,
             count(jl.id) filter (
               where (jl.source_cleared_date is not null and jl.source_cleared_date <= ${ctx.ends_on})
                  or jl.reconciled_at is not null
             ) as cleared,
             count(jl.id) filter (
               where (jl.source_cleared_date is null or jl.source_cleared_date > ${ctx.ends_on})
                 and jl.reconciled_at is null
             ) as uncleared,
             s.connector as source_connector, s.reconciled_through::text as source_through
        from open_accounts o
        left join (
          select jl.id, jl.account_id, jl.source_cleared_date, jl.reconciled_at
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where jl.org_id = ${orgId} and je.book_id = ${ctx.book_id}
             and je.status in ('posted', 'reversed') and ${excludePeriodEndJournals(sql`je.origin`)}
             and jl.posting_date <= ${ctx.ends_on} and ${inScope(sql`jl.subsidiary_id`)}
        ) jl on jl.account_id = o.id
        left join source_reconciliation_state s on s.org_id = ${orgId} and s.account_id = o.id
       group by o.id, o.number, o.name, s.connector, s.reconciled_through
       order by o.number nulls last, o.name`,
      "objects",
    ),
    db.execute(
      sql`
      select count(*) as count
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join fixed_assets a on a.id=s.asset_id and a.org_id=s.org_id
       where l.org_id = ${orgId} and l.period_id = ${ctx.period_id}
         and s.book_id = ${ctx.book_id} and l.posted_amount is null and l.planned_amount <> 0
         and ${inScope(sql`a.subsidiary_id`)}`,
      "objects",
    ),
    // Unposted revenue recognition, measured the way runRevenueRecognition
    // measures due lines: unposted, nonzero, non-cancelled, non-forecast,
    // and due by period end (percent-complete catch-up is due as soon as
    // its period has started). Subsidiary attribution follows the runner's
    // own coalesce chain so entity-scoped runs see the same population.
    db.execute(
      sql`
      select count(*) as count
        from recognition_schedule_lines l
        join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join performance_obligations o on o.id = s.obligation_id and o.org_id = s.org_id
        join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
        left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
        left join documents doc on doc.id = dl.document_id and doc.org_id = dl.org_id
        left join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
        left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
       where l.org_id = ${orgId} and l.period_id = ${ctx.period_id}
         and s.book_id = ${ctx.book_id} and l.journal_entry_id is null and l.planned_amount <> 0
         and o.status <> 'cancelled' and not r.is_forecast
         and (p.ends_on <= ${ctx.ends_on}
              or (r.method = 'percent_complete' and p.starts_on <= ${ctx.ends_on}))
         and ${inScope(sql`coalesce(dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId})`)}`,
      "objects",
    ),
    db.execute(
      sql`
      select count(*) as count
        from (
          select distinct l.currency, l.subsidiary_id,
                 public.accounting_book_currency(${orgId}, e.book_id, l.subsidiary_id) as measurement_currency
            from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id}
             and e.status in ('posted','reversed') and ${inScope(sql`l.subsidiary_id`)}
             and l.currency is distinct from public.accounting_book_currency(${orgId}, e.book_id, l.subsidiary_id)
        ) c
       where not exists (
         select 1 from fx_rates f where f.org_id = ${orgId}
           and ((f.from_currency=c.currency and f.to_currency=c.measurement_currency)
             or (f.from_currency=c.measurement_currency and f.to_currency=c.currency))
           and f.rate_type = 'spot' and f.rate > 0 and f.as_of <= ${ctx.ends_on}
           and f.as_of >= ${ctx.ends_on}::date - ${closingRateLimit.maxAgeDays}::int
       ) and not exists (
         select 1 from fx_revaluation_rate_evidence evidence
          where evidence.org_id = ${orgId} and evidence.book_id = ${ctx.book_id}
            and evidence.period_id = ${ctx.period_id} and evidence.rate_date = ${ctx.ends_on}::date
            and evidence.subsidiary_id = c.subsidiary_id
            and evidence.transaction_currency = c.currency
            and evidence.measurement_currency = c.measurement_currency and evidence.rate > 0
            and not exists (
              select 1 from fx_revaluation_rate_evidence successor
               where successor.org_id = evidence.org_id and successor.supersedes_id = evidence.id
            )
       )`,
      "objects",
    ),
    // The revaluation ENGINE decides fx readiness: the same monetary
    // population, spot-rate lookup, and delta arithmetic runRevaluation
    // posts from. A position already at the period-end rate needs no entry
    // (the engine skips it), so it is not an exception; a position the
    // engine cannot reverse (no following period) is reported as its own
    // actionable exception below rather than as "unrevalued".
    revaluationReadiness(orgId, ctx.book_id, ctx.period_id, scoped ? subsidiaryIds : undefined),
    // Entity closes do not certify consolidated elimination. Only an org-wide
    // run evaluates this complete-group assertion; filtering its ledger would
    // manufacture a residual by omitting the counterparty.
    // Intercompany residuals are measured the way runAutoElimination
    // eliminates them: balance-sheet accounts as cumulative balances through
    // this period translated at the period's current rate, flow accounts as
    // this period's activity at its average rate, each (account,
    // subsidiary) total translated once into the elimination subsidiary's
    // currency, with the elimination subsidiary's own lines included at
    // par — so a group that eliminates cleanly reads zero per account,
    // whatever functional currencies its entities keep and however the
    // rate has moved since earlier eliminations. A foreign entity with no
    // consolidated rate cannot be measured at all; that is counted
    // separately, never as a residual.
    scoped && ctx.system_blueprint
      ? Promise.resolve([{ count: 0, missing_rates: 0 }])
      : db.execute(
          sql`
      select count(*) filter (where residual <> 0 and not coalesce(missing_rate, false)) as count,
             count(*) filter (where missing_rate) as missing_rates
        from (
        select account_id, sum(translated) as residual, bool_or(missing_rate) as missing_rate
          from (
          select a.id as account_id,
                 round(sum(l.amount) * max(case
                   when s.base_currency = ${ctx.elimination_currency} then 1
                   when a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
                     then consolidated.average_rate
                   else consolidated.current_rate
                 end), 4) as translated,
                 bool_or(s.base_currency <> ${ctx.elimination_currency} and consolidated.id is null) as missing_rate
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
            join accounting_periods p on p.id = e.period_id and p.org_id = e.org_id
            join accounts a on a.id = l.account_id and a.org_id = l.org_id and a.eliminate
            join subsidiaries s on s.id = l.subsidiary_id and s.org_id = l.org_id
            left join consolidated_fx_rates consolidated
              on consolidated.org_id = e.org_id
             and consolidated.period_id = ${ctx.period_id}
             and consolidated.from_currency = s.base_currency
             and consolidated.to_currency = ${ctx.elimination_currency}
           where e.org_id = ${orgId} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
             and ${excludePeriodEndJournals(sql`e.origin`)}
             and (e.period_id = ${ctx.period_id}
                  or (a.type not in ('income','income_other','cogs','expense','expense_other','expense_deferred')
                      and p.ends_on < ${ctx.ends_on}::date))
           group by a.id, l.subsidiary_id
          ) by_subsidiary
         group by account_id
      ) residuals`,
          "objects",
        ),
    db.execute(
      sql`
      select coalesce(rules->>'amount', '10000.0000') as amount,
             coalesce((rules->>'percent')::numeric, 20) as percent
        from close_policies where org_id = ${orgId} and code = 'material-variance' and is_active limit 1`,
      "objects",
    ),
  ]);

  // Name the documents behind an incomplete-effects count: the exception
  // tells the operator to retry terminal failures from the document, so it
  // must say which documents to open. Only queried on the failure path.
  let effectDocuments: string[] = [];
  if (postingEffects > 0) {
    effectDocuments = (
      await db.execute<{ document_number: string }>(
        sql`
      select distinct d.document_number
        from posting_effects pe
        join journal_entries e on e.id = pe.entry_id and e.org_id = pe.org_id
        join documents d on d.id = pe.document_id and d.org_id = pe.org_id
       where pe.org_id = ${orgId} and e.period_id = ${ctx.period_id}
         and e.book_id = ${ctx.book_id} and pe.status <> 'succeeded'
         and ${
           subsidiaryIds.length
             ? sql`(d.subsidiary_id is null or ${inScope(sql`d.subsidiary_id`)}
             or exists (select 1 from journal_lines l where l.org_id = e.org_id and l.entry_id = e.id and ${inScope(sql`l.subsidiary_id`)}))`
             : sql`true`
         }
       order by d.document_number limit 10`,
        "objects",
      )
    ).map((row) => row.document_number);
  }

  // Commerce completeness runs only when the run carries the task: the
  // step is created exactly when Sales Channels is on, and every check
  // reads clean on an org with no channel data — so a run without the task
  // skips the storefront calls entirely instead of proving nothing.
  let commerce: CommerceCloseCheck[] = [];
  const commerceTask = (
    await db.execute<{ id: string }>(
      sql`
      select id from close_run_tasks
       where run_id = ${runId} and org_id = ${orgId} and key = 'commerce-complete' limit 1`,
      "objects",
    )
  )[0];
  if (commerceTask) {
    commerce = await commerceCloseChecks(orgId, {
      startsOn: ctx.starts_on,
      endsOn: ctx.ends_on,
      bookId: ctx.book_id,
      subsidiaryIds,
    });
  }

  // The unbilled revenue accrual is current when a run would post nothing:
  // the accrual engine's own preview decides, so the step and the poster
  // agree to the cent. Only runs that carry the task pay for the valuation.
  let unbilledAccrual: { applies: boolean; pendingKeys: number; problem: string | null } = {
    applies: false,
    pendingKeys: 0,
    problem: null,
  };
  const unbilledAccrualTask = (
    await db.execute<{ id: string }>(
      sql`
      select id from close_run_tasks
       where run_id = ${runId} and org_id = ${orgId} and key = 'unbilled-revenue-accrued' limit 1`,
      "objects",
    )
  )[0];
  if (unbilledAccrualTask) {
    unbilledAccrual = await unbilledAccrualReadiness(
      orgId,
      ctx.period_id,
      scoped ? subsidiaryIds : undefined,
    );
  }

  // The year-end step is current when every legal entity's period-end
  // journals match what the generator would post now. Only runs that carry
  // the task pay for the measurement.
  let periodEnd: PeriodEndCloseCheck = { count: 0 };
  const periodEndTask = (
    await db.execute<{ id: string }>(
      sql`
      select id from close_run_tasks
       where run_id = ${runId} and org_id = ${orgId} and key = 'period-end-journals' limit 1`,
      "objects",
    )
  )[0];
  if (periodEndTask) {
    periodEnd = await periodEndJournalCloseCheck(orgId, {
      periodId: ctx.period_id,
      bookId: ctx.book_id,
      subsidiaryIds,
    });
  }

  // Full books must hold every replicable primary entry through period end.
  let bookReplication: Awaited<ReturnType<typeof bookReplicationReadiness>> = {
    missing: 0,
    books: [],
  };
  const bookReplicationTask = (
    await db.execute<{ id: string }>(
      sql`
      select id from close_run_tasks
       where run_id = ${runId} and org_id = ${orgId} and key = 'book-replication-complete' limit 1`,
      "objects",
    )
  )[0];
  if (bookReplicationTask) {
    bookReplication = await bookReplicationReadiness(db, {
      orgId,
      bookId: ctx.book_id,
      through: ctx.ends_on,
      subsidiaryIds: scoped ? subsidiaryIds : undefined,
    });
  }
  // Prepaid amortization is current when no active schedule holds a planned
  // period ending on or before the period end in this book and scope. Only
  // runs that carry the step pay for the count.
  const prepaidTask = (
    await db.execute<{ id: string }>(
      sql`
      select id from close_run_tasks
       where run_id = ${runId} and org_id = ${orgId} and key = 'prepaid-amortized' limit 1`,
      "objects",
    )
  )[0];
  const prepaidDue = prepaidTask
    ? await dueUnpostedAmortization(db, orgId, {
        endsOn: ctx.ends_on,
        bookId: ctx.book_id,
        subsidiaryIds: scoped ? new Set(subsidiaryIds) : null,
      })
    : { lines: 0, schedules: 0 };

  // Equity runs are current when no legal entity in scope with equity
  // records has a stock compensation or note interest change due through
  // period end. Only runs that carry the steps pay for the measurement.
  const equityTasks = (
    await db.execute<{ key: string }>(
      sql`
      select key from close_run_tasks
       where run_id = ${runId} and org_id = ${orgId} and key in ('equity-compensation-posted', 'equity-interest-accrued')`,
      "objects",
    )
  ).map((row) => row.key);
  const equityDue =
    equityTasks.length > 0
      ? await closeEquityPostings(orgId, {
          through: ctx.ends_on,
          subsidiaryIds: scoped ? subsidiaryIds : [],
        })
      : { compensation: [], interest: [] };

  const threshold = variancePolicy[0] ?? {
    amount: "10000.0000",
    percent: 20,
  };
  const variances = await db.execute<{ count: string }>(
    sql`
    with current_activity as (
      select l.account_id, l.subsidiary_id, sum(l.amount) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
         and ${excludePeriodEndJournals(sql`e.origin`)}
         and ${inScope(sql`l.subsidiary_id`)}
       group by l.account_id, l.subsidiary_id
    ), prior_period as (
      select p2.id from accounting_periods p2
       where p2.org_id = ${orgId} and p2.fiscal_calendar_id=${ctx.fiscal_calendar_id}
         and p2.ends_on < ${ctx.starts_on} and not p2.is_adjustment
       order by p2.ends_on desc limit 1
    ), prior_activity as (
      select l.account_id, l.subsidiary_id, sum(l.amount) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${orgId} and e.period_id = (select id from prior_period)
         and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed') and ${excludePeriodEndJournals(sql`e.origin`)}
         and ${inScope(sql`l.subsidiary_id`)}
       group by l.account_id, l.subsidiary_id
    ), entity_activity as (
      select coalesce(c.account_id,p.account_id) as account_id,
             coalesce(c.amount,0) as current_amount, coalesce(p.amount,0) as prior_amount
        from current_activity c full join prior_activity p
          on p.account_id=c.account_id and p.subsidiary_id=c.subsidiary_id
    )
    select count(*) as count
      from entity_activity v join accounts a on a.id=v.account_id and a.org_id=${orgId}
     where not a.is_summary
       and abs(v.current_amount-v.prior_amount) >= ${threshold.amount}::numeric
       and (v.prior_amount=0 or abs((v.current_amount-v.prior_amount)/nullif(abs(v.prior_amount),0)*100) >= ${threshold.percent}::numeric)`,
    "objects",
  );

  const segmentResiduals =
    (
      await db.execute<{ count: string }>(
        sql`select count(*)::text as count from (
    select d.key,l.subsidiary_id from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
    join segment_definitions d on d.org_id=l.org_id and d.is_active and d.is_balancing
    where l.org_id=${orgId} and e.book_id=${ctx.book_id} and e.status in ('posted','reversed') and e.posting_date<=${ctx.ends_on}
      and ${inScope(sql`l.subsidiary_id`)}
    group by d.key,l.subsidiary_id,case d.storage_column when 'subsidiary_id' then l.subsidiary_id::text
      when 'department_id' then l.department_id::text when 'project_id' then l.project_id::text
      when 'location_id' then l.location_id::text when 'class_id' then l.class_id::text else l.extra_dims->>d.key end
    having sum(l.amount)<>0
  ) residuals`,
        "objects",
      )
    )[0]?.count ?? "0";

  // Loss contracts: the effective project loss policy decides whether a
  // project forecasting a loss without a loss assessment applied in the
  // period is reported, and whether that finding blocks the close.
  const isoDay = (value: unknown) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const lossMode = await projectLossPolicyMode(db, orgId, isoDay(ctx.ends_on));
  const lossContracts =
    lossMode === "off"
      ? []
      : await unassessedLossContracts(db, orgId, {
          periodStartsOn: isoDay(ctx.starts_on),
          periodEndsOn: isoDay(ctx.ends_on),
          bookId: ctx.book_id,
          subsidiaryIds,
        });
  // A project with no resolvable owner cannot be measured in any entity, so
  // no close scope can show it is out of reach: every close counts it, and
  // only an organization-wide close names the projects.
  const unownedProjects = lossMode === "off" ? [] : await unownedContractProjects(db, orgId);
  const lossChecks: ReadinessCheck[] =
    lossMode === "off"
      ? []
      : [
          {
            code: "project-loss-owner-unresolved",
            taskKey: "recognition-posted",
            category: "revenue",
            severity: lossMode === "require" ? "critical" : "warning",
            title: "close.diagnostics.project-loss-owner-unresolved.title",
            message: "close.diagnostics.project-loss-owner-unresolved.message",
            count: unownedProjects.length,
            details:
              unownedProjects.length > 0 && subsidiaryIds.length === 0
                ? { projects: unownedProjects }
                : undefined,
          },
          {
            code: "project-loss-unassessed",
            taskKey: "recognition-posted",
            category: "revenue",
            severity: lossMode === "require" ? "critical" : "warning",
            title: "close.diagnostics.project-loss-unassessed.title",
            message: "close.diagnostics.project-loss-unassessed.message",
            count: lossContracts.length,
            details: lossContracts.length > 0 ? { projects: lossContracts } : undefined,
          },
        ];

  return [
    ...lossChecks,
    {
      code: "balancing-segment-residual",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.balancing-segment-residual.title",
      message: "close.diagnostics.balancing-segment-residual.message",
      count: Number(segmentResiduals),
    },
    {
      code: "posting-effects-incomplete",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.posting-effects-incomplete.title",
      message: "close.diagnostics.posting-effects-incomplete.message",
      count: postingEffects,
      details: effectDocuments.length > 0 ? { documents: effectDocuments } : undefined,
    },
    {
      code: "drafts-open",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.drafts-open.title",
      message: "close.diagnostics.drafts-open.message",
      count: Number(drafts[0]?.count ?? 0),
    },
    {
      code: "posting-period-missing",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.posting-period-missing.title",
      message: "close.diagnostics.posting-period-missing.message",
      count: Number(missingPeriod[0]?.count ?? 0),
    },
    {
      code: "bank-unreconciled",
      taskKey: "bank-reconciled",
      category: "banking",
      severity: "critical",
      title: "close.diagnostics.bank-unreconciled.title",
      message: "close.diagnostics.bank-unreconciled.message",
      count: bank.length,
      details:
        bank.length > 0
          ? {
              accounts: bank.map((row: Record<string, unknown>) => ({
                accountId: row.account_id as string,
                number: row.number as string | null,
                name: row.name as string,
                clearedLines: Number(row.cleared),
                unclearedLines: Number(row.uncleared),
                sourceConnector: row.source_connector as string | null,
                sourceThrough: row.source_through as string | null,
              })),
            }
          : undefined,
    },
    {
      code: "depreciation-unposted",
      taskKey: "depreciation-posted",
      category: "assets",
      severity: "error",
      title: "close.diagnostics.depreciation-unposted.title",
      message: "close.diagnostics.depreciation-unposted.message",
      count: Number(depreciation[0]?.count ?? 0),
    },
    {
      code: "recognition-unposted",
      taskKey: "recognition-posted",
      category: "revenue",
      severity: "error",
      title: "close.diagnostics.recognition-unposted.title",
      message: "close.diagnostics.recognition-unposted.message",
      count: Number(recognition[0]?.count ?? 0),
    },
    {
      code: "unbilled-revenue-unaccrued",
      taskKey: "unbilled-revenue-accrued",
      category: "revenue",
      severity: "error",
      title: "close.diagnostics.unbilled-revenue-unaccrued.title",
      message: "close.diagnostics.unbilled-revenue-unaccrued.message",
      count: unbilledAccrual.applies ? unbilledAccrual.pendingKeys : 0,
      details: unbilledAccrual.problem ? { problem: unbilledAccrual.problem } : undefined,
    },
    {
      code: "period-end-journals-pending",
      taskKey: "period-end-journals",
      category: "year_end",
      severity: "error",
      title: "close.diagnostics.period-end-journals-pending.title",
      message: "close.diagnostics.period-end-journals-pending.message",
      count: periodEnd.count,
      details: periodEnd.details,
    },
    {
      code: "prepaid-amortization-unposted",
      taskKey: "prepaid-amortized",
      category: "gl",
      severity: "error",
      title: "close.diagnostics.prepaid-amortization-unposted.title",
      message: "close.diagnostics.prepaid-amortization-unposted.message",
      count: prepaidDue.lines,
      details: prepaidDue.lines > 0 ? { schedules: prepaidDue.schedules } : undefined,
    },
    {
      code: "equity-compensation-unposted",
      taskKey: "equity-compensation-posted",
      category: "gl",
      severity: "error",
      title: "close.diagnostics.equity-compensation-unposted.title",
      message: "close.diagnostics.equity-compensation-unposted.message",
      count: equityTasks.includes("equity-compensation-posted") ? equityDue.compensation.length : 0,
      details: equityDue.compensation.length > 0 ? { entities: equityDue.compensation } : undefined,
    },
    {
      code: "equity-interest-unaccrued",
      taskKey: "equity-interest-accrued",
      category: "gl",
      severity: "error",
      title: "close.diagnostics.equity-interest-unaccrued.title",
      message: "close.diagnostics.equity-interest-unaccrued.message",
      count: equityTasks.includes("equity-interest-accrued") ? equityDue.interest.length : 0,
      details: equityDue.interest.length > 0 ? { entities: equityDue.interest } : undefined,
    },
    {
      code: "fx-missing",
      taskKey: "fx-ready",
      category: "foreign_exchange",
      severity: "critical",
      title: "close.diagnostics.fx-missing.title",
      message: "close.diagnostics.fx-missing.message",
      count: Number(fx[0]?.count ?? 0),
    },
    {
      code: "fx-unrevalued",
      taskKey: "fx-revalued",
      category: "foreign_exchange",
      severity: "error",
      title: "close.diagnostics.fx-unrevalued.title",
      message: "close.diagnostics.fx-unrevalued.message",
      count: fxReval.unrevaluedPositions,
      details: { positionsMissingSpotRate: fxReval.positionsMissingSpotRate },
    },
    {
      code: "fx-reversal-period-missing",
      taskKey: "fx-revalued",
      category: "foreign_exchange",
      severity: "error",
      title: "close.diagnostics.fx-reversal-period-missing.title",
      message: "close.diagnostics.fx-reversal-period-missing.message",
      count: fxReval.reversalPeriodMissing ? 1 : 0,
    },
    {
      code: "book-replication-incomplete",
      taskKey: "book-replication-complete",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.book-replication-incomplete.title",
      message: "close.diagnostics.book-replication-incomplete.message",
      count: bookReplication.missing,
      details: { books: bookReplication.books },
    },
    {
      code: "intercompany-residual",
      taskKey: "intercompany-balanced",
      category: "intercompany",
      severity: "critical",
      title: "close.diagnostics.intercompany-residual.title",
      message: "close.diagnostics.intercompany-residual.message",
      count: Number(intercompany[0]?.count ?? 0),
    },
    {
      // Pair balances the two entities record differently at period end
      // (an invoice without its bill, a settlement one side has not posted).
      code: "intercompany-unreconciled",
      taskKey: "intercompany-balanced",
      category: "intercompany",
      severity: "warning",
      title: "close.diagnostics.intercompany-unreconciled.title",
      message: "close.diagnostics.intercompany-unreconciled.message",
      count: await unreconciledIntercompanyCount(orgId, {
        asOfDate:
          (ctx.ends_on as unknown) instanceof Date
            ? (ctx.ends_on as unknown as Date).toISOString().slice(0, 10)
            : String(ctx.ends_on).slice(0, 10),
        bookId: ctx.book_id,
        subsidiaryIds,
      }),
    },
    {
      code: "consolidated-rates-missing",
      taskKey: "intercompany-balanced",
      category: "intercompany",
      severity: "critical",
      title: "close.diagnostics.consolidated-rates-missing.title",
      message: "close.diagnostics.consolidated-rates-missing.message",
      count: Number(intercompany[0]?.missing_rates ?? 0),
    },
    {
      code: "material-variances",
      taskKey: "variance-review",
      category: "variance",
      severity: "warning",
      title: "close.diagnostics.material-variances.title",
      message: "close.diagnostics.material-variances.message",
      count: Number(variances[0]?.count ?? 0),
      details: {
        // Thresholds are evaluated in each legal entity's functional currency.
        amountBasis: "entity-functional-currency",
        amountThreshold: threshold.amount,
        percentThreshold: Number(threshold.percent),
      },
    },
    ...commerce,
  ];
}
