import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import { outOfScopeScenarioError, scenarioOutOfScopeSubsidiaryNames } from "./budget-scope";
import { BudgetMutationError } from "./budget-mutations";

export const budgetScenarioCreateFields = z.object({
  bookId: z
    .string()
    .regex(UUID_RE)
    .optional()
    .describe("Active accounting book id; omitted selects the native default book."),
  description: z.string().max(2000).optional().describe("Optional scenario description."),
  fiscalYear: z
    .number()
    .int()
    .min(1900)
    .max(9999)
    .optional()
    .describe("Fiscal year; omitted selects the year containing the organization business date."),
  kind: z.enum(["forecast", "budget"]).optional().describe("Scenario kind; defaults to budget."),
  name: z.string().max(200).optional().describe("Optional scenario name."),
  sourceScenarioId: z
    .string()
    .regex(UUID_RE)
    .optional()
    .describe("Optional scenario whose visible lines should be copied into this draft."),
});

export const budgetScenarioCreateSchema = budgetScenarioCreateFields.refine(
  (body) => Object.keys(body).length > 0,
  { message: "At least one field must be provided." },
);

export class BudgetScenarioSourceNotFoundRefusal extends Error {
  readonly status = 404;
  constructor() {
    super("source_not_found");
    this.name = "SourceNotFoundRefusal";
  }
}

export type BudgetScenarioCreateInput = z.infer<typeof budgetScenarioCreateFields>;

export const budgetScenarioPatchSchema = z.object({
  bookId: z
    .string()
    .regex(UUID_RE)
    .optional()
    .describe("Active accounting book id; changing books requires an empty draft."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("Scenario description, or null to clear it."),
  expectedRevision: z.number().int().positive().describe("Current scenario revision."),
  fiscalYear: z
    .number()
    .int()
    .optional()
    .describe("Fiscal year; changing years requires an empty draft."),
  kind: z.enum(["budget", "forecast"]).optional().describe("Scenario type."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Scenario name, up to 200 characters."),
});

export type BudgetScenarioPatchInput = z.infer<typeof budgetScenarioPatchSchema>;

/** Update draft metadata through the same locked, audited route path. */
export async function updateBudgetScenario(
  gate: Authz,
  id: string,
  body: BudgetScenarioPatchInput,
): Promise<{ revision: number; scopeChanged: boolean }> {
  const { user } = gate;
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision)) throw new BudgetMutationError("invalid_revision");
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const description =
    body.description === null
      ? null
      : typeof body.description === "string"
        ? body.description.trim().slice(0, 4_000) || null
        : undefined;
  const kind = body.kind === undefined ? undefined : body.kind;
  const bookId = body.bookId === undefined ? undefined : body.bookId;
  const fiscalYearValue = Number(body.fiscalYear);
  const fiscalYear =
    body.fiscalYear === undefined
      ? undefined
      : Number.isInteger(fiscalYearValue) && fiscalYearValue >= 1900 && fiscalYearValue <= 9999
        ? fiscalYearValue
        : null;
  if (name !== undefined && (name.length === 0 || name.length > 200)) {
    throw new BudgetMutationError("invalid_name");
  }
  if (bookId === null || fiscalYear === null)
    throw new BudgetMutationError("invalid_book_or_fiscal_year");

  return withOrgTransaction(user.orgId, async () => {
    const locked = await db.execute<Record<string, unknown>>(
      sql`
        select name, description, kind, book_id, fiscal_year, status, revision,
               exists (select 1 from budget_lines where scenario_id = ${id} and org_id = ${user.orgId}) as has_lines
          from budget_scenarios where id = ${id} and org_id = ${user.orgId} for update
      `,
      "objects",
    );
    const before = locked[0];
    if (!before) throw new BudgetMutationError("not_found", 404);
    if (
      (await scenarioOutOfScopeSubsidiaryNames(id, user.orgId, gate.allowedSubsidiaryIds)).length >
      0
    ) {
      throw new BudgetMutationError("not_found", 404);
    }
    if (before.status !== "draft") throw new BudgetMutationError("budget_is_locked", 409);
    if (Number(before.revision) !== expectedRevision)
      throw new BudgetMutationError("revision_conflict", 409);

    const nextBookId = bookId ?? before.book_id;
    const nextFiscalYear = fiscalYear ?? Number(before.fiscal_year);
    const scopeChanged =
      nextBookId !== before.book_id || nextFiscalYear !== Number(before.fiscal_year);
    if (nextBookId !== before.book_id) {
      const validBook = await db.execute(
        sql`select 1 from accounting_books where id = ${nextBookId} and org_id = ${user.orgId} and is_active`,
        "objects",
      );
      if (!validBook[0]) throw new BudgetMutationError("invalid_book_or_fiscal_year");
    }
    if (nextBookId !== before.book_id && before.has_lines) {
      throw new BudgetMutationError("budget_scope_has_lines", 409);
    }
    if (nextFiscalYear !== Number(before.fiscal_year)) {
      if (before.has_lines) throw new BudgetMutationError("budget_scope_has_lines", 409);
      const validYear = await db.execute(
        sql`select 1 from accounting_periods where org_id = ${user.orgId} and fiscal_year = ${nextFiscalYear} and not is_adjustment limit 1`,
        "objects",
      );
      if (!validYear[0]) throw new BudgetMutationError("invalid_book_or_fiscal_year");
    }
    const nextRevision = expectedRevision + 1;
    const updated = await db.execute<{ id: string }>(
      sql`
      update budget_scenarios set
        name = ${name !== undefined ? name : sql`name`},
        description = ${description !== undefined ? description : sql`description`},
        kind = ${kind !== undefined ? kind : sql`kind`},
        book_id = ${nextBookId},
        fiscal_year = ${nextFiscalYear},
        revision = ${nextRevision}, updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}
      returning id
    `,
      "objects",
    );
    if (updated.length !== 1) throw new Error("Budget scenario update returned no row.");
    const audit = await db.execute<{ row_id: string }>(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
        ${JSON.stringify({
          before: {
            name: before.name,
            description: before.description,
            kind: before.kind,
            bookId: before.book_id,
            fiscalYear: Number(before.fiscal_year),
          },
          after: {
            name: name ?? before.name,
            description: description === undefined ? before.description : description,
            kind: kind ?? before.kind,
            bookId: nextBookId,
            fiscalYear: nextFiscalYear,
          },
          revisionBefore: expectedRevision,
          revisionAfter: nextRevision,
        })}::jsonb, ${user.id})
      returning row_id
    `,
      "objects",
    );
    if (audit.length !== 1) throw new Error("Budget scenario audit record was not saved.");
    return { revision: nextRevision, scopeChanged };
  });
}

/** Delete an in-scope draft scenario with an audit record and affected-row check. */
export async function deleteBudgetScenario(gate: Authz, id: string): Promise<void> {
  const { user } = gate;
  await withOrgTransaction(user.orgId, async () => {
    const locked = await db.execute<Record<string, unknown>>(
      sql`select name, status, revision from budget_scenarios where id = ${id} and org_id = ${user.orgId} for update`,
      "objects",
    );
    const row = locked[0];
    if (!row) throw new BudgetMutationError("not_found", 404);
    if (
      (await scenarioOutOfScopeSubsidiaryNames(id, user.orgId, gate.allowedSubsidiaryIds)).length >
      0
    ) {
      throw new BudgetMutationError("not_found", 404);
    }
    if (row.status !== "draft") throw new BudgetMutationError("only_drafts_can_be_deleted", 409);
    const audit = await db.execute<{ row_id: string }>(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'budget_scenarios', ${id}, 'delete', ${JSON.stringify(row)}::jsonb, ${user.id})
      returning row_id
    `,
      "objects",
    );
    if (audit.length !== 1) throw new Error("Budget scenario audit record was not saved.");
    const deleted = await db.execute<{ id: string }>(
      sql`delete from budget_scenarios where id = ${id} and org_id = ${user.orgId} returning id`,
      "objects",
    );
    if (deleted.length !== 1) throw new Error("Budget scenario delete returned no row.");
  });
}

/** Create a draft scenario using the same route validation, scope, and copy path. */
export async function createBudgetScenario(
  gate: Authz,
  body: BudgetScenarioCreateInput,
): Promise<{ id: string; revision: number }> {
  const user = gate.user;
  const requestedBook = body.bookId ?? null;
  const requestedYear = body.fiscalYear ?? null;
  const kind = body.kind ?? "budget";
  const sourceScenarioId = body.sourceScenarioId ?? null;
  if (sourceScenarioId) {
    const outOfScope = await scenarioOutOfScopeSubsidiaryNames(
      sourceScenarioId,
      user.orgId,
      gate.allowedSubsidiaryIds,
    );
    if (outOfScope.length > 0) throw outOfScopeScenarioError(outOfScope);
  }
  const description = body.description?.trim().slice(0, 2000) ?? null;
  const today = await businessToday(user.orgId);
  const defaults = await db.execute<{ book_id: string | null; fiscal_year: number | null }>(
    sql`
    select
      (select id from accounting_books
        where org_id = ${user.orgId} and is_active
        order by is_primary desc, name limit 1) as book_id,
      coalesce(
        (select fiscal_year from accounting_periods
          where org_id = ${user.orgId} and ${today}::date between starts_on and ends_on and not is_adjustment
          order by starts_on desc limit 1),
        (select max(fiscal_year) from accounting_periods where org_id = ${user.orgId})
      ) as fiscal_year
  `,
    "objects",
  );
  const bookId = requestedBook ?? defaults[0]?.book_id;
  const fiscalYear = requestedYear ?? Number(defaults[0]?.fiscal_year);
  if (!bookId || !Number.isInteger(fiscalYear)) {
    throw new BudgetMutationError("configure_an_accounting_book_and_periods_first", 409);
  }
  const valid = await db.execute(
    sql`
    select 1 from accounting_books where id = ${bookId} and org_id = ${user.orgId} and is_active
  `,
    "objects",
  );
  const havePeriods = await db.execute(
    sql`
    select 1 from accounting_periods
     where org_id = ${user.orgId} and fiscal_year = ${fiscalYear} and not is_adjustment limit 1
  `,
    "objects",
  );
  if (!valid[0] || !havePeriods[0]) throw new BudgetMutationError("invalid_book_or_fiscal_year");

  const requestedName = body.name?.trim().slice(0, 200) ?? "";
  const baseName =
    requestedName || `FY${fiscalYear} ${kind === "forecast" ? "Forecast" : "Budget"}`;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${user.orgId}:${bookId}:${fiscalYear}:${kind}`}, 0))`,
    );
    const names = await tx.execute<{ name: string }>(
      sql`
      select name from budget_scenarios
       where org_id = ${user.orgId} and book_id = ${bookId}
         and fiscal_year = ${fiscalYear} and kind = ${kind}
         and (name = ${baseName} or name like ${`${baseName} (%`})
    `,
      "objects",
    );
    const used = new Set(names.map((row) => row.name));
    let name = baseName;
    for (let i = 2; used.has(name); i++) name = `${baseName} (${i})`;

    const inserted = await tx.execute<{ id: string; revision: number }>(
      sql`
      insert into budget_scenarios
        (org_id, book_id, fiscal_year, name, description, kind, status, created_by, updated_by)
      values (${user.orgId}, ${bookId}, ${fiscalYear}, ${name}, ${description}, ${kind}, 'draft', ${user.id}, ${user.id})
      returning id, revision
    `,
      "objects",
    );
    const scenario = inserted[0];
    if (inserted.length !== 1 || !scenario)
      throw new Error("Budget scenario insert returned no row.");

    if (sourceScenarioId) {
      const source = await tx.execute<{ id: string }>(
        sql`
        select id from budget_scenarios where id = ${sourceScenarioId} and org_id = ${user.orgId}
      `,
        "objects",
      );
      if (!source[0]) throw new BudgetScenarioSourceNotFoundRefusal();
      const unmapped = await tx.execute<{ period_name: string }>(
        sql`
        select distinct source_period.name as period_name
          from budget_lines bl
          join accounting_periods source_period
            on source_period.id = bl.period_id and source_period.org_id = bl.org_id
          left join accounting_periods destination
            on destination.org_id = ${user.orgId}
           and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
           and destination.fiscal_year = ${fiscalYear}
           and destination.period_number = source_period.period_number
           and not destination.is_adjustment
         where bl.org_id = ${user.orgId} and bl.scenario_id = ${sourceScenarioId}
           and destination.id is null
         order by 1
      `,
        "objects",
      );
      if (unmapped.length > 0) {
        const periods = unmapped.map((row) => row.period_name).join(", ");
        throw new BudgetMutationError(
          `unmapped_periods: no ${fiscalYear} period matches source period(s) ${periods}`,
        );
      }
      await tx.execute(sql`
        insert into budget_lines
          (org_id, scenario_id, account_id, period_id, subsidiary_id, department_id, project_id, location_id, class_id,
           extra_dims, amount, note, created_by, updated_by)
        select ${user.orgId}, ${scenario.id}, bl.account_id, destination.id,
               bl.subsidiary_id, bl.department_id, bl.project_id, bl.location_id, bl.class_id,
               bl.extra_dims, bl.amount, bl.note, ${user.id}, ${user.id}
          from budget_lines bl
          join accounting_periods source_period
            on source_period.id = bl.period_id and source_period.org_id = bl.org_id
          join accounting_periods destination
            on destination.org_id = ${user.orgId}
           and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
           and destination.fiscal_year = ${fiscalYear}
           and not destination.is_adjustment
           and destination.period_number = source_period.period_number
         where bl.org_id = ${user.orgId} and bl.scenario_id = ${sourceScenarioId}
           ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, gate.allowedSubsidiaryIds)}
      `);
    }

    const audit = await tx.execute<{ row_id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'budget_scenarios', ${scenario.id}, 'insert',
        ${JSON.stringify({ name, description, fiscalYear, bookId, kind, sourceScenarioId })}::jsonb, ${user.id})
      returning row_id
    `);
    if (audit.length !== 1) throw new Error("Budget scenario audit record was not saved.");
    return scenario;
  });
}
