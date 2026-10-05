import type { ReportEntity } from "./entities";

/**
 * Forecast accuracy: past demand forecasts scored against the issues that
 * actually happened, by item class and legal entity. The scoring matches
 * the planning engine's own accuracy reader — mean absolute percentage
 * error over weeks that sold, and sum-based bias — so the report and the
 * planning API never disagree about a class.
 */
export const DEMAND_REPORT_ENTITIES: ReportEntity[] = [
  {
    key: "demand_forecast_accuracy",
    label: "Forecast accuracy",
    category: "inventory",
    description:
      "Past demand forecasts scored against actual issues by item class: scored weeks, mean absolute percentage error, and bias. Positive bias reads over-forecast.",
    from: `(
      with actuals as (
        select m.org_id, m.subsidiary_id, m.item_id,
               date_trunc('week', m.moved_at)::date as week_start,
               sum(case when m.kind = 'issue' then -m.quantity else 0 end) as actual
          from inventory_movements m
         where m.status = 'posted'
           and m.reverses_movement_id is null
           and not exists (
             select 1 from inventory_movements reversal
              where reversal.org_id = m.org_id and reversal.reverses_movement_id = m.id)
         group by 1, 2, 3, 4
      )
      select f.org_id,
             (r.parameters->>'subsidiaryId')::uuid as subsidiary_id,
             coalesce(nullif(i.category, ''), 'uncategorized') as item_class,
             count(*) as scored_weeks,
             avg(case when a.actual > 0
               then abs(f.forecast_qty - a.actual) / a.actual end) as mape,
             case when coalesce(sum(a.actual), 0) = 0 then null
               else sum(f.forecast_qty - coalesce(a.actual, 0)) / sum(a.actual) end as bias
        from demand_forecasts f
        join demand_forecast_runs r on r.org_id = f.org_id and r.id = f.run_id
        join items i on i.org_id = f.org_id and i.id = f.item_id
        left join actuals a on a.org_id = f.org_id and a.item_id = f.item_id
          and a.week_start = f.period_start
          and a.subsidiary_id = (r.parameters->>'subsidiaryId')::uuid
       where r.status = 'complete'
         and f.period_start < current_date
         and f.method <> 'override'
       group by 1, 2, 3
    ) accuracy`,
    orgColumn: "accuracy.org_id",
    subsidiaryScope: { column: "accuracy.subsidiary_id" },
    requiredPermission: "inventory.plan",
    featureKey: "demandPlanning",
    defaultPeriodField: null,
    columns: [
      { key: "item_class", label: "Item class", kind: "text", expr: "accuracy.item_class" },
      { key: "scored_weeks", label: "Scored weeks", kind: "number", expr: "accuracy.scored_weeks" },
      { key: "mape", label: "MAPE", kind: "number", expr: "accuracy.mape" },
      { key: "bias", label: "Bias", kind: "number", expr: "accuracy.bias" },
    ],
    defaultSort: { column: "item_class", direction: "asc" },
  },
];
