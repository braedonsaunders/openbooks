import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { submitBudgetScenario } from "../flows/budget-submission.ts";
import { assertFixtureDatabase } from "./fixtures.ts";
import { createWorkOperator } from "./manufacturing.ts";

/** Reporting fixtures retain a real submission under their declared zero-gate policy. */
export async function approveBudgetScenarioFixture(
  orgId: string,
  scenarioId: string,
): Promise<void> {
  await assertFixtureDatabase();
  installEngineSeams();
  const actorId = await createWorkOperator(orgId, "Budget author", ["budgets.manage"]);
  const draft = (
    await db.execute<{ revision: number }>(
      sql`
    select revision from budget_scenarios where org_id=${orgId} and id=${scenarioId} and status='draft'`,
      "objects",
    )
  )[0];
  if (!draft) throw new Error("The budget fixture must identify a native draft.");
  const submitted = await submitBudgetScenario(orgId, actorId, scenarioId, draft.revision);
  if (submitted.status !== "approved")
    throw new Error("This reporting fixture requires its declared zero-gate budget policy.");
}
