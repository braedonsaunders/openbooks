import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { sql } from "drizzle-orm";
import { effectiveExtraDimsSql } from "@openbooks/engine/budgets/dimensions";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  submitBudgetScenario,
  withdrawBudgetScenario,
} from "@openbooks/engine/flows/budget-submission";
import { can, subsidiariesInScope, type Authz } from "./authz";
import { isUuid } from "./list-params";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import { BudgetMutationError } from "./budget-mutations";
import { outOfScopeScenarioError, scenarioOutOfScopeSubsidiaryNames } from "./budget-scope";
import { notFound } from "@/lib/api/responses";
const revisionSchema = z.number().int().positive();
const budgetDimensionsSchema = {
  subsidiaryId: uuidString().nullable().optional(),
  departmentId: uuidString().nullable().optional(),
  projectId: uuidString().nullable().optional(),
  locationId: uuidString().nullable().optional(),
  classId: uuidString().nullable().optional(),
};
export const budgetScenarioActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("archive"), expectedRevision: revisionSchema }),
  z.object({
    action: z.literal("copy"),
    expectedRevision: revisionSchema,
    fiscalYear: z.number().int().optional(),
  }),
  z.object({
    action: z.literal("copy_prior_actuals"),
    expectedRevision: revisionSchema,
    ...budgetDimensionsSchema,
  }),
  z.object({
    action: z.literal("apply_source"),
    expectedRevision: revisionSchema,
    sourceScenarioId: uuidString(),
  }),
  z.object({ action: z.literal("submit"), expectedRevision: revisionSchema }),
  z.object({ action: z.literal("withdraw"), expectedRevision: revisionSchema }),
]);

type Action = "archive" | "copy" | "copy_prior_actuals" | "apply_source" | "submit" | "withdraw";

/** A source period with no destination in the target year. */
type UnmappedPeriodRow = {
  id: string;
  fiscal_year: number;
  period_number: number;
  is_adjustment: boolean;
  starts_on: string;
  ends_on: string;
};

/**
 * The unmapped periods a refusal names, labelled as every period list labels
 * them in the operator's locale (`P07 FY2026 · Jul 2026`), whatever
 * free-text name each period was stored with.
 */
async function unmappedPeriodNames(rows: UnmappedPeriodRow[]): Promise<string> {
  const locale = await getLocale();
  return rows
    .map((row) =>
      periodDisplayLabel(
        {
          fiscalYear: Number(row.fiscal_year),
          periodNumber: Number(row.period_number),
          adjustment: row.is_adjustment,
          startsOn: row.starts_on,
          endsOn: row.ends_on,
        },
        locale,
      ),
    )
    .join(", ");
}

function dims(body: Record<string, unknown>) {
  // A supplied dimension that is not a valid id refuses by name: the old code
  // coerced malformed ids to null, and null means "no filter" — so a
  // copy_prior_actuals with a typo'd departmentId silently broadened a narrow
  // request into a whole-budget delete-and-replace. Absent/empty stays null.
  const value = (key: string) => {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw === "string" && isUuid(raw)) return raw as string;
    throw new BudgetMutationError(`invalid_${key.replace(/Id$/, "").toLowerCase()}`);
  };
  return {
    subsidiaryId: value("subsidiaryId"),
    departmentId: value("departmentId"),
    projectId: value("projectId"),
    locationId: value("locationId"),
    classId: value("classId"),
  };
}

export async function executeBudgetScenarioAction({
  request: _req,
  authz: routeAuthz,
  params: routeParams,
  body: routeBody,
}: {
  request: Request;
  authz: Authz;
  params: { id: string };
  body: Record<string, unknown>;
}) {
  const params = Promise.resolve(routeParams as { id: string });
  const gate = routeAuthz;
  const user = gate.user;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");

  const body = routeBody as Record<string, unknown>;
  const action = body.action as Action;
  if (
    !["archive", "copy", "copy_prior_actuals", "apply_source", "submit", "withdraw"].includes(
      action,
    )
  ) {
    return NextResponse.json({ error: "invalid_action" }, { status: 422 });
  }
  if (!can(gate, "budgets.manage"))
    return NextResponse.json({ error: "missing permission: budgets.manage" }, { status: 403 });
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision))
    return NextResponse.json({ error: "invalid_revision" }, { status: 422 });
  try {
    const result = await withOrgTransaction(user.orgId, async () => {
      const tx = db;
      const locked = await tx.execute<{
        id: string;
        name: string;
        description: string | null;
        book_id: string;
        fiscal_year: number;
        kind: string;
        status: string;
        revision: number;
        submitted_by: string | null;
      }>(
        sql`
            select id, name, description, book_id, fiscal_year, kind, status, revision, submitted_by
              from budget_scenarios where id = ${id} and org_id = ${user.orgId} for update
          `,
        "objects",
      );
      const scenario = locked[0];
      if (!scenario) throw new BudgetMutationError("not_found", 404);
      if (Number(scenario.revision) !== expectedRevision)
        throw new BudgetMutationError("revision_conflict", 409);

      // Scenario-level transitions and source application govern the
      // whole scenario. A restricted caller may copy visible lines into
      // a new scenario, but may only apply a source they can fully access.
      if (action === "submit" || action === "withdraw" || action === "archive") {
        const outOfScope = await scenarioOutOfScopeSubsidiaryNames(
          id,
          user.orgId,
          gate.allowedSubsidiaryIds,
        );
        if (outOfScope.length > 0) throw outOfScopeScenarioError(outOfScope);
      }

      if (action === "submit")
        return submitBudgetScenario(user.orgId, user.id, id, expectedRevision);
      if (action === "withdraw")
        return withdrawBudgetScenario(user.orgId, user.id, id, expectedRevision);

      // Every source line must land on a destination period: the copy join
      // maps by (calendar, period_number), so a target year missing any of
      // the source's periods would silently drop those lines (possibly all
      // of them) while the new scenario reports success. Verify the FULL
      // mapping before any write and refuse naming the unmapped periods.
      const assertFullPeriodMapping = async (
        sourceYear: number | null,
        sourceScenarioId: string | null,
        targetYear: number,
      ) => {
        const unmapped = await tx.execute<UnmappedPeriodRow>(
          sql`
              select distinct source_period.id, source_period.fiscal_year, source_period.period_number,
                     source_period.is_adjustment,
                     source_period.starts_on::text as starts_on, source_period.ends_on::text as ends_on
                from budget_lines bl
                join accounting_periods source_period
                  on source_period.id = bl.period_id and source_period.org_id = bl.org_id
                left join accounting_periods destination
                  on destination.org_id = ${user.orgId}
                 and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
                 and destination.fiscal_year = ${targetYear}
                 and destination.period_number = source_period.period_number
                 and not destination.is_adjustment
               where bl.org_id = ${user.orgId}
                 and ${sourceScenarioId ? sql`bl.scenario_id = ${sourceScenarioId}` : sql`bl.scenario_id = ${id}`}
                 ${sourceYear === null ? sql`` : sql`and source_period.fiscal_year = ${sourceYear}`}
                 ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
                 and destination.id is null
               order by starts_on, source_period.id
            `,
          "objects",
        );
        if (unmapped.length > 0) {
          const names = await unmappedPeriodNames(unmapped);
          throw new BudgetMutationError(
            `unmapped_periods: no ${targetYear} period matches source period(s) ${names}`,
          );
        }
      };

      if (action === "copy") {
        const targetYearRaw = Number(body.fiscalYear);
        const targetYear = Number.isInteger(targetYearRaw)
          ? targetYearRaw
          : Number(scenario.fiscal_year);
        const periods = await tx.execute(
          sql`
              select 1 from accounting_periods
               where org_id = ${user.orgId} and fiscal_year = ${targetYear} and not is_adjustment limit 1
            `,
          "objects",
        );
        if (!periods[0]) throw new BudgetMutationError("target_year_has_no_periods");
        await assertFullPeriodMapping(null, null, targetYear);
        // Budgets cover the P&L only: refuse legacy balance-sheet source
        // lines by name instead of copying lines the worksheet hides (the
        // line guard would fail them with a raw error at insert time).
        const nonPnlCopy = await tx.execute<{ display: string }>(
          sql`
              select distinct (case when a.number is null then a.name else a.name || ' (' || a.number || ')' end) as display
                from budget_lines bl
                join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
               where bl.org_id = ${user.orgId} and bl.scenario_id = ${id}
                 and a.type not in ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred')
                 ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
            `,
          "objects",
        );
        if (nonPnlCopy.length > 0) {
          throw new BudgetMutationError(
            `non_pnl_account: budgets cover profit-and-loss accounts only: ${nonPnlCopy.map((row) => row.display).join(", ")}`,
          );
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${user.orgId}:${scenario.book_id}:${targetYear}:${scenario.kind}`}, 0))`,
        );
        const baseName = `${scenario.name} Copy`;
        const existing = await tx.execute<{ name: string }>(
          sql`
              select name from budget_scenarios
               where org_id = ${user.orgId} and book_id = ${scenario.book_id}
                 and fiscal_year = ${targetYear} and kind = ${scenario.kind}
                 and (name = ${baseName} or name like ${`${baseName} (%`})
            `,
          "objects",
        );
        const used = new Set(existing.map((row) => row.name));
        let name = baseName;
        for (let i = 2; used.has(name); i++) name = `${baseName} (${i})`;
        const created = await tx.execute<{ id: string }>(
          sql`
              insert into budget_scenarios
                (org_id, book_id, fiscal_year, name, description, kind, status, created_by, updated_by)
              values (${user.orgId}, ${scenario.book_id}, ${targetYear}, ${name}, ${scenario.description},
                      ${scenario.kind}, 'draft', ${user.id}, ${user.id})
              returning id
            `,
          "objects",
        );
        const newId = created[0]!.id;
        await tx.execute(sql`
              insert into budget_lines
                (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
                 extra_dims, amount, note, created_by, updated_by)
              select ${user.orgId}, ${newId}, bl.account_id, destination.id,
                     bl.subsidiary_id, bl.department_id, bl.project_id, bl.location_id, bl.class_id,
                     bl.extra_dims, bl.amount, bl.note, ${user.id}, ${user.id}
                from budget_lines bl
                join accounting_periods source_period on source_period.id = bl.period_id and source_period.org_id = bl.org_id
                join accounting_periods destination
                  on destination.org_id = ${user.orgId}
                 and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
                 and destination.fiscal_year = ${targetYear}
                 and not destination.is_adjustment
                 and destination.period_number = source_period.period_number
               where bl.org_id = ${user.orgId} and bl.scenario_id = ${id}
                 ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
            `);
        await tx.execute(sql`
              insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${user.orgId}, 'budget_scenarios', ${newId}, 'insert',
                ${JSON.stringify({ copiedFrom: id, targetYear })}::jsonb, ${user.id})
            `);
        return { id: newId, revision: 1 };
      }

      if (action === "copy_prior_actuals") {
        if (scenario.status !== "draft") throw new BudgetMutationError("budget_is_locked", 409);
        const selected = dims(body);
        if (selected.subsidiaryId !== null && !subsidiariesInScope(gate, [selected.subsidiaryId])) {
          throw new BudgetMutationError("invalid_subsidiary");
        }
        // A selected dimension filters the source activity and stamps its value
        // onto every copied line. An unselected dimension is copied through:
        // each source line keeps its own value instead of being silently
        // collapsed into the NULL-dimension bucket.
        const sourceDimFilters = [
          selected.subsidiaryId === null
            ? null
            : sql`l.subsidiary_id is not distinct from ${selected.subsidiaryId}`,
          selected.departmentId === null
            ? null
            : sql`l.department_id is not distinct from ${selected.departmentId}`,
          selected.projectId === null
            ? null
            : sql`l.project_id is not distinct from ${selected.projectId}`,
          selected.locationId === null
            ? null
            : sql`l.location_id is not distinct from ${selected.locationId}`,
          selected.classId === null
            ? null
            : sql`l.class_id is not distinct from ${selected.classId}`,
        ].filter((predicate) => predicate !== null);
        // Clear exactly what this copy replaces: the selected dimensions'
        // existing lines, or the whole scenario when nothing narrows the scope.
        const clearDimFilters = [
          selected.subsidiaryId === null
            ? null
            : sql`subsidiary_id is not distinct from ${selected.subsidiaryId}`,
          selected.departmentId === null
            ? null
            : sql`department_id is not distinct from ${selected.departmentId}`,
          selected.projectId === null
            ? null
            : sql`project_id is not distinct from ${selected.projectId}`,
          selected.locationId === null
            ? null
            : sql`location_id is not distinct from ${selected.locationId}`,
          selected.classId === null ? null : sql`class_id is not distinct from ${selected.classId}`,
        ].filter((predicate) => predicate !== null);
        // Verify before the delete below: it clears the target first, so a
        // prior-year period with real actuals but no current-year counterpart
        // would destroy lines it can never replace. The group/having mirrors
        // the copy query exactly — a period netting to zero copies nothing,
        // so only nonzero periods can block.
        const priorYear = Number(scenario.fiscal_year) - 1;
        const unmappedActuals = await tx.execute<UnmappedPeriodRow>(
          sql`
              select source_period.id, source_period.fiscal_year, source_period.period_number,
                     source_period.is_adjustment,
                     source_period.starts_on::text as starts_on, source_period.ends_on::text as ends_on
                from journal_lines l
                join journal_entries e on e.id = l.entry_id and e.org_id = ${user.orgId} and e.status in ('posted', 'reversed')
                join accounts a on a.id = l.account_id and a.org_id = ${user.orgId}
                join accounting_periods source_period on source_period.id = e.period_id and source_period.org_id = e.org_id and source_period.fiscal_year = ${priorYear}
                left join accounting_periods destination
                  on destination.org_id = ${user.orgId}
                 and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
                 and destination.fiscal_year = ${scenario.fiscal_year}
                 and destination.period_number = source_period.period_number
                 and not destination.is_adjustment
               where e.book_id = ${scenario.book_id}
                 and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
                 ${sourceDimFilters.length > 0 ? sql`and ${sql.join(sourceDimFilters, sql` and `)}` : sql``}
                 ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, gate.allowedSubsidiaryIds)}
                 and destination.id is null
               group by source_period.id, source_period.fiscal_year, source_period.period_number,
                        source_period.is_adjustment, source_period.starts_on, source_period.ends_on
              having sum(l.amount) <> 0
               order by source_period.starts_on, source_period.id
            `,
          "objects",
        );
        if (unmappedActuals.length > 0) {
          const names = await unmappedPeriodNames(unmappedActuals);
          throw new BudgetMutationError(
            `unmapped_periods: no ${scenario.fiscal_year} period matches prior-year actuals period(s) ${names}`,
          );
        }
        await tx.execute(sql`
              delete from budget_lines
               where org_id = ${user.orgId} and scenario_id = ${id}
                 ${clearDimFilters.length > 0 ? sql`and ${sql.join(clearDimFilters, sql` and `)}` : sql``}
                 ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
            `);
        await tx.execute(sql`
              insert into budget_lines
                (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
                 extra_dims, amount, created_by, updated_by)
              select ${user.orgId}, ${id}, l.account_id, destination.id,
                     l.subsidiary_id, l.department_id, l.project_id, l.location_id, l.class_id,
                     -- Custom segments (fund included) copy through like the other
                     -- dimensions, under the default-fund reading control applies.
                     ${effectiveExtraDimsSql(sql`l.extra_dims`, user.orgId)},
                     sum(l.amount), ${user.id}, ${user.id}
                from journal_lines l
                join journal_entries e on e.id = l.entry_id and e.org_id = ${user.orgId} and e.status in ('posted', 'reversed')
                join accounts a on a.id = l.account_id and a.org_id = ${user.orgId}
                join accounting_periods source_period on source_period.id = e.period_id and source_period.org_id = e.org_id and source_period.fiscal_year = ${Number(scenario.fiscal_year) - 1}
                join accounting_periods destination
                  on destination.org_id = ${user.orgId}
                 and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
                 and destination.fiscal_year = ${scenario.fiscal_year}
                 and destination.period_number = source_period.period_number
                 and not destination.is_adjustment
               where e.book_id = ${scenario.book_id}
                 and a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')
                 ${sourceDimFilters.length > 0 ? sql`and ${sql.join(sourceDimFilters, sql` and `)}` : sql``}
                 ${subsidiaryVisibleFilter(sql`l.subsidiary_id`, gate.allowedSubsidiaryIds)}
               -- Positional: the effective custom-segment expression binds its own
               -- parameters, so it is grouped by its select-list position.
               group by 3, 4, 5, 6, 7, 8, 9, 10
              having sum(l.amount) <> 0
            `);
        const nextRevision = expectedRevision + 1;
        await tx.execute(sql`
              update budget_scenarios set revision = ${nextRevision}, updated_at = now(), updated_by = ${user.id}
               where id = ${id} and org_id = ${user.orgId}
            `);
        await tx.execute(sql`
              insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
                ${JSON.stringify({ action, sourceFiscalYear: Number(scenario.fiscal_year) - 1, dimensions: selected })}::jsonb,
                ${user.id})
            `);
        return { revision: nextRevision };
      }

      if (action === "apply_source") {
        if (scenario.status !== "draft") throw new BudgetMutationError("budget_is_locked", 409);
        const sourceScenarioId =
          typeof body.sourceScenarioId === "string" && isUuid(body.sourceScenarioId)
            ? body.sourceScenarioId
            : null;
        if (!sourceScenarioId || sourceScenarioId === id)
          throw new BudgetMutationError("invalid_source_scenario");
        const source = await tx.execute<{ id: string }>(
          sql`
              select id from budget_scenarios where id = ${sourceScenarioId} and org_id = ${user.orgId}
            `,
          "objects",
        );
        if (!source[0]) throw new BudgetMutationError("invalid_source_scenario");
        const sourceOutOfScope = await scenarioOutOfScopeSubsidiaryNames(
          sourceScenarioId,
          user.orgId,
          gate.allowedSubsidiaryIds,
        );
        if (sourceOutOfScope.length > 0) throw outOfScopeScenarioError(sourceOutOfScope);
        // Verify before the delete below: it clears the target first, so an
        // unmapped source period would destroy lines it can never replace.
        await assertFullPeriodMapping(null, sourceScenarioId, Number(scenario.fiscal_year));
        const nonPnlApply = await tx.execute<{ display: string }>(
          sql`
              select distinct (case when a.number is null then a.name else a.name || ' (' || a.number || ')' end) as display
                from budget_lines bl
                join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
               where bl.org_id = ${user.orgId} and bl.scenario_id = ${sourceScenarioId}
                 and a.type not in ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred')
                 ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
            `,
          "objects",
        );
        if (nonPnlApply.length > 0) {
          throw new BudgetMutationError(
            `non_pnl_account: budgets cover profit-and-loss accounts only: ${nonPnlApply.map((row) => row.display).join(", ")}`,
          );
        }
        await tx.execute(sql`
              delete from budget_lines
               where scenario_id = ${id} and org_id = ${user.orgId}
                 ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds)}
            `);
        await tx.execute(sql`
              insert into budget_lines
                (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
                 extra_dims, amount, note, created_by, updated_by)
              select ${user.orgId}, ${id}, bl.account_id, destination.id,
                     bl.subsidiary_id, bl.department_id, bl.project_id, bl.location_id, bl.class_id,
                     bl.extra_dims, bl.amount, bl.note, ${user.id}, ${user.id}
                from budget_lines bl
                join accounting_periods source_period on source_period.id = bl.period_id and source_period.org_id = bl.org_id
                join accounting_periods destination
                  on destination.org_id = ${user.orgId}
                 and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
                 and destination.fiscal_year = ${scenario.fiscal_year}
                 and destination.period_number = source_period.period_number
                 and not destination.is_adjustment
               where bl.org_id = ${user.orgId} and bl.scenario_id = ${sourceScenarioId}
                 ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
            `);
        const nextRevision = expectedRevision + 1;
        await tx.execute(sql`
              update budget_scenarios set revision = ${nextRevision}, updated_at = now(), updated_by = ${user.id}
               where id = ${id} and org_id = ${user.orgId}
            `);
        await tx.execute(sql`
              insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
                ${JSON.stringify({ action, sourceScenarioId })}::jsonb, ${user.id})
            `);
        return { revision: nextRevision, status: "draft" };
      }

      if (!["draft", "pending_approval", "approved"].includes(scenario.status)) {
        throw new BudgetMutationError("invalid_status_transition", 409);
      }
      if (scenario.status === "approved" && !can(gate, "budgets.approve")) {
        throw new BudgetMutationError("approved_budget_requires_approver", 403);
      }
      const nextRevision = expectedRevision + 1;
      await tx.execute(sql`
            update budget_scenarios set
              status = 'archived', revision = ${nextRevision},
              updated_at = now(), updated_by = ${user.id}
            where id = ${id} and org_id = ${user.orgId}
          `);
      await tx.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
              ${JSON.stringify({ action: "archive", from: scenario.status, to: "archived" })}::jsonb, ${user.id})
          `);
      return { revision: nextRevision, status: "archived" };
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BudgetMutationError) return apiErrorResponse(error);
    // A line deleted between the pre-check and the status flip still trips
    // the scenario-guard trigger: translate its raise to the same typed
    // refusal instead of a 500.
    if (error instanceof Error && error.message.includes("at least one non-zero line")) {
      return NextResponse.json({ error: "budget_requires_lines" }, { status: 422 });
    }
    throw error;
  }
}
