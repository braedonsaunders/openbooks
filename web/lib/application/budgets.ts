import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { isFeatureEnabled } from "../features";
import { BudgetMutationError, saveBudgetCells, type BudgetCellInput } from "../budget-mutations";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

/**
 * Governed budget-line writes for the application catalog (chat, MCP, API).
 * They terminate in `saveBudgetCells` — the service the PATCH
 * /api/budgets/[id]/lines route calls — with that route's permission
 * (`budgets.manage`), feature (`budgets`), subsidiary, and revision-concurrency
 * contract. Subsidiary refusals surface as `forbidden` per the
 * application-layer convention (the route answers the same refusal as a 422;
 * the control is identical).
 */

function budgetFailure(error: unknown): never {
  if (error instanceof BudgetMutationError) {
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404);
    if (error.status === 409) throw new ApplicationError("conflict", error.message, 409);
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

export type BudgetCellWrite = {
  accountId: string;
  periodId: string;
  subsidiaryId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  amount: string;
  note?: string | null;
};

export async function updateBudgetCells(context: ApplicationContext, input: {
  scenarioId: string;
  expectedRevision: number;
  cells: BudgetCellWrite[];
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "budgets.manage");
  // The route 404s through guardFeaturePermission when the module is off.
  if (!(await isFeatureEnabled(context.authz.user.orgId, "budgets"))) throw notFound("budget");
  // Mirror the route's subsidiary checks: explicit entities must sit inside
  // the caller's scope, and an omitted entity resolves to the tenant root
  // inside saveBudgetCells — so a restricted caller whose scope excludes the
  // root is refused instead of silently rooted.
  const explicit = [...new Set(
    input.cells.map((cell) => cell.subsidiaryId ?? null).filter((id): id is string => !!id),
  )];
  for (const subsidiaryId of explicit) assertSubsidiaryAccess(context, subsidiaryId);
  if (input.cells.some((cell) => (cell.subsidiaryId ?? null) === null) && context.authz.allowedSubsidiaryIds !== null) {
    const root = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${context.authz.user.orgId}
         and parent_id is null and is_active and not is_elimination
       order by created_at, id
       limit 1
    `)).rows[0]?.id;
    assertSubsidiaryAccess(context, root);
  }
  const cells: BudgetCellInput[] = input.cells.map((cell) => ({
    accountId: cell.accountId,
    periodId: cell.periodId,
    subsidiaryId: cell.subsidiaryId ?? null,
    departmentId: cell.departmentId ?? null,
    projectId: cell.projectId ?? null,
    locationId: cell.locationId ?? null,
    classId: cell.classId ?? null,
    amount: cell.amount,
    note: cell.note ?? null,
  }));
  const outcome = await executeIdempotent({
    context,
    operation: "budgets.cells.update",
    idempotencyKey: input.idempotencyKey,
    request: { scenarioId: input.scenarioId, expectedRevision: input.expectedRevision, cells },
    execute: async () => {
      try {
        return await saveBudgetCells({
          scenarioId: input.scenarioId,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          expectedRevision: input.expectedRevision,
          cells,
          source: context.source,
        });
      } catch (error) {
        budgetFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: { ...outcome.value } };
}
