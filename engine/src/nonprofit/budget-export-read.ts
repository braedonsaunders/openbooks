import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import {
  effectiveExtraDimsSql,
  loadBudgetSegments,
  type BudgetSegment,
} from "./budget-dimensions.ts";

export interface BudgetExportRow extends Record<string, unknown> {
  number: string | null;
  account_name: string;
  period: string;
  subsidiary: string | null;
  department: string | null;
  project: string | null;
  location: string | null;
  class: string | null;
  amount: string;
  note: string | null;
  extra_dims: Record<string, string>;
}

export interface BudgetExportData {
  scenario: { name: string; fiscal_year: number };
  lines: BudgetExportRow[];
  segments: BudgetSegment[];
}

export async function loadBudgetExportData(input: {
  orgId: string;
  scenarioId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<BudgetExportData | null> {
  return withOrgTransaction(
    input.orgId,
    async () => {
      const scenario = await db.execute<{ name: string; fiscal_year: number }>(
        sql`
          select name, fiscal_year from budget_scenarios where id = ${input.scenarioId} and org_id = ${input.orgId}
        `,
        "objects",
      );
      if (!scenario[0]) return null;

      if (input.allowedSubsidiaryIds !== null) {
        const visible = await db.execute<{ n: string }>(
          sql`
            select count(*) as n from budget_lines
             where org_id = ${input.orgId} and scenario_id = ${input.scenarioId}
             ${subsidiaryVisibleFilter(sql`subsidiary_id`, input.allowedSubsidiaryIds)}
          `,
          "objects",
        );
        if (Number(visible[0]?.n ?? 0) === 0) return null;
      }

      const lines = await db.execute<BudgetExportRow>(
        sql`
          select a.number, a.name as account_name, p.name as period,
                 s.name as subsidiary,
                 -- Dimensions export as code with a name fallback: a bare code
                 -- column emits blank for NULL codes, and the import reads blank as
                 -- "no dimension" — silently re-homing the line. Either form
                 -- resolves on import, so the round-trip is exact.
                 coalesce(d.code, d.name) as department,
                 coalesce(pr.code, pr.name) as project,
                 coalesce(loc.code, loc.name) as location,
                 coalesce(c.code, c.name) as class,
                 (case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end)::text as amount, bl.note,
                 ${effectiveExtraDimsSql(sql`bl.extra_dims`, input.orgId)} as extra_dims
            from budget_lines bl
            join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
            join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
            left join subsidiaries s on s.id = bl.subsidiary_id and s.org_id = bl.org_id
            left join departments d on d.id = bl.department_id and d.org_id = bl.org_id
            left join projects pr on pr.id = bl.project_id and pr.org_id = bl.org_id
            left join locations loc on loc.id = bl.location_id and loc.org_id = bl.org_id
            left join classes c on c.id = bl.class_id and c.org_id = bl.org_id
           where bl.org_id = ${input.orgId} and bl.scenario_id = ${input.scenarioId}
             ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, input.allowedSubsidiaryIds)}
           order by a.number nulls last, a.name, p.period_number, s.name, d.code, pr.code, loc.code, c.code
        `,
        "objects",
      );
      const segments = await loadBudgetSegments(db, input.orgId);
      return { scenario: scenario[0], lines, segments };
    },
    { readOnly: true },
  );
}
