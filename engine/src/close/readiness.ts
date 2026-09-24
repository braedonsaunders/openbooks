import { CloseError, NON_POSTING_DOCUMENT_KINDS } from "./period-policy.ts";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { financialClosePeriodScope, revaluationReadiness } from "./fx-revaluation.ts";
import { sourceEvidencePolicyActive } from "../banking/banking.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";
const nonPostingKindList = () => sql.join(NON_POSTING_DOCUMENT_KINDS.map((k) => sql`${k}`), sql`, `);

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

function closeEntityScope(subsidiaryIds: string[], entity: SQL): SQL {
  return subsidiaryIds.length
    ? sql`${entity} in (${sql.join(subsidiaryIds.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql`true`;
}

function closeBankStatementScope(orgId: string, subsidiaryIds: string[]): SQL {
  const inScope = (entity: SQL) => closeEntityScope(subsidiaryIds, entity);
  // Bank evidence is account-wide. For shared accounts its entity cannot be
  // inferred from a statement, so it remains relevant to every applicable close.
  return !subsidiaryIds.length ? sql`true` : sql`(
    a.subsidiary_id is null or ${inScope(sql`a.subsidiary_id`)} or
    (a.subsidiary_include_children and exists (
      with recursive ancestors as (
        select id, parent_id from subsidiaries where org_id=${orgId} and ${inScope(sql`id`)}
        union
        select s.id, s.parent_id from subsidiaries s join ancestors x on x.parent_id=s.id
          where s.org_id=${orgId}
      ) select 1 from ancestors where id=a.subsidiary_id
    )))`;
}

export async function periodFingerprint(
  orgId: string,
  periodId: string,
  bookId: string,
  subsidiaryIds: string[] = [],
  includeGroupEvidence = true,
): Promise<string> {
  const period = (await db.execute<{
    id: string; ends_on: string; is_adjustment: boolean; fiscal_calendar_id: string; period_number: number;
  }>(sql`select id,ends_on,is_adjustment,fiscal_calendar_id,period_number from accounting_periods
    where org_id=${orgId} and id=${periodId}`)).rows[0];
  if (!period) throw new CloseError("period not found");
  // Closing balances include prior posted activity. A controlled reopening of
  // an earlier period must invalidate evidence even without a current-period
  // entry. Use the FX engine's exact regular/adjustment period ordering.
  const ledgerPeriodScope = sql`(e.period_id=${periodId} or
    (e.status in ('posted','reversed') and ${financialClosePeriodScope(period)}))`;
  const inScope = (entity: SQL) => closeEntityScope(subsidiaryIds, entity);
  const entryScope = sql`(exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id and ${inScope(sql`l.subsidiary_id`)})
    or (not exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id) and ${inScope(sql`e.subsidiary_id`)}))`;
  const documentScope = sql`(d.subsidiary_id is null or ${inScope(sql`d.subsidiary_id`)})`;
  const result = (await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from journal_entries e where e.org_id = ${orgId} and ${ledgerPeriodScope} and e.book_id = ${bookId} and ${entryScope}) as entries,
      (select coalesce(max(updated_at)::text, '') from journal_entries e where e.org_id = ${orgId} and ${ledgerPeriodScope} and e.book_id = ${bookId} and ${entryScope}) as entry_changed,
      (select coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0)::text
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        where e.org_id = ${orgId} and ${ledgerPeriodScope} and e.book_id = ${bookId} and ${inScope(sql`l.subsidiary_id`)}) as debits,
      (select count(*) from documents d
       where d.org_id = ${orgId}
         and d.posting_period_id = ${periodId} and ${documentScope}) as documents,
      (select coalesce(max(d.updated_at)::text, '') from documents d
       where d.org_id = ${orgId}
         and d.posting_period_id = ${periodId} and ${documentScope}) as document_changed,
      (select count(*) from documents d
        where d.org_id = ${orgId}
          and d.status in ('draft','pending_approval','approved','posted')
          and d.posting_period_id is null and ${documentScope}) as unassigned_documents,
      (select coalesce(max(d.updated_at)::text, '') from documents d
        where d.org_id = ${orgId}
          and d.status in ('draft','pending_approval','approved','posted')
          and d.posting_period_id is null and ${documentScope}) as unassigned_document_changed,
      (select count(*) from reconciliations r join accounts a on a.org_id=r.org_id and a.id=r.account_id join accounting_periods p on p.id = ${periodId} and p.org_id = r.org_id
        where r.org_id = ${orgId} and r.through_date <= p.ends_on and r.status = 'signed_off'
          and (${closeBankStatementScope(orgId, subsidiaryIds)} or exists(select 1 from journal_lines l where l.org_id=r.org_id and l.account_id=r.account_id and ${inScope(sql`l.subsidiary_id`)}))) as reconciliations,
      -- Consolidated translation rates are close evidence: re-deriving or
      -- overriding a period's rates restates every consolidated statement, so
      -- the change must invalidate completed tasks like a ledger change does.
      -- Value-based (not updated_at) so a no-op re-derive leaves sign-offs intact.
      (select coalesce(string_agg(
                 cf.from_currency || '>' || cf.to_currency || ':' || cf.current_rate::text || '/'
                   || cf.average_rate::text || '/' || cf.historical_rate::text || '/' || cf.source,
                 ',' order by cf.from_currency, cf.to_currency), '')
         from consolidated_fx_rates cf
        where cf.org_id = ${orgId} and cf.period_id = ${periodId} and ${includeGroupEvidence}) as consolidated_rates,
      (select coalesce(string_agg(e.id::text || ':' || e.updated_at::text || ':' || l.id::text || ':' || l.amount::text, ',' order by l.id), '')
        from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
        join accounts a on a.id=l.account_id and a.org_id=l.org_id
        where e.org_id=${orgId} and ${ledgerPeriodScope} and e.book_id=${bookId}
          and a.eliminate and ${includeGroupEvidence}) as group_activity
  `));
  return createHash("sha256")
    .update(JSON.stringify({ subsidiaryIds: [...subsidiaryIds].sort(), evidence: result.rows[0] ?? {} }))
    .digest("hex");
}

export async function readinessChecks(
  orgId: string,
  runId: string,
): Promise<ReadinessCheck[]> {
  const context = (await db.execute<{
      period_id: string;
      book_id: string;
      scope: { subsidiaryIds?: string[] };
      system_blueprint: boolean;
      starts_on: string;
      ends_on: string;
      fiscal_calendar_id: string;
      period_number: number;
      is_adjustment: boolean;
      base_currency: string;
      elimination_currency: string;
    }>(sql`
    select r.period_id, r.book_id, r.scope, p.starts_on, p.ends_on,
           b.name = 'close.defaultData.blueprint.name' as system_blueprint,
           p.fiscal_calendar_id, p.period_number, p.is_adjustment,
           o.base_currency,
           coalesce(
             (select s.base_currency from subsidiaries s
               where s.org_id = o.id and s.is_elimination and s.is_active
               order by s.created_at, s.id limit 1),
             o.base_currency) as elimination_currency
      from close_runs r
      join close_blueprints b on b.id=r.blueprint_id and b.org_id=r.org_id
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join orgs o on o.id = r.org_id
     where r.id = ${runId} and r.org_id = ${orgId}`));
  const ctx = context.rows[0];
  if (!ctx) throw new CloseError("close run not found");
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

  const [drafts, missingPeriod, bank, depreciation, recognition, fx, fxReval, intercompany, variancePolicy] =
    (await Promise.all([
      db.execute(sql`
      select
        (select count(*) from journal_entries e where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status = 'draft'
          and (exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id and ${inScope(sql`l.subsidiary_id`)})
            or (not exists(select 1 from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id) and ${inScope(sql`e.subsidiary_id`)})))
        +
        (select count(*) from documents d
          where d.org_id = ${orgId} and d.status in ('draft','pending_approval','approved')
            and d.kind not in (${nonPostingKindList()})
            and d.posting_period_id = ${ctx.period_id} and ${documentScope}) as count`),
      db.execute(sql`
      select count(*) as count
        from documents d
       where d.org_id = ${orgId}
         and d.status in ('draft','pending_approval','approved','posted')
         and d.kind not in (${nonPostingKindList()})
         and d.posting_period_id is null
         and d.document_date between ${ctx.starts_on} and ${ctx.ends_on}
         and ${documentScope}`),
      // Bank-unreconciled returns the open accounts themselves (not just a
      // count) with per-account source-evidence coverage, so the close
      // detail names each account with cleared/uncleared line counts.
      db.execute(sql`
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
                where jl.org_id=${orgId} and jl.account_id=a.id and je.period_id=${ctx.period_id}
                  and je.book_id=${ctx.book_id} and je.status in ('posted','reversed') and ${inScope(sql`jl.subsidiary_id`)}
             )
             or exists (
               select 1 from journal_lines jl
               join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
               join accounting_periods jp on jp.id=je.period_id and jp.org_id=je.org_id
                where jl.org_id=${orgId} and jl.account_id=a.id and je.book_id=${ctx.book_id}
                  and je.status in ('posted','reversed') and jp.ends_on <= ${ctx.ends_on}
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
             and je.status in ('posted', 'reversed')
             and jl.posting_date <= ${ctx.ends_on} and ${inScope(sql`jl.subsidiary_id`)}
        ) jl on jl.account_id = o.id
        left join source_reconciliation_state s on s.org_id = ${orgId} and s.account_id = o.id
       group by o.id, o.number, o.name, s.connector, s.reconciled_through
       order by o.number nulls last, o.name`),
      db.execute(sql`
      select count(*) as count
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join fixed_assets a on a.id=s.asset_id and a.org_id=s.org_id
       where l.org_id = ${orgId} and l.period_id = ${ctx.period_id}
         and s.book_id = ${ctx.book_id} and l.posted_amount is null and l.planned_amount <> 0
         and ${inScope(sql`a.subsidiary_id`)}`),
      // Unposted revenue recognition, measured the way runRevenueRecognition
      // measures due lines: unposted, nonzero, non-cancelled, non-forecast,
      // and due by period end (percent-complete catch-up is due as soon as
      // its period has started). Subsidiary attribution follows the runner's
      // own coalesce chain so entity-scoped runs see the same population.
      db.execute(sql`
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
         and ${inScope(sql`coalesce(dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId})`)}`),
      db.execute(sql`
      select count(*) as count
        from (
          select distinct l.currency, s.base_currency
            from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
            join subsidiaries s on s.id=l.subsidiary_id and s.org_id=l.org_id
           where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id}
             and e.status in ('posted','reversed') and ${inScope(sql`l.subsidiary_id`)}
             and l.currency <> s.base_currency
        ) c
       where not exists (
         select 1 from fx_rates f where f.org_id = ${orgId}
           and ((f.from_currency=c.currency and f.to_currency=c.base_currency)
             or (f.from_currency=c.base_currency and f.to_currency=c.currency))
           and f.rate_type = 'spot' and f.rate > 0 and f.as_of <= ${ctx.ends_on}
       )`),
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
      // measures them: every subsidiary's flagged activity translated into the
      // elimination subsidiary's currency through the period's consolidated
      // rates (average for flows, current for balances), with the elimination
      // subsidiary's own lines included at par — so a group that eliminates
      // cleanly reads zero per account, whatever functional currencies its
      // entities keep. A foreign entity with no consolidated rate cannot be
      // measured at all; that is counted separately, never as a residual.
      scoped && ctx.system_blueprint ? Promise.resolve({ rows: [{ count: 0, missing_rates: 0 }] }) : db.execute(sql`
      select count(*) filter (where residual <> 0 and not coalesce(missing_rate, false)) as count,
             count(*) filter (where missing_rate) as missing_rates
        from (
        select a.id,
               sum(round(l.amount * case
                 when s.base_currency = ${ctx.elimination_currency} then 1
                 when a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
                   then consolidated.average_rate
                 else consolidated.current_rate
               end, 4)) as residual,
               bool_or(s.base_currency <> ${ctx.elimination_currency} and consolidated.id is null) as missing_rate
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          join accounts a on a.id = l.account_id and a.org_id = l.org_id and a.eliminate
          join subsidiaries s on s.id = l.subsidiary_id and s.org_id = l.org_id
          left join consolidated_fx_rates consolidated
            on consolidated.org_id = e.org_id
           and consolidated.period_id = e.period_id
           and consolidated.from_currency = s.base_currency
           and consolidated.to_currency = ${ctx.elimination_currency}
         where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
         group by a.id
      ) residuals`),
      db.execute(sql`
      select coalesce(rules->>'amount', '10000.0000') as amount,
             coalesce((rules->>'percent')::numeric, 20) as percent
        from close_policies where org_id = ${orgId} and code = 'material-variance' and is_active limit 1`),
    ]));

  const threshold = variancePolicy.rows[0] ?? {
    amount: "10000.0000",
    percent: 20,
  };
  const variances = (await db.execute<{ count: string }>(sql`
    with current_activity as (
      select l.account_id, l.subsidiary_id, sum(l.amount) as amount
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${orgId} and e.period_id = ${ctx.period_id} and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
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
         and e.book_id = ${ctx.book_id} and e.status in ('posted', 'reversed')
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
       and (v.prior_amount=0 or abs((v.current_amount-v.prior_amount)/nullif(abs(v.prior_amount),0)*100) >= ${threshold.percent}::numeric)`));

  return [
    {
      code: "drafts-open",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.drafts-open.title",
      message: "close.diagnostics.drafts-open.message",
      count: Number(drafts.rows[0]?.count ?? 0),
    },
    {
      code: "posting-period-missing",
      taskKey: "drafts-cleared",
      category: "readiness",
      severity: "critical",
      title: "close.diagnostics.posting-period-missing.title",
      message: "close.diagnostics.posting-period-missing.message",
      count: Number(missingPeriod.rows[0]?.count ?? 0),
    },
    {
      code: "bank-unreconciled",
      taskKey: "bank-reconciled",
      category: "banking",
      severity: "critical",
      title: "close.diagnostics.bank-unreconciled.title",
      message: "close.diagnostics.bank-unreconciled.message",
      count: bank.rows.length,
      details: bank.rows.length > 0 ? {
        accounts: bank.rows.map((row: Record<string, unknown>) => ({
          accountId: row.account_id as string,
          number: row.number as string | null,
          name: row.name as string,
          clearedLines: Number(row.cleared),
          unclearedLines: Number(row.uncleared),
          sourceConnector: row.source_connector as string | null,
          sourceThrough: row.source_through as string | null,
        })),
      } : undefined,
    },
    {
      code: "depreciation-unposted",
      taskKey: "depreciation-posted",
      category: "assets",
      severity: "error",
      title: "close.diagnostics.depreciation-unposted.title",
      message: "close.diagnostics.depreciation-unposted.message",
      count: Number(depreciation.rows[0]?.count ?? 0),
    },
    {
      code: "recognition-unposted",
      taskKey: "recognition-posted",
      category: "revenue",
      severity: "error",
      title: "close.diagnostics.recognition-unposted.title",
      message: "close.diagnostics.recognition-unposted.message",
      count: Number(recognition.rows[0]?.count ?? 0),
    },
    {
      code: "fx-missing",
      taskKey: "fx-ready",
      category: "foreign_exchange",
      severity: "critical",
      title: "close.diagnostics.fx-missing.title",
      message: "close.diagnostics.fx-missing.message",
      count: Number(fx.rows[0]?.count ?? 0),
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
      code: "intercompany-residual",
      taskKey: "intercompany-balanced",
      category: "intercompany",
      severity: "critical",
      title: "close.diagnostics.intercompany-residual.title",
      message: "close.diagnostics.intercompany-residual.message",
      count: Number(intercompany.rows[0]?.count ?? 0),
    },
    {
      code: "consolidated-rates-missing",
      taskKey: "intercompany-balanced",
      category: "intercompany",
      severity: "critical",
      title: "close.diagnostics.consolidated-rates-missing.title",
      message: "close.diagnostics.consolidated-rates-missing.message",
      count: Number(intercompany.rows[0]?.missing_rates ?? 0),
    },
    {
      code: "material-variances",
      taskKey: "variance-review",
      category: "variance",
      severity: "warning",
      title: "close.diagnostics.material-variances.title",
      message: "close.diagnostics.material-variances.message",
      count: Number(variances.rows[0]?.count ?? 0),
      details: {
        // Thresholds are evaluated in each legal entity's functional currency.
        amountBasis: "entity-functional-currency",
        amountThreshold: threshold.amount,
        percentThreshold: Number(threshold.percent),
      },
    },
  ];
}
